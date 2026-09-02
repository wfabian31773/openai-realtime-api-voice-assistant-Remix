/**
 * src/runtime/voiceRuntime.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * The server glue: Express routes, the media-stream WebSocket, and the
 * health endpoint. Everything it does is assembled from the pieces that
 * already have their own tests — this file wires, it does not decide.
 *
 *   POST /voice/:slug        the number's Voice webhook (voiceWebhook.ts)
 *   POST /voice/:slug/after  post-stream continuation (voiceWebhook.ts)
 *   WS   /voice/stream       Twilio Media Streams (mediaStreamBridge.ts)
 *   GET  /voice/health       deploy marker, readiness, missing env NAMES
 *
 * ONE PATH, EVERY LANE. The slug in the URL picks the agent, through the
 * registry that already exists (laneRegistry.ts -> src/config/agents.ts).
 * Adding a lane is a registry entry and a prompt; no code here changes.
 *
 * WHAT HAPPENS ON A CALL:
 *   1. Twilio POSTs /voice/optical. Signature checked, readiness checked,
 *      lane checked. The call is registered with a single-use token and
 *      answered with <Connect><Stream>.
 *   2. Twilio opens the stream and sends `start`, carrying the callSid and
 *      token as customParameters. They are claimed exactly once; anything
 *      unrecognised is closed without ever constructing a bridge.
 *   3. The lane's agent is built from its own factory, bound (instructions
 *      and tools verbatim, knowledge pack first), and a Grok session is
 *      opened. The bridge owns the call from there.
 *   4. Teardown records one outcome, writes call_logs, and closes the
 *      socket. Twilio runs the <Redirect>, which reads that outcome.
 *
 * THE AGENT IS BUILT AFTER THE START FRAME, NOT AT THE WEBHOOK. The factory
 * needs the callSid and caller phone, and the webhook's response has to be
 * fast — Twilio times it. Building at start-frame time also means a caller
 * who hangs up during setup costs one factory call, not a live session.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import type { Express, Request, Response } from "express";
import type { Server as HttpServer } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";

import {
  VoiceCallBridge,
  type CallOutcome,
  type VoiceCallRecord,
} from "./mediaStreamBridge";
import { CallSessionRegistry, type CallEntry } from "./sessionRegistry";
import {
  GrokVoiceSession,
  WebSocketGrokTransport,
  buildSessionConfig,
  type GrokTransport,
} from "./grokSession";
import { resolveLane, defaultLaneSource, type LaneSource } from "./laneRegistry";
import {
  createRuntimeTransfer,
  transferDestinationStatus,
  TRANSFER_ACCEPT_PATH,
  TRANSFER_STATUS_PATH,
} from "./runtimeTransfer";
import { releaseCallHandoff } from "../tools/handoffBroker";
import {
  greetingStyleFor,
  missingMandatoryCopy,
  personaliseGreeting,
} from "../services/greetingPersonalisation";

/**
 * The first name a caller-ID match resolved to, or "" when there is none.
 *
 * `precontext` reaches this untyped — it is whatever `fetchPrecontext`
 * returned, injected so the runtime needs no network in tests — so the shape
 * is checked rather than asserted. A match without a first name is not a
 * match for this purpose: personalising on an empty string would strip the
 * greeting's own question and leave nothing in its place.
 */
/**
 * Whether the lookup vouched for exactly one person, regardless of whether a
 * usable first name came with it.
 *
 * Separate from `recognisedFirstName` on purpose. `AzulPrecontext` permits
 * `{ matched: true }` with no name, and the greeting correctly does nothing
 * with that — there is nothing to say. But logging it as `no_match` describes
 * the opposite of what happened and would send someone looking for a lookup
 * failure that did not occur. Classification is the flag's job; the name
 * helper's job is the greeting (Codex review, PR #240).
 */
/**
 * The configured greeting, unless it is missing copy the lane must say.
 *
 * The database outranks the registry — that is `greetingResolver`'s whole
 * purpose and an operator's edit has to be what the caller hears. But an
 * edit is a choice of WORDING, not permission to drop the 911 direction or
 * the recording disclosure from the after-hours line. When the configured
 * text has lost one, the registry string is used and the gap is logged
 * loudly, because the row still needs fixing and only a person can do that.
 *
 * The alternative — play it anyway, warn, and let a caller miss a
 * disclosure — is worse in the only direction that matters. Codex, #240.
 */
export function chooseGreeting(
  slug: string,
  configured: string | null,
  registry: string | null,
): string {
  if (!configured) return registry ?? "";
  const missing = missingMandatoryCopy(slug, configured);
  if (missing.length === 0) return configured;
  if (missingMandatoryCopy(slug, registry).length > 0) {
    // Neither has it. Say the configured one and make the gap impossible to
    // miss: falling back would swap one deficient greeting for another.
    console.error(
      `[runtime] ${slug}: configured AND registry greetings are both missing ` +
        `${missing.join(", ")} — FIX agents.welcome_greeting`,
    );
    return configured;
  }
  console.error(
    `[runtime] ${slug}: configured greeting is missing ${missing.join(", ")} — ` +
      `using the built-in greeting instead. FIX agents.welcome_greeting`,
  );
  return registry ?? configured;
}

function precontextMatched(precontext: unknown): boolean {
  if (!precontext || typeof precontext !== "object") return false;
  return (precontext as { matched?: unknown }).matched === true;
}

function recognisedFirstName(precontext: unknown): string {
  if (!precontext || typeof precontext !== "object") return "";
  const pc = precontext as { matched?: unknown; firstName?: unknown };
  if (pc.matched !== true) return "";
  return typeof pc.firstName === "string" ? pc.firstName.trim() : "";
}
import type { TransferTwilioOps } from "./warmTransfer";
import { resolveAppDomain } from "../config/environment";
import { callEnvironment } from "./callRecord";
import { openRuntimeCall, persistRuntimeCall, type CallLogInsert } from "./callRecord";
import { persistRecordingUrl } from "./callRecord";
import {
  RECORDING_STATUS_PATH,
  createRecordingStarter,
  handleRecordingStatus,
  type RecordingStarter,
  type RecordingStatusBody,
} from "./callRecording";
import {
  handleAfterRedirect,
  handleVoiceWebhook,
  isValidSlug,
  VOICE_STREAM_PATH,
  type WebhookRequest,
  type WebhookResponse,
  checkTwilioSignature,
} from "./voiceWebhook";
import {
  computeRuntimeReadiness,
  formatReadinessLines,
  VOICE_RUNTIME_DEPLOY_MARKER,
} from "./readiness";
import {
  parseTwilioInboundFrame,
  type TwilioInboundFrame,
  type TwilioOutboundFrame,
} from "./twilioFrames";
import { KNOWLEDGE_PACK_VERSION } from "./knowledgePack";

/**
 * Twilio media frames held while the agent is being built — 10 seconds of
 * 20ms frames. Sized against the WORST case of the bounded setup steps
 * run in sequence, not the typical build: the precontext lookup (1.5s),
 * the lane factory's own context lookups (the answering-service factory
 * waits up to ~2s), and the call-row insert (2s) can all legitimately run
 * to their deadlines back to back, and a 4-second cap was dropping the
 * start of what the caller said during that window even though every
 * dependency finished inside its allowance (Codex review, PR #227
 * round 17). 500 frames of ~1KB JSON is at most ~0.5 MB per call.
 */
const PRE_BRIDGE_FRAME_CAP = 500;

/**
 * How long a socket may hold the media-stream endpoint without claiming a
 * call. The upgrade itself carries no token — Twilio delivers the callSid
 * and token in the `start` frame, so the gate cannot run any earlier — and
 * without a deadline any remote client can open sockets, send nothing, and
 * hold descriptors and memory indefinitely (Codex review, PR #227).
 * Twilio sends `connected` and `start` immediately, so ten seconds is far
 * more slack than a real call needs.
 */
const STREAM_CLAIM_DEADLINE_MS = 10_000;

/**
 * How long the provider has to connect and complete its handshake.
 *
 * The dead-air watchdog is armed by `onConfigured`, so nothing covers the
 * window before it: a WebSocket that never settles, or one that opens and
 * never emits `session.created`/`session.updated`, left the caller in
 * billed silence until the ten-minute ceiling — and then recorded a clean
 * `max_duration` rather than the provider failure it was (Codex review,
 * PR #227). A real handshake is sub-second.
 */
const PROVIDER_SETUP_DEADLINE_MS = 15_000;

/**
 * Bound on the caller-ID lookup. The pre-context is what lets an agent say
 * "Am I speaking with…?" instead of asking cold, but it is worth nothing if
 * the caller is listening to silence while we fetch it: an unbounded
 * lookup was a review finding on 5Star #200. Whatever has not arrived by
 * the time the stream is ready is dropped.
 */
const PRECONTEXT_DEADLINE_MS = 1_500;

/**
 * Bound on opening the call's row. Generous against a healthy database and
 * short against a wedged one: the row matters, but not more than the caller
 * hearing something.
 */
const CALL_ROW_DEADLINE_MS = 2_000;

/** Resolve within a bound, or null. Never throws. */
async function withinOrNull<T>(work: Promise<T>, ms: number): Promise<T | null> {
  return Promise.race([
    work.catch(() => null),
    new Promise<null>((resolve) => {
      const t = setTimeout(() => resolve(null), ms);
      (t as unknown as { unref?: () => void }).unref?.();
    }),
  ]);
}

export interface VoiceRuntimeOptions {
  env?: Record<string, string | undefined>;
  /** Overridable so tests never import the agent tree. */
  laneSource?: LaneSource;
  registry?: CallSessionRegistry;
  /** How long a media-stream socket may stay open without claiming a call.
   * Defaults to STREAM_CLAIM_DEADLINE_MS. */
  streamClaimDeadlineMs?: number;
  /** How long the provider has to connect AND finish its handshake.
   * Defaults to PROVIDER_SETUP_DEADLINE_MS. */
  providerSetupDeadlineMs?: number;
  /** Caller-ID pre-context lookup. Injected so tests need no network, and
   * so a lane that should not do one simply is not given it. */
  fetchPrecontext?: (phone: string) => Promise<unknown>;
  /**
   * The admin-configured `agents.welcome_greeting`, or null when there is
   * none. Injected for the same reason as `fetchPrecontext`: the resolver
   * reaches the database, and the runtime's tests must not.
   *
   * The DB value is the source of truth for how every agent opens — that is
   * what `greetingResolver` exists to enforce, and what the admin UI and the
   * Observatory display. Playing the registry string instead means an
   * operator edits the greeting, sees it change everywhere, and hears the old
   * one on the line (Codex review, PR #240). The registry string stays as the
   * fallback, which is also the SIP path's arrangement.
   */
  resolveGreeting?: (slug: string) => Promise<string | null>;
  /** Opens the call_logs row. Injected for tests. */
  openCallRow?: CallLogInsert;
  /** Test seam. Production builds one from env — see createRecordingStarter. */
  startRecording?: RecordingStarter;
  /** Persists the finished call. Injected for tests. */
  persistCall?: (record: VoiceCallRecord) => Promise<boolean>;
  /** Bound on opening the call row. Defaults to CALL_ROW_DEADLINE_MS. */
  callRowDeadlineMs?: number;
  /**
   * How to open the Grok connection. Injectable for one reason, and it is
   * the standing rule rather than a convenience: a failing call goes into
   * an offline test BEFORE any code changes, red then green, instead of
   * asking Wayne to dial and find out. With a fake transport the whole
   * path — webhook, token claim, lane resolve, binding, session, bridge,
   * teardown, outcome, after-redirect — runs in milliseconds with no phone
   * and no xAI account.
   */
  createTransport?: (config: { apiKey: string; model: string }) => RuntimeTransport;
  /**
   * Twilio operations for the warm transfer. Injected for tests; when
   * omitted, a client is built lazily from TWILIO_ACCOUNT_SID/AUTH_TOKEN.
   * Whether transfers are OFFERED at all is decided by
   * `transferUnavailableReason` — a deployment missing credentials, a
   * from-number or a public domain keeps refusing the transfer-capable
   * lanes exactly as before, with the reason logged once at mount.
   */
  transferOps?: TransferTwilioOps;
}

/** A transport the runtime can open. WebSocketGrokTransport satisfies it. */
export interface RuntimeTransport extends GrokTransport {
  connect(): Promise<void>;
}

function toWebhookRequest(req: Request): WebhookRequest {
  return {
    headers: req.headers as WebhookRequest["headers"],
    body: (req.body ?? {}) as Record<string, string>,
    originalUrl: req.originalUrl,
  };
}

function send(res: Response, out: WebhookResponse): void {
  res.status(out.status).type(out.contentType).send(out.body);
}

/**
 * Mount the runtime on an existing Express app and HTTP server. Returns the
 * registry so a caller can inspect live calls; mounting never throws and
 * never blocks startup on configuration — an unconfigured process still
 * starts, still serves health, and still fails closed at the webhook.
 */
/**
 * The public domain transfers may build their accept URL on, or undefined
 * when this deployment has none.
 *
 * `resolveAppDomain` ALWAYS answers, falling back to `localhost:8000` —
 * which is not a public domain: Twilio can never reach an accept URL on
 * it, so treating the fallback as proof of a domain marked a deployment
 * with credentials but no domain transfer-ready, and every transfer
 * dialled an office leg that timed out instead of the lane being refused
 * as intended (Codex, PR #230). Production preference uses the same
 * signal set as the rest of the runtime (callEnvironment), not NODE_ENV
 * alone (Codex, PR #227 round 21).
 */
export function publicTransferDomain(
  env: Record<string, string | undefined>,
): string | undefined {
  const resolved = resolveAppDomain({
    domain: env.DOMAIN,
    replitDomains: env.REPLIT_DOMAINS,
    replitDevDomain: env.REPLIT_DEV_DOMAIN,
    isProduction: callEnvironment(env) === "production",
  });
  return resolved.source === "fallback" ? undefined : resolved.domain;
}

export function mountVoiceRuntime(
  app: Express,
  server: HttpServer,
  options: VoiceRuntimeOptions = {},
): CallSessionRegistry {
  const env = options.env ?? process.env;
  const registry = options.registry ?? new CallSessionRegistry();
  // Resolved lazily and cached: importing src/config/agents pulls in every
  // agent (and their database and API clients), which must not happen at
  // boot or in a health check.
  const persistCall = options.persistCall ?? persistRuntimeCall;
  let laneSourcePromise: Promise<LaneSource> | null = null;
  const laneSource = () => {
    if (options.laneSource) return Promise.resolve(options.laneSource);
    laneSourcePromise ??= defaultLaneSource();
    return laneSourcePromise;
  };
  /** Lanes proven available at least once, so the webhook's own check does
   * not have to await the agent tree on Twilio's clock. A slug is only
   * added here after a successful resolve. */
  const knownLanes = new Set<string>();

  for (const line of formatReadinessLines(computeRuntimeReadiness(env))) {
    console.log(line);
  }

  // The warm transfer. Its availability is decided once, here, and logged —
  // so "why is no-ivr still refused?" is answered by the boot log, not a
  // live call. resolveAppDomain is the same resolution the SIP path uses
  // for its callback URLs, called with raw env so this module never pulls
  // in the full config (which requires DATABASE_URL at import).
  const transferDomain = publicTransferDomain(env);
  const transfer = createRuntimeTransfer({
    env,
    ops: options.transferOps,
    domain: transferDomain,
  });
  console.log(
    transfer.unavailableReason
      ? `[voice-runtime] ${transfer.unavailableReason} — transfer-capable lanes stay refused`
      : `[voice-runtime] warm transfer armed (accept: https://${transferDomain}${TRANSFER_ACCEPT_PATH})`,
  );

  app.post(TRANSFER_ACCEPT_PATH, (req: Request, res: Response) => {
    send(res, transfer.handleAccept(toWebhookRequest(req)));
  });

  app.post(TRANSFER_STATUS_PATH, (req: Request, res: Response) => {
    send(res, transfer.handleStatus(toWebhookRequest(req)));
  });

  /**
   * Task #54: the greeting promises a recording, so the runtime makes one and
   * this is where Twilio returns it. Keyed on CallSid — the old core's
   * /api/voice/recording-status reads ConferenceSid and would silently drop a
   * call-level recording. See handleRecordingStatus.
   */
  app.post(RECORDING_STATUS_PATH, (req: Request, res: Response) => {
    // AUTHENTICATE BEFORE WRITING. This endpoint is public and its only input
    // is a CallSid and a URL, so without this anyone holding a CallSid could
    // POST `RecordingStatus=completed` with a RecordingUrl of their choosing
    // and overwrite the staff-facing recording link on a real patient's call
    // (Codex, PR #247). Every other runtime Twilio webhook already gates on
    // this; this one was the exception.
    //
    // Still always 200 — Twilio retries any non-2xx, and a retry storm from a
    // caller that can never authenticate is worse than a dropped callback.
    const webhookReq = toWebhookRequest(req);
    const sig = checkTwilioSignature(webhookReq, env);
    if (sig !== "valid") {
      console.warn(
        `[RUNTIME RECORDING] ✗ recording-status callback REJECTED (${sig}) — not writing anything.`,
      );
      res.status(200).type("text/plain").send("");
      return;
    }
    const result = handleRecordingStatus(webhookReq.body as RecordingStatusBody);
    console.log(result.log);
    if (result.persist) {
      // Fire-and-forget: Twilio gets its 200 either way, and persistRecordingUrl
      // never throws.
      void persistRecordingUrl(result.persist.callSid, result.persist.recordingUrl);
    }
    res.status(result.status).type("text/plain").send(result.body);
  });

  app.get("/voice/health", (_req: Request, res: Response) => {
    const readiness = computeRuntimeReadiness(env);
    const destinations = transferDestinationStatus(env);
    res.json({
      marker: VOICE_RUNTIME_DEPLOY_MARKER,
      // The cached prefix every lane shares. Reported so a change in the
      // fleet's cache-hit rate can be attributed to a prefix change rather
      // than guessed at — which is the whole reason the constant exists,
      // and it was doing none of it while nothing read it.
      knowledgePack: KNOWLEDGE_PACK_VERSION,
      liveReady: readiness.liveReady,
      // NAMES only. A readiness endpoint that echoes a value is a
      // credential leak with a health check's URL.
      missing: readiness.missing,
      requiredDbEnvVar: readiness.requiredDbEnvVar,
      // Transfer readiness is SEPARATE from liveReady on purpose: a
      // deployment with no transfer configuration still serves every
      // non-transfer lane correctly, so it is ready — it just refuses the
      // transfer-capable ones. But `liveReady: true` was being read as
      // "everything works", and the only place the difference showed was
      // one line in the boot log, which meant checking whether a warm
      // transfer could possibly succeed required shell access to the
      // running deployment. Names only here too.
      //
      // TRANSPORT is not the whole answer: the transport can be armed
      // while no destination number is configured, in which case every
      // transfer still fails at resolveHandoffDestination. Ready means a
      // transfer can actually complete — transport AND somewhere to dial
      // (Codex, PR #236).
      transferReady: transfer.unavailableReason === null && destinations.missing.length < 2,
      transferBlockedBy:
        transfer.unavailableReason ??
        (destinations.missing.length === 2
          ? `transfer unavailable: no destination configured (${destinations.missing.join(", ")})`
          : null),
      // Per LANE, because the two use different numbers and one can work
      // while the other does not. Booleans, never the numbers themselves.
      transferDestinations: { clinical: destinations.clinical, pcp: destinations.pcp },
      activeCalls: registry.activeCount(),
    });
  });

  app.post("/voice/:slug/after", (req: Request, res: Response) => {
    send(
      res,
      handleAfterRedirect(toWebhookRequest(req), {
        env,
        registry,
        laneIsAvailable: () => true,
      }),
    );
  });

  /**
   * Task #54. Built once, not per call: the SDK client is constructed lazily
   * inside it, so an unconfigured process still boots and still answers its
   * health check — and readiness already refuses to take calls without the
   * account sid, so a live call always has the means to record.
   */
  // Injectable for the same reason createTransport is: without a seam the
  // start-frame trigger cannot be observed, and a mutation that deletes the
  // call entirely reddens nothing (found by mutation check, PR #247).
  const startRecording =
    options.startRecording ?? createRecordingStarter({ env, log: (line) => console.log(line) });

  app.post("/voice/:slug", (req: Request, res: Response) => {
    const slug = String(req.params.slug ?? "");
    send(
      res,
      handleVoiceWebhook(slug, toWebhookRequest(req), {
        env,
        registry,
        // A lane the runtime has already served is known available. An
        // unseen slug is accepted here and resolved at start-frame time:
        // the alternative is awaiting the agent tree inside Twilio's
        // webhook timeout, and a slug that turns out to be unknown then
        // gets the same controlled unavailable line, one verb later.
        laneIsAvailable: (candidate) => knownLanes.has(candidate) || isValidSlug(candidate),
      }),
    );
  });

  // maxPayload: /voice/stream is PUBLIC until a start frame's token is
  // claimed, and ws's default cap is 100 MiB — an unauthenticated client
  // could make the message handler materialize and parse huge strings
  // before any check runs (Codex review, PR #227 round 17). Real Twilio
  // frames are tiny: a 20ms μ-law media frame is ~216 base64 chars in
  // under 1 KB of JSON, and start frames with customParameters are smaller
  // still. 64 KiB is orders of magnitude of headroom; anything larger is
  // not Twilio and the socket is closed by ws itself (1009).
  const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });

  server.on("upgrade", (req, socket, head) => {
    let path = "";
    try {
      path = new URL(req.url ?? "", "http://localhost").pathname;
    } catch {
      return; // malformed URL — not ours
    }
    if (path !== VOICE_STREAM_PATH) return; // another handler owns it, or nobody does
    wss.handleUpgrade(req, socket as never, head, (ws) => wss.emit("connection", ws));
  });

  wss.on("connection", (ws: WebSocket) => {
    // Armed from the moment of upgrade and cleared the instant a call is
    // claimed: an unauthenticated socket gets a bounded window, a real
    // call is never touched by it.
    let claimDeadline: ReturnType<typeof setTimeout> | null = setTimeout(() => {
      claimDeadline = null;
      console.warn("[voice-runtime] closing a stream socket that never claimed a call");
      try {
        ws.close();
      } catch {
        /* already gone */
      }
    }, options.streamClaimDeadlineMs ?? STREAM_CLAIM_DEADLINE_MS);
    const clearClaimDeadline = () => {
      if (claimDeadline !== null) {
        clearTimeout(claimDeadline);
        claimDeadline = null;
      }
    };
    let bridge: VoiceCallBridge | null = null;
    let starting = false;
    /**
     * Twilio is gone. Set by the close and error handlers, which cannot
     * report to a bridge that does not exist yet: building the agent is
     * asynchronous, and a caller who hangs up during it would otherwise be
     * forgotten while the continuation went on to open a Grok session
     * against a dead socket — a provider connection nobody owns and nobody
     * closes (Codex review, PR #227).
     */
    let socketGone = false;
    /**
     * Caller audio that arrives between the `start` frame and the bridge
     * existing. Building the agent and opening the Grok socket takes real
     * time, and a caller who begins talking during it would otherwise be
     * talking into a dropped stream. The session has its own hold for the
     * NEXT gap (its handshake); this one covers the gap before it exists.
     * Bounded for the same reason as that one: on a live call, stale audio
     * is worth less than fresh, and oldest goes first.
     */
    const pendingFrames: TwilioInboundFrame[] = [];

    const twilioSocket = {
      sendFrame: (frame: TwilioOutboundFrame) => {
        if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(frame));
      },
      close: () => {
        try {
          ws.close();
        } catch {
          /* already closed */
        }
      },
    };

    ws.on("message", (raw) => {
      const frame = parseTwilioInboundFrame(raw.toString());
      if (!frame) return;

      if (frame.event === "start") {
        if (starting || bridge) return; // one stream per socket
        starting = true;
        const params = frame.start.customParameters ?? {};
        const entry = registry.claimStream(params.callSid ?? "", params.token ?? "");
        if (!entry) {
          // Unknown callSid, wrong token, or a second stream for a call
          // that already has one. Closed before any bridge exists.
          console.warn("[voice-runtime] refused a stream with no valid claim");
          twilioSocket.close();
          return;
        }
        clearClaimDeadline();
        void startCall(entry, frame.streamSid);
        return;
      }

      if (!bridge) {
        if (starting) {
          pendingFrames.push(frame);
          if (pendingFrames.length > PRE_BRIDGE_FRAME_CAP) pendingFrames.shift();
        }
        return;
      }
      bridge.handleTwilioFrame(frame);
    });

    ws.on("close", () => {
      clearClaimDeadline();
      clearSetupDeadline();
      socketGone = true;
      bridge?.handleSocketClosed();
    });
    ws.on("error", () => {
      clearClaimDeadline();
      clearSetupDeadline();
      socketGone = true;
      bridge?.handleSocketClosed();
    });

    /** Armed once the provider socket is being opened, cleared by the
     * handshake. Declared out here because the bridge's session is
     * constructed before the timer is armed. */
    let setupDeadline: ReturnType<typeof setTimeout> | null = null;
    const clearSetupDeadline = () => {
      if (setupDeadline !== null) {
        clearTimeout(setupDeadline);
        setupDeadline = null;
      }
    };

    async function startCall(entry: CallEntry, streamSid: string): Promise<void> {
      const startedAtMs = Date.now();
      // RECORDING STARTS HERE, not in the webhook.
      //
      // An inbound call is not `in-progress` until Twilio has received and
      // begun executing the TwiML, and the webhook returns that TwiML AFTER
      // its handler body runs — so a `recordings.create` issued there raced
      // the answer and lost, rejected with 21220, leaving the greeting's
      // recording disclosure false on every call (Codex, PR #247). This
      // frame is Twilio telling us it is executing that TwiML, so the call
      // is live by definition.
      //
      // Guarded even though the starter is documented as non-throwing: a
      // caller must not lose a call over a recording.
      if (entry.host) {
        try {
          startRecording(entry.callSid, entry.host);
        } catch (error) {
          console.error(
            `[RUNTIME RECORDING] ✗ starter threw for ${entry.callSid} — continuing the call:`,
            error,
          );
        }
      } else {
        console.error(
          `[RUNTIME RECORDING] ✗ no host on the registry entry for ${entry.callSid} — ` +
            `NOT recording, and the greeting says we are.`,
        );
      }
      /** Filled in when the call_logs row lands; read through the metadata
       * getter above for the rest of the call. */
      let callLogId: string | undefined;
      const context = {
        callSid: entry.callSid,
        streamSid,
        slug: entry.slug,
        callerPhone: entry.callerPhone,
        dialedNumber: entry.dialedNumber,
      };
      try {
        // Started BEFORE the agent is built so the two overlap, and bounded
        // so it can never hold the call open on its own.
        // Both together: the greeting resolver is a warm Map read after
        // boot, but on a cold miss it can wait on the database, and that
        // must overlap the pre-context lookup rather than follow it.
        const [precontext, configuredGreeting] = await Promise.all([
          options.fetchPrecontext
            ? withinOrNull(
                options.fetchPrecontext(entry.callerPhone) as Promise<unknown>,
                PRECONTEXT_DEADLINE_MS,
              )
            : Promise.resolve(null),
          options.resolveGreeting
            ? withinOrNull(
                options.resolveGreeting(entry.slug),
                PRECONTEXT_DEADLINE_MS,
              )
            : Promise.resolve(null),
        ]);
        // WHICH of the three pre-context outcomes happened. Without this the
        // runbook's own diagnosis step is not performable: every failure —
        // an ordinary "no match", a service error, a lookup that beat no
        // deadline — arrives here as the same `null`, and the runbook told
        // an operator to establish which one before concluding anything.
        // `si_persons` shows what data exists, not what this request
        // returned. So the distinction has to be logged where it is known,
        // and this is the only place that knows (Codex review, PR #239).
        //
        // No name, no number: `recognised` is the fact the operator needs,
        // and the caller's own line already carries the identity.
        // `unavailable` is null — the lookup failed or missed the 1.5s
        // deadline, and callEyecareTool's own [AZUL-SCHED] lines separate
        // those two. `no_match` is a lookup that ran and vouched for nobody,
        // which is ORDINARY and the commonest reason an opening is cold.
        console.info(
          `[runtime] pre-context ${entry.slug} ${entry.callSid}: ` +
            (precontext === null
              ? "unavailable (failed or past the 1.5s deadline — see [AZUL-SCHED])"
              : precontextMatched(precontext)
                ? recognisedFirstName(precontext)
                  ? "recognised"
                  : "matched, no usable first name — the greeting stays generic"
                : "no_match (ran, vouched for nobody — a cold open is correct)"),
        );
        const lane = await resolveLane(
          entry.slug,
          {
            callSid: entry.callSid,
            callId: entry.callSid,
            callerPhone: entry.callerPhone,
            dialedNumber: entry.dialedNumber,
            // A GETTER, because the agent is built before the row exists.
            // answeringServiceAgent polls this for five seconds before
            // writing what it recognised about the caller; a plain value
            // captured here would be undefined forever and every
            // recognised caller would be logged as unidentified — the very
            // phone-ID metric the migration is measured on (Codex review,
            // PR #227).
            get callLogId(): string | undefined {
              return callLogId;
            },
            // The queue agents choose their opening from this: with a
            // unique match they confirm ("Am I speaking with…?") instead of
            // asking cold, which is the behaviour the SIP path already
            // gives every one of these lanes. A match is a candidate to
            // confirm, never an identity — the agent's own prompt decides
            // what to do with it (Codex review, PR #227).
            ...(precontext ? { precontext } : {}),
          },
          {
            source: await laneSource(),
            env,
            // Only when this deployment can actually transfer. Otherwise the
            // transfer-capable lanes keep their refusal, reason logged at
            // mount — never a handoff that dials nothing.
            ...(transfer.unavailableReason
              ? {}
              : {
                  handoff: (md) =>
                    transfer.handoffFor(entry.slug, md, {
                      // Late-bound on purpose: the handoff is built before
                      // the bridge exists, and invoked mid-call when it
                      // does. The mark is what records a successful
                      // transfer as `transferred` rather than the
                      // caller_hangup the stream's death looks like
                      // (Codex, PR #230 round 2).
                      onCallerRedirectStarting: () => bridge?.noteTransferStarting(),
                      onCallerRedirectFailed: () => bridge?.noteTransferFailed(),
                      // The watchdog must span the accept window while the
                      // office is being dialed and briefed, or the caller
                      // is torn down as dead_air at the tool budget and
                      // the office leg abandoned mid-briefing (Codex,
                      // PR #230 round 3).
                      onAttemptStarting: (waitMs) => bridge?.noteTransferWaitStarting(waitMs),
                      onAttemptSettled: () => bridge?.noteTransferWaitSettled(),
                    }),
                }),
          },
        );
        if (!lane) {
          // The webhook let this through unseen and it turned out to be
          // unknown or disabled. Closing the socket runs the <Redirect>,
          // whose handler speaks the controlled line.
          console.warn(`[voice-runtime] no available lane for slug ${entry.slug}`);
          registry.recordOutcome(entry.callSid, "provider_failure");
          // Same durable record the catch below writes: this early return
          // sits BEFORE that catch, and the registry copy is consumed by
          // the redirect — a claimed call for an unknown or disabled lane
          // would otherwise vanish (Codex review, PR #227 round 18).
          void persistCall({
            callSid: entry.callSid,
            streamSid,
            slug: entry.slug,
            callerPhone: entry.callerPhone,
            dialedNumber: entry.dialedNumber,
            outcome: "provider_failure",
            transcript: "",
            toolEvents: [],
            agentTurns: 0,
            interruptions: 0,
            startedAtMs,
            endedAtMs: Date.now(),
          }).catch(() => undefined);
          twilioSocket.close();
          return;
        }
        knownLanes.add(entry.slug);
        // Open the call's row BEFORE the agent can run a tool. The agents'
        // own telemetry, identity stamping and ticket number all UPDATE
        // this row by call_sid, and a flush that lands on no row still
        // marks itself done — so a row created only at teardown loses the
        // tool timeline permanently (Codex review, PR #227).
        //
        // BOUNDED, not merely try/caught. A rejection was handled; an
        // insert that never settles — a lock, a wedged pool — is not a
        // rejection, and awaiting it here blocks before the bridge exists
        // and before the provider deadline is armed, leaving the caller in
        // billed silence. Logging must never do that, so the call proceeds
        // without the row if it does not land in time; teardown's upsert
        // inserts it then instead.
        const openRow = openRuntimeCall(
          {
            callSid: entry.callSid,
            slug: entry.slug,
            callerPhone: entry.callerPhone,
            dialedNumber: entry.dialedNumber,
            agentVersion: lane.version,
            startedAtMs,
          },
          options.openCallRow,
          env,
        );
        // Stopping the WAIT is not cancelling the insert. A row that lands
        // a moment late still carries the id the answering-service agent is
        // polling for — it polls for five seconds — so attach it whenever it
        // arrives rather than discarding it along with the wait. Without
        // this, transient database slowness puts a recognised caller back to
        // being logged as unidentified (Codex review, PR #227).
        void openRow.then((id) => {
          if (id) callLogId = id;
        });
        callLogId =
          (await withinOrNull(openRow, options.callRowDeadlineMs ?? CALL_ROW_DEADLINE_MS)) ??
          undefined;
        if (socketGone) {
          // The caller hung up while the agent was being built. No session
          // exists, so there is nothing to tear down — but a row opened a
          // moment ago is now sitting `in_progress`, and left alone it is
          // swept as a stale call rather than the hangup it was. Finalize
          // it here, on the one path that never reaches the bridge.
          registry.recordOutcome(entry.callSid, "caller_hangup");
          // Finalized unconditionally. Both writes are safe in either
          // order: the open does nothing on conflict, this updates on
          // conflict. So whether the row landed before the deadline, after
          // it, or never, the call is recorded as the hangup it was rather
          // than swept as stale.
          void persistCall({
            callSid: entry.callSid,
            streamSid,
            slug: entry.slug,
            callerPhone: entry.callerPhone,
            dialedNumber: entry.dialedNumber,
            outcome: "caller_hangup",
            transcript: "",
            toolEvents: [],
            agentTurns: 0,
            interruptions: 0,
            startedAtMs,
            endedAtMs: Date.now(),
          }).catch(() => {
            // Losing the record must never break the hangup path.
          });
          return;
        }
        if (lane.agent.skipped.length > 0) {
          // Reported, never silent: a tool that vanished is
          // indistinguishable from a model that would not call it.
          console.warn(
            `[voice-runtime] ${entry.slug}: tools not offered — ` +
              lane.agent.skipped.map((s) => `${s.name} (${s.reason})`).join(", "),
          );
        }

        const transport = options.createTransport
          ? options.createTransport({ apiKey: lane.voice.apiKey, model: lane.voice.model })
          : new WebSocketGrokTransport(lane.voice.apiKey, lane.voice.model);
        bridge = new VoiceCallBridge({
          context,
          startedAtMs,
          agent: lane.agent,
          // The practice's own line, spoken before the agent's first turn,
          // personalised for a recognised caller exactly as the SIP path
          // personalises it — same two helpers, same per-agent style.
          //
          // Passing the raw registry greeting was not a smaller version of
          // this, it was a different opening: the queue lines APPEND, so a
          // recognised caller should hear their own greeting with its
          // trailing question swapped for "Am I speaking with <name>?".
          // Tech and records prompts then tell the model to take that
          // answer and move on — which it cannot do if the caller was only
          // ever asked "How can I help you today?" (Codex review, PR #240).
          //
          // No name, or no match, returns the greeting untouched: whether
          // recognition happened is not a decision this makes.
          // The configured greeting outranks the registry string, exactly as
          // it does on the SIP path — an admin edit must be what the caller
          // hears, not what the code was shipped with. UNLESS it has dropped
          // copy the lane is required to say; see `chooseGreeting`.
          greeting: personaliseGreeting(
            chooseGreeting(entry.slug, configuredGreeting, lane.greeting),
            recognisedFirstName(precontext),
            greetingStyleFor(entry.slug),
          ) || null,
          twilio: twilioSocket,
          createSession: (handlers) =>
            new GrokVoiceSession(
              transport,
              buildSessionConfig(lane.voice, lane.agent.instructions, lane.agent.tools),
              {
                ...handlers,
                // The handshake landing is what stands the setup deadline
                // down — the same event that arms the bridge's own dead-air
                // watchdog, so the two windows meet with no gap between
                // them and nothing to poll.
                onConfigured: () => {
                  clearSetupDeadline();
                  handlers.onConfigured();
                },
              },
            ),
          // Enforce by default — the SDK interrupts on the SIP path, and a
          // lane must not lose its safety rules by moving transports. "log"
          // exists to measure a rule's false-positive rate first.
          guardrailMode: env.RUNTIME_GUARDRAIL_MODE === "log" ? "log" : "enforce",
          onOutcome: (outcome: CallOutcome) => {
            registry.recordOutcome(entry.callSid, outcome);
            // The per-call transfer the proving agent may have brokered dies
            // with the call — an entry outliving its call would let a later
            // call's tool dial a dead leg.
            releaseCallHandoff(entry.callSid);
            // The call is over, whatever ended it: any office leg still
            // ringing for this caller is abandoned NOW, not after the
            // accept window — the staffer must not keep ringing toward,
            // or accept into, a completed leg (Codex, PR #230 round 2).
            // A successful transfer has no pending legs left; no-op then.
            transfer.abandonFor(entry.callSid);
          },
          persistCallRecord: (record) => persistCall(record).then(() => undefined),
        });
        // Connect AFTER the bridge exists: a connection that fails then has
        // somewhere to report to and the call tears down cleanly, instead
        // of leaving the caller on an open socket in silence.
        // The handshake gets its own deadline: the dead-air watchdog only
        // arms once the session is configured, so without this the window
        // before that is covered by nothing but the ten-minute ceiling.
        setupDeadline = setTimeout(() => {
          setupDeadline = null;
          console.error(`[voice-runtime] provider setup timed out for ${entry.callSid}`);
          bridge?.failSession(new Error("provider setup timed out"));
        }, options.providerSetupDeadlineMs ?? PROVIDER_SETUP_DEADLINE_MS);
        (setupDeadline as unknown as { unref?: () => void }).unref?.();
        (bridge.getSession() as GrokVoiceSession).markConnecting();
        await transport.connect();
        if (socketGone) {
          // Twilio went away while the provider socket was opening. Route it
          // through the bridge's own teardown so the transport is closed and
          // exactly one outcome is recorded.
          bridge.handleSocketClosed();
          return;
        }
        // Only now replay what the caller said while the agent was being
        // built — in order, and after the connect, so a queued `stop` frame
        // tears the call down against a live transport instead of closing
        // one that is about to be opened. The session holds this audio
        // through its own handshake and releases it once the config lands,
        // which is the ordering its module doc requires.
        for (const held of pendingFrames.splice(0)) bridge.handleTwilioFrame(held);
      } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error));
        console.error(`[voice-runtime] call setup failed for ${entry.callSid}:`, err.message);
        if (bridge) {
          bridge.failSession(err);
        } else {
          registry.recordOutcome(entry.callSid, "provider_failure");
          // The registry copy is consumed by the post-stream redirect, so
          // without a durable row the setup failures operators most need
          // to diagnose — lane resolution or agent binding rejecting —
          // would vanish entirely (Codex review, PR #227 round 17).
          // Minimal record, fire-and-forget: failing to log a failure
          // must not block closing the caller's socket.
          void persistCall({
            callSid: entry.callSid,
            streamSid,
            slug: entry.slug,
            callerPhone: entry.callerPhone,
            dialedNumber: entry.dialedNumber,
            outcome: "provider_failure",
            transcript: "",
            toolEvents: [],
            agentTurns: 0,
            interruptions: 0,
            startedAtMs,
            endedAtMs: Date.now(),
          }).catch(() => undefined);
          twilioSocket.close();
        }
      } finally {
        // No bridge means no `onOutcome`, and `onOutcome` holds the only
        // release of this call's brokered transfer. The proving lane
        // registers that entry inside `resolveLane` — the factory runs
        // before this function has a bridge — so every exit above between
        // the factory and the bridge (the caller hanging up during the
        // call-row wait, a transport or binding failure) would strand a
        // closure over a dead leg until the broker's 200-entry cap evicted
        // it (Codex review, PR #237). Keyed by callSid and idempotent, so
        // it is a no-op for the lanes that never registered one.
        if (!bridge) releaseCallHandoff(entry.callSid);
      }
    }
  });

  return registry;
}

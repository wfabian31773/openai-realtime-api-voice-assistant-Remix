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

import { VoiceCallBridge, type CallOutcome } from "./mediaStreamBridge";
import { CallSessionRegistry, type CallEntry } from "./sessionRegistry";
import {
  GrokVoiceSession,
  WebSocketGrokTransport,
  buildSessionConfig,
  type GrokTransport,
} from "./grokSession";
import { resolveLane, defaultLaneSource, type LaneSource } from "./laneRegistry";
import { persistRuntimeCall } from "./callRecord";
import {
  handleAfterRedirect,
  handleVoiceWebhook,
  isValidSlug,
  VOICE_STREAM_PATH,
  type WebhookRequest,
  type WebhookResponse,
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

/** Twilio media frames held while the agent is being built — ~4 seconds of
 * 20ms frames, which is far longer than the build takes. */
const PRE_BRIDGE_FRAME_CAP = 200;

export interface VoiceRuntimeOptions {
  env?: Record<string, string | undefined>;
  /** Overridable so tests never import the agent tree. */
  laneSource?: LaneSource;
  registry?: CallSessionRegistry;
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

  app.get("/voice/health", (_req: Request, res: Response) => {
    const readiness = computeRuntimeReadiness(env);
    res.json({
      marker: VOICE_RUNTIME_DEPLOY_MARKER,
      liveReady: readiness.liveReady,
      // NAMES only. A readiness endpoint that echoes a value is a
      // credential leak with a health check's URL.
      missing: readiness.missing,
      requiredDbEnvVar: readiness.requiredDbEnvVar,
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

  const wss = new WebSocketServer({ noServer: true });

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
      socketGone = true;
      bridge?.handleSocketClosed();
    });
    ws.on("error", () => {
      socketGone = true;
      bridge?.handleSocketClosed();
    });

    async function startCall(entry: CallEntry, streamSid: string): Promise<void> {
      const context = {
        callSid: entry.callSid,
        streamSid,
        slug: entry.slug,
        callerPhone: entry.callerPhone,
        dialedNumber: entry.dialedNumber,
      };
      try {
        const lane = await resolveLane(
          entry.slug,
          {
            callSid: entry.callSid,
            callId: entry.callSid,
            callerPhone: entry.callerPhone,
            dialedNumber: entry.dialedNumber,
          },
          { source: await laneSource(), env },
        );
        if (!lane) {
          // The webhook let this through unseen and it turned out to be
          // unknown or disabled. Closing the socket runs the <Redirect>,
          // whose handler speaks the controlled line.
          console.warn(`[voice-runtime] no available lane for slug ${entry.slug}`);
          registry.recordOutcome(entry.callSid, "provider_failure");
          twilioSocket.close();
          return;
        }
        knownLanes.add(entry.slug);
        if (socketGone) {
          // The caller hung up while the agent was being built. Nothing has
          // been opened yet, so there is nothing to tear down — just record
          // the call and stop before a session exists.
          registry.recordOutcome(entry.callSid, "caller_hangup");
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
          agent: lane.agent,
          twilio: twilioSocket,
          createSession: (handlers) =>
            new GrokVoiceSession(
              transport,
              buildSessionConfig(lane.voice, lane.agent.instructions, lane.agent.tools),
              handlers,
            ),
          onOutcome: (outcome: CallOutcome) => registry.recordOutcome(entry.callSid, outcome),
          persistCallRecord: (record) => persistRuntimeCall(record).then(() => undefined),
        });
        // Connect AFTER the bridge exists: a connection that fails then has
        // somewhere to report to and the call tears down cleanly, instead
        // of leaving the caller on an open socket in silence.
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
          twilioSocket.close();
        }
      }
    }
  });

  return registry;
}

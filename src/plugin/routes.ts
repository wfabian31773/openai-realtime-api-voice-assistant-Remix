/**
 * HTTP surface for /api/plugin/v1.
 *
 * Bearer tokens (si.<jti>.<secret>), scopes, PLUGIN_WRITES_ENABLED off by
 * default. Contact writes require approval and a confirm token; the explicit
 * bot-only calls:direct scope also permits immediate open-line calls.
 */

import type { Express, NextFunction, Request, Response } from "express";
import { hasScope, mintScopesCompatible, type PluginScope } from "./scopes";
import { operatorLineEnabled } from "./operatorLineSettings";
import { isOperatorPayload, operatorFromProblem } from "./operatorLine";
import { pluginWritesEnabled } from "./writesEnabled";
import { parseBearerToken, type VerifiedPluginToken } from "./tokens";
import { verifyStoredToken, publicApproval, approvalForApprover, type ContactApprovalRow, type PluginStore } from "./store";
import {
  approveContact,
  cancelContact,
  consumeConfirmToken,
  markCommitted,
  markFailed,
  markUnknown,
  prepareContact,
  reapStaleSending,
  rejectContact,
} from "./approvals";
import { hashPayload, hashSecret } from "./tokens";
import { createLiveCallSender, placeLiveCall, placeDirectCall, placeOperatorCall, type LiveCallSender } from "./liveCalls";
import { liveCallRegistry, type LiveCallRegistry } from "./liveSessions";
import type { DialerLock } from "../runtime/outbound/scheduler";
import { checkTwilioSignature, type WebhookRequest } from "../runtime/voiceWebhook";
import { agentHealth, emptyFleetReader, listAgents, outboundStatus, type AgentSource, type FleetReader } from "./reads";
import { evaluateAndEnqueueCall, identityFromPreparePayload, siAssistantDialingProblem } from "./callEnqueue";
import { classifyInboundSms, createTwilioSmsSender, handleInboundSms, inboundSmsPreview, sendApprovedSms, type SmsSender } from "./sms";
import { createGraphMail, sendApprovedEmail, type GraphMail } from "./email";
import { createCallbackReporter, type CallbackReporter } from "./callbackReport";
import { flushOutboxRow, persistTakenMessage } from "./messageOutbox";
import type { OutboundStore } from "../runtime/outbound/store";
import { directCallAuditDetails, sanitizeAuditEntry, type PluginAuditEntry, type PluginAuditOutcome } from "./audit";

export interface PluginApiDeps {
  store: PluginStore;
  agents: AgentSource;
  fleet?: FleetReader;
  env?: Record<string, string | undefined>;
  now?: () => Date;
  outboundStore?: OutboundStore;
  smsSender?: SmsSender | null;
  liveCallSender?: LiveCallSender | null;
  liveCalls?: LiveCallRegistry;
  liveCallLock?: DialerLock;
  graphMail?: GraphMail | null;
  callbackReporter?: CallbackReporter | null;
}

type AuthedRequest = Request & { pluginAuth?: VerifiedPluginToken };

const DIRECT_AUDIT_TIMEOUT_MS = 250;

function envOf(deps: PluginApiDeps): Record<string, string | undefined> {
  return deps.env ?? process.env;
}

async function audit(
  deps: PluginApiDeps,
  auth: VerifiedPluginToken | undefined,
  req: Request,
  tool: string,
  outcome: PluginAuditOutcome,
  httpStatus: number,
  extra?: { approvalId?: string | null; ticketId?: string | null; reason?: string },
): Promise<void> {
  const direct = req.route?.path === "/api/plugin/v1/calls/direct";
  if (!auth && !direct) return;
  const entry: PluginAuditEntry = {
    tokenJti: auth?.jti ?? parseBearerToken(req.headers.authorization)?.jti ?? "unauthenticated",
    tool: direct ? "direct_call" : tool,
    route: typeof req.route?.path === "string" ? req.route.path : req.path,
    method: req.method,
    approvalId: extra?.approvalId ?? null,
    ticketId: extra?.ticketId ?? null,
    outcome,
    httpStatus,
    ...(direct ? {
      details: directCallAuditDetails(req.body, extra?.reason ?? tool),
      createdAt: (deps.now ?? (() => new Date()))(),
    } : {}),
  };
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    if (direct) {
      // A stalled audit database must not hold a direct-call response open.
      await Promise.race([
        deps.store.writeAudit(entry),
        new Promise<never>((_, reject) => {
          timeout = setTimeout(() => reject(new Error("audit write timed out")), DIRECT_AUDIT_TIMEOUT_MS);
        }),
      ]);
    } else await deps.store.writeAudit(entry);
  } catch {
    if (direct) {
      // Preserve a PHI-free attempt log even if the audit database is down.
      console.error("[plugin-audit] direct attempt (database unavailable)", {
        ...sanitizeAuditEntry(entry), at: entry.createdAt?.toISOString(),
      });
    } else console.error("[plugin-audit] failed to write audit row");
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

/**
 * What a commit error means for the contact (v115). Set only once the
 * confirm token has been consumed, where the fleet knows: `not_sent` when it
 * marked the request failed and nothing went out, `unknown` when the send may
 * have gone out. A caller classifies on this, never on the HTTP status alone:
 * a 503 "Calls are not being placed" sent nothing, a 502 may have.
 */
type CommitOutcome = "not_sent" | "unknown";

function jsonError(res: Response, status: number, error: string, outcome?: CommitOutcome): void {
  res.status(status).json(outcome ? { error, outcome } : { error });
}

function canAccessApproval(auth: VerifiedPluginToken | undefined, row: ContactApprovalRow): boolean {
  if (!auth) return false;
  if (row.tokenJti === auth.jti) return true;
  return hasScope(auth.scopes, "contacts:approve");
}

function asWebhookRequest(req: Request): WebhookRequest {
  return {
    headers: req.headers as WebhookRequest["headers"],
    body: (req.body ?? {}) as Record<string, string>,
    originalUrl: req.originalUrl,
  };
}

function enqueueHttpStatus(reason: string): number {
  if (reason === "do_not_contact" || reason === "invalid_phone" || reason === "call_already_queued") return 409;
  if (reason === "no_campaign") return 503;
  return 422;
}

export function mountPluginApi(app: Express, deps: PluginApiDeps): void {
  const fleet = deps.fleet ?? emptyFleetReader();
  const liveCalls = deps.liveCalls ?? liveCallRegistry;
  const liveSender = () => deps.liveCallSender === undefined ? createLiveCallSender(envOf(deps)) : deps.liveCallSender;

  const requireAuth = async (req: AuthedRequest, res: Response, next: NextFunction) => {
    const parsed = parseBearerToken(req.headers.authorization);
    if (!parsed) {
      if (req.route?.path === "/api/plugin/v1/calls/direct") await audit(deps, undefined, req, "auth", "denied", 401);
      jsonError(res, 401, "Missing or invalid Bearer token");
      return;
    }
    const auth = await verifyStoredToken(deps.store, parsed, (deps.now ?? (() => new Date()))());
    if (!auth) {
      if (req.route?.path === "/api/plugin/v1/calls/direct") await audit(deps, undefined, req, "auth", "denied", 401);
      jsonError(res, 401, "Invalid, expired, or revoked token");
      return;
    }
    req.pluginAuth = auth;
    next();
  };

  const requireScope = (scope: PluginScope) => (req: AuthedRequest, res: Response, next: NextFunction) => {
    if (!hasScope(req.pluginAuth?.scopes, scope)) {
      void audit(deps, req.pluginAuth, req, "auth", "denied", 403);
      jsonError(res, 403, `Missing required scope: ${scope}`);
      return;
    }
    next();
  };

  const requireWrites = (req: AuthedRequest, res: Response, next: NextFunction) => {
    if (!pluginWritesEnabled(envOf(deps))) {
      void audit(deps, req.pluginAuth, req, "writes", "denied", 403);
      jsonError(res, 403, "Plugin writes are disabled. Set PLUGIN_WRITES_ENABLED=true to enable.");
      return;
    }
    next();
  };

  const v1 = "/api/plugin/v1";

  const requireBot = (req: AuthedRequest, res: Response, next: NextFunction) => {
    if (hasScope(req.pluginAuth?.scopes, "contacts:approve")) { jsonError(res, 403, "This operation is bot-only"); return; }
    next();
  };
  const requireHuman = (req: AuthedRequest, res: Response, next: NextFunction) => {
    if (!mintScopesCompatible(req.pluginAuth!.scopes).ok) { jsonError(res, 403, "Approval requires a human-only token"); return; }
    next();
  };
  const requireCommitScope = (req: AuthedRequest, res: Response, next: NextFunction) => {
    if (hasScope(req.pluginAuth?.scopes, "operator:call")) { next(); return; }
    requireScope("contacts:commit")(req, res, next);
  };

  app.get(`${v1}/operator-line/inbound/:callSid`, requireAuth, requireScope("operator:call"), requireBot, async (req: AuthedRequest, res) => {
    res.setHeader("Cache-Control", "no-store");
    try {
      const record = await deps.store.getOperatorInboundCall(req.params.callSid);
      if (!record || record.laneSlug !== "wayne-operator" || record.direction !== "inbound") {
        jsonError(res, 404, "Operator inbound call not found");
        await audit(deps, req.pluginAuth, req, "operator_inbound_transcript", "denied", 404);
        return;
      }
      res.json({ callId: record.callId, callSid: record.callSid, direction: record.direction, status: record.status,
        startedAt: record.startedAt.toISOString(), endedAt: record.endedAt?.toISOString() ?? null,
        callerNumber: record.callerNumber, queuedRequests: record.queuedRequests, optedOut: record.optedOut,
        transcript: record.turns.map((turn) => ({ role: turn.role, text: turn.text, at: new Date(turn.atMs).toISOString() })) });
      await audit(deps, req.pluginAuth, req, "operator_inbound_transcript", "ok", 200);
    } catch {
      jsonError(res, 503, "Operator inbound storage is unavailable");
      await audit(deps, req.pluginAuth, req, "operator_inbound_transcript", "error", 503);
    }
  });

  for (const kind of ["sms", "voicemail"] as const) {
    const param = kind === "sms" ? "messageSid" : "recordingSid";
    app.get(`${v1}/operator-line/${kind}/:${param}`, requireAuth, requireScope("operator:call"), requireBot, async (req: AuthedRequest, res) => {
      res.setHeader("Cache-Control", "no-store");
      const tool = kind === "sms" ? "operator_inbound_sms" : "operator_inbound_voicemail";
      try {
        const record = kind === "sms" ? await deps.store.getOperatorSms(req.params[param]) : await deps.store.getOperatorVoicemail(req.params[param]);
        if (!record) {
          jsonError(res, 404, "Operator message not found");
          await audit(deps, req.pluginAuth, req, tool, "denied", 404);
          return;
        }
        res.json(record);
        await audit(deps, req.pluginAuth, req, tool, "ok", 200);
      } catch {
        jsonError(res, 503, "Operator message storage is unavailable");
        await audit(deps, req.pluginAuth, req, tool, "error", 503);
      }
    });
  }

  app.post(`${v1}/prepare_operator_call`, requireAuth, requireScope("operator:call"), requireBot, requireWrites, async (req: AuthedRequest, res) => {
    res.setHeader("Cache-Control", "no-store");
    const problem = operatorFromProblem(envOf(deps));
    if (problem) { jsonError(res, 503, problem); return; }
    try {
      if (!(await operatorLineEnabled(envOf(deps), deps.store))) { jsonError(res, 503, "Operator line is disabled"); return; }
      const result = await prepareContact(deps.store, req.pluginAuth!.jti,
        { channel: "call", payload: req.body }, (deps.now ?? (() => new Date()))(), "operator", envOf(deps));
      if (!result.ok) { jsonError(res, result.status, result.error); return; }
      res.status(201).json({ status: result.confirmToken ? "approved" : "pending_approval", approval: publicApproval(result.approval),
        ...(result.confirmToken ? { confirmToken: result.confirmToken, expiresAt: result.approval.confirmExpiresAt?.toISOString() } : {}) });
      await audit(deps, req.pluginAuth, req, "prepare_operator_call", result.confirmToken ? "approved" : "pending_approval", 201, { approvalId: result.approval.id });
    } catch { jsonError(res, 503, "Operator request storage is unavailable"); }
  });

  app.get(`${v1}/calls/:id/transcript`, requireAuth, requireScope("operator:call"), requireBot, async (req: AuthedRequest, res) => {
    res.setHeader("Cache-Control", "no-store");
    const session = liveCalls.owned(req.params.id, req.pluginAuth!.jti);
    if (session?.operatorCall) {
      await liveCalls.persist(session).catch(() => undefined);
      res.json({ sessionId: session.sessionId, ...liveCalls.view(session) });
      return;
    }
    let record;
    try { record = await deps.store.getOperatorCall(req.params.id); }
    catch { jsonError(res, 503, "Operator transcript storage is unavailable"); return; }
    if (!record || record.tokenJti !== req.pluginAuth!.jti) { jsonError(res, 404, "Operator call not found"); return; }
    res.json({ sessionId: record.sessionId, initiated_by: record.initiatedBy, callSid: record.callSid, status: record.status,
      startedAt: record.startedAt.toISOString(), endedAt: record.endedAt?.toISOString() ?? null,
      transcript: record.turns.map((turn) => ({ role: turn.role, text: turn.text, at: new Date(turn.atMs).toISOString() })),
      nextAfter: record.turns.length - 1 });
    await audit(deps, req.pluginAuth, req, "operator_call_transcript", "ok", 200, { approvalId: record.approvalId });
  });

  // Each kind retains its scope, and live controls always check the owner.
  const requireLiveScope = (req: AuthedRequest, res: Response, next: NextFunction) => {
    const owned = liveCalls.owned(req.params.sessionId, req.pluginAuth!.jti);
    if (owned?.operatorCall) {
      if (hasScope(req.pluginAuth?.scopes, "contacts:approve")) { jsonError(res, 403, "This operation is bot-only"); return; }
      requireScope("operator:call")(req, res, next); return;
    }
    if (owned?.directCall && hasScope(req.pluginAuth?.scopes, "calls:direct")) { next(); return; }
    requireScope("contacts:commit")(req, res, next);
  };

  // TODO(Wayne): calling-hours (9 AM–8 PM PT) intentionally not enforced on
  // direct calls per Wayne; revisit.
  app.post(`${v1}/calls/direct`, requireAuth, requireScope("calls:direct"), requireWrites, async (req: AuthedRequest, res) => {
    res.setHeader("Cache-Control", "no-store");
    const refuse = async (status: number, reason: string) => {
      await audit(deps, req.pluginAuth, req, "direct_call", "denied", status, { reason });
      res.status(status).json({ error: reason, reason, outcome: "not_sent" });
    };
    if (hasScope(req.pluginAuth!.scopes, "contacts:approve")) { await refuse(403, "bot_only"); return; }
    const { phone, purpose, name } = req.body ?? {};
    if (typeof phone !== "string" || !/^(?:\d{10}|\+1\d{10})$/.test(phone.trim())) {
      await refuse(400, "phone must be a US 10-digit or +1 E.164 number"); return;
    }
    if (typeof purpose !== "string" || !purpose.trim() || purpose.length > 4000) {
      await refuse(400, "purpose must contain 1 to 4000 characters"); return;
    }
    if (name !== undefined && (typeof name !== "string" || !name.trim() || name.length > 100)) {
      await refuse(400, "name must contain 1 to 100 characters"); return;
    }
    try {
      const sender = liveSender();
      if (!sender || !deps.outboundStore) { await refuse(503, "direct_call_unavailable"); return; }
      const result = await placeDirectCall({
        store: deps.outboundStore, plugin: deps.store, sender, sessions: liveCalls, env: envOf(deps),
      }, { phone: `+1${phone.trim().slice(-10)}`, purpose: purpose.trim(), name: name?.trim(), tokenJti: req.pluginAuth!.jti },
      (deps.now ?? (() => new Date()))());
      if (!result.ok) {
        if (!result.mayHaveSent) { await refuse(result.reason === "do_not_contact" ? 409 : 503, result.reason); return; }
        await audit(deps, req.pluginAuth, req, "direct_call", "unknown", 502, { reason: result.reason });
        res.status(502).json({ error: result.reason, reason: result.reason, outcome: "unknown", sessionId: result.sessionId });
        return;
      }
      res.json({ status: "live", sessionId: result.sessionId, callSid: result.callSid });
      void audit(deps, req.pluginAuth, req, "direct_call", "committed", 200, { reason: "placed" });
    } catch {
      await refuse(503, "direct_call_unavailable");
    }
  });

  app.get(`${v1}/capabilities`, requireAuth, requireScope("fleet:read"), async (req: AuthedRequest, res) => {
    res.json({ liveCalls: true, confirmTokenHandoff: true, smsHoursEnforced: true });
    await audit(deps, req.pluginAuth, req, "capabilities", "ok", 200);
  });

  app.get(`${v1}/contact_requests/:id/confirm_token`, requireAuth, requireCommitScope, async (req: AuthedRequest, res) => {
    res.setHeader("Cache-Control", "no-store");
    const row = await deps.store.getApproval(req.params.id);
    if (!row || row.tokenJti !== req.pluginAuth!.jti) {
      jsonError(res, 404, "Contact request not found");
      await audit(deps, req.pluginAuth, req, "confirm_token", "denied", 404);
      return;
    }
    const needed = isOperatorPayload(row.payload) ? "operator:call" : "contacts:commit";
    if (!hasScope(req.pluginAuth!.scopes, needed) || (isOperatorPayload(row.payload) && hasScope(req.pluginAuth!.scopes, "contacts:approve"))) {
      jsonError(res, 403, `Bot scope ${needed} is required`); return;
    }
    const taken = await deps.store.takeConfirmToken(row.id, req.pluginAuth!.jti, (deps.now ?? (() => new Date()))());
    if (!taken) {
      jsonError(res, 409, "Confirmation token is unavailable, used, or expired");
      await audit(deps, req.pluginAuth, req, "confirm_token", "denied", 409, { approvalId: row.id });
      return;
    }
    res.json({ confirmToken: taken.confirmToken, expiresAt: taken.expiresAt.toISOString() });
    await audit(deps, req.pluginAuth, req, "confirm_token", "ok", 200, { approvalId: row.id });
  });

  app.get(`${v1}/live_calls/:sessionId`, requireAuth, requireLiveScope, requireWrites, async (req: AuthedRequest, res) => {
    res.setHeader("Cache-Control", "no-store");
    const session = liveCalls.owned(req.params.sessionId, req.pluginAuth!.jti);
    if (!session) { jsonError(res, 404, "Live call not found"); return; }
    const after = req.query.after === undefined ? -1 : Number(req.query.after);
    if (!Number.isSafeInteger(after) || after < -1) { jsonError(res, 400, "after must be a turn index"); return; }
    res.json(liveCalls.view(session, after));
    await audit(deps, req.pluginAuth, req, "live_call_status", "ok", 200, { approvalId: session.approvalId });
  });

  app.post(`${v1}/live_calls/:sessionId/instruct`, requireAuth, requireLiveScope, requireWrites, async (req: AuthedRequest, res) => {
    const session = liveCalls.owned(req.params.sessionId, req.pluginAuth!.jti);
    if (!session) { jsonError(res, 404, "Live call not found"); return; }
    const text = req.body?.text;
    if (typeof text !== "string" || !text.trim() || text.length > 2000) {
      jsonError(res, 400, "text must contain 1 to 2000 characters"); return;
    }
    if (!session.controls || session.endedAt) { jsonError(res, 409, "Live session is not running"); return; }
    try { session.controls.instruct(text); }
    catch { jsonError(res, 502, "Could not deliver guidance"); return; }
    res.json({ status: "instructed" });
    await audit(deps, req.pluginAuth, req, "live_call_instruct", "ok", 200, { approvalId: session.approvalId });
  });

  app.post(`${v1}/live_calls/:sessionId/end`, requireAuth, requireLiveScope, requireWrites, async (req: AuthedRequest, res) => {
    const session = liveCalls.owned(req.params.sessionId, req.pluginAuth!.jti);
    if (!session) { jsonError(res, 404, "Live call not found"); return; }
    if (!session.endedAt) {
      const sender = liveSender();
      if (!sender || !session.callSid) { jsonError(res, 503, "Call control is unavailable"); return; }
      try { await sender.endCall(session.callSid); }
      catch { jsonError(res, 502, "Could not end the call"); return; }
      const end = session.controls?.end;
      end?.();
      liveCalls.setStatus(session.sessionId, "completed");
    }
    res.json({ status: session.status });
    await audit(deps, req.pluginAuth, req, "live_call_end", "ok", 200, { approvalId: session.approvalId });
  });

  app.post(`${v1}/commit_call_live`, requireAuth, requireCommitScope, requireWrites, async (req: AuthedRequest, res) => {
    const confirmToken = typeof req.body?.confirmToken === "string" ? req.body.confirmToken : "";
    const now = (deps.now ?? (() => new Date()))();
    // A live call and its controls belong only to the bot that prepared it.
    // Check immutable owner/channel before consuming another kind of approval.
    if (/^[a-f0-9]{64}$/.test(confirmToken)) {
      const row = await deps.store.findApprovalByConfirmHash(hashSecret(confirmToken));
      if (row && row.tokenJti !== req.pluginAuth!.jti) {
        jsonError(res, 404, "Contact request not found");
        await audit(deps, req.pluginAuth, req, "commit_call_live", "denied", 404);
        return;
      }
      if (row && row.channel !== "call") {
        jsonError(res, 400, "A call approval is required");
        await audit(deps, req.pluginAuth, req, "commit_call_live", "denied", 400);
        return;
      }
      if (row) {
        const operator = isOperatorPayload(row.payload);
        const needed = operator ? "operator:call" : "contacts:commit";
        if (!hasScope(req.pluginAuth!.scopes, needed) || (operator && hasScope(req.pluginAuth!.scopes, "contacts:approve"))) {
          jsonError(res, 403, `Bot scope ${needed} is required`); return;
        }
        if (operator) {
          if (!(await operatorLineEnabled(envOf(deps), deps.store))) { jsonError(res, 503, "Operator line is disabled"); return; }
          const problem = operatorFromProblem(envOf(deps));
          if (problem) { jsonError(res, 503, problem); return; }
        }
      }
    }
    const consumed = await consumeConfirmToken(deps.store, confirmToken, now);
    if (!consumed.ok) {
      jsonError(res, consumed.status, consumed.error);
      await audit(deps, req.pluginAuth, req, "commit_call_live", "denied", consumed.status);
      return;
    }
    const row = consumed.approval;
    const operator = isOperatorPayload(row.payload);
    const extra = { approvalId: row.id, ticketId: row.ticketId };
    let mayHaveSent = false;
    let sessionId: string | undefined;
    try {
      let reason: string | null = hashPayload(row.payload) !== row.payloadHash ? "payload_hash_mismatch" : null;
      const sender = liveSender();
      if (!reason && !deps.outboundStore) reason = "no_outbound_store";
      if (!reason && !sender) reason = "no_twilio";
      if (!reason) {
        const result = operator ? await placeOperatorCall({
          store: deps.outboundStore!, plugin: deps.store, sender: sender!, sessions: liveCalls, env: envOf(deps),
        }, row, now) : await placeLiveCall({
          store: deps.outboundStore!, sender: sender!, sessions: liveCalls, env: envOf(deps), lock: deps.liveCallLock,
        }, row, now);
        if (operator) sessionId = result.sessionId;
        if (result.ok) {
          mayHaveSent = true;
          const approval = await markCommitted(deps.store, row.id, { callSid: result.callSid, sessionId: result.sessionId, live: true }, now);
          if (!approval) throw new Error("commit_failed");
          res.json({ status: "live", approval: publicApproval(approval), callSid: result.callSid, sessionId: result.sessionId });
          await audit(deps, req.pluginAuth, req, "commit_call_live", "committed", 200, extra);
          return;
        }
        reason = result.reason;
        mayHaveSent = result.mayHaveSent;
      }
      const refusalStatus = operator ? (reason === "do_not_contact" ? 409 : 503) : enqueueHttpStatus(reason!);
      const status = mayHaveSent ? 502 : reason === "payload_hash_mismatch" ? 409 : refusalStatus;
      if (mayHaveSent) await markUnknown(deps.store, row.id, { reason, ...(sessionId ? { sessionId } : {}) }, now);
      else await markFailed(deps.store, row.id, { reason }, now);
      res.status(status).json({ error: mayHaveSent ? "Call outcome is unknown" : `Call was not placed: ${reason}`,
        outcome: mayHaveSent ? "unknown" : "not_sent", ...(sessionId ? { sessionId } : {}) });
      await audit(deps, req.pluginAuth, req, "commit_call_live", mayHaveSent ? "unknown" : "failed", status, extra);
    } catch {
      const outcome = mayHaveSent ? "unknown" : "not_sent";
      const mark = mayHaveSent ? markUnknown : markFailed;
      await mark(deps.store, row.id, { reason: mayHaveSent ? "send_unknown" : "live_call_unavailable", ...(sessionId ? { sessionId } : {}) }, now).catch(() => null);
      res.status(mayHaveSent ? 502 : 503).json({ error: "Live call could not be completed", outcome, ...(sessionId ? { sessionId } : {}) });
      await audit(deps, req.pluginAuth, req, "commit_call_live", mayHaveSent ? "unknown" : "failed", mayHaveSent ? 502 : 503, extra);
    }
  });

  app.get(`${v1}/health`, requireAuth, requireScope("fleet:read"), async (req: AuthedRequest, res) => {
    res.json({ ok: true, ...agentHealth(envOf(deps)) });
    await audit(deps, req.pluginAuth, req, "health", "ok", 200);
  });

  app.get(`${v1}/list_agents`, requireAuth, requireScope("fleet:read"), async (req: AuthedRequest, res) => {
    res.json({ agents: listAgents(deps.agents) });
    await audit(deps, req.pluginAuth, req, "list_agents", "ok", 200);
  });

  app.get(`${v1}/agent_health`, requireAuth, requireScope("fleet:read"), async (req: AuthedRequest, res) => {
    res.json(agentHealth(envOf(deps)));
    await audit(deps, req.pluginAuth, req, "agent_health", "ok", 200);
  });

  app.get(`${v1}/fleet_today`, requireAuth, requireScope("fleet:read"), async (req: AuthedRequest, res) => {
    const day = typeof req.query.day === "string" ? req.query.day : new Date().toISOString().slice(0, 10);
    const rows = await fleet.fleetToday(day);
    res.json({ day, lanes: rows });
    await audit(deps, req.pluginAuth, req, "fleet_today", "ok", 200);
  });

  app.get(`${v1}/recent_outcomes`, requireAuth, requireScope("fleet:read"), async (req: AuthedRequest, res) => {
    const limit = Math.min(50, Math.max(1, Number(req.query.limit) || 20));
    res.json({ outcomes: await fleet.recentOutcomes(limit) });
    await audit(deps, req.pluginAuth, req, "recent_outcomes", "ok", 200);
  });

  app.get(`${v1}/outbound_status`, requireAuth, requireScope("fleet:read"), async (req: AuthedRequest, res) => {
    const queued = await fleet.outboundQueued("si-assistant");
    res.json(outboundStatus(envOf(deps), queued));
    await audit(deps, req.pluginAuth, req, "outbound_status", "ok", 200);
  });

  app.get(`${v1}/get_contact_request`, requireAuth, requireScope("fleet:read"), async (req: AuthedRequest, res) => {
    const id = typeof req.query.id === "string" ? req.query.id : "";
    const row = id ? await deps.store.getApproval(id) : null;
    if (!row || !canAccessApproval(req.pluginAuth, row)) {
      jsonError(res, 404, "Contact request not found");
      await audit(deps, req.pluginAuth, req, "get_contact_request", "error", 404);
      return;
    }
    const view = hasScope(req.pluginAuth?.scopes, "contacts:approve")
      ? approvalForApprover(row)
      : publicApproval(row);
    res.json(view);
    await audit(deps, req.pluginAuth, req, "get_contact_request", "ok", 200, {
      approvalId: row.id,
      ticketId: row.ticketId,
    });
  });

  app.get(`${v1}/email_replies`, requireAuth, requireScope("fleet:read"), async (req: AuthedRequest, res) => {
    const mail = deps.graphMail ?? createGraphMail(envOf(deps));
    if (!mail) {
      jsonError(res, 503, "Microsoft Graph is not configured");
      await audit(deps, req.pluginAuth, req, "email_replies", "error", 503);
      return;
    }
    try {
      const replies = await mail.listReplies({ top: 20 });
      const reveal = hasScope(req.pluginAuth?.scopes, "contacts:approve");
      res.json({
        replies: replies.map((r) => ({
          id: r.id,
          receivedAt: r.receivedAt,
          conversationId: r.conversationId,
          ...(reveal ? { from: r.from, subject: r.subject } : {}),
        })),
      });
      await audit(deps, req.pluginAuth, req, "email_replies", "ok", 200);
    } catch {
      jsonError(res, 502, "Could not list email replies");
      await audit(deps, req.pluginAuth, req, "email_replies", "error", 502);
    }
  });

  const prepare = (channel: "call" | "sms" | "email") => async (req: AuthedRequest, res: Response) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const result = await prepareContact(
      deps.store,
      req.pluginAuth!.jti,
      { channel, payload: body as never },
      (deps.now ?? (() => new Date()))(),
    );
    if (!result.ok) {
      jsonError(res, result.status, result.error);
      await audit(deps, req.pluginAuth, req, `prepare_${channel}`, "error", result.status);
      return;
    }
    res.status(201).json({
      status: "pending_approval",
      approval: publicApproval(result.approval),
    });
    await audit(deps, req.pluginAuth, req, `prepare_${channel}`, "pending_approval", 201, {
      approvalId: result.approval.id,
      ticketId: result.approval.ticketId,
    });
  };

  app.post(`${v1}/prepare_call`, requireAuth, requireScope("contacts:prepare"), requireWrites, prepare("call"));
  app.post(`${v1}/prepare_sms`, requireAuth, requireScope("contacts:prepare"), requireWrites, prepare("sms"));
  app.post(`${v1}/prepare_email`, requireAuth, requireScope("contacts:prepare"), requireWrites, prepare("email"));

  app.post(`${v1}/cancel_contact`, requireAuth, requireScope("contacts:prepare"), requireWrites, async (req: AuthedRequest, res) => {
    const id = String((req.body as { id?: string })?.id ?? "");
    const existing = id ? await deps.store.getApproval(id) : null;
    if (!existing || !canAccessApproval(req.pluginAuth, existing)) {
      jsonError(res, 404, "Contact request not found");
      await audit(deps, req.pluginAuth, req, "cancel_contact", "error", 404, { approvalId: id });
      return;
    }
    const result = await cancelContact(deps.store, id, (deps.now ?? (() => new Date()))());
    if (!result.ok) {
      jsonError(res, result.status, result.error);
      await audit(deps, req.pluginAuth, req, "cancel_contact", "error", result.status, { approvalId: id });
      return;
    }
    res.json({ status: "cancelled", approval: publicApproval(result.approval) });
    await audit(deps, req.pluginAuth, req, "cancel_contact", "cancelled", 200, {
      approvalId: result.approval.id,
      ticketId: result.approval.ticketId,
    });
  });

  app.get(`${v1}/approvals`, requireAuth, requireScope("contacts:approve"), async (req: AuthedRequest, res) => {
    const status = typeof req.query.status === "string" ? req.query.status : "pending";
    const rows = await deps.store.listApprovals(status as never);
    res.json({ approvals: rows.map(approvalForApprover) });
    await audit(deps, req.pluginAuth, req, "list_approvals", "ok", 200);
  });

  app.post(`${v1}/approvals/:id/approve`, requireAuth, requireScope("contacts:approve"), requireHuman, requireWrites, async (req: AuthedRequest, res) => {
    res.setHeader("Cache-Control", "no-store");
    const payloadHash = String((req.body as { payloadHash?: string } | undefined)?.payloadHash ?? "");
    const result = await approveContact(
      deps.store,
      req.params.id,
      req.pluginAuth!.jti,
      (deps.now ?? (() => new Date()))(),
      payloadHash,
    );
    if (!result.ok) {
      jsonError(res, result.status, result.error);
      await audit(deps, req.pluginAuth, req, "approve_contact", "error", result.status, { approvalId: req.params.id });
      return;
    }
    res.json({
      status: "approved",
      confirmToken: result.confirmToken,
      expiresAt: result.approval.confirmExpiresAt?.toISOString() ?? null,
      approval: approvalForApprover(result.approval),
    });
    await audit(deps, req.pluginAuth, req, "approve_contact", "approved", 200, {
      approvalId: result.approval.id,
      ticketId: result.approval.ticketId,
    });
  });

  app.post(`${v1}/approvals/:id/reject`, requireAuth, requireScope("contacts:approve"), requireWrites, async (req: AuthedRequest, res) => {
    const result = await rejectContact(
      deps.store,
      req.params.id,
      req.pluginAuth!.jti,
      (deps.now ?? (() => new Date()))(),
    );
    if (!result.ok) {
      jsonError(res, result.status, result.error);
      await audit(deps, req.pluginAuth, req, "reject_contact", "error", result.status, { approvalId: req.params.id });
      return;
    }
    res.json({ status: "rejected", approval: publicApproval(result.approval) });
    await audit(deps, req.pluginAuth, req, "reject_contact", "rejected", 200, {
      approvalId: result.approval.id,
      ticketId: result.approval.ticketId,
    });
  });

  app.post(`${v1}/commit_contact`, requireAuth, requireScope("contacts:commit"), requireWrites, async (req: AuthedRequest, res) => {
    const confirmToken = String((req.body as { confirmToken?: string })?.confirmToken ?? "");
    const requested = /^[a-f0-9]{64}$/.test(confirmToken) ? await deps.store.findApprovalByConfirmHash(hashSecret(confirmToken)) : null;
    if (requested && isOperatorPayload(requested.payload)) {
      jsonError(res, 400, "Operator calls require the preparing bot and commit_call_live"); return;
    }
    const now = (deps.now ?? (() => new Date()))();
    try {
      await reapStaleSending(deps.store, now);
    } catch {
      console.error("[plugin] stale-send sweep failed");
    }
    const consumed = await consumeConfirmToken(deps.store, confirmToken, now);
    if (!consumed.ok) {
      jsonError(res, consumed.status, consumed.error);
      await audit(deps, req.pluginAuth, req, "commit_contact", "denied", consumed.status);
      return;
    }

    if (hashPayload(consumed.approval.payload) !== consumed.approval.payloadHash) {
      await markFailed(deps.store, consumed.approval.id, { reason: "payload_hash_mismatch" }, now);
      jsonError(res, 409, "Approved payload no longer matches the locked hash", "not_sent");
      await audit(deps, req.pluginAuth, req, "commit_contact", "error", 409, {
        approvalId: consumed.approval.id,
        ticketId: consumed.approval.ticketId,
      });
      return;
    }

    let executed: Awaited<ReturnType<typeof executeApproved>>;
    try {
      executed = await executeApproved(deps, consumed.approval, now);
    } catch {
      // Timeout / throw after the send may already have gone out.
      await markUnknown(deps.store, consumed.approval.id, { reason: "send_unknown" }, now);
      jsonError(res, 502, "The send outcome is unknown", "unknown");
      await audit(deps, req.pluginAuth, req, "commit_contact", "unknown", 502, {
        approvalId: consumed.approval.id,
        ticketId: consumed.approval.ticketId,
      });
      return;
    }
    if (!executed.ok) {
      if (executed.reason === "unknown") {
        await markUnknown(deps.store, consumed.approval.id, { reason: "unknown" }, now);
        jsonError(res, executed.status, executed.error, "unknown");
        await audit(deps, req.pluginAuth, req, "commit_contact", "unknown", executed.status, {
          approvalId: consumed.approval.id,
          ticketId: consumed.approval.ticketId,
        });
        return;
      }
      await markFailed(deps.store, consumed.approval.id, { reason: executed.reason }, now);
      jsonError(res, executed.status, executed.error, "not_sent");
      await audit(deps, req.pluginAuth, req, "commit_contact", "failed", executed.status, {
        approvalId: consumed.approval.id,
        ticketId: consumed.approval.ticketId,
      });
      return;
    }
    res.json({
      status: "committed",
      approval: publicApproval(executed.approval),
      result: executed.result,
    });
    await audit(deps, req.pluginAuth, req, "commit_contact", "committed", 200, {
      approvalId: consumed.approval.id,
      ticketId: consumed.approval.ticketId,
    });
  });

  app.post(`${v1}/webhooks/twilio-sms`, async (req, res) => {
    const sig = checkTwilioSignature(asWebhookRequest(req), envOf(deps));
    if (sig === "no_auth_token") {
      // Fail closed: do not honour STOP/START. 200 empty TwiML so Twilio
      // does not treat this as a 5xx and retry.
      res.type("text/xml").status(200).send("<Response></Response>");
      return;
    }
    if (sig === "invalid") {
      res.status(403).type("text/plain").send("invalid signature");
      return;
    }
    const body = (req.body ?? {}) as { From?: string; Body?: string; MessageSid?: string };
    const from = String(body.From ?? "");
    const text = String(body.Body ?? "");
    const sender = deps.smsSender === undefined ? createTwilioSmsSender(envOf(deps)) : deps.smsSender;
    let handled: Awaited<ReturnType<typeof handleInboundSms>>;
    try {
      handled = await handleInboundSms(deps.store, sender, { from, body: text }, envOf(deps));
    } catch {
      // Twilio does not retry a messaging webhook, so a 500 would lose this
      // text as surely as a 200. Say so loudly, without the phone or body,
      // and answer 200 (v115).
      console.error(`[si-assistant] inbound sms (${classifyInboundSms(text)}) could not be handled; it may not have been recorded`);
      res.type("text/xml").status(200).send("<Response></Response>");
      return;
    }
    const reporter = deps.callbackReporter ?? createCallbackReporter(envOf(deps));
    if (handled.command === "other") {
      const preview = inboundSmsPreview(text);
      if (preview) {
        const now = deps.now?.() ?? new Date();
        // Sender and MessageSid ride on the row and the webhook payload, never
        // in a log. Keyed on the MessageSid so a Twilio retry is one row.
        const row = await persistTakenMessage(
          {
            message: preview,
            fromPhone: from || null,
            messageSid: String(body.MessageSid ?? "") || null,
            inboundSms: true,
          },
          now,
          deps.store,
        );
        if (row) {
          void flushOutboxRow(row, deps.store, reporter, now).catch(() => {
            console.error("[si-assistant] inbound sms outbox flush failed");
          });
        }
      }
    }
    res.type("text/xml").send("<Response></Response>");
  });
}

async function executeApproved(
  deps: PluginApiDeps,
  approval: Awaited<ReturnType<PluginStore["getApproval"]> & object>,
  now: Date,
): Promise<
  | { ok: true; result: Record<string, unknown>; approval: NonNullable<typeof approval> }
  | { ok: false; status: number; error: string; reason: string }
> {
  if (!approval) return { ok: false, status: 404, error: "Contact request not found", reason: "missing" };

  let heartbeat: Awaited<ReturnType<PluginStore["updateApproval"]>>;
  try {
    heartbeat = await deps.store.updateApproval(approval.id, { updatedAt: now }, "sending");
  } catch {
    return { ok: false, status: 500, error: "Contact request could not be marked sending", reason: "heartbeat_failed" };
  }
  if (!heartbeat) {
    return { ok: false, status: 409, error: "Contact request is no longer sending", reason: "not_sending" };
  }

  if (approval.channel === "call") {
    if (!deps.outboundStore) {
      return { ok: false, status: 503, error: "Outbound store is not configured", reason: "no_outbound_store" };
    }
    // Nothing would dial it: refuse, so the approval fails visibly instead of
    // reading as a queued call that never rings (v115).
    const dialing = siAssistantDialingProblem(envOf(deps));
    if (dialing) {
      return { ok: false, status: 503, error: `Calls are not being placed: ${dialing}`, reason: dialing };
    }
    const identity = identityFromPreparePayload(approval.payload);
    const queued = await evaluateAndEnqueueCall(
      deps.outboundStore,
      {
        approvalId: approval.id,
        phone: String(approval.payload.phone ?? ""),
        firstName: identity.firstName,
        lastName: identity.lastName,
        dateOfBirth: identity.dateOfBirth,
        ticketNumber: approval.ticketNumber,
        ticketId: approval.ticketId,
        purpose: typeof approval.payload.purpose === "string" ? approval.payload.purpose : null,
      },
      now,
    );
    if (!queued.ok) {
      const status = enqueueHttpStatus(queued.reason);
      return { ok: false, status, error: `Call was not placed: ${queued.reason}`, reason: queued.reason };
    }
    return commitSend(deps, approval, { queued: true, campaignId: queued.campaignId }, now);
  }

  if (approval.channel === "sms") {
    const sender = deps.smsSender === undefined ? createTwilioSmsSender(envOf(deps)) : deps.smsSender;
    if (!sender) return { ok: false, status: 503, error: "SMS sender is not configured", reason: "no_sms" };
    const sent = await sendApprovedSms(
      deps.store,
      sender,
      { phone: String(approval.payload.phone ?? ""), body: String(approval.payload.body ?? "") },
      envOf(deps),
      now,
    );
    if (!sent.ok) {
      if (sent.mayHaveSent) {
        return { ok: false, status: 502, error: `SMS outcome is unknown: ${sent.reason}`, reason: "unknown" };
      }
      return { ok: false, status: 409, error: `SMS was not sent: ${sent.reason}`, reason: sent.reason };
    }
    return commitSend(deps, approval, { messageSid: sent.sid }, now);
  }

  const mail = deps.graphMail === undefined ? createGraphMail(envOf(deps)) : deps.graphMail;
  if (!mail) return { ok: false, status: 503, error: "Microsoft Graph is not configured", reason: "no_graph" };
  const sent = await sendApprovedEmail(mail, {
    to: String(approval.payload.to ?? ""),
    subject: String(approval.payload.subject ?? ""),
    body: String(approval.payload.body ?? ""),
  });
  if (!sent.ok) {
    if (sent.mayHaveSent) {
      return { ok: false, status: 502, error: `Email outcome is unknown: ${sent.reason}`, reason: "unknown" };
    }
    return { ok: false, status: 409, error: `Email was not sent: ${sent.reason}`, reason: sent.reason };
  }
  return commitSend(deps, approval, { messageId: sent.id }, now);
}

async function commitSend(
  deps: PluginApiDeps,
  approval: NonNullable<Awaited<ReturnType<PluginStore["getApproval"]>>>,
  result: Record<string, unknown>,
  now: Date,
): Promise<
  | { ok: true; result: Record<string, unknown>; approval: NonNullable<Awaited<ReturnType<PluginStore["getApproval"]>>> }
  | { ok: false; status: number; error: string; reason: string }
> {
  const committed = await markCommitted(deps.store, approval.id, result, now);
  if (!committed) {
    return { ok: false, status: 409, error: "Contact request outcome is unknown", reason: "unknown" };
  }
  return { ok: true, result, approval: committed };
}

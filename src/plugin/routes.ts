/**
 * HTTP surface for /api/plugin/v1.
 *
 * Bearer tokens (si.<jti>.<secret>), scopes, PLUGIN_WRITES_ENABLED off by
 * default. Writes create a pending contact_approvals row; nothing is sent
 * until a human approves it and commit_contact consumes the 5-minute token.
 */

import type { Express, NextFunction, Request, Response } from "express";
import { hasScope, type PluginScope } from "./scopes";
import { pluginWritesEnabled } from "./writesEnabled";
import { parseBearerToken, type VerifiedPluginToken } from "./tokens";
import { verifyStoredToken, publicApproval, approvalForApprover, type ContactApprovalRow, type PluginStore } from "./store";
import {
  approveContact,
  cancelContact,
  consumeConfirmToken,
  markCommitted,
  markFailed,
  prepareContact,
  rejectContact,
} from "./approvals";
import { hashPayload } from "./tokens";
import { checkTwilioSignature, type WebhookRequest } from "../runtime/voiceWebhook";
import { agentHealth, emptyFleetReader, listAgents, outboundStatus, type AgentSource, type FleetReader } from "./reads";
import { evaluateAndEnqueueCall } from "./callEnqueue";
import { createTwilioSmsSender, handleInboundSms, sendApprovedSms, type SmsSender } from "./sms";
import { createGraphMail, sendApprovedEmail, type GraphMail } from "./email";
import { createCallbackReporter, type CallbackReporter } from "./callbackReport";
import type { OutboundStore } from "../runtime/outbound/store";
import type { PluginAuditOutcome } from "./audit";

export interface PluginApiDeps {
  store: PluginStore;
  agents: AgentSource;
  fleet?: FleetReader;
  env?: Record<string, string | undefined>;
  now?: () => Date;
  outboundStore?: OutboundStore;
  smsSender?: SmsSender | null;
  graphMail?: GraphMail | null;
  callbackReporter?: CallbackReporter | null;
}

type AuthedRequest = Request & { pluginAuth?: VerifiedPluginToken };

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
  extra?: { approvalId?: string | null; ticketId?: string | null },
): Promise<void> {
  if (!auth) return;
  try {
    await deps.store.writeAudit({
      tokenJti: auth.jti,
      tool,
      route: req.path,
      method: req.method,
      approvalId: extra?.approvalId ?? null,
      ticketId: extra?.ticketId ?? null,
      outcome,
      httpStatus,
    });
  } catch {
    console.error("[plugin-audit] failed to write audit row");
  }
}

function jsonError(res: Response, status: number, error: string): void {
  res.status(status).json({ error });
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
  if (reason === "do_not_contact" || reason === "invalid_phone") return 409;
  if (reason === "no_campaign") return 503;
  return 422;
}

export function mountPluginApi(app: Express, deps: PluginApiDeps): void {
  const fleet = deps.fleet ?? emptyFleetReader();

  const requireAuth = async (req: AuthedRequest, res: Response, next: NextFunction) => {
    const parsed = parseBearerToken(req.headers.authorization);
    if (!parsed) {
      jsonError(res, 401, "Missing or invalid Bearer token");
      return;
    }
    const auth = await verifyStoredToken(deps.store, parsed, (deps.now ?? (() => new Date()))());
    if (!auth) {
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

  app.post(`${v1}/approvals/:id/approve`, requireAuth, requireScope("contacts:approve"), requireWrites, async (req: AuthedRequest, res) => {
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
    const now = (deps.now ?? (() => new Date()))();
    const consumed = await consumeConfirmToken(deps.store, confirmToken, now);
    if (!consumed.ok) {
      jsonError(res, consumed.status, consumed.error);
      await audit(deps, req.pluginAuth, req, "commit_contact", "denied", consumed.status);
      return;
    }

    if (hashPayload(consumed.approval.payload) !== consumed.approval.payloadHash) {
      await markFailed(deps.store, consumed.approval.id, { reason: "payload_hash_mismatch" }, now);
      jsonError(res, 409, "Approved payload no longer matches the locked hash");
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
      await markFailed(deps.store, consumed.approval.id, { reason: "send_failed" }, now);
      jsonError(res, 502, "The send failed");
      await audit(deps, req.pluginAuth, req, "commit_contact", "failed", 502, {
        approvalId: consumed.approval.id,
        ticketId: consumed.approval.ticketId,
      });
      return;
    }
    if (!executed.ok) {
      await markFailed(deps.store, consumed.approval.id, { reason: executed.reason }, now);
      jsonError(res, executed.status, executed.error);
      await audit(deps, req.pluginAuth, req, "commit_contact", "failed", executed.status, {
        approvalId: consumed.approval.id,
        ticketId: consumed.approval.ticketId,
      });
      return;
    }
    const committed = await markCommitted(deps.store, consumed.approval.id, executed.result, now);
    if (!committed) {
      jsonError(res, 409, "Contact request is no longer approved");
      await audit(deps, req.pluginAuth, req, "commit_contact", "error", 409, {
        approvalId: consumed.approval.id,
        ticketId: consumed.approval.ticketId,
      });
      return;
    }
    res.json({
      status: "committed",
      approval: publicApproval(committed ?? consumed.approval),
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
    const body = (req.body ?? {}) as { From?: string; Body?: string };
    const from = String(body.From ?? "");
    const text = String(body.Body ?? "");
    const sender = deps.smsSender === undefined ? createTwilioSmsSender(envOf(deps)) : deps.smsSender;
    const handled = await handleInboundSms(deps.store, sender, { from, body: text }, envOf(deps));
    const reporter = deps.callbackReporter ?? createCallbackReporter(envOf(deps));
    if (handled.command === "other" && reporter) {
      void reporter.report({
        event: "inbound_sms",
        slug: "si-assistant",
        smsCommand: handled.command,
      });
    }
    res.type("text/xml").send("<Response></Response>");
  });
}

async function executeApproved(
  deps: PluginApiDeps,
  approval: Awaited<ReturnType<PluginStore["getApproval"]> & object>,
  now: Date,
): Promise<
  | { ok: true; result: Record<string, unknown> }
  | { ok: false; status: number; error: string; reason: string }
> {
  if (!approval) return { ok: false, status: 404, error: "Contact request not found", reason: "missing" };

  if (approval.channel === "call") {
    if (!deps.outboundStore) {
      return { ok: false, status: 503, error: "Outbound store is not configured", reason: "no_outbound_store" };
    }
    const queued = await evaluateAndEnqueueCall(
      deps.outboundStore,
      {
        approvalId: approval.id,
        phone: String(approval.payload.phone ?? ""),
        firstName: typeof approval.payload.firstName === "string" ? approval.payload.firstName : null,
        lastName: typeof approval.payload.lastName === "string" ? approval.payload.lastName : null,
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
    return { ok: true, result: { queued: true, campaignId: queued.campaignId } };
  }

  if (approval.channel === "sms") {
    const sender = deps.smsSender === undefined ? createTwilioSmsSender(envOf(deps)) : deps.smsSender;
    if (!sender) return { ok: false, status: 503, error: "SMS sender is not configured", reason: "no_sms" };
    const sent = await sendApprovedSms(
      deps.store,
      sender,
      { phone: String(approval.payload.phone ?? ""), body: String(approval.payload.body ?? "") },
      envOf(deps),
    );
    if (!sent.ok) return { ok: false, status: 409, error: `SMS was not sent: ${sent.reason}`, reason: sent.reason };
    return { ok: true, result: { messageSid: sent.sid } };
  }

  const mail = deps.graphMail === undefined ? createGraphMail(envOf(deps)) : deps.graphMail;
  if (!mail) return { ok: false, status: 503, error: "Microsoft Graph is not configured", reason: "no_graph" };
  const sent = await sendApprovedEmail(mail, {
    to: String(approval.payload.to ?? ""),
    subject: String(approval.payload.subject ?? ""),
    body: String(approval.payload.body ?? ""),
  });
  if (!sent.ok) return { ok: false, status: 409, error: `Email was not sent: ${sent.reason}`, reason: sent.reason };
  return { ok: true, result: { messageId: sent.id } };
}

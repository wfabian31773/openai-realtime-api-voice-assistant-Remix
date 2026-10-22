/**
 * SI Assistant email via Microsoft Graph sendMail, from
 * SI_ASSISTANT_EMAIL (default Support-Assistant@azulvision.com).
 *
 * App-only client credentials: SI_MAIL_TENANT_ID, SI_MAIL_CLIENT_ID,
 * SI_MAIL_CLIENT_SECRET. The Entra app is scoped through Exchange RBAC for
 * Applications to that one mailbox. Tests inject a mock GraphMail. The
 * client id is never hardcoded — set it in env.
 */

import {
  SI_MAIL_CLIENT_ID_ENV,
  SI_MAIL_CLIENT_SECRET_ENV,
  SI_MAIL_TENANT_ENV,
  emailIdentifiedBody,
  graphMailConfigured,
  siAssistantEmail,
} from "./siAssistantConstants";
import { SendOutcomeError, failureFromUnknown, type SendFailure } from "./sendFailure";

export interface GraphMail {
  sendMail(input: { to: string; subject: string; body: string }): Promise<{ id: string }>;
  listReplies(input?: { top?: number }): Promise<EmailReply[]>;
}

export interface EmailReply {
  id: string;
  receivedAt: string;
  conversationId?: string;
  /** Present for the authenticated plugin caller (BAA). Never written to audit. */
  from?: string;
  subject?: string;
}

export interface TokenSource {
  getToken(): Promise<string>;
}

export async function sendApprovedEmail(
  mail: GraphMail,
  input: { to: string; subject: string; body: string },
): Promise<{ ok: true; id: string } | SendFailure> {
  const to = input.to.trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) return { ok: false, reason: "invalid_email", mayHaveSent: false };
  try {
    const sent = await mail.sendMail({
      to,
      subject: input.subject.trim(),
      body: emailIdentifiedBody(input.body),
    });
    return { ok: true, id: sent.id };
  } catch (err) {
    return failureFromUnknown(err);
  }
}

export function createMemoryGraphMail(): GraphMail & { sent: Array<{ to: string; subject: string; body: string; id: string }> } {
  const sent: Array<{ to: string; subject: string; body: string; id: string }> = [];
  const inbox: EmailReply[] = [];
  return {
    sent,
    async sendMail(input) {
      const id = `mem-mail-${sent.length + 1}`;
      sent.push({ ...input, id });
      return { id };
    },
    async listReplies(input) {
      return inbox.slice(0, input?.top ?? 20);
    },
  };
}

export const GRAPH_TIMEOUT_MS = 15_000;

async function timedFetch(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit = {},
  timeoutMs = GRAPH_TIMEOUT_MS,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

export function createGraphMail(
  env: Record<string, string | undefined> = process.env,
  fetchImpl: typeof fetch = fetch,
): GraphMail | null {
  if (!graphMailConfigured(env)) return null;
  const tenant = env[SI_MAIL_TENANT_ENV]!.trim();
  const clientId = env[SI_MAIL_CLIENT_ID_ENV]!.trim();
  const clientSecret = env[SI_MAIL_CLIENT_SECRET_ENV]!.trim();
  const mailbox = siAssistantEmail(env);

  let cached: { token: string; exp: number } | null = null;

  async function token(): Promise<string> {
    if (cached && cached.exp > Date.now() + 30_000) return cached.token;
    const body = new URLSearchParams({
      client_id: clientId!,
      client_secret: clientSecret!,
      grant_type: "client_credentials",
      scope: "https://graph.microsoft.com/.default",
    });
    const res = await timedFetch(fetchImpl, `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });
    if (!res.ok) throw new SendOutcomeError("graph_token_failed", false);
    const json = (await res.json()) as { access_token?: string; expires_in?: number };
    if (!json.access_token) throw new SendOutcomeError("graph_token_missing", false);
    cached = { token: json.access_token, exp: Date.now() + (json.expires_in ?? 3600) * 1000 };
    return cached.token;
  }

  return {
    async sendMail(input) {
      const access = await token();
      const res = await timedFetch(
        fetchImpl,
        `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(mailbox)}/sendMail`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${access}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            message: {
              subject: input.subject,
              body: { contentType: "Text", content: input.body },
              from: { emailAddress: { address: mailbox } },
              toRecipients: [{ emailAddress: { address: input.to } }],
            },
            saveToSentItems: true,
          }),
        },
      );
      if (!res.ok) throw new SendOutcomeError("graph_send_failed", res.status >= 500);
      return { id: res.headers.get("request-id") || `graph-${Date.now()}` };
    },
    async listReplies(input) {
      const access = await token();
      const top = input?.top ?? 20;
      const res = await timedFetch(
        fetchImpl,
        `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(mailbox)}/mailFolders/inbox/messages?$top=${top}&$select=id,receivedDateTime,conversationId,from,subject,isDraft&$orderby=receivedDateTime desc`,
        { headers: { Authorization: `Bearer ${access}` } },
      );
      if (!res.ok) throw new Error("graph_list_failed");
      const json = (await res.json()) as {
        value?: Array<{
          id: string;
          receivedDateTime?: string;
          conversationId?: string;
          from?: { emailAddress?: { address?: string } };
          subject?: string;
          isDraft?: boolean;
        }>;
      };
      return (json.value ?? [])
        .filter((m) => !m.isDraft)
        .map((m) => ({
          id: m.id,
          receivedAt: m.receivedDateTime ?? "",
          conversationId: m.conversationId,
          from: m.from?.emailAddress?.address,
          subject: m.subject,
        }));
    },
  };
}

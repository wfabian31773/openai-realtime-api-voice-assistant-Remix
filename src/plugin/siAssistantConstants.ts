/** Dedicated SI Assistant number. Env SI_ASSISTANT_NUMBER overrides. */
export const SI_ASSISTANT_NUMBER_DEFAULT = "+19092553213";
export const SI_ASSISTANT_SLUG = "si-assistant";
export const SI_ASSISTANT_CAMPAIGN_KEY = "si-assistant";
export const SI_ASSISTANT_ENABLE_ENV = "OUTBOUND_CAMPAIGN_SI_ASSISTANT";
export const SI_ASSISTANT_CALLER_ID_ENV = "SI_ASSISTANT_NUMBER";

export const SI_ASSISTANT_SMS_PREFIX = "Azul Vision SI Assistant (AI): ";
export const SI_ASSISTANT_EMAIL_DEFAULT = "Support-Assistant@azulvision.com";
export const SI_ASSISTANT_EMAIL_ENV = "SI_ASSISTANT_EMAIL";
export const SI_MAIL_TENANT_ENV = "SI_MAIL_TENANT_ID";
export const SI_MAIL_CLIENT_ID_ENV = "SI_MAIL_CLIENT_ID";
export const SI_MAIL_CLIENT_SECRET_ENV = "SI_MAIL_CLIENT_SECRET";

/** From-address. Env SI_ASSISTANT_EMAIL overrides. Not a secret. */
export function siAssistantEmail(env: Record<string, string | undefined> = process.env): string {
  const raw = (env[SI_ASSISTANT_EMAIL_ENV] ?? SI_ASSISTANT_EMAIL_DEFAULT).trim();
  return raw || SI_ASSISTANT_EMAIL_DEFAULT;
}

export function graphMailConfigured(env: Record<string, string | undefined> = process.env): boolean {
  return Boolean(
    (env[SI_MAIL_TENANT_ENV] ?? "").trim() &&
      (env[SI_MAIL_CLIENT_ID_ENV] ?? "").trim() &&
      (env[SI_MAIL_CLIENT_SECRET_ENV] ?? "").trim(),
  );
}

export function siAssistantNumber(env: Record<string, string | undefined> = process.env): string {
  const raw = (env.SI_ASSISTANT_NUMBER ?? SI_ASSISTANT_NUMBER_DEFAULT).trim();
  return raw || SI_ASSISTANT_NUMBER_DEFAULT;
}

export function smsIdentifiedBody(body: string): string {
  const trimmed = body.trim();
  if (trimmed.toLowerCase().startsWith("azul vision si assistant")) return trimmed;
  return `${SI_ASSISTANT_SMS_PREFIX}${trimmed}`;
}

export function emailIdentifiedBody(body: string): string {
  const header = "This message is from Azul Vision's SI Assistant, an AI. A staff member approved it.";
  if (body.includes("SI Assistant, an AI")) return body;
  return `${header}\n\n${body.trim()}`;
}

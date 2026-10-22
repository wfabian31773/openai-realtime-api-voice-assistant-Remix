import { createHash, randomBytes } from "node:crypto";
import { DEFAULT_PLUGIN_SCOPES, parseScopes, type PluginScope } from "./scopes";
import { timingSafeEqualHex } from "./timingSafe";

export const TOKEN_PREFIX = "si";

export function hashSecret(secret: string): string {
  return createHash("sha256").update(secret, "utf8").digest("hex");
}

export function generateTokenParts(): { jti: string; secret: string; plaintext: string } {
  const jti = randomBytes(16).toString("hex");
  const secret = randomBytes(32).toString("hex");
  return { jti, secret, plaintext: `${TOKEN_PREFIX}.${jti}.${secret}` };
}

export function parseBearerToken(header: string | null | undefined): { jti: string; secret: string } | null {
  if (!header) return null;
  const match = header.match(/^Bearer\s+(\S+)\s*$/i);
  if (!match) return null;
  return parsePlaintextToken(match[1]);
}

export function parsePlaintextToken(token: string): { jti: string; secret: string } | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [prefix, jti, secret] = parts;
  if (prefix !== TOKEN_PREFIX) return null;
  if (!/^[a-f0-9]{32}$/.test(jti)) return null;
  if (!/^[a-f0-9]{64}$/.test(secret)) return null;
  return { jti, secret };
}

export type VerifiedPluginToken = {
  jti: string;
  label: string | null;
  scopes: PluginScope[];
};

export function verifyHashedSecret(plaintextSecret: string, hashedSecret: string): boolean {
  return timingSafeEqualHex(hashSecret(plaintextSecret), hashedSecret);
}

export function scopesOrDefault(scopes: string[] | null | undefined): PluginScope[] {
  return parseScopes(scopes ?? DEFAULT_PLUGIN_SCOPES);
}

export const CONFIRM_TTL_MS = 5 * 60 * 1000;

export function generateConfirmToken(): { plaintext: string; hash: string } {
  const plaintext = randomBytes(32).toString("hex");
  return { plaintext, hash: hashSecret(plaintext) };
}

export function isConfirmExpired(expiresAt: Date, now = new Date()): boolean {
  return expiresAt.getTime() <= now.getTime();
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => [k, sortValue(v)]);
    return Object.fromEntries(entries);
  }
  return value;
}

export function hashPayload(payload: unknown): string {
  return createHash("sha256").update(canonicalJson(payload), "utf8").digest("hex");
}

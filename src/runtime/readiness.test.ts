import { describe, it, expect } from "vitest";
import {
  computeRuntimeReadiness,
  formatReadinessLines,
  VOICE_RUNTIME_DEPLOY_MARKER,
} from "./readiness";

const FULL = {
  XAI_API_KEY: "k",
  TWILIO_AUTH_TOKEN: "t",
  TWILIO_ACCOUNT_SID: "ACtest",
  DATABASE_URL: "postgres://x",
};

describe("runtime readiness", () => {
  it("is live-ready with the voice, the webhook auth and a database", () => {
    const r = computeRuntimeReadiness(FULL);
    expect(r.liveReady).toBe(true);
    expect(r.missing).toEqual([]);
  });

  it("reports env var NAMES only — a readiness endpoint that echoes a value leaks it", () => {
    const r = computeRuntimeReadiness({ DATABASE_URL: "postgres://user:secret@host/db" });
    expect(r.missing).toEqual(["XAI_API_KEY", "TWILIO_AUTH_TOKEN", "TWILIO_ACCOUNT_SID"]);
    expect(JSON.stringify(r)).not.toContain("secret");
  });

  it("is not live-ready without the Grok key — there is no session to open", () => {
    const r = computeRuntimeReadiness({ ...FULL, XAI_API_KEY: undefined });
    expect(r.liveReady).toBe(false);
    expect(r.missing).toContain("XAI_API_KEY");
  });

  it("is not live-ready without the Twilio token — nothing could be authenticated", () => {
    const r = computeRuntimeReadiness({ ...FULL, TWILIO_AUTH_TOKEN: undefined });
    expect(r.liveReady).toBe(false);
    expect(r.missing).toContain("TWILIO_AUTH_TOKEN");
  });

  it("is not live-ready without a database — a call that can talk but not file is worse than none", () => {
    const r = computeRuntimeReadiness({ ...FULL, DATABASE_URL: undefined });
    expect(r.liveReady).toBe(false);
    expect(r.missing).toContain("DATABASE_URL");
  });

  it("mirrors the app's own production DB fallback rather than inventing a stricter rule", () => {
    // getEnvironmentConfig() prefers PRODUCTION_DATABASE_URL in production
    // and falls back to DATABASE_URL with a warning. Readiness has to
    // agree with the code that opens the connection.
    const prodWithFallback = computeRuntimeReadiness({
      ...FULL,
      NODE_ENV: "production",
    });
    expect(prodWithFallback.liveReady).toBe(true);
    const prodWithProper = computeRuntimeReadiness({
      XAI_API_KEY: "k",
      TWILIO_AUTH_TOKEN: "t",
  TWILIO_ACCOUNT_SID: "ACtest",
      NODE_ENV: "production",
      PRODUCTION_DATABASE_URL: "postgres://prod",
    });
    expect(prodWithProper.liveReady).toBe(true);
    const prodWithNothing = computeRuntimeReadiness({
      XAI_API_KEY: "k",
      TWILIO_AUTH_TOKEN: "t",
  TWILIO_ACCOUNT_SID: "ACtest",
      NODE_ENV: "production",
    });
    expect(prodWithNothing.liveReady).toBe(false);
  });

  it("treats a Replit deployment as production", () => {
    const r = computeRuntimeReadiness({
      XAI_API_KEY: "k",
      TWILIO_AUTH_TOKEN: "t",
  TWILIO_ACCOUNT_SID: "ACtest",
      REPLIT_DEPLOYMENT: "1",
      PRODUCTION_DATABASE_URL: "postgres://prod",
    });
    expect(r.liveReady).toBe(true);
  });

  it("recognizes EVERY production signal the deployment sets — none implies the others", () => {
    // A published deployment can present only APP_ENV=production (from
    // .replit) or only a published .replit.app domain. The shared resolver
    // treats both as production and selects PRODUCTION_DATABASE_URL, while
    // this function tested only NODE_ENV/REPLIT_DEPLOYMENT — classifying
    // the process as development, reporting DATABASE_URL missing, and
    // serving the unavailable TwiML for every call of a completely
    // configured deployment (Codex, PR #227 round 21).
    for (const signal of [
      { APP_ENV: "production" },
      { REPLIT_DOMAINS: "azul.replit.app" },
    ]) {
      const r = computeRuntimeReadiness({
        XAI_API_KEY: "k",
        TWILIO_AUTH_TOKEN: "t",
  TWILIO_ACCOUNT_SID: "ACtest",
        PRODUCTION_DATABASE_URL: "postgres://prod",
        ...signal,
      });
      expect(r.liveReady).toBe(true);
      expect(r.requiredDbEnvVar).toBe("PRODUCTION_DATABASE_URL (or DATABASE_URL)");
    }
    // A dev workspace domain stays development: DATABASE_URL is required.
    const dev = computeRuntimeReadiness({
      XAI_API_KEY: "k",
      TWILIO_AUTH_TOKEN: "t",
  TWILIO_ACCOUNT_SID: "ACtest",
      PRODUCTION_DATABASE_URL: "postgres://prod",
      REPLIT_DOMAINS: "azul.spock.replit.dev",
    });
    expect(dev.liveReady).toBe(false);
    expect(dev.missing).toContain("DATABASE_URL");
  });

  it("prints the marker and the reason, which is how a stale build is caught", () => {
    const lines = formatReadinessLines(computeRuntimeReadiness({}));
    expect(lines[0]).toBe(`[voice-runtime] ${VOICE_RUNTIME_DEPLOY_MARKER}`);
    expect(lines[1]).toContain("NOT live-ready");
    expect(lines[1]).toContain("XAI_API_KEY");
    expect(formatReadinessLines(computeRuntimeReadiness(FULL))[1]).toBe(
      "[voice-runtime] live-ready",
    );
  });
});

/**
 * Added with task #54. The runtime now starts Twilio's call recording over
 * REST on the inbound path, and the greeting promises that recording — so a
 * line without the means to make one is not ready to answer. Before this the
 * account sid was not required, because nothing in the runtime made an
 * inbound REST call.
 */
describe("recording is part of being ready to answer", () => {
  it("is not live-ready without TWILIO_ACCOUNT_SID", () => {
    const r = computeRuntimeReadiness({ ...FULL, TWILIO_ACCOUNT_SID: undefined });
    expect(r.liveReady).toBe(false);
    expect(r.missing).toContain("TWILIO_ACCOUNT_SID");
  });
});

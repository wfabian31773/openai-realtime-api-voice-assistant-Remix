import { describe, it, expect } from "vitest";
import {
  computeRuntimeReadiness,
  formatReadinessLines,
  markerSetOn,
  VOICE_RUNTIME_DEPLOY_MARKER,
} from "./readiness";

const FULL = {
  XAI_API_KEY: "k",
  TWILIO_AUTH_TOKEN: "t",
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
    expect(r.missing).toEqual(["XAI_API_KEY", "TWILIO_AUTH_TOKEN"]);
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
      NODE_ENV: "production",
      PRODUCTION_DATABASE_URL: "postgres://prod",
    });
    expect(prodWithProper.liveReady).toBe(true);
    const prodWithNothing = computeRuntimeReadiness({
      XAI_API_KEY: "k",
      TWILIO_AUTH_TOKEN: "t",
      NODE_ENV: "production",
    });
    expect(prodWithNothing.liveReady).toBe(false);
  });

  it("treats a Replit deployment as production", () => {
    const r = computeRuntimeReadiness({
      XAI_API_KEY: "k",
      TWILIO_AUTH_TOKEN: "t",
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

  /**
   * WHY A TEST GUARDS A STRING'S SUFFIX.
   *
   * The marker went 2026-08-29 to 2026-09-05 without a bump, across every
   * commit in between — including the one adding the `[runtime] pre-context`
   * diagnostic. When the operator searched a live deployment for that line
   * and found nothing, the marker could not say whether the build contained
   * it, because the identical string is served either side of the change.
   * The rule "bump it on every ship" was already written at the top of
   * readiness.ts and was not enough on its own.
   *
   * The date suffix makes the marker answer "how old is this build?" without
   * anyone knowing our commits. These tests exist so a future bump cannot
   * quietly drop it and put us back where we were.
   */
  it("carries the date it was set, so a build's age is readable from the marker", () => {
    expect(VOICE_RUNTIME_DEPLOY_MARKER).toMatch(/-\d{8}$/);
    const on = markerSetOn();
    expect(on).not.toBeNull();
    // A real calendar date, not eight digits that merely look like one.
    expect(Number.isNaN(Date.parse(`${on}T00:00:00Z`))).toBe(false);
  });

  it("markerSetOn reports null rather than guessing when the suffix is gone", () => {
    expect(markerSetOn("voice-runtime-v2-transfer-guardrails-tools")).toBeNull();
    expect(markerSetOn("voice-runtime-v9-something-2026090")).toBeNull();
    expect(markerSetOn("voice-runtime-v3-precontext-diagnosable-20260905")).toBe(
      "2026-09-05",
    );
  });
});

// Integration tests for the deployment probe (/healthz), readiness (/readyz),
// and the initialization failure gate — covering startup, successful init,
// and failed init, for the probe path, a normal route, and a voice webhook path.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import express from "express";
import http from "http";
import type { AddressInfo } from "net";
import { createHealthState, registerHealthEndpoints, INIT_FAILED_TWIML, type HealthState } from "./health";

function makeServer(state: HealthState): Promise<{ server: http.Server; base: string }> {
  const app = express();
  registerHealthEndpoints(app, state);
  // Simulates the voice proxy + normal routes registered after the gate
  app.use("/api/voice", (_req, res) => res.status(200).send("voice-proxied"));
  app.get("/api/normal", (_req, res) => res.status(200).json({ ok: true }));
  app.use((_req, res) => res.status(200).send("index.html"));
  return new Promise((resolve) => {
    const server = http.createServer(app);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({ server, base: `http://127.0.0.1:${port}` });
    });
  });
}

describe("health endpoints and failure gate", () => {
  const state = createHealthState();
  let server: http.Server;
  let base: string;

  beforeAll(async () => {
    ({ server, base } = await makeServer(state));
  });

  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  it("during startup: /healthz 200, /readyz 503 initializing, traffic flows", async () => {
    state.isReady = false;
    state.initFailed = false;
    expect((await fetch(`${base}/healthz`)).status).toBe(200);
    const ready = await fetch(`${base}/readyz`);
    expect(ready.status).toBe(503);
    expect(await ready.json()).toEqual({ status: "initializing" });
    expect((await fetch(`${base}/api/normal`)).status).toBe(200);
  });

  it("after successful init: /healthz 200, /readyz 200 ready, traffic flows", async () => {
    state.isReady = true;
    state.initFailed = false;
    expect((await fetch(`${base}/healthz`)).status).toBe(200);
    const ready = await fetch(`${base}/readyz`);
    expect(ready.status).toBe(200);
    expect(await ready.json()).toEqual({ status: "ready" });
    expect((await fetch(`${base}/api/normal`)).status).toBe(200);
    expect((await fetch(`${base}/api/voice/incoming-call`, { method: "POST" })).status).toBe(200);
  });

  it("after failed init: /healthz 503 so the deployment probe fails", async () => {
    state.isReady = false;
    state.initFailed = true;
    expect((await fetch(`${base}/healthz`)).status).toBe(503);
  });

  it("after failed init: /readyz 503 with generic body (no error internals)", async () => {
    state.isReady = false;
    state.initFailed = true;
    const ready = await fetch(`${base}/readyz`);
    expect(ready.status).toBe(503);
    expect(await ready.json()).toEqual({ status: "failed" });
  });

  it("after failed init: normal routes and root return 503, not silent success", async () => {
    state.isReady = false;
    state.initFailed = true;
    const normal = await fetch(`${base}/api/normal`);
    expect(normal.status).toBe(503);
    expect(await normal.json()).toEqual({ error: "Server initialization failed" });
    expect((await fetch(`${base}/`)).status).toBe(503);
  });

  it("after failed init: voice webhook paths get HTTP 200 TwiML apology (Twilio requires 200)", async () => {
    state.isReady = false;
    state.initFailed = true;
    const voice = await fetch(`${base}/api/voice/incoming-call`, { method: "POST" });
    expect(voice.status).toBe(200);
    expect(voice.headers.get("content-type")).toContain("xml");
    const body = await voice.text();
    expect(body).toBe(INIT_FAILED_TWIML);
    expect(body).toContain("<Hangup/>");
  });
});

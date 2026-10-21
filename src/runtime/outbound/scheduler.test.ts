import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import type { LaneConfig, LaneSource } from "../laneRegistry";
import type { OutboundLanePolicy } from "./campaign";
import { DEFAULT_ATTEMPT_CAPS, DEFAULT_CALLING_WINDOW } from "./callingWindow";
import { enabledCampaigns, runOutboundTick, startOutboundScheduler, type SchedulerDeps } from "./scheduler";
import { FakeOutboundStore } from "./store.testkit";

const NOW = new Date("2041-03-05T18:00:00Z");
const policy: OutboundLanePolicy = {
  campaignKey: "test-campaign",
  enableEnv: "OUTBOUND_CAMPAIGN_TEST",
  callerIdEnv: "OUTBOUND_TEST_FROM",
  window: DEFAULT_CALLING_WINDOW,
  caps: DEFAULT_ATTEMPT_CAPS,
  concurrency: 1,
  greeting: () => "Hello, this is an automated assistant calling for Azul Vision. This call is recorded.",
  voicemail: () => "Hello, this is Azul Vision.",
};
const ON = { RUNTIME_OUTBOUND_DIALING: "1", OUTBOUND_CAMPAIGN_TEST: "1", OUTBOUND_TEST_FROM: "+15555550100" };

function source(configs: LaneConfig[]): LaneSource {
  return { getAgentConfig: (id) => configs.find((c) => c.id === id) };
}

function deps(env: Record<string, string>, over: Partial<SchedulerDeps> = {}) {
  const store = new FakeOutboundStore(() => NOW);
  store.addContact({ id: "c1", phone: "+15555550111" });
  const createCall = vi.fn(async () => ({ sid: "CA00000000000000000000000000000001" }));
  const lock = { acquire: vi.fn(async () => true), release: vi.fn(async () => undefined) };
  const d: SchedulerDeps = {
    env,
    host: "voice.example.test",
    now: () => NOW,
    log: () => undefined,
    laneSource: async () =>
      source([
        { id: "test-lane", enabled: true, agentType: "outbound", outbound: policy, factory: () => undefined },
        { id: "optical", enabled: true, agentType: "inbound", factory: () => undefined },
      ]),
    slugs: async () => ["test-lane", "optical"],
    store: async () => store,
    twilio: async () => ({ createCall }),
    lock,
    ...over,
  };
  return { d, store, createCall, lock };
}

describe("the outbound scheduler", () => {
  it("finds only enabled outbound lanes that carry a policy", async () => {
    const { d } = deps(ON);
    expect((await enabledCampaigns(d)).map((c) => c.slug)).toEqual(["test-lane"]);
  });

  it("dials an enabled campaign under the lock, and lets the lock go", async () => {
    const { d, createCall, lock } = deps(ON);
    const results = await runOutboundTick(d);
    expect(results[0].dialled).toBe(1);
    expect(createCall).toHaveBeenCalledTimes(1);
    expect(lock.release).toHaveBeenCalledTimes(1);
  });

  it("does nothing at all with the fleet switch off — not even the lock", async () => {
    const { d, createCall, lock } = deps({ ...ON, RUNTIME_OUTBOUND_DIALING: "" });
    expect(await runOutboundTick(d)).toEqual([]);
    expect(lock.acquire).not.toHaveBeenCalled();
    expect(createCall).not.toHaveBeenCalled();
  });

  it("does nothing when another instance holds the lock", async () => {
    const { d, createCall } = deps(ON, { lock: { acquire: async () => false, release: async () => undefined } });
    expect(await runOutboundTick(d)).toEqual([]);
    expect(createCall).not.toHaveBeenCalled();
  });

  it("lets the lock go even when the store cannot be opened", async () => {
    const { d, lock } = deps(ON, {
      store: async () => {
        throw new Error("no database");
      },
    });
    expect(await runOutboundTick(d)).toEqual([]);
    expect(lock.release).toHaveBeenCalledTimes(1);
  });

  it("starts no timer with the switch off", () => {
    const { d } = deps({});
    const spy = vi.spyOn(globalThis, "setInterval");
    startOutboundScheduler(d)();
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});

describe("the old core's appointment-confirmation scheduler", () => {
  // The Campaigns screen starts THIS, not the executor (Codex P1 on #357).
  it("refuses a runtime outbound campaign before it takes its lock", () => {
    const src = readFileSync("src/services/outboundCampaignScheduler.ts", "utf8");
    const start = src.indexOf("async start(): Promise<void> {");
    const guard = src.indexOf("campaign?.campaignType === RUNTIME_OUTBOUND_CAMPAIGN_TYPE", start);
    expect(guard).toBeGreaterThan(start);
    expect(guard).toBeLessThan(src.indexOf("distributedLockService.acquireLock", start));
  });

  it("is refused by its start route before a scheduler is created", () => {
    const src = readFileSync("server/routes.ts", "utf8");
    const route = src.indexOf("'/api/campaigns/:id/start-outbound-scheduler'");
    const guard = src.indexOf("campaign.campaignType === 'runtime_outbound'", route);
    expect(guard).toBeGreaterThan(route);
    expect(guard).toBeLessThan(src.indexOf("createScheduler({", route));
  });
});

describe("the old core's campaign executor", () => {
  it("refuses a runtime outbound campaign before dialling anything", () => {
    const src = readFileSync("server/services/campaignExecutor.ts", "utf8");
    const guard = src.indexOf("campaign.campaignType === 'runtime_outbound'");
    expect(guard).toBeGreaterThan(0);
    // Ahead of the status change and the contact fetch that lead to dialling.
    expect(guard).toBeLessThan(src.indexOf("status: 'running'"));
    expect(guard).toBeLessThan(src.indexOf("getCampaignContacts(campaignId)"));
  });
});

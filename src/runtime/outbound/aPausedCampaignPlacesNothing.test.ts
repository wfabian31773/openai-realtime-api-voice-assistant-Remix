/**
 * v277: a runtime campaign paused, cancelled or deleted on the Campaigns
 * screen places no new outreach, and what is owed still goes out.
 *
 * THE BEFORE, read from the code on 2026-11-26: the dialler never read the
 * campaign row's status. Stop/Pause wrote `paused` and said "The campaign has
 * stopped making calls" while the next tick rang the next person; Cancel the
 * same; Resume and Start marked the campaign `cancelled` through the old
 * executor's refusal; and Delete left the runtime to create a FRESH campaign
 * by name, with no attempts, so the source refresh queued everybody again.
 * Measured on the Hub the same day: four runtime campaigns, all `running`,
 * none deleted, `updated_at` equal to `created_at` on every one — nobody has
 * pressed these buttons on one yet, so this changes nothing that is live.
 *
 * Driven through the real scheduler and dialler with the in-memory store.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import type { LaneConfig, LaneSource } from "../laneRegistry";
import type { ContactSource, OutboundLanePolicy } from "./campaign";
import { DEFAULT_ATTEMPT_CAPS, DEFAULT_CALLING_WINDOW } from "./callingWindow";
import { runCampaignTick, type OutboundTwilio } from "./dialer";
import { runTextTick } from "./outreachText";
import { runOutboundTick, type SchedulerDeps } from "./scheduler";
import { campaignHoldReason } from "./store";
import { FakeOutboundStore } from "./store.testkit";
import { runtimeCampaignControl } from "../../../server/runtimeCampaignControls";
import { evaluateAndEnqueueCall } from "../../plugin/callEnqueue";

// Tuesday 10 AM Pacific.
const NOW = new Date("2041-03-05T18:00:00Z");
const LIVE = { XAI_API_KEY: "k", TWILIO_AUTH_TOKEN: "t", DATABASE_URL: "postgres://x" };
const ON = {
  ...LIVE,
  RUNTIME_OUTBOUND_DIALING: "1",
  OUTBOUND_CAMPAIGN_TEST: "1",
  OUTBOUND_TEST_FROM: "+15555550100",
  TEST_TEXTS: "1",
};

const page = {
  isDemo: () => true,
  currentAppointment: () => "",
  openings: async () => ({ openings: [] }),
  book: async () => ({ ok: false as const, error: "x" }),
};
const afterCalls = vi.fn(async () => ({ held_cancels_run: 1 }));
const policy: OutboundLanePolicy = {
  campaignKey: "test-campaign",
  enableEnv: "OUTBOUND_CAMPAIGN_TEST",
  callerIdEnv: "OUTBOUND_TEST_FROM",
  window: DEFAULT_CALLING_WINDOW,
  caps: DEFAULT_ATTEMPT_CAPS,
  concurrency: 2,
  greeting: () => "Hello, this is an automated assistant calling for Azul Vision. This call is recorded.",
  voicemail: () => "Hello, this is Azul Vision.",
  textOutreach: { enableEnv: "TEST_TEXTS", perTick: 5, body: (l: string) => l, page },
  afterCalls,
};

function source(configs: LaneConfig[]): LaneSource {
  return { getAgentConfig: (id) => configs.find((c) => c.id === id) };
}

/** A campaign with a person due a call, a person due a text, and a person
 * who booked and is owed a confirmation. */
async function setup(over: Partial<SchedulerDeps> = {}, lanePolicy: OutboundLanePolicy = policy) {
  afterCalls.mockClear();
  const store = new FakeOutboundStore(() => NOW);
  store.addContact({ id: "c1", phone: "+15555550111" });
  store.addContact({ id: "c2", phone: "+15555550112" });
  store.addContact({
    id: "c3",
    phone: "+15555550113",
    status: "completed",
    customData: { outreach_text: { state: "sent" } },
  });
  await store.queueConfirmation("c3", {
    state: "due",
    booking_id: "b1",
    by: "link",
    when: "Mon, Feb 4 at 9:00 AM",
    place: "Partner One Optometry, 1 Test St, Testville",
    phone: "555-010-0000",
    replaced_day: "Mar 20",
    cancel: "cancelled",
    queued_at: NOW.toISOString(),
    due_at: NOW.toISOString(),
  });
  let n = 0;
  const createCall = vi.fn(async () => ({ sid: `CA${String(++n).padStart(32, "0")}` }));
  const send = vi.fn(async () => ({ sid: "SM1" }));
  const lines: string[] = [];
  const d: SchedulerDeps = {
    env: ON,
    host: "voice.example.test",
    now: () => NOW,
    log: (l) => lines.push(l),
    laneSource: async () =>
      source([{ id: "test-lane", enabled: true, agentType: "outbound", outbound: lanePolicy, factory: () => undefined }]),
    slugs: async () => ["test-lane"],
    store: async () => store,
    twilio: async () => ({ createCall, voiceUrlFor: async () => "https://voice.example.test/voice/test-lane" }),
    lock: { acquire: async () => true, release: async () => undefined },
    sms: async () => ({ send }),
    ...over,
  };
  return { d, store, createCall, send, lines };
}

/** What the Campaigns screen's server route does to the row, written where
 * the runtime reads it — the column the two halves share. */
function screen(store: FakeOutboundStore) {
  const row = () => ({ id: store.campaignId, name: "test-campaign", campaignType: "runtime_outbound", status: store.campaignState?.status ?? null, deletedAt: null });
  const deps = {
    update: async (_id: string, updates: Record<string, unknown>) => {
      if (typeof updates.status === "string") store.campaignState = { status: updates.status, deleted: false };
    },
  };
  return {
    press: (action: "pause" | "stop" | "cancel" | "resume") => runtimeCampaignControl(action, row(), deps),
  };
}

describe("campaignHoldReason: the runtime places new outreach only while the row reads running", () => {
  it("holds nothing for a running, undeleted campaign", () => {
    expect(campaignHoldReason({ status: "running", deleted: false })).toBeNull();
  });

  it("holds a paused, cancelled or any other status, and says which", () => {
    for (const status of ["paused", "cancelled", "completed", "draft", "scheduled"]) {
      expect(campaignHoldReason({ status, deleted: false })).toBe(`the campaign is ${status} on the Campaigns screen`);
    }
    expect(campaignHoldReason({ status: null, deleted: false })).toMatch(/without a status/);
  });

  it("holds a deleted campaign even when its status still reads running", () => {
    expect(campaignHoldReason({ status: "running", deleted: true })).toMatch(/deleted on the Campaigns screen/);
  });

  it("holds when the row cannot be found", () => {
    expect(campaignHoldReason(null)).toMatch(/could not be found/);
  });
});

describe("a paused campaign through the real scheduler", () => {
  it("rings nobody and texts nobody, and still sends what is owed", async () => {
    const { d, store, createCall, send } = await setup();
    store.campaignState = { status: "paused", deleted: false };
    const [tick] = await runOutboundTick(d);
    expect(tick.skipped).toBe("the campaign is paused on the Campaigns screen");
    expect(tick.dialled).toBe(0);
    expect(createCall).not.toHaveBeenCalled();
    // Nobody was claimed: no attempt, the rows untouched.
    expect(store.attempts).toHaveLength(0);
    expect(store.contacts.get("c1")!.status).toBe("pending");
    expect(store.contacts.get("c2")!.status).toBe("pending");
    // No outreach text.
    expect(tick.texts).toEqual({ sent: 0, held: {}, skipped: "the campaign is paused on the Campaigns screen" });
    // The booked person's confirmation still goes, and the held cancels run.
    expect(tick.confirmations).toEqual({ sent: 1, held: {} });
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ to: "+15555550113" }));
    expect(afterCalls).toHaveBeenCalledTimes(1);
  });

  it("a running campaign dials and texts as before (the control)", async () => {
    const { d, createCall, send } = await setup();
    const [tick] = await runOutboundTick(d);
    expect(tick.skipped).toBeUndefined();
    expect(tick.dialled).toBe(2);
    expect(createCall).toHaveBeenCalledTimes(2);
    expect(tick.confirmations).toEqual({ sent: 1, held: {} });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("a cancelled campaign is held the same way", async () => {
    const { d, store, createCall } = await setup();
    store.campaignState = { status: "cancelled", deleted: false };
    const [tick] = await runOutboundTick(d);
    expect(tick.skipped).toBe("the campaign is cancelled on the Campaigns screen");
    expect(createCall).not.toHaveBeenCalled();
    expect(tick.texts?.sent).toBe(0);
  });

  it("a deleted campaign is held, even reading running", async () => {
    const { d, store, createCall } = await setup();
    store.campaignState = { status: "running", deleted: true };
    const [tick] = await runOutboundTick(d);
    expect(tick.skipped).toMatch(/deleted/);
    expect(createCall).not.toHaveBeenCalled();
    expect(tick.texts?.sent).toBe(0);
  });

  it("a status that cannot be read dials nobody: it fails closed", async () => {
    const { d, store, createCall, lines } = await setup();
    store.campaignRunState = async () => {
      throw new Error("db down");
    };
    const [tick] = await runOutboundTick(d);
    expect(tick.dialled).toBe(0);
    expect(createCall).not.toHaveBeenCalled();
    expect(tick.texts?.sent).toBe(0);
    expect(lines.join("\n")).toMatch(/tick failed — db down/);
  });

  it("writes nothing from the source while paused: the refresh waits for Resume", async () => {
    const list = vi.fn(async () => []);
    const src: ContactSource = {
      name: "test source",
      refreshEveryMs: 0,
      parkMs: 60_000,
      list,
      recheck: async () => ({ state: "off_list" as const }),
    };
    const withSource = { ...policy, source: async () => src };
    const { d, store, createCall } = await setup({}, withSource);
    store.campaignState = { status: "paused", deleted: false };
    await runOutboundTick(d);
    expect(list).not.toHaveBeenCalled();
    expect(createCall).not.toHaveBeenCalled();
  });
});

describe("the button and the dialler, joined by the column they share", () => {
  it("Pause on the screen stops the next tick; Resume lets it dial again", async () => {
    const { d, store, createCall } = await setup();
    const buttons = screen(store);

    const paused = await buttons.press("pause");
    expect(paused?.status).toBe(200);
    let [tick] = await runOutboundTick(d);
    expect(tick.dialled).toBe(0);
    expect(createCall).not.toHaveBeenCalled();

    const resumed = await buttons.press("resume");
    expect(resumed?.status).toBe(200);
    [tick] = await runOutboundTick(d);
    expect(tick.dialled).toBe(2);
    expect(createCall).toHaveBeenCalledTimes(2);
  });

  it("the screen's Stop button and Cancel stop it too", async () => {
    for (const action of ["stop", "cancel"] as const) {
      const { d, store, createCall } = await setup();
      await screen(store).press(action);
      const [tick] = await runOutboundTick(d);
      expect(tick.dialled, action).toBe(0);
      expect(createCall, action).not.toHaveBeenCalled();
    }
  });
});

describe("the hold is said once, not every minute", () => {
  function tickDeps(store: FakeOutboundStore, lines: string[], holdNoted?: Map<string, string | null>) {
    const createCall = vi.fn(async () => ({ sid: "CA00000000000000000000000000000001" }));
    const twilio: OutboundTwilio = { createCall, voiceUrlFor: async () => "https://voice.example.test/voice/test-lane" };
    return { store, twilio, env: ON, host: "voice.example.test", now: () => NOW, log: (l: string) => lines.push(l), holdNoted };
  }

  it("logs the pause on the first held tick, nothing on the next, and the resume once", async () => {
    const store = new FakeOutboundStore(() => NOW);
    const lines: string[] = [];
    const noted = new Map<string, string | null>();
    const deps = tickDeps(store, lines, noted);
    store.campaignState = { status: "paused", deleted: false };
    await runCampaignTick("test-lane", policy, deps);
    await runCampaignTick("test-lane", policy, deps);
    expect(lines.filter((l) => l.includes("NOT dialling"))).toEqual([
      "[outbound] test-campaign: NOT dialling — the campaign is paused on the Campaigns screen",
    ]);
    store.campaignState = { status: "running", deleted: false };
    await runCampaignTick("test-lane", policy, deps);
    await runCampaignTick("test-lane", policy, deps);
    expect(lines.filter((l) => l.includes("dialling again"))).toEqual([
      "[outbound] test-campaign: dialling again — the campaign is running",
    ]);
  });

  it("says nothing on a campaign that was never held", async () => {
    const store = new FakeOutboundStore(() => NOW);
    const lines: string[] = [];
    await runCampaignTick("test-lane", policy, tickDeps(store, lines, new Map()));
    expect(lines.join("\n")).not.toMatch(/dialling again|NOT dialling/);
  });

  it("the scheduler keeps one map across ticks", () => {
    const src = readFileSync("src/runtime/outbound/scheduler.ts", "utf8");
    const start = src.indexOf("export function startOutboundScheduler");
    expect(src.indexOf("const holdNoted = deps.holdNoted ?? new Map", start)).toBeGreaterThan(start);
    expect(src.indexOf("runOutboundTick({ ...deps, routeCache, sourceRefreshedAt, holdNoted })", start)).toBeGreaterThan(start);
  });
});

describe("a staff-approved SI Assistant call on a paused campaign", () => {
  const input = { approvalId: "a1", phone: "+15555550131", firstName: "Test", lastName: "Patient", dateOfBirth: null, ticketNumber: null, ticketId: null, purpose: null };

  it("is refused at commit rather than answered queued, while a live call is not the dialler's", async () => {
    const store = new FakeOutboundStore(() => NOW);
    store.campaignState = { status: "paused", deleted: false };
    expect(await evaluateAndEnqueueCall(store, input, NOW)).toEqual({ ok: false, reason: "campaign_paused" });
    expect(await store.sourceRows(store.campaignId)).toHaveLength(0);
    // A live approval is placed now, not by the dialler, so the hold is not its.
    expect((await evaluateAndEnqueueCall(store, { ...input, approvalId: "a2" }, NOW, true)).ok).toBe(true);
  });

  it("is queued on a running campaign (the control)", async () => {
    const store = new FakeOutboundStore(() => NOW);
    expect((await evaluateAndEnqueueCall(store, input, NOW)).ok).toBe(true);
  });

  it("the commit answers 503, which the fleet reads as not sent", () => {
    const src = readFileSync("src/plugin/routes.ts", "utf8");
    expect(src).toContain('if (reason === "no_campaign" || reason === "campaign_paused") return 503;');
  });
});

describe("what is owed never reads the hold", () => {
  // Returned calls, the answer and status webhooks, booking confirmations and
  // held Azul cancels serve people already in a call or a booking. A pause
  // must not strand them, so none of these reads the campaign's status.
  for (const file of ["callback.ts", "outboundWebhook.ts", "bookingConfirmation.ts", "heldAzulCancel.ts", "bookingPage.ts"]) {
    it(`${file} does not read campaignRunState`, () => {
      const src = readFileSync(`src/runtime/outbound/${file}`, "utf8");
      expect(src).not.toContain("campaignRunState");
      expect(src).not.toContain("campaignHoldReason");
    });
  }
});

describe("a Pause pressed while a tick is under way (review of #531)", () => {
  // A tick reads `running` at its start, then can spend seconds on the source
  // refresh, the re-check and the offer check. The status is read again just
  // before the call or the text, so a Pause pressed meanwhile places nothing.
  function pausingMidTick(store: FakeOutboundStore) {
    let pressed = false;
    const offerCheck = vi.fn(async () => {
      if (!pressed) {
        pressed = true;
        await screen(store).press("pause");
      }
      return "offerable" as const;
    });
    return { lane: { ...policy, offerCheck }, offerCheck };
  }

  function dialDeps(store: FakeOutboundStore, lines: string[] = []) {
    let n = 0;
    const createCall = vi.fn(async () => ({ sid: `CA${String(++n).padStart(32, "0")}` }));
    const twilio: OutboundTwilio = { createCall, voiceUrlFor: async () => "https://voice.example.test/voice/test-lane" };
    return {
      deps: { store, twilio, env: ON, host: "voice.example.test", now: () => NOW, log: (l: string) => lines.push(l), holdNoted: new Map<string, string | null>() },
      createCall,
    };
  }

  it("the dialler rings nobody, gives the row back as it was, and claims nobody else this tick", async () => {
    const store = new FakeOutboundStore(() => NOW);
    store.addContact({ id: "c1", phone: "+15555550111" });
    store.addContact({ id: "c2", phone: "+15555550112" });
    const before = (id: string) => ({ status: store.contacts.get(id)!.status, next: store.contacts.get(id)!.nextAttemptAt });
    const c1 = before("c1");
    const { lane, offerCheck } = pausingMidTick(store);
    const lines: string[] = [];
    const { deps, createCall } = dialDeps(store, lines);
    const result = await runCampaignTick("test-lane", lane, deps);
    expect(createCall).not.toHaveBeenCalled();
    expect(result.dialled).toBe(0);
    expect(result.held).toEqual({ campaign_held: 1 });
    expect(offerCheck).toHaveBeenCalledTimes(1);
    expect(before("c1")).toEqual(c1);
    expect(store.contacts.get("c2")!.status).toBe("pending");
    expect(lines).toContain("[outbound] test-campaign: NOT dialling — the campaign is paused on the Campaigns screen");

    // Resume on the screen, and the next tick dials both.
    await screen(store).press("resume");
    await runCampaignTick("test-lane", lane, deps);
    expect(createCall).toHaveBeenCalledTimes(2);
  });

  it("a status that cannot be read at the last check rings nobody", async () => {
    const store = new FakeOutboundStore(() => NOW);
    store.addContact({ id: "c1", phone: "+15555550111" });
    const real = store.campaignRunState.bind(store);
    let reads = 0;
    store.campaignRunState = async (id: string) => {
      if (++reads > 1) throw new Error("db down");
      return real(id);
    };
    const { deps, createCall } = dialDeps(store);
    const result = await runCampaignTick("test-lane", policy, deps);
    expect(createCall).not.toHaveBeenCalled();
    expect(result.held).toEqual({ campaign_held: 1 });
    expect(store.contacts.get("c1")!.status).toBe("pending");
  });

  it("a running campaign is read twice and dials as before (the control)", async () => {
    const store = new FakeOutboundStore(() => NOW);
    store.addContact({ id: "c1", phone: "+15555550111" });
    const spy = vi.spyOn(store, "campaignRunState");
    const { deps, createCall } = dialDeps(store);
    const result = await runCampaignTick("test-lane", policy, deps);
    expect(result.dialled).toBe(1);
    expect(createCall).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it("the outreach text is not sent, waits with no try spent, and goes on Resume", async () => {
    const store = new FakeOutboundStore(() => NOW);
    store.addContact({ id: "c1", phone: "+15555550111" });
    store.addContact({ id: "c2", phone: "+15555550112" });
    const { lane, offerCheck } = pausingMidTick(store);
    const send = vi.fn(async () => ({ sid: "SM1" }));
    const deps = { store, env: ON, host: "voice.example.test", sms: async () => ({ send }), now: () => NOW, log: () => undefined };
    const result = await runTextTick("test-lane", lane, deps);
    expect(send).not.toHaveBeenCalled();
    expect(result.held).toEqual({ campaign_held: 1 });
    expect(offerCheck).toHaveBeenCalledTimes(1);
    const record = store.contacts.get("c1")!.customData.outreach_text as Record<string, unknown>;
    expect(record).toMatchObject({ state: "retry", retry_after: NOW.toISOString(), reason: "campaign_held" });
    expect(record.tries).toBeUndefined();
    expect(store.contacts.get("c2")!.customData.outreach_text).toBeUndefined();

    await screen(store).press("resume");
    await runTextTick("test-lane", lane, deps);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("a status that cannot be read at the last check sends no text", async () => {
    const store = new FakeOutboundStore(() => NOW);
    store.addContact({ id: "c1", phone: "+15555550111" });
    const real = store.campaignRunState.bind(store);
    let reads = 0;
    store.campaignRunState = async (id: string) => {
      if (++reads > 1) throw new Error("db down");
      return real(id);
    };
    const send = vi.fn(async () => ({ sid: "SM1" }));
    const deps = { store, env: ON, host: "voice.example.test", sms: async () => ({ send }), now: () => NOW, log: () => undefined };
    const result = await runTextTick("test-lane", policy, deps);
    expect(send).not.toHaveBeenCalled();
    expect(result.held).toEqual({ campaign_held: 1 });
  });

  it("a Pause pressed while the SMS sender is fetched sends nothing: the check is the last step before the send", async () => {
    const store = new FakeOutboundStore(() => NOW);
    store.addContact({ id: "c1", phone: "+15555550111" });
    const send = vi.fn(async () => ({ sid: "SM1" }));
    let fetched = 0;
    // The tick fetches the sender once at its start, and textOne once more just before the send.
    const sms = async () => {
      if (++fetched === 2) await screen(store).press("pause");
      return { send };
    };
    const deps = { store, env: ON, host: "voice.example.test", sms, now: () => NOW, log: () => undefined };
    const result = await runTextTick("test-lane", policy, deps);
    expect(fetched).toBe(2);
    expect(send).not.toHaveBeenCalled();
    expect(result.held).toEqual({ campaign_held: 1 });
  });
});

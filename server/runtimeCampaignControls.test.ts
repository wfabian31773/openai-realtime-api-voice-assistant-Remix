/**
 * v277: the Campaigns screen's buttons on a runtime outbound campaign.
 * See server/runtimeCampaignControls.ts for the before and after.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
  RUNTIME_CANCELLED_MESSAGE,
  RUNTIME_DELETED_REFUSAL,
  RUNTIME_DELETE_REFUSAL,
  RUNTIME_PAUSED_MESSAGE,
  RUNTIME_RESUMED_MESSAGE,
  RUNTIME_START_REFUSAL,
  runtimeCampaignControl,
  runtimeCampaignEditRefusal,
  type RuntimeCampaignAction,
} from "./runtimeCampaignControls";

const NOW = new Date("2041-03-05T18:00:00Z");
const RUNTIME = { id: "camp-1", name: "npx-outreach", campaignType: "runtime_outbound", status: "running", deletedAt: null };
const OLD = { id: "camp-2", name: "Resolution Callbacks", campaignType: "call", status: "running", deletedAt: null };

function fake() {
  const update = vi.fn(async (_id: string, _u: Record<string, unknown>) => undefined);
  return { update };
}

describe("a runtime campaign's buttons", () => {
  it("Pause and the screen's Stop write paused and say what that does", async () => {
    for (const action of ["pause", "stop"] as const) {
      const deps = fake();
      const answer = await runtimeCampaignControl(action, RUNTIME, deps, () => NOW);
      expect(answer).toEqual({
        status: 200,
        body: { success: true, message: RUNTIME_PAUSED_MESSAGE, campaignId: "camp-1", status: "paused" },
      });
      expect(deps.update).toHaveBeenCalledWith("camp-1", { status: "paused" });
    }
    expect(RUNTIME_PAUSED_MESSAGE).toMatch(/no new calls or outreach texts/);
    expect(RUNTIME_PAUSED_MESSAGE).toMatch(/still answered/);
  });

  it("Cancel writes cancelled with an end time", async () => {
    const deps = fake();
    const answer = await runtimeCampaignControl("cancel", RUNTIME, deps, () => NOW);
    expect(answer?.status).toBe(200);
    expect(answer?.body.message).toBe(RUNTIME_CANCELLED_MESSAGE);
    expect(deps.update).toHaveBeenCalledWith("camp-1", { status: "cancelled", actualEndTime: NOW });
  });

  it("Resume writes running and clears the end time, without the old executor", async () => {
    const deps = fake();
    const answer = await runtimeCampaignControl("resume", { ...RUNTIME, status: "paused" }, deps, () => NOW);
    expect(answer?.status).toBe(200);
    expect(answer?.body.message).toBe(RUNTIME_RESUMED_MESSAGE);
    expect(deps.update).toHaveBeenCalledWith("camp-1", { status: "running", actualEndTime: null });
  });

  it("Start is refused and points at Resume; nothing is written", async () => {
    const deps = fake();
    const answer = await runtimeCampaignControl("start", { ...RUNTIME, status: "paused" }, deps);
    expect(answer).toEqual({ status: 409, body: { success: false, message: RUNTIME_START_REFUSAL, campaignId: "camp-1" } });
    expect(RUNTIME_START_REFUSAL).toMatch(/Use Resume/);
    expect(deps.update).not.toHaveBeenCalled();
  });

  it("Delete is refused whatever the status; nothing is written", async () => {
    for (const status of ["running", "paused", "cancelled"]) {
      const deps = fake();
      const answer = await runtimeCampaignControl("delete", { ...RUNTIME, status }, deps);
      expect(answer).toEqual({ status: 409, body: { success: false, message: RUNTIME_DELETE_REFUSAL, campaignId: "camp-1" } });
      expect(deps.update).not.toHaveBeenCalled();
    }
  });

  it("a deleted runtime campaign is not paused, cancelled or resumed: it stays held", async () => {
    for (const action of ["pause", "stop", "cancel", "resume"] as const) {
      const deps = fake();
      const answer = await runtimeCampaignControl(action, { ...RUNTIME, deletedAt: NOW }, deps);
      expect(answer?.status, action).toBe(409);
      expect(answer?.body.message, action).toBe(RUNTIME_DELETED_REFUSAL);
      expect(deps.update, action).not.toHaveBeenCalled();
    }
  });

  it("answers nothing for any other campaign, which keeps the old executor", async () => {
    for (const action of ["pause", "stop", "cancel", "resume", "start", "delete"] as RuntimeCampaignAction[]) {
      const deps = fake();
      expect(await runtimeCampaignControl(action, OLD, deps), action).toBeNull();
      expect(await runtimeCampaignControl(action, undefined, deps), action).toBeNull();
      expect(deps.update).not.toHaveBeenCalled();
    }
  });
});

describe("an edit (PATCH) of a runtime campaign", () => {
  it("may change the description and the status to running, paused or cancelled", () => {
    expect(runtimeCampaignEditRefusal(RUNTIME, { description: "x" })).toBeNull();
    for (const status of ["running", "paused", "cancelled"]) {
      expect(runtimeCampaignEditRefusal(RUNTIME, { status })).toBeNull();
    }
  });

  it("never the name, type or agent the runtime finds it by, nor the deleted mark", () => {
    for (const body of [{ name: "npx-outreach-2" }, { campaignType: "call" }, { agentId: "a" }, { deletedAt: NOW.toISOString() }, { description: "x", name: "y" }]) {
      expect(runtimeCampaignEditRefusal(RUNTIME, body), JSON.stringify(body)).toMatch(/cannot be changed here/);
    }
  });

  it("refuses another status, a body that is not an object, and a status on a deleted row", () => {
    expect(runtimeCampaignEditRefusal(RUNTIME, { status: "completed" })).toMatch(/running, paused or cancelled/);
    expect(runtimeCampaignEditRefusal(RUNTIME, null)).toMatch(/only a description or a status/);
    expect(runtimeCampaignEditRefusal(RUNTIME, [])).toMatch(/only a description or a status/);
    expect(runtimeCampaignEditRefusal({ ...RUNTIME, deletedAt: NOW }, { status: "running" })).toBe(RUNTIME_DELETED_REFUSAL);
  });

  it("leaves every other campaign's edits alone", () => {
    expect(runtimeCampaignEditRefusal(OLD, { name: "renamed", deletedAt: NOW })).toBeNull();
    expect(runtimeCampaignEditRefusal(undefined, { name: "renamed" })).toBeNull();
  });
});

describe("the routes ask before the old code acts", () => {
  const SRC = readFileSync("server/routes.ts", "utf8");
  const routeBody = (path: string) => {
    const start = SRC.indexOf(path);
    expect(start, path).toBeGreaterThan(0);
    return SRC.slice(start, SRC.indexOf("\n  app.", start + 1));
  };

  for (const [path, action, oldCode] of [
    ["app.post('/api/campaigns/:id/start'", "start", "campaignExecutor.executeCampaign(campaignId)"],
    ["app.post('/api/campaigns/:id/pause'", "pause", "campaignExecutor.pauseCampaign(campaignId)"],
    ["app.post('/api/campaigns/:id/resume'", "resume", "campaignExecutor.resumeCampaign(campaignId)"],
    ["app.post('/api/campaigns/:id/cancel'", "cancel", "campaignExecutor.cancelCampaign(campaignId)"],
    ["app.post('/api/campaigns/:id/stop-outbound-scheduler'", "stop", "stopScheduler(campaignId)"],
  ] as const) {
    it(`${action}: answers a runtime campaign before ${oldCode}`, () => {
      const body = routeBody(path);
      const asked = body.indexOf(`await runtimeControl('${action}', campaignId)`);
      expect(asked, path).toBeGreaterThan(0);
      expect(body.indexOf("if (runtime) return res.status(runtime.status).json(runtime.body);", asked)).toBeGreaterThan(asked);
      expect(asked).toBeLessThan(body.indexOf(oldCode));
    });
  }

  it("delete: refuses a runtime campaign before the soft delete and the running check", () => {
    const body = routeBody("app.delete('/api/campaigns/:id'");
    const asked = body.indexOf("await runtimeControlFor('delete', campaign)");
    expect(asked).toBeGreaterThan(0);
    expect(asked).toBeLessThan(body.indexOf("campaign.status === 'running'"));
    expect(asked).toBeLessThan(body.indexOf("storage.deleteCampaign(campaignId)"));
  });

  it("start-outbound-scheduler: refuses a runtime campaign before a scheduler is created", () => {
    const body = routeBody("app.post('/api/campaigns/:id/start-outbound-scheduler'");
    const asked = body.indexOf("await runtimeControlFor('start', campaign)");
    expect(asked).toBeGreaterThan(0);
    expect(asked).toBeLessThan(body.indexOf("createScheduler({"));
  });

  it("patch: refuses an edit before it is written", () => {
    const body = routeBody("app.patch('/api/campaigns/:id'");
    const asked = body.indexOf("runtimeCampaignEditRefusal(await storage.getCampaign(req.params.id), req.body)");
    expect(asked).toBeGreaterThan(0);
    expect(asked).toBeLessThan(body.indexOf("storage.updateCampaign(req.params.id, req.body)"));
  });

  it("the helper writes through storage.updateCampaign on the campaign it read", () => {
    const helper = SRC.slice(SRC.indexOf("const runtimeControlFor ="), SRC.indexOf("app.post('/api/campaigns/:id/start'"));
    expect(helper).toContain("runtimeCampaignControl(action, campaign, {");
    expect(helper).toContain("storage.updateCampaign(id, updates");
    expect(helper).toContain("runtimeControlFor(action, await storage.getCampaign(campaignId))");
  });
});

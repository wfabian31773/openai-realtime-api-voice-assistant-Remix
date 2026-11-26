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
  RUNTIME_STATUS_EDIT_REFUSAL,
  RUNTIME_TYPE_RESERVED_REFUSAL,
  reservesRuntimeType,
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
  it("may change the description", () => {
    expect(runtimeCampaignEditRefusal(RUNTIME, { description: "x" })).toBeNull();
  });

  it("never the status: that route checks only sign-in, and Pause, Resume and Cancel check the role (review of #531)", () => {
    for (const status of ["running", "paused", "cancelled", "completed", "running "]) {
      expect(runtimeCampaignEditRefusal(RUNTIME, { status }), status).toBe(RUNTIME_STATUS_EDIT_REFUSAL);
      expect(runtimeCampaignEditRefusal(RUNTIME, { description: "x", status }), status).toBe(RUNTIME_STATUS_EDIT_REFUSAL);
    }
    // The current status re-sent unchanged is still refused: one rule, no reading of the row.
    expect(runtimeCampaignEditRefusal({ ...RUNTIME, status: "paused" }, { status: "paused" })).toBe(RUNTIME_STATUS_EDIT_REFUSAL);
    expect(RUNTIME_STATUS_EDIT_REFUSAL).toMatch(/Pause, Resume and Cancel/);
  });

  it("never the name, type or agent the runtime finds it by, nor the deleted mark", () => {
    for (const body of [{ name: "npx-outreach-2" }, { campaignType: "call" }, { agentId: "a" }, { deletedAt: NOW.toISOString() }, { description: "x", name: "y" }]) {
      expect(runtimeCampaignEditRefusal(RUNTIME, body), JSON.stringify(body)).toMatch(/cannot be changed here/);
    }
  });

  it("refuses a body that is not an object", () => {
    expect(runtimeCampaignEditRefusal(RUNTIME, null)).toMatch(/only its description/);
    expect(runtimeCampaignEditRefusal(RUNTIME, [])).toMatch(/only its description/);
  });

  it("leaves every other campaign's edits alone", () => {
    expect(runtimeCampaignEditRefusal(OLD, { name: "renamed", deletedAt: NOW })).toBeNull();
    expect(runtimeCampaignEditRefusal(OLD, { status: "paused" })).toBeNull();
    expect(runtimeCampaignEditRefusal(undefined, { name: "renamed" })).toBeNull();
  });

  it("never changes another campaign into a runtime one, which could become the row the runtime dials from (review of #531, round 3)", () => {
    expect(runtimeCampaignEditRefusal(OLD, { campaignType: "runtime_outbound" })).toBe(RUNTIME_TYPE_RESERVED_REFUSAL);
    expect(runtimeCampaignEditRefusal(OLD, { campaignType: "runtime_outbound", name: "npx-outreach", status: "running" })).toBe(RUNTIME_TYPE_RESERVED_REFUSAL);
    expect(runtimeCampaignEditRefusal(OLD, { campaignType: "call" })).toBeNull();
  });

  it("reservesRuntimeType reads only the runtime type, on an object body", () => {
    expect(reservesRuntimeType({ campaignType: "runtime_outbound", name: "x" })).toBe(true);
    for (const body of [{ campaignType: "call" }, { name: "npx-outreach" }, null, [], "runtime_outbound", { campaign_type: "runtime_outbound" }]) {
      expect(reservesRuntimeType(body), JSON.stringify(body)).toBe(false);
    }
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

  it("every route that can change a runtime campaign's status asks for an admin or a manager (review of #531)", () => {
    for (const path of [
      "app.post('/api/campaigns/:id/start'",
      "app.post('/api/campaigns/:id/pause'",
      "app.post('/api/campaigns/:id/resume'",
      "app.post('/api/campaigns/:id/cancel'",
      "app.post('/api/campaigns/:id/stop-outbound-scheduler'",
      "app.post('/api/campaigns/:id/start-outbound-scheduler'",
      "app.delete('/api/campaigns/:id'",
    ]) {
      const line = routeBody(path).split("\n")[0];
      expect(line, path).toContain("requireRole('admin', 'manager')");
    }
  });

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

  it("create: refuses the runtime type before a campaign is created", () => {
    const body = routeBody("app.post('/api/campaigns', isAuthenticated");
    const asked = body.indexOf("if (reservesRuntimeType(req.body))");
    expect(asked).toBeGreaterThan(0);
    expect(body.indexOf("RUNTIME_TYPE_RESERVED_REFUSAL", asked)).toBeGreaterThan(asked);
    expect(asked).toBeLessThan(body.indexOf("storage.createCampaign(campaignData)"));
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

/**
 * v277: the old executor refuses a runtime outbound campaign and changes
 * nothing. Before, its catch marked the campaign `cancelled`, so Resume
 * (and `/start`) on NPX outreach cancelled it — harmless while the runtime
 * ignored the status, and a stop of the runtime dialler once it reads it.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const rows = new Map<string, Record<string, unknown>>();
const updates: Array<{ id: string; updates: Record<string, unknown> }> = [];

vi.mock("../storage", () => ({
  storage: {
    getCampaign: async (id: string) => rows.get(id),
    updateCampaign: async (id: string, u: Record<string, unknown>) => {
      updates.push({ id, updates: u });
      rows.set(id, { ...rows.get(id), ...u });
      return rows.get(id);
    },
    getAgent: async () => ({ id: "agent-1", slug: "old-lane" }),
    getCampaignContacts: async () => [],
  },
}));
vi.mock("../../src/lib/twilioClient", () => ({
  getTwilioClient: async () => ({}),
  getTwilioFromPhoneNumber: async () => "+15555550100",
}));

const { CampaignExecutor, RuntimeCampaignRefusedError } = await import("./campaignExecutor");

beforeEach(() => {
  rows.clear();
  updates.length = 0;
  rows.set("runtime-1", { id: "runtime-1", name: "npx-outreach", campaignType: "runtime_outbound", status: "running", agentId: "agent-1" });
  rows.set("old-1", { id: "old-1", name: "Old", campaignType: "call", status: "scheduled", agentId: "agent-1" });
});

describe("the old executor on a runtime campaign", () => {
  it("refuses to run it and writes nothing", async () => {
    const executor = new CampaignExecutor();
    await expect(executor.executeCampaign("runtime-1")).rejects.toBeInstanceOf(RuntimeCampaignRefusedError);
    expect(updates).toEqual([]);
    expect(rows.get("runtime-1")!.status).toBe("running");
  });

  it("resume leaves it running, never cancelled", async () => {
    const executor = new CampaignExecutor();
    rows.set("runtime-1", { ...rows.get("runtime-1"), status: "paused" });
    await expect(executor.resumeCampaign("runtime-1")).rejects.toBeInstanceOf(RuntimeCampaignRefusedError);
    expect(updates.map((u) => u.updates.status)).toEqual(["running"]);
    expect(rows.get("runtime-1")!.status).toBe("running");
  });

  it("still marks an old campaign's failed run cancelled (the control)", async () => {
    const executor = new CampaignExecutor();
    rows.set("old-1", { ...rows.get("old-1"), status: "draft" });
    await expect(executor.executeCampaign("old-1")).rejects.toThrow(/cannot be executed/);
    expect(updates.map((u) => u.updates.status)).toEqual(["cancelled"]);
  });
});

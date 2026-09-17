/**
 * The Observatory's call page shows a tool call where it happened, the way
 * xAI's console does. `tool_timeline` records when a call ENDED and how long
 * it took, so the chip has to be moved back to its start — and a chip must
 * never be placed on a transcript that has no clock.
 */
import { describe, it, expect } from "vitest";
import { toolChipsFrom, interleave, type TimedTurn } from "./transcriptTimeline";

const T0 = Date.parse("2026-09-17T12:00:00.000Z");
const iso = (offsetMs: number) => new Date(T0 + offsetMs).toISOString();

describe("toolChipsFrom", () => {
  it("places the chip at the START of the call, not where the timeline recorded its end", () => {
    const [chip] = toolChipsFrom([{ at: iso(10_000), ms: 6_000, tool: "lookup_patient" }]);
    expect(chip.atMs).toBe(T0 + 4_000);
    expect(chip.ms).toBe(6_000);
    expect(chip.tool).toBe("lookup_patient");
  });

  it("an event with no duration sits at its recorded time", () => {
    const [chip] = toolChipsFrom([{ at: iso(10_000), tool: "check_open_tickets" }]);
    expect(chip.atMs).toBe(T0 + 10_000);
    expect(chip.ms).toBeNull();
  });

  it("an event with no usable time is not a chip — there is nowhere to put it", () => {
    expect(toolChipsFrom([{ ms: 5, tool: "x" }, { at: "not a date", tool: "y" }])).toEqual([]);
    expect(toolChipsFrom(null)).toEqual([]);
  });

  it("a refusal is marked, and the outcome and arguments ride along for the expander", () => {
    const [chip] = toolChipsFrom([
      { at: iso(1), ms: 1, tool: "file_optical_ticket", outcome: { success: false, missingFields: ["location"] }, args: { dobShape: "(none)" } },
    ]);
    expect(chip.ok).toBe(false);
    expect(chip.outcome).toEqual({ success: false, missingFields: ["location"] });
    expect(chip.args).toEqual({ dobShape: "(none)" });
  });

  it("an older event that named the tool as `name` still gets its name", () => {
    expect(toolChipsFrom([{ at: iso(1), name: "lookup_schedule" }])[0].tool).toBe("lookup_schedule");
  });
});

const turn = (role: "caller" | "agent", text: string, offsetMs?: number): TimedTurn => ({
  kind: "turn",
  role,
  text,
  ...(offsetMs === undefined ? {} : { at: iso(offsetMs) }),
});

describe("interleave", () => {
  it("puts a tool call between the two lines it ran between", () => {
    const rows = [turn("agent", "May I have your last name?", 0), turn("caller", "Fabian.", 3_000), turn("agent", "Found you.", 12_000)];
    const chips = toolChipsFrom([{ at: iso(10_000), ms: 6_000, tool: "lookup_patient" }]);
    const out = interleave(rows, chips);
    expect(out.map((r) => (r.kind === "tool" ? `tool:${r.tool}` : r.text))).toEqual([
      "May I have your last name?",
      "Fabian.",
      "tool:lookup_patient",
      "Found you.",
    ]);
  });

  it("a chip at exactly a line's time goes AFTER the line it followed", () => {
    const rows = [turn("caller", "Fabian.", 3_000), turn("agent", "Found you.", 12_000)];
    const chips = toolChipsFrom([{ at: iso(3_000), tool: "lookup_patient" }]);
    expect(interleave(rows, chips).map((r) => r.kind)).toEqual(["turn", "tool", "turn"]);
  });

  it("a flat-transcript fallback has no clock, so it gets no chips", () => {
    const rows = [turn("agent", "Hello"), turn("caller", "Hi")];
    const chips = toolChipsFrom([{ at: iso(1), tool: "lookup_patient" }]);
    expect(interleave(rows, chips)).toBe(rows);
  });

  it("one untimed line is enough to keep the chips off — a half-clocked transcript is not a clock", () => {
    const rows = [turn("agent", "Hello", 0), turn("caller", "Hi")];
    const chips = toolChipsFrom([{ at: iso(1), tool: "lookup_patient" }]);
    expect(interleave(rows, chips)).toBe(rows);
  });

  it("no chips: the rows come back as they were", () => {
    const rows = [turn("agent", "Hello", 0)];
    expect(interleave(rows, [])).toBe(rows);
  });

  it("two chips keep their timeline order on a tie", () => {
    const rows = [turn("agent", "Hello", 0), turn("caller", "Hi", 20_000)];
    const chips = toolChipsFrom([
      { at: iso(5_000), tool: "first" },
      { at: iso(5_000), tool: "second" },
    ]);
    expect(interleave(rows, chips).map((r) => (r.kind === "tool" ? r.tool : r.text))).toEqual(["Hello", "first", "second", "Hi"]);
  });
});

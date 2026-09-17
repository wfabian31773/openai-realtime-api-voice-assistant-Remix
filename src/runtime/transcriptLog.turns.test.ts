/**
 * EVERY TRANSCRIPT LINE KEEPS THE MOMENT IT WAS FIRST WRITTEN.
 *
 * The runtime's transcript was a flat string with no time in it, so the
 * Observatory's call page could not place a tool call between the two lines
 * it happened between and showed "the per-turn record for this call was
 * lost (instrumentation gap)" on every runtime call. `turns()` is what the
 * teardown write reads; this pins what the times MEAN.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { CallTranscriptLog } from "./transcriptLog";

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date("2026-09-16T14:54:00Z")); });
afterEach(() => vi.useRealTimers());

const T0 = Date.parse("2026-09-16T14:54:00Z");

describe("turns()", () => {
  it("gives each line its role, its words without the prefix, and its time", () => {
    const log = new CallTranscriptLog();
    log.openingLine("Thank you for calling.");
    vi.advanceTimersByTime(4_000);
    log.callerCompleted("I need to reschedule", "item-1");
    vi.advanceTimersByTime(3_000);
    log.agentLine("Of course. What is your last name?");
    expect(log.turns()).toEqual([
      { role: "agent", text: "Thank you for calling.", atMs: T0 },
      { role: "caller", text: "I need to reschedule", atMs: T0 + 4_000 },
      { role: "agent", text: "Of course. What is your last name?", atMs: T0 + 7_000 },
    ]);
    expect(log.render()).toBe(
      "AGENT: Thank you for calling.\nCALLER: I need to reschedule\nAGENT: Of course. What is your last name?",
    );
  });

  /** A caller line refined in place is the SAME utterance: it keeps the time
   *  the caller started, not the time the last re-emission landed. */
  it("a caller line refined in place keeps the time it was first written", () => {
    const log = new CallTranscriptLog();
    log.callerCompleted("I need", "item-1");
    vi.advanceTimersByTime(1_500);
    log.callerCompleted("I need to reschedule my surgery", "item-1");
    expect(log.turns()).toEqual([
      { role: "caller", text: "I need to reschedule my surgery", atMs: T0 },
    ]);
  });

  it("an amended opening keeps its time too", () => {
    const log = new CallTranscriptLog();
    const i = log.openingLine("Thank you for calling Azul Vision.");
    vi.advanceTimersByTime(2_000);
    log.amendAgentLine(i, "Thank you for calling Azul— [interrupted]");
    expect(log.turns()[0]).toEqual({ role: "agent", text: "Thank you for calling Azul— [interrupted]", atMs: T0 });
  });

  it("an empty call has no turns", () => {
    expect(new CallTranscriptLog().turns()).toEqual([]);
  });

  it("stays aligned with lines after every kind of write", () => {
    const log = new CallTranscriptLog();
    log.openingLine("Hello.");
    log.callerCompleted("Hi", "a");
    log.agentLine("How can I help?");
    log.callerCompleted("Refill", "b");
    log.callerCompleted("Refill please", "b");
    log.agentLine("Sure.");
    expect(log.turns().map((t) => `${t.role.toUpperCase()}: ${t.text}`)).toEqual(log.lines);
  });
});

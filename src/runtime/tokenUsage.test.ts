/**
 * The operator asked "at what rate are we cacheing tokens?" and the runtime
 * could not answer: 179 completed calls on 2026-09-03 wrote NULL to every
 * token column while the old core reported 77.0% cached over the same hours.
 *
 * These tests are mostly about ONE distinction — nothing reported is not the
 * same as nothing used — because collapsing it is what hid the gap.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  readUsage,
  describeUsageShape,
  usageShapeMarker,
  usageSummaryMarker,
  CallUsage,
} from "./tokenUsage";

/** The shape the realtime APIs document. Not assumed — see the module doc. */
function openAiShaped(over: Record<string, unknown> = {}) {
  return {
    type: "response.done",
    response: {
      usage: {
        input_tokens: 1200,
        output_tokens: 300,
        input_token_details: {
          text_tokens: 1000,
          audio_tokens: 200,
          cached_tokens: 940,
          cached_tokens_details: { text_tokens: 900, audio_tokens: 40 },
        },
        output_token_details: { text_tokens: 100, audio_tokens: 200 },
        ...over,
      },
    },
  };
}

describe("reading usage off a response", () => {
  it("reads the documented shape", () => {
    expect(readUsage(openAiShaped())).toEqual({
      inputTextTokens: 1000,
      inputAudioTokens: 200,
      outputTextTokens: 100,
      outputAudioTokens: 200,
      inputCachedTokens: 940,
      inputCachedTextTokens: 900,
      inputCachedAudioTokens: 40,
    });
  });

  it("finds usage at the top level too", () => {
    // Some implementations hang it there. Checking both costs nothing and
    // guessing wrong costs the entire measurement.
    const u = readUsage({ type: "response.done", usage: { input_token_details: { text_tokens: 7 } } });
    expect(u?.inputTextTokens).toBe(7);
  });

  it("accepts the plural spelling of the details keys", () => {
    const u = readUsage({ response: { usage: { input_tokens_details: { text_tokens: 5 } } } });
    expect(u?.inputTextTokens).toBe(5);
  });

  it("derives the cached total from its parts when it is not reported", () => {
    const u = readUsage({
      response: { usage: { input_token_details: { cached_tokens_details: { text_tokens: 60, audio_tokens: 5 } } } },
    });
    expect(u?.inputCachedTokens).toBe(65);
  });

  it("prefers a reported total over the sum of its parts", () => {
    // A provider whose total disagrees with its parts is doing its own
    // arithmetic; correcting it here would be inventing a number.
    const u = readUsage({
      response: {
        usage: {
          input_token_details: { cached_tokens: 500, cached_tokens_details: { text_tokens: 1, audio_tokens: 1 } },
        },
      },
    });
    expect(u?.inputCachedTokens).toBe(500);
  });

  it("returns NULL when the event carries no usage at all", () => {
    // The distinction this module exists for.
    expect(readUsage({ type: "response.done" })).toBeNull();
    expect(readUsage(undefined)).toBeNull();
    expect(readUsage("response.done")).toBeNull();
  });

  it("never invents a number from a malformed value", () => {
    const u = readUsage({
      response: { usage: { input_token_details: { text_tokens: "lots", audio_tokens: -5, cached_tokens: null } } },
    });
    expect(u).toEqual({
      inputTextTokens: 0, inputAudioTokens: 0, outputTextTokens: 0, outputAudioTokens: 0,
      inputCachedTokens: 0, inputCachedTextTokens: 0, inputCachedAudioTokens: 0,
    });
  });
});

describe("what the marker reports", () => {
  it("names the keys the provider sent, and no values", () => {
    const shape = describeUsageShape(openAiShaped());
    expect(shape).toContain("input_token_details{");
    expect(shape).toContain("cached_tokens");
    // Counts are not content, but the habit of logging shapes rather than
    // numbers is what keeps a log safe to read aloud.
    expect(shape).not.toContain("1200");
    expect(shape).not.toContain("940");
  });

  it('says "none" when the provider sent nothing — which is a real answer', () => {
    expect(describeUsageShape({ type: "response.done" })).toBe("none");
    expect(usageShapeMarker("none")).toContain("none");
  });

  it("puts the cache rate in the summary line", () => {
    const line = usageSummaryMarker({
      inputTextTokens: 1000, inputAudioTokens: 200, outputTextTokens: 100, outputAudioTokens: 200,
      inputCachedTokens: 940, inputCachedTextTokens: 900, inputCachedAudioTokens: 40,
    });
    expect(line).toContain("1200");
    expect(line).toContain("78.3%");
  });
});

describe("accumulating across a call", () => {
  beforeEach(() => vi.spyOn(console, "info").mockImplementation(() => {}));
  afterEach(() => vi.restoreAllMocks());

  it("sums every response", () => {
    const u = new CallUsage();
    u.add(openAiShaped());
    u.add(openAiShaped());
    expect(u.result()?.inputTextTokens).toBe(2000);
    expect(u.result()?.inputCachedTokens).toBe(1880);
  });

  it("returns UNDEFINED when no response ever reported usage", () => {
    /**
     * The heart of it. Undefined leaves the columns NULL, which truthfully
     * records "the provider told us nothing". Returning zeros would make a
     * missing feed indistinguishable from a call that used nothing — the exact
     * confusion that let 179 calls go unmeasured.
     */
    const u = new CallUsage();
    u.add({ type: "response.done" });
    u.add({ type: "response.done" });
    expect(u.result()).toBeUndefined();
  });

  it("keeps the tokens from responses that DID report, alongside ones that did not", () => {
    const u = new CallUsage();
    u.add({ type: "response.done" });
    u.add(openAiShaped());
    expect(u.result()?.inputTextTokens).toBe(1000);
  });

  it("describes the shape once per call, not once per response", () => {
    const u = new CallUsage();
    u.add(openAiShaped());
    u.add(openAiShaped());
    u.add(openAiShaped());
    const shapeLines = (console.info as unknown as { mock: { calls: string[][] } }).mock.calls
      .filter((c) => String(c[0]).includes("[TOKENS] usage reported"));
    expect(shapeLines).toHaveLength(1);
  });
});

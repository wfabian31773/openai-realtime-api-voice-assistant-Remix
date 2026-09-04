/**
 * WHICH PIPELINE SERVED A SET OF CALLS — as a pure decision, so the one
 * branch that matters can be tested without a browser.
 *
 * `voice_provider = 'grok'` is the Media Streams runtime; NULL is the OpenAI
 * SIP core. The Observatory never read that column, so on 2026-09-03 —
 * optical over at 15:24:58, surgery 19:43:57, tech 19:51:10, records
 * deliberately left behind as the same-day control — the one screen built to
 * watch these agents could not say which stack any card was showing.
 *
 * MIXED IS THE CASE THIS EXISTS FOR. A lane that cut over at 19:51 has two
 * populations in one day's number, and averaging them is how a migration
 * gets declared better or worse from noise. The label says so out loud
 * rather than leaving the reader to remember.
 *
 * Extracted from the component for the reason voiceCostRates.ts was
 * extracted from callCostService: a branch that cannot be tested is a branch
 * nobody checks.
 */

export type PipelineKind = "idle" | "runtime" | "legacy" | "mixed";

export interface PipelineSplit {
  kind: PipelineKind;
  /** What the Observatory card shows. Empty when there is nothing to say. */
  label: string;
}

export function describePipeline(counts: { runtime: number; legacy: number }): PipelineSplit {
  const runtime = Math.max(0, counts.runtime | 0);
  const legacy = Math.max(0, counts.legacy | 0);
  if (runtime + legacy === 0) return { kind: "idle", label: "" };
  if (runtime > 0 && legacy > 0) {
    return {
      kind: "mixed",
      label:
        `mixed pipelines — ${runtime} runtime (Grok), ${legacy} old core. ` +
        `Do not read these as one population.`,
    };
  }
  return runtime > 0
    ? { kind: "runtime", label: "Grok runtime (Media Streams)" }
    : { kind: "legacy", label: "OpenAI SIP core" };
}

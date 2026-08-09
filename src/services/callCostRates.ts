/**
 * COST RATES — the billing constants, with no client construction.
 *
 * Split out of callCostService because that module instantiates an OpenAI
 * client at import time, so it throws without OPENAI_API_KEY. Anything that
 * only wants to price a number of seconds (a report, an audit, a test) had to
 * hold API credentials to do it. This module is constants only.
 */

/**
 * Duration-based OpenAI estimate, used ONLY when token counts are missing.
 * 0.19 c/sec = 11.4 c/min — the blended gpt-realtime audio rate assuming a
 * 70/30 listen/speak split (the same split the historical backfill used).
 * The previous value (0.027 c/sec = 1.62 c/min) under-reported ~7x, and the
 * admin recalculate endpoint used 19 c/min — a units slip of this same
 * number. ALL duration estimates must use this constant.
 */
export const OPENAI_COST_CENTS_PER_SECOND = 0.19;

/**
 * src/config/techKeyterms.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * The medication and pharmacy vocabulary the medication-taking lanes hear, as
 * a transcription hint for Grok (`audio.input.transcription.keyterms`).
 *
 * WHY IT GREW, 2026-09-05. The list was six drug names, lifted from the
 * practice's Medication Requests classifier. That classifier exists to ROUTE a
 * call once the words are already transcribed; it was never a record of what
 * patients say, and using it as one left the ASR deaf to most of the formulary.
 *
 * The cost was measured on a real call. 2026-09-05 00:42 UTC, after hours: a
 * caller asked to refill Miebo. Speech-to-text returned it six different ways
 * — "Maibo", "My bowl", "Mebo", "Maibol", "N I E B O", "My bow, I dropped" —
 * the agent never saw a stable value, its prompt forbade proceeding on an
 * incomplete field, and it asked for the drug name ELEVEN times across eight
 * and a half minutes before the caller was left with no ticket at all. Miebo
 * was not in this file. It has been said on 31 calls since July.
 *
 * RANKED BY WHAT CALLERS ACTUALLY SAY. Every drug below was counted in real
 * transcripts (`call_logs`, 2026-07-01 onward) and ordered by how many calls
 * mention it. That replaces the old header's "no volume to rank on" — there is
 * volume, it simply had never been counted. The cut is FIVE mentions: below
 * that a term is spending one of a hundred slots that a provider name needs.
 *
 *   the six that were here     latanoprost 453 · timolol 346 · Restasis 181
 *                              Lumigan 139 · Xiidra 55 · Combigan 17
 *   the biggest that were NOT  dorzolamide 278 · brimonidine 199
 *                              prednisolone 142 · Acular 114 · Miebo 31
 *
 * dorzolamide and brimonidine are the practice's THIRD and FOURTH most-spoken
 * drugs and neither was here.
 *
 * THE COUNT IS A LOWER BOUND, and the bias runs one way. A drug only appears
 * in a transcript when ASR managed to transcribe it at least once, so the
 * drugs hurt worst by bad ASR are the ones most likely to be under-counted or
 * missing entirely. Re-run the count as the formulary changes; do not read a
 * zero as "nobody asks for it".
 *
 * DELIBERATELY EXCLUDED though it cleared the cut: bare "Refresh" (20). It is
 * an ordinary English verb, and biasing the transcriber toward it risks
 * mangling the many calls that use the word normally. "artificial tears"
 * below carries that category without the collision.
 *
 * Only words a CALLER would say are here. The classifier also matches routing
 * words — "callback", "records", "referral", "message" — which are ordinary
 * English and would waste slots a drug name needs.
 *
 * The prompts still tell the agent to ask again rather than guess a drug name
 * it did not catch. That stays: this reduces how often it fires, it does not
 * make a wrong name safe.
 *
 * NOTHING HERE IS PHI. These are drug and pharmacy names, not patients.
 */
export const TECH_KEYTERMS: readonly string[] = [
  // ── Drug names, most-spoken first (call counts since 2026-07-01). ────────
  'latanoprost',      // 453
  'timolol',          // 346
  'dorzolamide',      // 278
  'brimonidine',      // 199
  'Restasis',         // 181
  'prednisolone',     // 142
  'Lumigan',          // 139
  'Acular',           // 114
  'Xiidra',           //  55
  'moxifloxacin',     //  52
  'Cequa',            //  43
  'ofloxacin',        //  42
  'erythromycin',     //  36
  'Rocklatan',        //  36
  'Miebo',            //  31 — the call that prompted this file
  'Xdemvy',           //  23
  'Avastin',          //  21
  'Alphagan',         //  19
  'Rhopressa',        //  17
  'Combigan',         //  17
  'Vyzulta',          //  11
  'Systane',          //  10
  'Travatan',         //  10
  'ciprofloxacin',    //  10
  'Cosopt',           //  10
  'Azopt',            //   8
  'Vevye',            //   8
  'Maxitrol',         //   7
  'Upneeq',           //   7
  'Xalatan',          //   6
  'Eylea',            //   5
  'Lotemax',          //   5
  'Tyrvaya',          //   5
  // ── Categories callers use as names. ─────────────────────────────────────
  'glaucoma drops',
  'artificial tears',
  'allergy drops',
  'steroid drops',
  'antibiotic drops',
  'dry eye',
  // ── Pharmacies: proper nouns, routinely mangled. ─────────────────────────
  'CVS',
  'Walgreens',
  'Rite Aid',
  'Costco pharmacy',
  // ── The request itself, where the wording carries the meaning. ───────────
  'prescription refill',
  'prior authorization',
];

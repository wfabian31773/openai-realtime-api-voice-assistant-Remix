/**
 * src/config/techKeyterms.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * The medication and pharmacy vocabulary the medication-taking lanes hear, as
 * a transcription hint for Grok (`audio.input.transcription.keyterms`).
 *
 * WHY IT GREW, 2026-09-05. The list was six drug names, lifted from the
 * Medication Requests classifier. That classifier exists to ROUTE a call once
 * the words are already transcribed; it was never a record of what patients
 * say, and using it as one left ASR deaf to most of the formulary.
 *
 * The cost is on the record. 2026-09-05 00:42 UTC, after hours: a caller asked
 * to refill Miebo. Speech-to-text returned it six ways — "Maibo", "My bowl",
 * "Mebo", "Maibol", "N I E B O", "My bow, I dropped" — the agent never saw a
 * stable value, its prompt forbade proceeding on an incomplete field, and it
 * asked for the drug name ELEVEN times across eight and a half minutes before
 * leaving the caller with no ticket at all.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * RANKED BY STAFF-TYPED TICKETS, NOT BY TRANSCRIPTS. THIS IS THE WHOLE POINT.
 *
 * The first version of this file ranked by how often each drug appeared in
 * call transcripts. Codex rejected it, correctly: **a transcript count is
 * gated on the very ASR the keyterms exist to fix.** A drug the transcriber
 * always mangles scores zero and is excluded — so the method systematically
 * drops the exact vocabulary it is supposed to recover, while favouring the
 * names ASR already gets right. Labelling that a "lower bound" documented the
 * circularity without escaping it.
 *
 * The counts below come from ticket text TYPED BY STAFF (`created_by_id IS
 * NOT NULL`). A human at a keyboard is independent of the transcriber, which
 * is the property the ranking needs. The gap between the two sources measures
 * the damage:
 *
 *     drug          staff-typed   in transcripts
 *     Xiidra                157               55
 *     Miebo                  98               31
 *     Xdemvy                 72               23
 *     ketorolac              71     never appeared
 *     cyclosporine           70     never appeared
 *     bromfenac              39     never appeared
 *
 * ASR loses roughly two-thirds of the mid-frequency brand names and ALL of
 * several generics. Those are now in the list; under the transcript ranking
 * none of the bottom three could ever have qualified.
 *
 * AND THE TRANSCRIPT METHOD SHIPPED A GHOST. "Acular" ranked EIGHTH on 114
 * transcript mentions. Every one was the substring inside **macular** —
 * word-boundary matching returns 0 for Acular and 112 for "macular
 * degeneration", and staff have typed Acular fewer than three times ever. It
 * was a `LIKE '%acular%'` bug wearing a rank. Every count here is now matched
 * with `\m…\M` word boundaries on both sources.
 *
 * The cut is THREE staff-typed tickets. 42 drugs clear it.
 * ───────────────────────────────────────────────────────────────────────────
 *
 * DELIBERATELY EXCLUDED: bare "Refresh" — an ordinary English verb, and
 * biasing the transcriber toward it would collide with normal speech.
 * "artificial tears" carries the category without the collision.
 *
 * Only words a CALLER would say are here. The classifier also matches routing
 * words — "callback", "records", "referral" — which are ordinary English and
 * would waste slots a drug name needs.
 *
 * The prompts still tell the agent to ask again rather than guess a drug name
 * it did not catch. That stays: this reduces how often it fires, it does not
 * make a wrong name safe.
 *
 * NOTHING HERE IS PHI. Drug and pharmacy names, not patients.
 */
export const TECH_KEYTERMS: readonly string[] = [
  // ── Drugs, by staff-typed ticket count. ──────────────────────────────────
  'latanoprost',      // 415
  'timolol',          // 319
  'dorzolamide',      // 291
  'Restasis',         // 215
  'brimonidine',      // 167
  'Xiidra',           // 157   ASR sees 55
  'prednisolone',     // 148
  'Lumigan',          // 118
  'Miebo',            //  98   ASR sees 31 — the call that prompted this file
  'Cequa',            //  77
  'Xdemvy',           //  72   ASR sees 23
  'ketorolac',        //  71   ASR has never transcribed it
  'cyclosporine',     //  70   ASR has never transcribed it
  'Rocklatan',        //  45
  'Vyzulta',          //  42
  'bromfenac',        //  39   ASR has never transcribed it
  'Rhopressa',        //  38
  'moxifloxacin',     //  36
  'Vevye',            //  33
  'Cosopt',           //  31
  'erythromycin',     //  29
  'ofloxacin',        //  28
  'Combigan',         //  26
  'Alphagan',         //  25
  'Maxitrol',         //  18
  'Systane',          //  15
  'acetazolamide',    //  15
  'Tobradex',         //  13
  'loteprednol',      //  13
  'Pataday',          //  10
  'Travatan',         //  10
  'Durezol',          //   7
  'methazolamide',    //   7
  'Upneeq',           //   7
  'ciprofloxacin',    //   7
  'Lotemax',          //   7
  'Tyrvaya',          //   6
  'Azopt',            //   5
  'difluprednate',    //   4
  'Avastin',          //   4
  'Xalatan',          //   3
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

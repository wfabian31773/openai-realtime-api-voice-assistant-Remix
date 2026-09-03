/**
 * src/config/techKeyterms.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * The medication and pharmacy vocabulary the tech line hears, as a
 * transcription hint for Grok (`audio.input.transcription.keyterms`).
 *
 * NOT INVENTED HERE. Every term is lifted from the practice's own Medication
 * Requests classifier in `answeringServiceTicketing.ts`, which has been
 * routing these calls in production. Keeping it as its own export makes it
 * usable as ASR vocabulary without importing the classifier's whole taxonomy,
 * and makes the list reviewable on its own.
 *
 * Only the words a CALLER would say are here. The classifier also matches on
 * routing words — "callback", "records", "referral", "message", "question",
 * "help" — which are ordinary English and would waste keyterm slots that a
 * drug name needs, so they are deliberately left out.
 *
 * Tech's prompt still tells the agent to ask again rather than guess a drug
 * name it did not catch. That stays: this reduces how often it fires, it does
 * not make a wrong name safe.
 */
export const TECH_KEYTERMS: readonly string[] = [
  // Brand and generic names, the ones most often mis-heard.
  'Restasis',
  'Xiidra',
  'Lumigan',
  'latanoprost',
  'timolol',
  'Combigan',
  // Categories callers use as names.
  'glaucoma drops',
  'artificial tears',
  'allergy drops',
  'steroid drops',
  'antibiotic drops',
  'dry eye',
  // Pharmacies, which are proper nouns and routinely mangled.
  'CVS',
  'Walgreens',
  'Rite Aid',
  'Costco pharmacy',
  // The request itself, where the wording carries the meaning.
  'prescription refill',
  'prior authorization',
];

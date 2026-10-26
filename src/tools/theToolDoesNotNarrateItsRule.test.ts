/**
 * A CLASSIFY TOOL'S INSTRUCTION TO THE MODEL MUST NOT SIT IN THE CHANNEL THE
 * MODEL SPEAKS.
 *
 * CA…8dbb8dd441, surgery, 2026-09-16 17:06, 73 seconds. The caller said she
 * was checking on a surgery schedule for a detached retina. The lexicon fired
 * (`detached retina` is a Retinal Detachment Urgent cue), and the agent then
 * said, word for word:
 *
 *   "These are the words we treat as a surgical emergency."
 *   "Please seek emergency care or call 911 now. I've logged your urgent…"
 *
 * The first line is the tool's own `message` — written as an instruction TO
 * THE MODEL ("Tell the caller to seek emergency care… file this at urgent
 * priority. Do not take a routine message and hang up.") but placed in the one
 * field every other tool in the registry uses for WHAT THE AGENT SAYS.
 * `dobRefusalCopy` documents the convention: `message` is spoken, `fix` is for
 * the model. This tool had the two folded into one key, so the model narrated
 * its rule to a patient.
 *
 * WHAT IS AND IS NOT CHANGED. The spoken sentence is the prompt's own,
 * operator-approved direction ("tell them to seek emergency care or call 911
 * now"), in the caller's direction and nothing more. Whether "detached retina"
 * should fire on a SCHEDULING call is the lexicon, which is the operator's
 * (CLAUDE.md, the `can't see` precedent) and is not touched — the test below
 * uses that exact phrase because it is the corpus shape, and asserts only that
 * the rule is no longer read aloud. The catch-all branches on all four lanes
 * carried the same shape ("Nothing matched, so this is filed as…") and move to
 * `fix` for the same reason; they have nothing for the caller to hear.
 */
import { describe, it, expect } from 'vitest';

process.env.DATABASE_URL ??= 'postgres://user:pass@localhost:5432/db';
process.env.OPENAI_API_KEY ??= 'sk-test';

// Registration is an import side effect.
await import('./surgeryTools');
await import('./opticalTools');
await import('./techTools');
await import('./medicalRecordsTools');
const { getTool } = await import('./registry');

const run = (name: string, input: Record<string, unknown>) => getTool(name)!.handler(input);

/** The model-facing instruction, in every lane's wording. */
const INSTRUCTION = /words we treat|file (this )?at urgent|do not take a routine message|Nothing matched|does not match one of our|filed as "Other|leave the category off|Make sure it says/i;

describe('classify_surgery_request on an emergency', () => {
  it('speaks the direction to the caller and keeps the rule for the model', async () => {
    // The corpus shape: the lexicon fires on the diagnosis. That is the
    // lexicon's business; what is asserted is what gets SAID about it.
    const r: any = await run('classify_surgery_request', {
      request_description: 'checking on a surgery schedule for a detached retina',
    });
    expect(r.urgent).toBe(true);
    expect(r.message).toMatch(/call 911/i);
    expect(r.message, 'the rule is being read to the caller').not.toMatch(INSTRUCTION);
    expect(r.fix).toMatch(/words we treat as a surgical emergency/);
    expect(r.fix).toMatch(/urgent priority/);
  });

  it('a curtain over the vision gets the same two channels', async () => {
    const r: any = await run('classify_surgery_request', {
      request_description: 'there is a curtain over my left eye since this morning',
    });
    expect(r.urgent).toBe(true);
    expect(r.message).toMatch(/call 911/i);
    expect(r.message).not.toMatch(INSTRUCTION);
  });
});

describe('a catch-all classification has nothing for the caller to hear', () => {
  const CASES: Array<[string, Record<string, unknown>]> = [
    ['classify_surgery_request', { request_description: 'zebra quartz umbrella' }],
    ['classify_optical_request', { request_description: 'zebra quartz umbrella' }],
    ['classify_tech_request', { request_description: 'zebra quartz umbrella' }],
    ['classify_records_request', { request_description: 'zebra quartz umbrella' }],
  ];
  for (const [name, input] of CASES) {
    it(`${name}: the instruction is in fix, and message is absent`, async () => {
      const def = getTool(name);
      expect(def, `${name} is not registered`).toBeTruthy();
      const r: any = await def!.handler(input);
      expect(r.success).toBe(true);
      expect(r.classified).toBe(false);
      expect(r.message, `${name} would narrate its catch-all`).toBeUndefined();
      expect(r.fix).toMatch(/description/i);
    });
  }
});

describe('an ordinary classification says nothing at all', () => {
  it('surgery: a clearance form is classified with no message and no fix', async () => {
    const r: any = await run('classify_surgery_request', {
      request_description: 'my primary doctor needs the clearance form for my cataract surgery',
    });
    expect(r.success).toBe(true);
    expect(r.urgent).toBeUndefined();
    expect(r.message).toBeUndefined();
    expect(r.fix).toBeUndefined();
  });
});

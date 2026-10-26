/**
 * THE RECORDS PROMPT CARRIES THE FUNNEL — owner, 2026-09-27: *"we need the
 * voice agent to send SMS or emails with the link whenever a patient is
 * requesting records."* The tool half is `recordsFormAtCallTime.test.ts`; this
 * file pins what the MODEL is told: offer the link with the format in the
 * question, ask the email to be spelled out, give the spoken directions when
 * there is no mobile and no email, use the re-send tool, leave third parties
 * exactly as they were, and stop deferring the paperwork to the team — the
 * agent now sends it. `queuePromptRulings.test.ts` separately guards that every
 * pinned records ruling survived the rewrite.
 */
import { describe, it, expect, vi } from 'vitest';

// The agent modules validate the environment at import time; the same device
// queuePromptRulings.test.ts uses.
vi.hoisted(() => {
  process.env.DATABASE_URL ||= 'postgresql://unused:unused@127.0.0.1:5432/unused';
});

import { RECORDS_TOOLS, buildRecordsPrompt } from './recordsAgent';
import { WEBSITE_DIRECTIONS } from '../tools/medicalRecordsTools';

describe('the prompt and the plumbing', () => {
  it('the records lane carries the re-send tool', () => {
    expect(RECORDS_TOOLS).toContain('send_records_form');
    expect(RECORDS_TOOLS).toContain('file_records_ticket');
  });

  it('the prompt offers the link with the format in the question, gives the spoken directions, and no longer defers the paperwork to the team', () => {
    const prompt = buildRecordsPrompt({ callerPhone: '+17605551234' });
    expect(prompt).toMatch(/mobile number that receives texts, or would you rather have it by email/);
    expect(prompt).toMatch(/spell it out/i);
    expect(prompt).toContain(WEBSITE_DIRECTIONS);
    expect(prompt).toMatch(/send_records_form/);
    expect(prompt).toMatch(/do not ask on the phone/i);
    expect(prompt).not.toMatch(/records team does that/);
    // A third party still gets no form, in the prompt as in the tool.
    expect(prompt).toMatch(/another office, a plan, an attorney — gets no link and no form/);
  });
});

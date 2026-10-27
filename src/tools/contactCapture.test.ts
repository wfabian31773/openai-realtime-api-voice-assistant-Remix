import { beforeAll, describe, expect, it } from 'vitest';

const filingTools = [
  ['file_optical_ticket', 'opticalTools'],
  ['file_surgery_ticket', 'surgeryTools'],
  ['file_tech_ticket', 'techTools'],
  ['file_records_ticket', 'medicalRecordsTools'],
] as const;

beforeAll(async () => {
  await import('./sharedPatientTools');
  await Promise.all([
    import('./opticalTools'),
    import('./surgeryTools'),
    import('./techTools'),
    import('./medicalRecordsTools'),
  ]);
});

describe('agent-visible name and email capture instructions', () => {
  it('asks for an uncertain surname letter by letter', async () => {
    const { getTool } = await import('./registry');
    const lookup = getTool('lookup_patient');
    const lastName = lookup?.input_schema.properties.last_name;

    expect(lastName?.askAs).toMatch(/spell.*letter by letter/i);
    expect(lastName?.description).toMatch(/place name|transcription/i);
  });

  it.each(filingTools)('%s requires a full email read-back and confirmation', async (name) => {
    const { getTool } = await import('./registry');
    const email = getTool(name)?.input_schema.properties.email;

    expect(email?.description).toMatch(/read.*back/i);
    expect(email?.description).toMatch(/confirm/i);
    expect(email?.description).toMatch(/complete address unchanged/i);
  });
});

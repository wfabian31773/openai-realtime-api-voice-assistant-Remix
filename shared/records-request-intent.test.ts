import { describe, expect, it } from 'vitest';
import { recordsLinePurpose, recordsLineRedirect, recordsRequestText } from './records-request-intent';

describe('item #8 request evidence, independent of the model taxonomy', () => {
  it.each([
    'Please fax the notes before the appointment',
    'We have not received the records for our patient',
    'A health plan requests the chart for a risk adjustment audit',
    'The vendor requests copies of the medical records',
    'Necesito una copia de mi historial para mi cita',
    'the notes from the surgery, her PCP has not gotten the report',
    "I need a doctor's note",
    'Please email my results to my PCP',
    'Please provide my prescription',
    'I need my glasses prescription',
    'Copy of my records. Also, please reschedule my appointment.',
  ])('keeps the actual records request: %s', text => {
    expect(recordsLinePurpose(text)).toBe('records');
    expect(recordsLineRedirect(text)).toBeNull();
  });
  it.each([
    ['I do not need records; please reschedule my appointment', 'scheduling'],
    ['I called the medical records office to cancel my appointment', 'scheduling'],
    ['Please note that I need to change my appointment', 'scheduling'],
    ['I need someone to explain my test results', 'clinical'],
    ['Reprogramar mi cita por favor', 'scheduling'],
    ['The vendor has an insurance eligibility question', 'professional'],
    ['I have an office question', 'unknown'],
    ['Our surgery center is checking insurance eligibility', 'professional'],
    ['Our surgical center has a referral authorization question', 'referral'],
    ['I called the surgery center to reschedule my eye exam', 'scheduling'],
    ['REASON FOR CALL: PATIENT REQUEST - on the records clock (CAP reportable).\n\nPlease reschedule my appointment', 'scheduling'],
  ])('does not create a records request: %s', (text, purpose) => {
    expect(recordsLinePurpose(text)).toBe(purpose);
    expect(recordsLineRedirect(text)?.departmentId).not.toBe(16);
  });
  it('removes only generated CAP fields and preserves the request', () => {
    const request = 'Please move my appointment to Friday';
    expect(recordsRequestText(`PATIENT REQUEST — on the records clock (CAP reportable).\n\n${request}\n\nRequested by: patient [patient]\nSend to: on the signed form\nDates needed: on the signed form`)).toBe(request);
  });
});


describe('self-review: preserve the supported records workflows', () => {
  it.each([
    'Please fax my OCT images to my doctor',
    'I need copies of the visual field test',
    'ROI request',
    'Send me everything',
    'I need a letter for work',
    'Revisar mi expediente',
    'I want to inspect my file',
    'I need a work note',
    'Please complete my DMV form',
    'Necesito mis registros medicos',
    'I need my records before I schedule an appointment',
    'I do not need my chart, but please fax my operative report',
  ])('keeps genuine records work: %s', text => {
    expect(recordsLinePurpose(text)).toBe('records');
    expect(recordsLineRedirect(text)).toBeNull();
  });

  it.each([
    ['Do not send any records; please reschedule my appointment', 'scheduling'],
    ["Don't fax my chart. Please cancel my appointment", 'scheduling'],
    ['No need to send records; I have a billing question', 'billing'],
    ['I need to review my test results with the doctor', 'clinical'],
  ])('does not infer access from a refused or clinical request: %s', (text, purpose) => {
    expect(recordsLinePurpose(text)).toBe(purpose);
  });

  it.each([
    ['I need to be seen today', 151],
    ['Do you have any openings?', 150],
    ['I need an earlier appointment', 151],
    ['Confirmación de la cita', 149],
    ['Cancelación de la cita', 148],
    ['Quiero mover mi cita', 147],
  ])('preserves the established scheduling reason: %s', (text, reason) => {
    expect(recordsLineRedirect(text)).toMatchObject({ departmentId: 9, requestTypeId: 32, requestReasonId: reason });
  });
});


describe('review regressions: records evidence follows the caller request', () => {
  it.each([
    'test results', 'lab results', 'exam results', 'diagnostic results',
    'progress notes', 'consultation notes', 'visit notes', 'office notes',
    'surgery notes', 'surgical notes', 'operative notes', 'notes',
    'medical report', 'operative report', 'surgical report', 'optometry report', 'consultation report', 'op report', 'reports',
    'imaging', 'OCT images', 'visual field', 'VF', 'DRS', 'fundus images', 'topography',
    'documentation', 'historial', 'informes', 'results',
  ])('honors a refusal to send %s', document => {
    const text = `Don't send my ${document}; please reschedule my appointment`;
    expect(recordsLinePurpose(text)).toBe('scheduling');
    expect(recordsLineRedirect(text)).toMatchObject({ departmentId: 9, requestTypeId: 32, requestReasonId: 147 });
  });

  it.each([
    'Can someone explain the test results that were sent to me?',
    'Please interpret the lab results that were emailed to me',
    'I have a question about my exam results that were faxed',
    'I need to review the results that were mailed with my doctor',
    'Can you explain the test results my doctor will send me?',
    'I want someone to explain the test results I get in the mail',
    'Can someone get a doctor to explain my test results?',
    'Can you explain my test results that I need to send to my doctor?',
  ])('keeps delivered results interpretation in clinical: %s', text => {
    expect(recordsLinePurpose(text)).toBe('clinical');
    expect(recordsLineRedirect(text)).toMatchObject({ departmentId: 3 });
  });

  it.each([
    "I don't need my whole chart, just send the operative report",
    "I don't need my chart, only fax the consultation notes",
    "I don't need my chart, but please send my test results",
    "I don't need my chart; please send my imaging",
    'I need documentation from my last visit',
    'Please send documentation from my last visit',
    'Documentation from my last visit',
  ])('preserves the affirmative document request: %s', text => {
    expect(recordsLinePurpose(text)).toBe('records');
    expect(recordsLineRedirect(text)).toBeNull();
  });
});

describe('latest review: preserve the affirmative request', () => {
  it.each([
    'I need a medical report',
    'I need my medical reports',
    'Please fax my medical report to my doctor',
  ])('keeps established medical report requests in Medical Records: %s', text => {
    expect(recordsLinePurpose(text)).toBe('records');
    expect(recordsLineRedirect(text)).toBeNull();
  });

  it.each([
    'Please send my test results so I can discuss them with my doctor',
    'Please fax my records to my surgeon to discuss surgery',
    'Could you send my lab results so my doctor can interpret them?',
    'I need copies of my test results to discuss with my doctor',
    'Please email my lab results so I can review them with my doctor',
    'I want you to fax my records to discuss surgery with my surgeon',
    'Please get my test results so I can discuss them with my doctor',
    'Could you have my test results sent so I can discuss them with my doctor?',
    'Can someone please have my lab results faxed so my doctor can interpret them?',
    'I need you to have my records emailed so I can discuss them with my doctor',
    'Please have my medical report sent so I can discuss it with my doctor',
  ])('keeps explicit delivery in Medical Records: %s', text => {
    expect(recordsLinePurpose(text)).toBe('records');
    expect(recordsLineRedirect(text)).toBeNull();
  });

  it.each([
    'Could you have someone explain my test results that were sent to me?',
    'Could you have my doctor discuss the test results that were sent to me?',
    'I have my test results sent to me so I can discuss them with my doctor',
  ])('keeps interpretation requests in Clinical: %s', text => {
    expect(recordsLinePurpose(text)).toBe('clinical');
    expect(recordsLineRedirect(text)).toMatchObject({ departmentId: 3 });
  });

  it.each([
    'I do not need records, please reschedule my appointment',
    "I don't need my chart, can you reschedule my appointment?",
    'I do not need records, I want to reschedule my appointment',
    'I do not need records, reschedule my appointment',
    'I do not need records for my canceled appointment, please reschedule my appointment',
  ])('preserves rescheduling after a records refusal: %s', text => {
    expect(recordsLinePurpose(text)).toBe('scheduling');
    expect(recordsLineRedirect(text)).toMatchObject({
      departmentId: 9, requestTypeId: 32, requestReasonId: 147,
    });
  });

  it.each([
    ['I do not need records, please cancel my appointment', 'scheduling', 9, 32, 148],
    ['I do not need records, please confirm my appointment', 'scheduling', 9, 32, 149],
    ['I do not need records, please help with my billing question', 'billing', 4, 78, 548],
    ['Do not send my records, the results, or my imaging', 'unknown', 9, 69, 539],
  ])('keeps the remaining callback intent without reviving refusals: %s', (text, purpose, departmentId, requestTypeId, requestReasonId) => {
    expect(recordsLinePurpose(text)).toBe(purpose);
    expect(recordsLineRedirect(text)).toMatchObject({ departmentId, requestTypeId, requestReasonId });
  });
});

describe('review regressions: delivery, corrections, and access questions', () => {
  it.each([
    'I need my test results sent to my doctor so I can discuss them with her',
    'I want my lab results faxed to my doctor so she can interpret them',
    'I would like my medical records mailed to me so I can review them with my doctor',
  ])('recognizes passive delivery requests: %s', text => {
    expect(recordsLinePurpose(text)).toBe('records');
    expect(recordsLineRedirect(text)).toBeNull();
  });

  it.each([
    ["I don't need records, I have a billing question", 'billing', 4],
    ["I don't need my chart, my glasses are broken", 'optical', 1],
    ["I don't need my chart, we have an insurance question", 'professional', 18],
    ["I don't need records, I have a question about getting my lab results", 'records', null],
  ])('preserves an independent correction after a refusal: %s', (text, purpose, departmentId) => {
    expect(recordsLinePurpose(text)).toBe(purpose);
    if (departmentId === null) expect(recordsLineRedirect(text)).toBeNull();
    else expect(recordsLineRedirect(text)).toMatchObject({ departmentId });
  });

  it.each([
    'Do not send my records, my chart, or my imaging',
    "I don't need my records, my chart, or my test results",
  ])('does not revive a comma-separated list of refused documents: %s', text => {
    expect(recordsLinePurpose(text)).toBe('unknown');
    expect(recordsLineRedirect(text)).toMatchObject({ departmentId: 9 });
  });

  it.each([
    'I have a question about getting a copy of my medical records',
    'I have a question about the status of my records request',
    'I have a question about getting my test results',
    'I have a question about obtaining test results',
    'I have a question about the status of my test results',
    'I have a question about getting a copy of my test results so I can discuss them with my doctor',
    'I have a question about my medical records',
  ])('recognizes records access and status questions: %s', text => {
    expect(recordsLinePurpose(text)).toBe('records');
    expect(recordsLineRedirect(text)).toBeNull();
  });

  it.each([
    'I have a question about my exam results that were faxed',
    'I have a question about my test results before I get copies',
    'I have a question about what my test results mean',
    'I have a question about the meaning of my lab results',
  ])('keeps questions about interpreting results in Clinical: %s', text => {
    expect(recordsLinePurpose(text)).toBe('clinical');
    expect(recordsLineRedirect(text)).toMatchObject({ departmentId: 3 });
  });
});

describe('review regressions: copy requests and scheduled exams', () => {
  it.each([
    'Can someone explain my test results and send me a copy?',
    'Please interpret my lab results and fax them to my doctor',
    'Can you discuss my results and have my records sent to me?',
    'Can you explain my results and I need my test results sent to me?',
    'Can you explain my results and I want a copy?',
    'Can someone explain my MRI and send me a copy?',
    'I need a copy of my MRI',
    'Please send me a copy of my x-rays',
    'Necesito una copia de mis resultados',
    'Please send me a copy of my last eye exam',
    'Please send me a copy of my file',
    'Copy of my MRI',
    'I have a question about getting a copy of my MRI',
    'I have a question about getting a copy of my MRI so I can discuss it with my doctor',
    'I need my records before I schedule an appointment',
    'I need to schedule a visual field exam and send me my records',
    'I need to schedule an OCT appointment and I need my records',
  ])('keeps requested copies or delivery in Medical Records: %s', text => {
    expect(recordsLinePurpose(text)).toBe('records');
    expect(recordsLineRedirect(text)).toBeNull();
  });

  it.each([
    'I need to schedule a visual field exam',
    'I want to book an OCT appointment',
    'Please schedule my visual field exam',
    'I need to schedule an appointment for an OCT',
    'I need to schedule my OCT',
    'I need to schedule my OCT and get a ride to the appointment',
  ])('routes an exam scheduling request to HVA Hub: %s', text => {
    expect(recordsLinePurpose(text)).toBe('scheduling');
    expect(recordsLineRedirect(text)).toMatchObject({ departmentId: 9, requestTypeId: 32, requestReasonId: 146 });
  });

  it.each([
    'Can someone explain my test results and tell me when they were sent?',
    'Please interpret my lab results and confirm they were faxed to my doctor',
    'Can you explain my test results and why I need to send them to my doctor?',
    'Can you explain my results and can you tell me why I need to send them?',
    'Can you explain my test results and get a doctor to interpret them?',
    'Can you explain my results and get a doctor to discuss my test results?',
  ])('does not mistake interpretation or historical delivery for a copy request: %s', text => {
    expect(recordsLinePurpose(text)).toBe('clinical');
    expect(recordsLineRedirect(text)).toMatchObject({ departmentId: 3 });
  });

  it.each([
    ['I do not need a copy of my MRI; please reschedule my appointment', 'scheduling'],
    ["Don't send me a copy of my file; I have a billing question", 'billing'],
    ['I already have a copy of my MRI', 'unknown'],
    ['I need to know whether you sent me a copy of my MRI', 'unknown'],
    ['I need to discuss my results, not a copy of my MRI', 'clinical'],
    ['I need someone to discuss a copy of my MRI', 'unknown'],
  ])('does not infer a generic copy request from a refusal or history: %s', (text, purpose) => {
    expect(recordsLinePurpose(text)).toBe(purpose);
    expect(recordsLineRedirect(text)?.departmentId).not.toBe(16);
  });
});

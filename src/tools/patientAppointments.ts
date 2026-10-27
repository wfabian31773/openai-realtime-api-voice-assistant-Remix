import { registerTool } from './registry';
import { verifiedIdentityFor } from './verifiedIdentity';
import { appointmentAccess } from '../services/appointmentAccess';
import { appointmentReadPolicy } from '../services/appointmentReadPolicy';

registerTool({
  name: 'check_patient_appointments',
  layer: 'agent',
  timeoutMs: 4000,
  description: 'Read the matched patient\'s upcoming appointments or check a provider/office the caller names. Uses the patient already established on this call; never searches by a model-supplied name or ID. ' + appointmentReadPolicy('check_patient_appointments'),
  input_schema: {
    type: 'object',
    properties: {
      provider: { type: 'string', description: 'Provider the caller named, if any.', askAs: 'Which provider did you mean?' },
      office: { type: 'string', description: 'Office the caller named, if any.', askAs: 'Which office did you mean?' },
    },
  },
  handler: async (input) => {
    const identity = verifiedIdentityFor(typeof input.call_sid === 'string' ? input.call_sid : undefined);
    if (!identity) return {
      success: true, appointment_access: 'identity_required', read_only: true,
      scheduling_action: 'establish_identity',
      appointment_instruction: 'Use lookup_patient to establish the patient record before reading appointments. Do not guess an identity or repeatedly search an unresolved caller; take their request with the match unresolved if necessary.',
    };
    if (!identity.personId) return {
      success: true, appointment_access: 'unavailable', read_only: true,
      has_upcoming_appointments: null, scheduling_action: 'request_schedule_review',
      appointment_instruction: 'The matched record has no person key for another schedule read. Use any appointments already returned on this call; otherwise take a schedule-review request. Do not re-search the identified patient or claim there are no bookings.',
    };
    const { scheduleLookupService } = await import('../services/scheduleLookupService');
    const context = await scheduleLookupService.lookupByPersonId(identity.personId, 'name_and_dob', Date.now() + 3500);
    // The read may finish after an explicit identity invalidation. Never return
    // that former patient's schedule on a call now about somebody else.
    if (verifiedIdentityFor(typeof input.call_sid === 'string' ? input.call_sid : undefined)?.personId !== identity.personId) {
      return { success: true, ...appointmentAccess(context, false) };
    }
    return { success: true, ...appointmentAccess(context, true, {
      provider: typeof input.provider === 'string' ? input.provider : undefined,
      office: typeof input.office === 'string' ? input.office : undefined,
    }) };
  },
});

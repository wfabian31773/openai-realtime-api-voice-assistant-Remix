/**
 * THE CALL LOG AS THE API RETURNS IT. Moved out of `server/routes.ts` (v223)
 * so the shape every call-log route answers can be tested without loading the
 * route file, which validates the environment and opens the database at
 * import.
 *
 * Every route that hands a call log to the Observatory goes through this:
 * the list (`/api/call-logs`), the urgent list and its CSV, the voicemail
 * list, one call (`/api/call-logs/:id`) and the call page
 * (`/api/call-logs/:id/detail`).
 */
import { ticketNumbersForCall } from './callTicketNumbers';

// Helper to normalize call log fields to camelCase for frontend compatibility
export function normalizeCallLog(log: any) {
  return {
    ...log,
    transferredToHuman: log.transferredToHuman ?? log.transferred_to_human ?? false,
    transcript: log.transcript ?? log.transcript_text ?? null,
    recordingUrl: log.recordingUrl ?? log.recording_url ?? null,
    callerName: log.callerName ?? log.caller_name ?? null,
    patientName: log.patientName ?? log.patient_name ?? null,
    ticketNumber: log.ticketNumber ?? log.ticket_number ?? null,
    /**
     * v223: every ticket the call created, the row's own first. One column
     * holds one number, and 15 calls in the 14 days to 2026-11-13 had two
     * tickets; the second was in the call's tool timeline or nowhere. See
     * callTicketNumbers.ts.
     */
    ticketNumbers: ticketNumbersForCall(log),
    createdAt: log.createdAt ?? log.created_at,
    updatedAt: log.updatedAt ?? log.updated_at,
    fromCarrier: log.fromCarrier ?? log.from_carrier ?? null,
    toCarrier: log.toCarrier ?? log.to_carrier ?? null,
    fromConnectionType: log.fromConnectionType ?? log.from_connection_type ?? null,
    toConnectionType: log.toConnectionType ?? log.to_connection_type ?? null,
    fromCountry: log.fromCountry ?? log.from_country ?? null,
    toCountry: log.toCountry ?? log.to_country ?? null,
    whoHungUp: log.whoHungUp ?? log.who_hung_up ?? null,
    postDialDelayMs: log.postDialDelayMs ?? log.post_dial_delay_ms ?? null,
    lastSipResponse: log.lastSipResponse ?? log.last_sip_response ?? null,
    edgeLocation: log.edgeLocation ?? log.edge_location ?? null,
    twilioInsightsFetchedAt: log.twilioInsightsFetchedAt ?? log.twilio_insights_fetched_at ?? null,
  };
}

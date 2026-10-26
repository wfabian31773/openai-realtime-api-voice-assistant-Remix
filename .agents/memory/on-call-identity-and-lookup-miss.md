# On-call identity before transfer, and a lookup miss that is not "not found"

VA-76222 (internal 67395) and VA-76221 (internal 67394). Ticket ids only — no
PHI in this file.

## VA-76222 — failed on-call transfer filed as Unknown Caller

An urgent-symptom call was routed to on-call, the transfer failed, and the
callback ticket was saved as "Unknown Caller" with no name and no date of
birth.

**Cause.** `escalate_to_human` transferred first and collected nothing. The
failed-transfer safety net (`urgentFallbackTicketParams`, used by both
pipelines) then filed `patientFirstName: 'Unknown'` + `patientLastName:
'Caller'`. `/submit-ticket` refuses that pair; `/create-ticket` used to save
it. The ANI was not stamped on `callbackNumber` unless the model passed one.

**Fix.** Before an on-call transfer, collect name and DOB in at most one
quick prompt (`decideOnCallIdentityAsk`). A 911-level emergency (chemical,
trauma, sudden vision loss, bleeding) or a clinician goes straight through.
If the caller cannot or will not give details, transfer anyway. Both first
and last name are required before skipping the ask. A batched sibling of
the ask (same 2s window as records) repeats the ask and does not dial. The
calling number (ANI) is always the callback — a model-supplied number never
overrides it, including on the successful-transfer record ticket. A failed
transfer's ticket uses `nameOrStandIn` (never Unknown Caller) and carries
whatever identity was captured. A `need_identity` result is not a transfer;
the model asks once and calls the tool again. The Grok CRITICAL line says
the same: at most once after a sanctioned transfer, not once per call.

## VA-76221 — "not found in system" while visit history matched

The agent told the caller they were not found, then visit history matched the
same patient once the spoken name was corrected to the name on the schedule.

**Root cause.** `lookup_schedule` on the after-hours agent called
`lookupByNameAndDOB` only — a STRING match on what the caller (or the
transcriber) said. The same call already held a phone-loaded schedule with
the chart name and the visits. Two queries, two answers. The tool returned
`{ found: false }`; the prompt then told the model to note "existing
patient — not found in system".

**Fix.** When the spoken trio misses and the spoken first name agrees with
the chart, re-run with the chart name and the spoken date of birth — never
the previously held one. Only a unique `name_and_dob` hit is accepted on
both `lookup_schedule` and `lookup_patient`; a name-only or ambiguous
fallthrough is another person, not this caller. If a
visit-history match still cannot be confirmed, the spoken line is "Let me
make sure the team has your details." Never tell the caller they are not
found when a schedule match exists.

Synthetic fixtures only. `src/agents/noIvrOnCallIdentityAndLookup.test.ts`.

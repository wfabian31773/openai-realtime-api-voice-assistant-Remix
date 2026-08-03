# PCP Support launch runbook

The PCP Support line is implemented under the hardcoded agent slug `pcp`. It is a professional-caller line, not a patient line. It uses the ticketing app's dedicated caller-first endpoint and never uses the patient `create-ticket` or `submit-ticket` endpoints.

## Workflow boundaries

The hotline uses these operational boundaries:

1. Professional verification occurs after the request is received. The call stores `pending`; the agent does not attempt or claim verification during the call.
2. Explicit requests for copies or release of patient medical records are isolated for manual review and remain accountable to the patient medical-records process. Peer-to-peer, medical-group, referral, grievance, and other PCP requests never enter that pathway.

## Configuration

Voice service secrets:

- `PCP_TWILIO_PHONE_NUMBER`: dedicated inbound E.164 number.
- `PCP_HUMAN_AGENT_NUMBER`: dedicated PCP human queue in E.164 format. There is deliberately no fallback to `HUMAN_AGENT_NUMBER`.
- `PCP_PHARMA_HANDOFF_ENABLED`: defaults to false; pharmaceutical callers create tasks unless this is explicitly set to `true` after operations approves the live destination.
- `TICKETING_ENRICHMENT_URL`: direct ticketing-app origin. PCP traffic bypasses n8n and its patient-oriented contract.
- Existing `TICKETING_API_KEY`, `TWILIO_*`, `OPENAI_*`, and `DISABLE_PHI_LOGGING=true` remain required.

Ticketing service secrets:

- `VOICE_AGENT_API_KEY` must match the voice service's `TICKETING_API_KEY`.
- `PCP_SUPPORT_ASSIGNEE_EMAILS` and `PCP_SUPPORT_WORKSPACE_EMAILS` configure launch staff in the ticketing seed.

## Database preparation

Ticketing app, in order:

1. Apply `server/migrations/0003_pcp_support_columns.sql` in the normal migration transaction.
2. Apply `server/migrations/0004_pcp_support_indexes.sql` outside a transaction because it uses `CREATE INDEX CONCURRENTLY`.
3. Run `npm run seed:pcp-support` and verify exactly one active `pcp_support` department plus its request types/reasons.

Voice service:

1. Set `PCP_TWILIO_PHONE_NUMBER` and `PCP_HUMAN_AGENT_NUMBER`.
2. Run `npm run seed:pcp-agent`.
3. Verify the `agents` row has slug `pcp`, status `active`, and the dedicated Twilio number.

The seed scripts are idempotent. They were not run as part of this code change.

## Twilio setup

On the dedicated PCP number, configure the incoming Voice webhook as:

- Method: `POST`
- URL: `https://<voice-domain>/api/voice/pcp`

Do not point this number at the generic IVR or after-hours route. The PCP route stamps `X-agentSlug=pcp` into the OpenAI SIP leg. The OpenAI realtime webhook remains the service-wide `/api/voice/realtime` endpoint.

## Acceptance checks

Run one controlled call per case and inspect the stored ticket/call record, not only the spoken result:

1. Public provider/service information: `AUTOMATE`, no ticket, no PHI.
2. Unbacked plan/accessibility/accommodation request: `CREATE_TASK`, PCP taxonomy, no SMS.
3. Peer-to-peer: a PCP ticket exists before dialing; success records `CONNECTED`.
4. Unanswered PCP handoff: the same call SID updates the same ticket to `CREATE_TASK` with `NO_ANSWER`; no patient/after-hours ticket is created.
5. Patient schedule question while staff verification is pending: collect the required caller and patient context, use the schedule source, and retain `pending` for post-call review.
6. Explicit patient medical-record request: create the isolated manual-review task; do not classify peer-to-peer or medical-group work as a records request.

Also verify recording/transcript enrichment, `agent_used = 'pcp'`, caller facility filters, assignment, and workspace visibility.

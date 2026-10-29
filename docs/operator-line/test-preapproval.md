# Operator-line test pre-approval

The server can approve a narrow synthetic test lane in `POST /api/plugin/v1/prepare_operator_call`. It is **off by default**. Every condition must pass: a valid dedicated operator caller ID, an allowlisted E.164 destination, a committed scenario script, available rolling quota, and a time outside the Pacific peak window. Other valid requests remain `pending_approval` for the existing human review. A missing/invalid caller ID retains the existing HTTP 503 behavior.

| Environment variable | Default / meaning |
| --- | --- |
| `OPERATOR_TEST_PREAPPROVAL_ENABLED` | Off; only the exact string `true` enables it. |
| `OPERATOR_LINE_FROM_NUMBER` | No default. Required E.164 caller ID, distinct from the SI Assistant number; checked at prepare and commit. The actual call uses this number. |
| `OPERATOR_TEST_ALLOWLIST` | Empty extra list. Comma-separated additional E.164 **test** destinations. The sole built-in destination is QVO `+19094795435`; no after-hours lane or personal numbers are included. |
| `OPERATOR_TEST_MAX_AUTO_APPROVALS` | `10`, a positive integer; global across bots, destinations and scenarios. |
| `OPERATOR_TEST_WINDOW_HOURS` | `24`, positive hours (fractions supported, up to 365 days). |
| `OPERATOR_TEST_PEAK_DAYS` | `Mon,Tue,Wed,Thu,Fri`; comma-separated English three-letter day names. |
| `OPERATOR_TEST_PEAK_START` | `08:00`, Pacific local time, inclusive. |
| `OPERATOR_TEST_PEAK_END` | `17:00`, Pacific local time, exclusive. Weekends are allowed by default. Overnight windows belong to their starting day. |

Peak checks always use `America/Los_Angeles`, including daylight saving time. Invalid limits, times, days or allowlist entries disable auto-approval and retain human review. Start and end must differ. Existing `PLUGIN_WRITES_ENABLED=true`, caller payload validation, and duration limits (default 600 seconds; range 30–1800) still apply. Deployment environment configuration is the only way to add test destinations; the bot cannot modify it.

Send the complete contents of a committed `scenarios/*.md` file as `callerScript`. Optional `scenarioId` is the filename without `.md` (for example, `family-bookings`) and must match that script. Without an ID, the server finds the scenario by exact SHA-256 match. Hash normalization converts CRLF/CR to LF and trims outer whitespace; words and internal spacing remain exact. Free text, unknown IDs, mismatched IDs and changed scripts require human approval. Client-supplied rule/approval overrides are rejected.

`scenarios/manifest.json` maps IDs to hashes of the complete files, including their success criteria. Run `npm run operator:scenarios:check` after changes; Vitest also verifies all five files. Update the reviewed manifest when committing scenario changes. The server verifies and loads the deployed files once at startup, from `docs/operator-line/scenarios` under its working directory. Missing/stale assets disable this rule. Restart to load a new manifest.

Successful prepare returns HTTP 201 with `status: "auto_approved"` and an approval containing `autoApproved: true`, `approvedBy: "test-preapproval-rule"`, `scenarioId` and `approvalReason`. Prepare never dials. The preparing bot then fetches `GET /contact_requests/:id/confirm_token` once and posts it to `/commit_call_live` within the existing five-minute expiry. Ownership, hash validation, single-use consumption, opt-outs, transcript persistence and duration limits still apply. The rule adds no bot scope and changes no staff permission; bots must never receive `contacts:approve`.

Approvals stay in `contact_approvals`, marked `approved_by='test-preapproval-rule'`. The separate `preapproval_rule` JSON records the reason, scenario ID/hash and bound caller ID; execution results do not overwrite it. Existing `plugin_audit_log` entries reference the approval with outcome `approved`. Scripts and transcripts remain in their existing protected storage and retrieval paths. No new log contains phone numbers, scripts, purpose, transcripts or secrets; public approval views mask destination numbers to their last four digits.

The database counts every auto-approved row with `approved_at > now - window`, including later committed, cancelled, failed and expired confirmations. Pending and human-approved rows do not count. A transaction-scoped advisory lock serializes count-and-approve across server instances; quota is never released by cancellation. Missing rule storage falls back to human review. This requires the separately reviewed, **unapplied** migration `migrations/add_operator_test_preapproval.sql` (one column, partial index and invoker-only function; no new tables). The server's existing owner connection uses READ COMMITTED transactions; other isolation levels decline auto-approval.

To enable, apply the migration separately through the normal deployment process, configure the caller ID and set `OPERATOR_TEST_PREAPPROVAL_ENABLED=true` in the server deployment environment, then restart/redeploy. To stop, set it to `false` (or remove it) and restart/redeploy **all instances**. Outstanding auto-approved confirmations also recheck the switch, allowlist, scenario, peak time and bound caller ID before commit. They cannot dial while the rule no longer applies; prepare a new request for human approval. Already active calls keep their existing end controls and hard duration limit. Human-approved calls keep their normal behavior.

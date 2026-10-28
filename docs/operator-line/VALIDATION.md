# Validation (2026-10-28)

`npx tsc -p . --noEmit`: passed, exit 0.

The final focused run passed **134 tests in 7 files**, including 34 operator API/storage tests and 2 operator agent tests:

```bash
npx vitest run src/plugin/operatorLine.test.ts src/agents/operatorLineAgent.test.ts \
  src/plugin/liveCalls.test.ts src/plugin/liveSessions.test.ts \
  src/agents/siAssistantAgent.test.ts src/runtime/outbound/outboundLanes.test.ts \
  src/tools/outboundTools.test.ts
```

Coverage includes explicit bot scopes and incompatible human minting; human approval and owner-only handoff/commit; payload tampering; concurrent confirm reuse and five-minute expiry; voice/SMS/international opt-outs; missing or SI Assistant caller IDs; duration validation; REST hard stops with and without an attached bridge; late call binding and delayed preparation; patient-free instructions/tool bindings; the unchanged SI Assistant number/window/caps/tools; complete ordered transcript retrieval after memory expiry; bridge-finalization amendments; and the SQL adapter.

The requested full `npx vitest run` completed: **7,049 passed, 134 failed, 16 skipped**; 362 files passed, 5 failed, 1 skipped. It ran before the final additional edge-case tests and cleanup. Its failures were confined to:

| File | Failure |
| --- | --- |
| `src/agents/noIvrPromptShapeForGrok.test.ts` | Existing prompt is 15,011 characters; the test requires less than 15,000. |
| `src/runtime/buildIdentity.test.ts` | Six tests cannot spawn `git`/`node` (`EPERM`) inside this sandbox. |
| `src/plugin/pluginApi.test.ts` | 42 existing socket-based tests time out because `listen` is denied (`EPERM`). |
| `src/runtime/voiceRuntime.test.ts` | 85 existing socket-based tests time out for the same reason. |
| `server/health.test.ts` | Its server setup cannot listen; the suite hook fails and its six tests are skipped. |

A clean archive of the starting HEAD (`1578ae5`, PR #385) reproduced the prompt-length failure, process-spawn failures and representative plugin/live-runtime socket failures. A standalone localhost listener also returned `EPERM`. These failures were not suppressed or changed in this implementation. The new API tests run the actual middleware and handlers in process, without listeners.

No migrations were run and no live Twilio/QVO calls were placed. The provider-enforced duration setting, deployed runtime behavior and production SQL remain unverified live. A server crash before transcript finalization can lose turns still held in memory; see the README. The external Support Desk UI was inspected: it supports approve-only calls without tickets, but currently previews only purpose; full script/duration review uses the human `GET /approvals` API until that separate UI is updated.

The requested local commit could not be created: this session mounts `/tmp/r385/.git` read-only, and staging failed with `Unable to create .../.git/index.lock: Read-only file system`. All edits remain in the working tree. No push was attempted. Intended commit message: `Add approval-gated Wayne operator line with hard stops and transcripts`.

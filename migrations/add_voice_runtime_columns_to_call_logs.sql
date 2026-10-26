-- 2026-08-29: the Grok voice runtime writes call_logs rows alongside the
-- OpenAI SIP core, and two things about those rows could not be expressed.
--
-- voice_provider. Cost reconciliation estimates OpenAI spend from duration
-- whenever input_audio_tokens is NULL (callCostService.retryTwilioCostFetch).
-- Every runtime row has NULL token columns, so every Grok call would have
-- been priced at the OpenAI rate — fictitious OpenAI spend, and the one
-- number this migration is supposed to prove ($0.0918/min OpenAI vs $0.08/min
-- Grok) reported against itself.
--
-- runtime_outcome. The runtime records exactly one outcome per call, but it
-- lived only in a process-local registry that the post-stream redirect
-- consumes and deletes. Nothing durable distinguished dead_air from
-- provider_failure, or a ten-minute ceiling from an ordinary completed call —
-- while the runbook told operators to read the recorded outcome.
ALTER TABLE call_logs ADD COLUMN IF NOT EXISTS voice_provider varchar;
ALTER TABLE call_logs ADD COLUMN IF NOT EXISTS runtime_outcome varchar;

COMMENT ON COLUMN call_logs.voice_provider IS
  'Which voice stack served the call: ''grok'' for the Media Streams runtime (src/runtime), NULL for the OpenAI SIP core. Cost reconciliation must not apply the OpenAI per-second estimate to a non-OpenAI provider.';

COMMENT ON COLUMN call_logs.runtime_outcome IS
  'The voice runtime''s own single recorded outcome: completed | caller_hangup | agent_ended | provider_failure | dead_air | max_duration. NULL for calls the runtime did not serve. dead_air and provider_failure are the two the runtime itself caused.';

-- The turn table: one row per conversational turn.
--
-- Applied to the remote project on 2026-08-05 and committed here because the
-- repo is the source of truth — the same rule the console repo learned the
-- hard way when migrations 0057-0072 lived only on the remote for five days.
create table if not exists public.call_turns (
  id varchar primary key default gen_random_uuid(),
  call_log_id varchar,
  call_sid varchar,
  agent_slug varchar,
  turn_index integer not null,
  role varchar not null,
  at timestamp default now(),
  raw_transcript text,
  final_transcript text,
  state jsonb,
  director_decision jsonb,
  model_output jsonb,
  since_prev_ms integer,
  created_at timestamp default now()
);

create index if not exists idx_call_turns_call_log on public.call_turns (call_log_id, turn_index);
create index if not exists idx_call_turns_sid      on public.call_turns (call_sid);
create index if not exists idx_call_turns_created  on public.call_turns (created_at);

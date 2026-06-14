-- ============================================================================
-- 0015_quota_gen_tts.sql
-- Close the two biggest uncapped OpenAI cost vectors: generate-lesson and tts.
-- Adds 'generate_lesson' and 'tts' to the ai_usage_kind enum and gives them
-- default per-user daily caps, so the Edge Functions can call
-- ai_usage_check_and_increment() and fail closed (429) before any paid work.
--
-- NOTE: ALTER TYPE ... ADD VALUE must be committed before the value is used,
-- so apply the two ALTER TYPE statements FIRST, then CREATE OR REPLACE the cap
-- function in a SEPARATE statement/transaction.
-- ============================================================================

-- 1) New usage kinds (idempotent).
alter type ai_usage_kind add value if not exists 'generate_lesson';
alter type ai_usage_kind add value if not exists 'tts';

-- 2) Default caps (free tier). generate_lesson: ~1 full + 1 examples call per
--    chapter, so 100/day covers a very heavy day while blocking loop abuse.
--    tts: word/example/sentence playback (deduped client-side); 800/day is
--    comfortable for real use and stops unbounded synthesis.
create or replace function ai_usage_daily_cap(p_kind ai_usage_kind)
returns integer
language sql
immutable
as $$
  select case p_kind
    when 'conversation_session' then 20
    when 'speech_token_mint'    then 200
    when 'stt'                  then 200
    when 'tts_fallback'         then 100
    when 'generate_lesson'      then 100
    when 'tts'                  then 800
    else 0
  end;
$$;

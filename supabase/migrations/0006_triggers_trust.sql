-- ============================================================================
-- 0006_triggers_trust.sql
-- The TRUST-BOUNDARY layer (integrity rule 1), consolidated + completed.
-- ----------------------------------------------------------------------------
-- WHAT THIS FILE IS FOR
--
-- The browser must NOT be able to forge progress, XP, streaks, grades, billing
-- state, or AI-quota usage. Postgres RLS can restrict ROWS but NOT COLUMNS, so
-- the trust boundary is enforced with BEFORE INSERT/UPDATE(/DELETE) triggers
-- that REJECT any write touching a "trusted" column unless the session GUC
--   set local app.trusted = 'on'
-- has been set. ONLY a SECURITY DEFINER RPC owned by a privileged role is
-- allowed to set that GUC (RPCs are owned by another agent). A direct client
-- write (anon / authenticated role) that touches a trusted column is rejected
-- by assert_trusted_session() (defined in 0003).
--
-- WHERE THE PER-COLUMN GUARDS ALREADY LIVE
--
-- The BEFORE INSERT/UPDATE guard functions + triggers for every trusted-column
-- table were defined inline next to their tables in earlier migrations and are
-- NOT redefined here (re-creating them would error on "trigger already exists"
-- and duplicate the logic). For reference / audit, the full map is:
--
--   0003_user_tables.sql:
--     assert_trusted_session()                  -- the shared GUC guard helper
--     guard_profiles_trusted()                  -> profiles_guard_trusted
--         (total_xp, current_streak_days, longest_streak_days,
--          words_learned_count, current_level, last_activity_date,
--          onboarding_completed, placement_completed, foundations_completed)
--     guard_placement_answers_trusted()         -> placement_answers_guard_trusted
--         (is_correct)
--     guard_foundations_progress_trusted()      -> foundations_progress_guard_trusted
--         (completed, completed_at)
--     guard_unit_progress_trusted()             -> unit_progress_guard_trusted
--         (status, words_completed, listening_completed, reading_completed,
--          conversation_completed, grammar_completed, xp_awarded, completed_at)
--     guard_user_word_status_trusted()          -> user_word_status_guard_trusted
--         (spelling_passed, pronunciation_passed, meaning_passed,
--          best_pronunciation_score, learned, learned_at)
--     guard_quiz_attempts_trusted()             -> quiz_attempts_guard_trusted
--         (is_correct, score)
--     guard_pronunciation_attempts_trusted()    -> pronunciation_attempts_guard_trusted
--         (score, passed, assessment)
--     guard_conversation_sessions_trusted()     -> conversation_sessions_guard_trusted
--         (required_word_ids, outcome, words_used_ids, turns_used, xp_awarded)
--     guard_conversation_messages_trusted()     -> conversation_messages_guard_trusted
--         (ENTIRE ROW — written only by the conversation RPC)
--
--   0004_gamification.sql:
--     guard_xp_events_trusted()                 -> xp_events_guard_trusted     (ENTIRE ROW, incl. DELETE)
--     guard_streak_log_trusted()                -> streak_log_guard_trusted    (ENTIRE ROW, incl. DELETE)
--     guard_subscriptions_trusted()             -> subscriptions_guard_trusted (tier, status, provider, provider_ref, current_period_end)
--     guard_ai_usage_trusted()                  -> ai_usage_guard_trusted      (ENTIRE ROW, incl. DELETE)
--
-- WHAT THIS FILE ADDS
--
--   1) APPEND-ONLY DELETE PROTECTION for the audit / transcript tables whose
--      INSERT/UPDATE were already guarded but whose DELETE was not. Without
--      this, an untrusted client could DELETE its own rows to:
--        - reset pronunciation attempt_no and bypass retry_cap=3 (rule 7),
--        - erase quiz_attempts audit history,
--        - delete conversation_messages / conversation_sessions to hide or
--          replay graded turns.
--      These tables are server-authored audit logs; clients may read their own
--      rows (RLS, 0007) but must never delete them. The new guards reject DELETE
--      unless app.trusted='on'.
--
--   2) DENORMALIZED uses_word_ids MIRRORS — see the note at the bottom. There
--      are intentionally NONE to sync in this schema (the *_word_ids columns are
--      server-set arrays written wholesale by the conversation RPC, not mirrors
--      of a normalized join table), so no sync trigger is created. The reasoning
--      is recorded so a future contributor does not "fix" a non-bug.
--
-- This file writes NO RLS policies — those are in 0007_rls.sql.
-- ============================================================================


-- ============================================================================
-- APPEND-ONLY DELETE GUARDS
-- ----------------------------------------------------------------------------
-- assert_trusted_session() (0003) raises 'insufficient_privilege' unless
-- app.trusted='on'. We reuse it directly: for a pure deny-DELETE-to-clients
-- guard the function body is simply "raise unless trusted".
-- ============================================================================

-- --- quiz_attempts: insert-only audit; no client DELETE --------------------
-- CROSS-USER / SELF-TAMPER DENIAL INTENT: a user must not delete their own quiz
-- audit rows (and RLS already prevents touching other users' rows). Deleting is
-- a server-only operation (e.g. account erasure via a DEFINER RPC).
create or replace function guard_quiz_attempts_no_delete()
returns trigger
language plpgsql
as $$
begin
  if coalesce(current_setting('app.trusted', true), 'off') = 'on' then
    return old;  -- privileged DEFINER RPC (e.g. account deletion): allow
  end if;
  perform assert_trusted_session();  -- always raises for untrusted clients
  return old;
end;
$$;

create trigger quiz_attempts_guard_no_delete
  before delete on quiz_attempts
  for each row execute function guard_quiz_attempts_no_delete();

-- --- pronunciation_attempts: deleting would reset attempt_no -> bypass cap --
-- CROSS-USER / SELF-TAMPER DENIAL INTENT: deleting attempts would let a client
-- reset the per-screen attempt counter and exceed retry_cap=3 (rule 7). Deny.
create or replace function guard_pronunciation_attempts_no_delete()
returns trigger
language plpgsql
as $$
begin
  if coalesce(current_setting('app.trusted', true), 'off') = 'on' then
    return old;
  end if;
  perform assert_trusted_session();  -- always raises for untrusted clients
  return old;
end;
$$;

create trigger pronunciation_attempts_guard_no_delete
  before delete on pronunciation_attempts
  for each row execute function guard_pronunciation_attempts_no_delete();

-- --- conversation_sessions: graded session; no client DELETE ---------------
-- CROSS-USER / SELF-TAMPER DENIAL INTENT: the session row holds the trusted
-- outcome / words_used_ids / xp_awarded; deleting it would let a client discard
-- a recorded result or replay a session. Server-only deletion.
create or replace function guard_conversation_sessions_no_delete()
returns trigger
language plpgsql
as $$
begin
  if coalesce(current_setting('app.trusted', true), 'off') = 'on' then
    return old;
  end if;
  perform assert_trusted_session();  -- always raises for untrusted clients
  return old;
end;
$$;

create trigger conversation_sessions_guard_no_delete
  before delete on conversation_sessions
  for each row execute function guard_conversation_sessions_no_delete();

-- --- conversation_messages: server-authored transcript; no client DELETE ---
-- CROSS-USER / SELF-TAMPER DENIAL INTENT: the transcript is written wholesale
-- by the conversation RPC; a client must not edit OR delete turns. INSERT/UPDATE
-- are already fully guarded in 0003; this closes the DELETE path.
create or replace function guard_conversation_messages_no_delete()
returns trigger
language plpgsql
as $$
begin
  if coalesce(current_setting('app.trusted', true), 'off') = 'on' then
    return old;
  end if;
  perform assert_trusted_session();  -- always raises for untrusted clients
  return old;
end;
$$;

create trigger conversation_messages_guard_no_delete
  before delete on conversation_messages
  for each row execute function guard_conversation_messages_no_delete();


-- ============================================================================
-- DENORMALIZED  uses_word_ids  MIRRORS — INTENTIONALLY NONE TO SYNC
-- ----------------------------------------------------------------------------
-- The conversation flow carries three uuid[] columns:
--   conversation_sessions.required_word_ids  (server-selected from the unit's 5)
--   conversation_sessions.words_used_ids     (server-detected usage)
--   conversation_messages.used_word_ids      (per-message server-detected usage)
--
-- These are NOT denormalized mirrors of a normalized join table. They are
-- authoritative, server-computed arrays written wholesale by the conversation
-- DEFINER RPC inside a trusted session, and the entire row / every trusted
-- column is already guarded (0003). There is no client-writable normalized
-- source to keep them in sync with, so a sync trigger would have nothing to do.
--
-- The genuinely NORMALIZED unit-word-reuse data lives in the join tables from
-- 0002 (listening_clip_words, reading_passage_words, grammar_lesson_words,
-- grammar_question_words, conversation_required_words). Their composite FK to
-- unit_words(unit_id, word_id) makes attaching a foreign word physically
-- impossible (rule 5); they have no denormalized array mirror to maintain.
--
-- CONCLUSION: no mirror-sync triggers are required. This note exists so a future
-- contributor does not add a redundant sync trigger or mistake the server-set
-- arrays for cache columns that drift.
-- ============================================================================

comment on function guard_quiz_attempts_no_delete() is
  'Append-only guard: rejects client DELETE on quiz_attempts unless app.trusted=on.';
comment on function guard_pronunciation_attempts_no_delete() is
  'Append-only guard: rejects client DELETE on pronunciation_attempts (would bypass retry_cap) unless app.trusted=on.';
comment on function guard_conversation_sessions_no_delete() is
  'Append-only guard: rejects client DELETE on conversation_sessions unless app.trusted=on.';
comment on function guard_conversation_messages_no_delete() is
  'Append-only guard: rejects client DELETE on conversation_messages transcript unless app.trusted=on.';

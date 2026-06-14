-- ============================================================================
-- 0005_indexes.sql
-- Secondary indexes for the access patterns the app actually runs. PK / UNIQUE
-- constraints from earlier migrations already create their own indexes; this
-- file adds the FK-lookup and query indexes that are NOT covered by those.
-- No data integrity here — purely performance.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- CONTENT lookups
-- ----------------------------------------------------------------------------
-- Journey list: published units in order.
create index units_status_position_idx on units (status, position);
create index units_level_idx on units (level);

-- Word lookups by level (level-fallback content resolution).
create index words_level_idx on words (level);
create index words_status_idx on words (status);

-- unit_words: PK is (unit_id, word_id); add the reverse lookup word -> units.
create index unit_words_word_id_idx on unit_words (word_id);

-- word_examples by word.
create index word_examples_word_id_idx on word_examples (word_id);

-- audio_clips owner lookup is the UNIQUE(owner_type, owner_id) already; add an
-- index on owner_id alone for cross-type scans during seeding/audit.
create index audio_clips_owner_id_idx on audio_clips (owner_id);

-- listening clips / reading passages / grammar lessons by unit (+level for fallback).
create index listening_clips_unit_idx on listening_clips (unit_id, level, status);
create index reading_passages_unit_idx on reading_passages (unit_id, level, status);
create index grammar_lessons_unit_idx on grammar_lessons (unit_id, level, status);

-- comprehension questions by their parent (one question per screen, ordered).
create index comprehension_q_listening_idx
  on comprehension_questions (listening_clip_id, position)
  where listening_clip_id is not null;
create index comprehension_q_reading_idx
  on comprehension_questions (reading_passage_id, position)
  where reading_passage_id is not null;

-- grammar questions by lesson (already UNIQUE(lesson, position); explicit FK idx).
create index grammar_questions_lesson_idx on grammar_questions (grammar_lesson_id, position);

-- placement questions in order.
create index placement_questions_position_idx on placement_questions (position);

-- foundations in order.
create index foundations_lessons_position_idx on foundations_lessons (position, status);

-- ----------------------------------------------------------------------------
-- JOIN-TABLE reverse lookups (word -> content). The composite PKs cover the
-- forward direction; index word_id for "which content uses this word".
-- ----------------------------------------------------------------------------
create index listening_clip_words_word_idx on listening_clip_words (word_id);
create index listening_clip_words_unit_word_idx on listening_clip_words (unit_id, word_id);
create index reading_passage_words_word_idx on reading_passage_words (word_id);
create index reading_passage_words_unit_word_idx on reading_passage_words (unit_id, word_id);
create index grammar_lesson_words_word_idx on grammar_lesson_words (word_id);
create index grammar_lesson_words_unit_word_idx on grammar_lesson_words (unit_id, word_id);
create index grammar_question_words_word_idx on grammar_question_words (word_id);
create index grammar_question_words_unit_word_idx on grammar_question_words (unit_id, word_id);
create index conversation_required_words_unit_word_idx on conversation_required_words (unit_id, word_id);

-- ----------------------------------------------------------------------------
-- ANSWER tables: lookups are by PK (question_id); no extra index needed.
-- ----------------------------------------------------------------------------

-- ----------------------------------------------------------------------------
-- USER data lookups (almost all scoped by user_id)
-- ----------------------------------------------------------------------------
create index onboarding_responses_user_idx on onboarding_responses (user_id);

create index placement_answers_user_idx on placement_answers (user_id);
create index placement_answers_question_idx on placement_answers (question_id);

create index foundations_progress_user_idx on foundations_progress (user_id);
create index foundations_progress_lesson_idx on foundations_progress (lesson_id);

-- "Continue learning" + journey state: a user's progress rows.
create index unit_progress_user_idx on unit_progress (user_id, status);
create index unit_progress_unit_idx on unit_progress (unit_id);

create index user_word_status_user_idx on user_word_status (user_id);
create index user_word_status_unit_word_idx on user_word_status (unit_id, word_id);

create index quiz_attempts_user_idx on quiz_attempts (user_id, created_at desc);
create index quiz_attempts_unit_idx on quiz_attempts (unit_id);
create index quiz_attempts_question_idx on quiz_attempts (question_id);

create index pronunciation_attempts_user_idx on pronunciation_attempts (user_id, created_at desc);
create index pronunciation_attempts_unit_word_idx on pronunciation_attempts (unit_id, word_id);

create index conversation_sessions_user_idx on conversation_sessions (user_id, started_at desc);
create index conversation_sessions_unit_idx on conversation_sessions (unit_id);

create index conversation_messages_session_idx on conversation_messages (session_id, turn_index);

-- ----------------------------------------------------------------------------
-- GAMIFICATION lookups
-- ----------------------------------------------------------------------------
create index xp_events_user_idx on xp_events (user_id, created_at desc);
create index xp_events_unit_idx on xp_events (unit_id);

create index streak_log_user_date_idx on streak_log (user_id, activity_date desc);

-- Word of the day "today" lookup is the UNIQUE(scheduled_for); add word_id idx.
create index word_of_the_day_word_idx on word_of_the_day (word_id);

-- Leaderboard: all-time by total_xp DESC (DECISIONS.md). 'period' hook lives in
-- the leaderboard RPC/view (weekly later); the base ranking reads profiles.
create index profiles_leaderboard_idx on profiles (total_xp desc);

create index subscriptions_user_idx on subscriptions (user_id);

create index device_tokens_user_idx on device_tokens (user_id);

-- ai_usage quota check is by the UNIQUE(user_id, kind, usage_date); add a
-- date-scoped index for cleanup/reporting.
create index ai_usage_user_date_idx on ai_usage (user_id, usage_date);

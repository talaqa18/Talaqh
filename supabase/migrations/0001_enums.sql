-- ============================================================================
-- 0001_enums.sql
-- Extensions, enum types, and the shared set_updated_at() trigger function.
-- ----------------------------------------------------------------------------
-- This migration is the FOUNDATION. It creates:
--   * required extensions (pgcrypto for gen_random_uuid(), citext for emails)
--   * every enum type used across content / user / gamification tables
--   * the reusable set_updated_at() trigger function
--
-- NOTHING here grants access. RLS, RPCs and storage are owned by other agents.
-- See DECISIONS.md for the product constants these enums encode.
-- ============================================================================

-- --- Extensions -------------------------------------------------------------
-- pgcrypto provides gen_random_uuid() used for every uuid PK.
create extension if not exists pgcrypto;
-- citext gives case-insensitive text (used for email-style columns / dedupe).
create extension if not exists citext;

-- ============================================================================
-- ENUMS
-- ============================================================================

-- ----------------------------------------------------------------------------
-- content_level: the level attached to EVERY learning-content row.
-- "beginner" == complete-beginner / Foundations stage. A1..C1 == CEFR units.
-- Level fallback policy (DECISIONS.md): when a unit lacks an exact-level row,
-- use the nearest LOWER level, else any published row for that unit.
-- ----------------------------------------------------------------------------
create type content_level as enum ('beginner', 'A1', 'A2', 'B1', 'B2', 'C1');

-- ----------------------------------------------------------------------------
-- The user's resolved proficiency level. Mirrors content_level so a user can
-- sit at "beginner" (Foundations) before being placed into A1+.
-- ----------------------------------------------------------------------------
create type user_level as enum ('beginner', 'A1', 'A2', 'B1', 'B2', 'C1');

-- ----------------------------------------------------------------------------
-- Onboarding goal (scope 4.1).
-- ----------------------------------------------------------------------------
create type learning_goal as enum ('travel', 'work', 'study_abroad', 'daily_conversation');

-- ----------------------------------------------------------------------------
-- Publishing status for content rows (drafts must not be served to clients).
-- ----------------------------------------------------------------------------
create type content_status as enum ('draft', 'published', 'archived');

-- ----------------------------------------------------------------------------
-- Sequential unlock state for any per-user unit/section progress row.
-- TRUSTED: unit_progress.status may ONLY be advanced by SECURITY DEFINER RPCs.
-- ----------------------------------------------------------------------------
create type progress_status as enum ('locked', 'in_progress', 'completed');

-- ----------------------------------------------------------------------------
-- The five distinct sections inside a unit (scope 4.5 A-G). Used to key
-- per-section progress and to scope content lookups. "words" covers the
-- teaching + 3 per-word quizzes + full words quiz.
-- ----------------------------------------------------------------------------
create type unit_section as enum ('words', 'listening', 'reading', 'conversation', 'grammar');

-- ----------------------------------------------------------------------------
-- The three per-word quiz screens (scope 4.5 A.2) plus the mixed full quiz.
-- ----------------------------------------------------------------------------
create type quiz_kind as enum ('spelling', 'pronunciation', 'meaning', 'full_words', 'grammar');

-- ----------------------------------------------------------------------------
-- Question answer formats. multiple_choice => grade by option index;
-- text_input => grade by normalized string match. Grading is SERVER-ONLY.
-- ----------------------------------------------------------------------------
create type question_kind as enum ('multiple_choice', 'text_input');

-- ----------------------------------------------------------------------------
-- Author of a conversation message (scope 4.5 F). The AI tutor TYPES (text);
-- the user replies by VOICE ONLY (transcribed to text server-side).
-- ----------------------------------------------------------------------------
create type message_role as enum ('assistant', 'user');

-- ----------------------------------------------------------------------------
-- Outcome of a 3-minute conversation session. "success" requires >=4 of the
-- unit's 5 words used (DECISIONS.md). Evaluated SERVER-SIDE.
-- ----------------------------------------------------------------------------
create type conversation_outcome as enum ('in_progress', 'success', 'incomplete', 'expired', 'abandoned');

-- ----------------------------------------------------------------------------
-- xp_events.source_type — what action minted the XP. Combined with source_id
-- in a UNIQUE(user_id, source_type, source_id) constraint for IDEMPOTENCY so
-- replays cannot inflate XP. Amounts are fixed server-side (DECISIONS.md):
--   word_quiz_pass=10 full_words_quiz=50 listening=40 reading=40
--   grammar_quiz=40 conversation=60 unit_complete=100 streak_daily_bonus=20
--   foundations_lesson=5 placement=0
-- ----------------------------------------------------------------------------
create type xp_source_type as enum (
  'word_quiz_pass',
  'full_words_quiz',
  'listening',
  'reading',
  'grammar_quiz',
  'conversation',
  'unit_complete',
  'streak_daily_bonus',
  'foundations_lesson',
  'placement'
);

-- ----------------------------------------------------------------------------
-- Where a single audio clip lives in the content model. The audio_clips table
-- is the ONE source of truth for all audio (integrity rule 6).
-- ----------------------------------------------------------------------------
create type audio_owner_type as enum (
  'word',            -- the word's own pronunciation
  'word_example',    -- an example sentence for a word
  'listening_clip',  -- a listening exercise clip
  'word_of_the_day'  -- home screen word-of-the-day audio
);

-- ----------------------------------------------------------------------------
-- Leaderboard period. v1 ships 'all_time' only; the column is a hook so a
-- 'weekly' period can be added later without a schema change (DECISIONS.md).
-- ----------------------------------------------------------------------------
create type leaderboard_period as enum ('all_time', 'weekly');

-- ----------------------------------------------------------------------------
-- Subscription tier / state (kept minimal for v1; billing owned elsewhere).
-- ----------------------------------------------------------------------------
create type subscription_tier as enum ('free', 'premium');
create type subscription_status as enum ('active', 'trialing', 'past_due', 'canceled', 'expired');

-- ----------------------------------------------------------------------------
-- Push device platform (Capacitor Phase 2 targets + web push).
-- ----------------------------------------------------------------------------
create type device_platform as enum ('ios', 'android', 'web');

-- ----------------------------------------------------------------------------
-- ai_usage.kind — per-user daily quota buckets enforced INSIDE each Edge
-- Function (DECISIONS.md daily caps):
--   conversation_session<=20  speech_token_mint<=200  stt<=200  tts_fallback<=100
-- ----------------------------------------------------------------------------
create type ai_usage_kind as enum (
  'conversation_session',
  'speech_token_mint',
  'stt',
  'tts_fallback'
);

-- ============================================================================
-- set_updated_at(): generic BEFORE UPDATE trigger to maintain updated_at.
-- Attached to every table that carries an updated_at column.
-- ============================================================================
create or replace function set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

comment on function set_updated_at() is
  'Generic BEFORE UPDATE trigger: stamps updated_at = now() on row change.';

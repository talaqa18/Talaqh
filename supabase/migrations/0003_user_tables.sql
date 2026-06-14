-- ============================================================================
-- 0003_user_tables.sql
-- Per-user tables: profiles, onboarding, placement answers, foundations
-- progress, unit/section progress, per-word status, quiz / pronunciation
-- attempts, conversation sessions + messages, user_settings.
-- ----------------------------------------------------------------------------
-- THE TRUST BOUNDARY (integrity rule 1) lives here.
--
-- The browser must NOT be able to forge progress. Postgres RLS cannot restrict
-- *columns*, so we add BEFORE INSERT/UPDATE triggers that REJECT any change to
-- "trusted" columns unless the session has set  app.trusted = 'on'  via
-- `set local app.trusted = 'on'`. ONLY a SECURITY DEFINER RPC (or service-role
-- Edge Function) owned by a privileged role is allowed to set that GUC, so a
-- direct client write that touches a trusted column is rejected.
--
-- The guard function `assert_trusted_session()` and the per-table guard
-- triggers are defined here. RLS row-level policies are added by ANOTHER agent;
-- this file only protects COLUMNS.
--
-- TRUSTED COLUMNS PROTECTED IN THIS FILE (must only be written via DEFINER RPC):
--   profiles: total_xp, current_streak_days, longest_streak_days,
--             words_learned_count, current_level, last_activity_date,
--             onboarding_completed, placement_completed, foundations_completed
--   unit_progress: status, words_completed, listening_completed,
--             reading_completed, conversation_completed, grammar_completed,
--             completed_at, xp_awarded
--   user_word_status: spelling_passed, pronunciation_passed, meaning_passed,
--             best_pronunciation_score, learned, learned_at
--   foundations_progress: completed, completed_at
-- (xp_events / streak_log trusted rows are guarded in 0004.)
-- ============================================================================

-- ----------------------------------------------------------------------------
-- assert_trusted_session(): raises unless the current transaction was opened by
-- a privileged DEFINER RPC that ran `set local app.trusted = 'on'`.
-- current_setting(..., true) returns NULL (not error) when the GUC is unset.
-- ----------------------------------------------------------------------------
create or replace function assert_trusted_session()
returns void
language plpgsql
as $$
begin
  if coalesce(current_setting('app.trusted', true), 'off') <> 'on' then
    raise exception
      'forbidden: trusted column may only be written by a SECURITY DEFINER RPC'
      using errcode = 'insufficient_privilege';
  end if;
end;
$$;

comment on function assert_trusted_session() is
  'Guard for trusted columns. Raises unless app.trusted=on (set by a DEFINER RPC).';

-- ============================================================================
-- PROFILES — one row per auth user. id == auth.users.id (FK added by the RLS/
-- auth-owning agent; we keep id as a plain uuid PK here to avoid coupling).
-- ============================================================================
create table profiles (
  id                   uuid primary key default gen_random_uuid(),
  -- citext email mirror (optional convenience; source of truth is auth.users).
  email                citext,
  display_name         text,
  avatar_url           text,
  age                  integer,
  goal                 learning_goal,
  -- ===== TRUSTED (server-only) =====
  current_level        user_level not null default 'beginner',     -- TRUSTED
  total_xp             integer not null default 0,                  -- TRUSTED
  current_streak_days  integer not null default 0,                  -- TRUSTED
  longest_streak_days  integer not null default 0,                  -- TRUSTED
  words_learned_count  integer not null default 0,                  -- TRUSTED
  last_activity_date   date,                                        -- TRUSTED
  onboarding_completed boolean not null default false,              -- TRUSTED
  placement_completed  boolean not null default false,              -- TRUSTED
  foundations_completed boolean not null default false,             -- TRUSTED
  -- ===== client-writable preferences kept in user_settings, not here =====
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  constraint profiles_total_xp_nonneg check (total_xp >= 0),
  constraint profiles_streak_nonneg check (current_streak_days >= 0 and longest_streak_days >= 0),
  constraint profiles_words_learned_nonneg check (words_learned_count >= 0),
  constraint profiles_age_sane check (age is null or (age between 3 and 120))
);

create trigger profiles_set_updated_at
  before update on profiles
  for each row execute function set_updated_at();

-- --- Trusted-column guard for profiles --------------------------------------
-- Rejects INSERT/UPDATE that sets a trusted column to a non-default (insert) or
-- changed (update) value unless app.trusted='on'. On INSERT we only allow the
-- documented defaults from an untrusted session.
create or replace function guard_profiles_trusted()
returns trigger
language plpgsql
as $$
begin
  if coalesce(current_setting('app.trusted', true), 'off') = 'on' then
    return new;  -- privileged DEFINER RPC: allow everything
  end if;

  if (tg_op = 'INSERT') then
    -- Untrusted inserts must use the safe defaults for trusted columns.
    if new.current_level <> 'beginner'
       or new.total_xp <> 0
       or new.current_streak_days <> 0
       or new.longest_streak_days <> 0
       or new.words_learned_count <> 0
       or new.last_activity_date is not null
       or new.onboarding_completed <> false
       or new.placement_completed <> false
       or new.foundations_completed <> false then
      perform assert_trusted_session();  -- always raises
    end if;
    return new;
  end if;

  -- UPDATE: reject any change to a trusted column.
  if new.current_level is distinct from old.current_level
     or new.total_xp is distinct from old.total_xp
     or new.current_streak_days is distinct from old.current_streak_days
     or new.longest_streak_days is distinct from old.longest_streak_days
     or new.words_learned_count is distinct from old.words_learned_count
     or new.last_activity_date is distinct from old.last_activity_date
     or new.onboarding_completed is distinct from old.onboarding_completed
     or new.placement_completed is distinct from old.placement_completed
     or new.foundations_completed is distinct from old.foundations_completed then
    perform assert_trusted_session();  -- always raises
  end if;

  return new;
end;
$$;

create trigger profiles_guard_trusted
  before insert or update on profiles
  for each row execute function guard_profiles_trusted();

-- ============================================================================
-- ONBOARDING_RESPONSES — captured during onboarding (scope 4.1). These are
-- user-supplied (name/age/goal) and are NOT trusted — fully client-writable.
-- ============================================================================
create table onboarding_responses (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references profiles(id) on delete cascade,
  display_name text,
  age          integer,
  native_language text not null default 'ar',
  goal         learning_goal,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  constraint onboarding_user_unique unique (user_id),
  constraint onboarding_age_sane check (age is null or (age between 3 and 120))
);

create trigger onboarding_responses_set_updated_at
  before update on onboarding_responses
  for each row execute function set_updated_at();

-- ============================================================================
-- PLACEMENT_ANSWERS — the user's chosen answers during the placement test.
-- The SELECTION is client-supplied (not trusted). is_correct + the resulting
-- assigned level are written ONLY by the grading DEFINER RPC -> guarded.
-- ============================================================================
create table placement_answers (
  id                 uuid primary key default gen_random_uuid(),
  user_id            uuid not null references profiles(id) on delete cascade,
  question_id        uuid not null references placement_questions(id) on delete cascade,
  -- client-supplied selection
  selected_option_index integer,
  text_response      text,
  -- ===== TRUSTED (graded server-side) =====
  is_correct         boolean,                                       -- TRUSTED
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  constraint placement_answers_user_question_unique unique (user_id, question_id),
  constraint placement_answers_index_nonneg check (
    selected_option_index is null or selected_option_index >= 0
  )
);

create trigger placement_answers_set_updated_at
  before update on placement_answers
  for each row execute function set_updated_at();

-- Guard the trusted is_correct column.
create or replace function guard_placement_answers_trusted()
returns trigger
language plpgsql
as $$
begin
  if coalesce(current_setting('app.trusted', true), 'off') = 'on' then
    return new;
  end if;
  if (tg_op = 'INSERT') then
    if new.is_correct is not null then
      perform assert_trusted_session();
    end if;
    return new;
  end if;
  if new.is_correct is distinct from old.is_correct then
    perform assert_trusted_session();
  end if;
  return new;
end;
$$;

create trigger placement_answers_guard_trusted
  before insert or update on placement_answers
  for each row execute function guard_placement_answers_trusted();

-- ============================================================================
-- FOUNDATIONS_PROGRESS — per-user completion of each foundations lesson.
-- completed/completed_at are TRUSTED (awarding XP=5 must be server-side).
-- ============================================================================
create table foundations_progress (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references profiles(id) on delete cascade,
  lesson_id    uuid not null references foundations_lessons(id) on delete cascade,
  -- ===== TRUSTED =====
  completed    boolean not null default false,                      -- TRUSTED
  completed_at timestamptz,                                         -- TRUSTED
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  constraint foundations_progress_user_lesson_unique unique (user_id, lesson_id)
);

create trigger foundations_progress_set_updated_at
  before update on foundations_progress
  for each row execute function set_updated_at();

create or replace function guard_foundations_progress_trusted()
returns trigger
language plpgsql
as $$
begin
  if coalesce(current_setting('app.trusted', true), 'off') = 'on' then
    return new;
  end if;
  if (tg_op = 'INSERT') then
    if new.completed <> false or new.completed_at is not null then
      perform assert_trusted_session();
    end if;
    return new;
  end if;
  if new.completed is distinct from old.completed
     or new.completed_at is distinct from old.completed_at then
    perform assert_trusted_session();
  end if;
  return new;
end;
$$;

create trigger foundations_progress_guard_trusted
  before insert or update on foundations_progress
  for each row execute function guard_foundations_progress_trusted();

-- ============================================================================
-- UNIT_PROGRESS — per-user, per-unit journey state. THE sequential-unlock row
-- (integrity rule 4: advance only via DEFINER RPC that checks predecessors).
-- ALL state columns are TRUSTED.
-- ============================================================================
create table unit_progress (
  id                     uuid primary key default gen_random_uuid(),
  user_id                uuid not null references profiles(id) on delete cascade,
  unit_id                uuid not null references units(id) on delete cascade,
  -- ===== TRUSTED =====
  status                 progress_status not null default 'locked', -- TRUSTED
  words_completed        boolean not null default false,            -- TRUSTED
  listening_completed    boolean not null default false,            -- TRUSTED
  reading_completed      boolean not null default false,            -- TRUSTED
  conversation_completed boolean not null default false,            -- TRUSTED
  grammar_completed      boolean not null default false,            -- TRUSTED
  xp_awarded             boolean not null default false,            -- TRUSTED (unit_complete XP idempotency helper)
  started_at             timestamptz,
  completed_at           timestamptz,                               -- TRUSTED
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  constraint unit_progress_user_unit_unique unique (user_id, unit_id)
);

create trigger unit_progress_set_updated_at
  before update on unit_progress
  for each row execute function set_updated_at();

create or replace function guard_unit_progress_trusted()
returns trigger
language plpgsql
as $$
begin
  if coalesce(current_setting('app.trusted', true), 'off') = 'on' then
    return new;
  end if;
  if (tg_op = 'INSERT') then
    if new.status <> 'locked'
       or new.words_completed <> false
       or new.listening_completed <> false
       or new.reading_completed <> false
       or new.conversation_completed <> false
       or new.grammar_completed <> false
       or new.xp_awarded <> false
       or new.completed_at is not null then
      perform assert_trusted_session();
    end if;
    return new;
  end if;
  if new.status is distinct from old.status
     or new.words_completed is distinct from old.words_completed
     or new.listening_completed is distinct from old.listening_completed
     or new.reading_completed is distinct from old.reading_completed
     or new.conversation_completed is distinct from old.conversation_completed
     or new.grammar_completed is distinct from old.grammar_completed
     or new.xp_awarded is distinct from old.xp_awarded
     or new.completed_at is distinct from old.completed_at then
    perform assert_trusted_session();
  end if;
  return new;
end;
$$;

create trigger unit_progress_guard_trusted
  before insert or update on unit_progress
  for each row execute function guard_unit_progress_trusted();

-- ============================================================================
-- USER_WORD_STATUS — per-user mastery of each of a unit's words.
-- The three quiz "*_passed" flags + best_pronunciation_score + learned are
-- TRUSTED (gating progress; pronunciation score must be SERVER-trusted, rule 7).
-- ============================================================================
create table user_word_status (
  id                       uuid primary key default gen_random_uuid(),
  user_id                  uuid not null references profiles(id) on delete cascade,
  unit_id                  uuid not null,
  word_id                  uuid not null,
  -- ===== TRUSTED =====
  spelling_passed          boolean not null default false,          -- TRUSTED
  pronunciation_passed     boolean not null default false,          -- TRUSTED
  meaning_passed           boolean not null default false,          -- TRUSTED
  best_pronunciation_score integer,                                 -- TRUSTED (0-100)
  learned                  boolean not null default false,          -- TRUSTED
  learned_at               timestamptz,                             -- TRUSTED
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now(),
  constraint user_word_status_user_word_unique unique (user_id, unit_id, word_id),
  -- word must be one of the unit's 5 (composite FK -> unit_words, rule 5)
  constraint user_word_status_unit_word_fk
    foreign key (unit_id, word_id) references unit_words(unit_id, word_id) on delete cascade,
  constraint user_word_status_score_range check (
    best_pronunciation_score is null
    or (best_pronunciation_score between 0 and 100)
  )
);

create trigger user_word_status_set_updated_at
  before update on user_word_status
  for each row execute function set_updated_at();

create or replace function guard_user_word_status_trusted()
returns trigger
language plpgsql
as $$
begin
  if coalesce(current_setting('app.trusted', true), 'off') = 'on' then
    return new;
  end if;
  if (tg_op = 'INSERT') then
    if new.spelling_passed <> false
       or new.pronunciation_passed <> false
       or new.meaning_passed <> false
       or new.best_pronunciation_score is not null
       or new.learned <> false
       or new.learned_at is not null then
      perform assert_trusted_session();
    end if;
    return new;
  end if;
  if new.spelling_passed is distinct from old.spelling_passed
     or new.pronunciation_passed is distinct from old.pronunciation_passed
     or new.meaning_passed is distinct from old.meaning_passed
     or new.best_pronunciation_score is distinct from old.best_pronunciation_score
     or new.learned is distinct from old.learned
     or new.learned_at is distinct from old.learned_at then
    perform assert_trusted_session();
  end if;
  return new;
end;
$$;

create trigger user_word_status_guard_trusted
  before insert or update on user_word_status
  for each row execute function guard_user_word_status_trusted();

-- ============================================================================
-- QUIZ_ATTEMPTS — an audit log of every quiz attempt (spelling / meaning /
-- full_words / grammar). The PASS decision (is_correct/passed/score) is graded
-- SERVER-SIDE -> TRUSTED. The raw submission (selected_option_index/response)
-- is client-supplied.
-- ============================================================================
create table quiz_attempts (
  id                    uuid primary key default gen_random_uuid(),
  user_id               uuid not null references profiles(id) on delete cascade,
  unit_id               uuid references units(id) on delete cascade,
  quiz_kind             quiz_kind not null,
  -- optional linkage to the specific question graded
  question_id           uuid,
  word_id               uuid,
  -- client-supplied submission
  selected_option_index integer,
  text_response         text,
  -- ===== TRUSTED (graded server-side) =====
  is_correct            boolean,                                    -- TRUSTED
  score                 integer,                                    -- TRUSTED (0-100 where applicable)
  created_at            timestamptz not null default now(),
  constraint quiz_attempts_index_nonneg check (
    selected_option_index is null or selected_option_index >= 0
  ),
  constraint quiz_attempts_score_range check (
    score is null or (score between 0 and 100)
  )
);

create or replace function guard_quiz_attempts_trusted()
returns trigger
language plpgsql
as $$
begin
  if coalesce(current_setting('app.trusted', true), 'off') = 'on' then
    return new;
  end if;
  -- quiz_attempts is insert-only from clients; reject graded fields on insert.
  if (tg_op = 'INSERT') then
    if new.is_correct is not null or new.score is not null then
      perform assert_trusted_session();
    end if;
    return new;
  end if;
  -- any update to graded fields is server-only
  if new.is_correct is distinct from old.is_correct
     or new.score is distinct from old.score then
    perform assert_trusted_session();
  end if;
  return new;
end;
$$;

create trigger quiz_attempts_guard_trusted
  before insert or update on quiz_attempts
  for each row execute function guard_quiz_attempts_trusted();

-- ============================================================================
-- PRONUNCIATION_ATTEMPTS — every recording the user makes for a word's
-- pronunciation quiz (scope 4.5 A.2). score 0-100 + passed are SERVER-trusted
-- (rule 7: scores that gate progress must be server-trusted). retry_cap=3 per
-- word per screen visit (DECISIONS.md) is enforced by the RPC, not a column.
-- ============================================================================
create table pronunciation_attempts (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references profiles(id) on delete cascade,
  unit_id       uuid not null,
  word_id       uuid not null,
  -- ===== TRUSTED (assessed server-side from the audio) =====
  score         integer,                                            -- TRUSTED (0-100)
  passed        boolean,                                            -- TRUSTED (score >= 70)
  -- diagnostic detail returned by the assessment provider (phoneme errors etc.)
  assessment    jsonb,                                              -- TRUSTED
  recording_path text,                                              -- user-recordings bucket (30-day TTL)
  attempt_no    integer,                                            -- 1..retry_cap within a screen visit
  created_at    timestamptz not null default now(),
  constraint pronunciation_attempts_unit_word_fk
    foreign key (unit_id, word_id) references unit_words(unit_id, word_id) on delete cascade,
  constraint pronunciation_attempts_score_range check (
    score is null or (score between 0 and 100)
  ),
  constraint pronunciation_attempts_attempt_no_range check (
    attempt_no is null or (attempt_no between 1 and 3)
  )
);

create or replace function guard_pronunciation_attempts_trusted()
returns trigger
language plpgsql
as $$
begin
  if coalesce(current_setting('app.trusted', true), 'off') = 'on' then
    return new;
  end if;
  if (tg_op = 'INSERT') then
    if new.score is not null or new.passed is not null or new.assessment is not null then
      perform assert_trusted_session();
    end if;
    return new;
  end if;
  if new.score is distinct from old.score
     or new.passed is distinct from old.passed
     or new.assessment is distinct from old.assessment then
    perform assert_trusted_session();
  end if;
  return new;
end;
$$;

create trigger pronunciation_attempts_guard_trusted
  before insert or update on pronunciation_attempts
  for each row execute function guard_pronunciation_attempts_trusted();

-- ============================================================================
-- CONVERSATION_SESSIONS — a 3-minute AI tutor session (scope 4.5 F).
-- INTEGRITY (rule 7): the session + its required_word_ids are created
-- SERVER-SIDE; the client cannot pick the words. Therefore required_word_ids,
-- outcome, words_used, and xp_awarded are TRUSTED. duration_cap=180s,
-- max_turns=12, success when >=4 of the 5 words used (DECISIONS.md).
-- ============================================================================
create table conversation_sessions (
  id               uuid primary key default gen_random_uuid(),
  user_id          uuid not null references profiles(id) on delete cascade,
  unit_id          uuid not null references units(id) on delete cascade,
  -- ===== TRUSTED (chosen server-side) =====
  required_word_ids uuid[] not null default '{}',                  -- TRUSTED (server-selected from the unit's 5)
  outcome          conversation_outcome not null default 'in_progress', -- TRUSTED
  words_used_ids   uuid[] not null default '{}',                   -- TRUSTED (detected server-side)
  turns_used       integer not null default 0,                     -- TRUSTED
  xp_awarded       boolean not null default false,                 -- TRUSTED
  started_at       timestamptz not null default now(),
  ends_at          timestamptz,                                    -- started_at + 180s, server-set
  ended_at         timestamptz,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  constraint conversation_sessions_turns_range check (turns_used between 0 and 12)
);

create trigger conversation_sessions_set_updated_at
  before update on conversation_sessions
  for each row execute function set_updated_at();

create or replace function guard_conversation_sessions_trusted()
returns trigger
language plpgsql
as $$
begin
  if coalesce(current_setting('app.trusted', true), 'off') = 'on' then
    return new;
  end if;
  -- Untrusted clients cannot create or modify a session: every meaningful field
  -- is server-owned. Reject any non-empty/non-default trusted field.
  if (tg_op = 'INSERT') then
    if array_length(new.required_word_ids, 1) is not null
       or new.outcome <> 'in_progress'
       or array_length(new.words_used_ids, 1) is not null
       or new.turns_used <> 0
       or new.xp_awarded <> false then
      perform assert_trusted_session();
    end if;
    return new;
  end if;
  if new.required_word_ids is distinct from old.required_word_ids
     or new.outcome is distinct from old.outcome
     or new.words_used_ids is distinct from old.words_used_ids
     or new.turns_used is distinct from old.turns_used
     or new.xp_awarded is distinct from old.xp_awarded then
    perform assert_trusted_session();
  end if;
  return new;
end;
$$;

create trigger conversation_sessions_guard_trusted
  before insert or update on conversation_sessions
  for each row execute function guard_conversation_sessions_trusted();

-- ============================================================================
-- CONVERSATION_MESSAGES — the transcript. assistant rows are TYPED by the AI;
-- user rows carry the VOICE-transcribed text (typing not allowed). The
-- assistant content + any word-usage detection are server-produced -> guarded.
-- The user's transcript is produced by the server STT RPC too (voice-only), so
-- inserts here are effectively server-mediated; we still allow a client to
-- record its own user message text only when not trusted is unnecessary — keep
-- it simple: messages are written by the conversation RPC.
-- ============================================================================
create table conversation_messages (
  id          uuid primary key default gen_random_uuid(),
  session_id  uuid not null references conversation_sessions(id) on delete cascade,
  role        message_role not null,
  -- the message text (assistant typed; user = STT transcript)
  content     text not null,
  -- words from the unit detected as used in THIS message (server-detected)
  used_word_ids uuid[] not null default '{}',                      -- TRUSTED
  turn_index  integer not null,
  -- hint shown / translation revealed are UI flags; keep minimal in v1
  created_at  timestamptz not null default now(),
  constraint conversation_messages_turn_nonneg check (turn_index >= 0)
);

-- The whole message stream is written by the conversation DEFINER RPC, so a
-- direct untrusted client insert is rejected entirely.
create or replace function guard_conversation_messages_trusted()
returns trigger
language plpgsql
as $$
begin
  if coalesce(current_setting('app.trusted', true), 'off') = 'on' then
    return new;
  end if;
  perform assert_trusted_session();  -- always raises for untrusted clients
  return new;
end;
$$;

create trigger conversation_messages_guard_trusted
  before insert or update on conversation_messages
  for each row execute function guard_conversation_messages_trusted();

-- ============================================================================
-- USER_SETTINGS — client-writable preferences (scope 4.6): Arabic-support
-- level, audio, notifications. NOT trusted (no progress here).
-- ============================================================================
create table user_settings (
  user_id              uuid primary key references profiles(id) on delete cascade,
  arabic_support_level content_level not null default 'A1',  -- depth of Arabic explanation
  audio_autoplay       boolean not null default true,
  sound_effects        boolean not null default true,
  notifications_enabled boolean not null default true,
  daily_reminder_time  time,
  timezone             text not null default 'UTC',          -- used for streak day boundary
  locale               text not null default 'ar',
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);

create trigger user_settings_set_updated_at
  before update on user_settings
  for each row execute function set_updated_at();

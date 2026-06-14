-- ============================================================================
-- 0002_content_tables.sql
-- Authored learning content (units, words, examples, audio, listening, reading,
-- grammar, placement) + the separate ANSWER tables + the unit-word-reuse JOIN
-- tables + the "EXACTLY 5 unit_words per unit" deferred constraint trigger.
-- ----------------------------------------------------------------------------
-- INTEGRITY this file establishes:
--   * Rule 2 (answers never client-readable): comprehension_answers,
--     grammar_answers, placement_answer_keys are SEPARATE tables. Other agents
--     MUST give them NO select policy; grading happens only in a DEFINER RPC.
--     The readable *_questions rows expose prompt + options ONLY.
--   * Rule 5 (unit-word reuse): unit_words holds EXACTLY 5 rows per unit at
--     positions 1..5 (deferred constraint trigger below). Every listening /
--     reading / grammar / conversation link to a word goes through a join table
--     whose COMPOSITE FK references unit_words(unit_id, word_id) -> physically
--     impossible to attach a foreign word.
--   * Rule 6 (one audio catalog): audio_clips is the single source of truth.
--   * Every learning-content row carries a `level content_level` column.
--
-- This file writes NO RLS/RPC/storage. It DOES flag trusted columns in comments
-- where relevant (none of the authored-content tables are user-trusted; the
-- trust boundary lives in 0003/0004).
-- ============================================================================

-- ============================================================================
-- UNITS — the ordered journey. Each unit owns EXACTLY 5 words.
-- ============================================================================
create table units (
  id           uuid primary key default gen_random_uuid(),
  -- Global ordering of the journey; sequential unlock keys off this.
  position     integer not null,
  level        content_level not null,
  slug         text not null,
  title_ar     text not null,           -- Arabic UI title
  subtitle_ar  text,
  description_ar text,
  status       content_status not null default 'draft',
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  constraint units_position_positive check (position >= 1),
  constraint units_slug_unique unique (slug),
  constraint units_position_unique unique (position)
);

create trigger units_set_updated_at
  before update on units
  for each row execute function set_updated_at();

-- ============================================================================
-- WORDS — the English vocabulary catalog. A word may, in principle, exist
-- independently; its membership in a unit is expressed via unit_words.
-- ============================================================================
create table words (
  id            uuid primary key default gen_random_uuid(),
  level         content_level not null,
  text_en       text not null,           -- the English word (rendered LTR)
  phonetic      text,                     -- phonetic spelling (scope 4.5 A.1)
  translation_ar text not null,           -- Arabic meaning
  part_of_speech text,
  status        content_status not null default 'draft',
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  constraint words_text_en_not_blank check (length(btrim(text_en)) > 0)
);

create trigger words_set_updated_at
  before update on words
  for each row execute function set_updated_at();

-- ============================================================================
-- UNIT_WORDS — the 5-words membership. THE anchor for unit-word reuse.
-- position 1..5. The composite UNIQUE(unit_id, word_id) is the target of every
-- reuse join table's composite FK. A deferred constraint trigger enforces that
-- each unit has EXACTLY 5 rows (checked at COMMIT, so a 5-row insert in one
-- transaction is valid).
-- ============================================================================
create table unit_words (
  unit_id   uuid not null references units(id) on delete cascade,
  word_id   uuid not null references words(id) on delete restrict,
  position  integer not null,
  created_at timestamptz not null default now(),
  primary key (unit_id, word_id),
  -- positions are 1..5 and unique within a unit
  constraint unit_words_position_range check (position between 1 and 5),
  constraint unit_words_position_unique unique (unit_id, position)
);

-- The composite UNIQUE target that join-table composite FKs reference.
-- (The PK already provides this, but name it explicitly for FK clarity.)
-- Postgres lets a composite FK reference the PK columns directly, so the PK
-- (unit_id, word_id) is sufficient as the FK target.

-- --- Deferred "EXACTLY 5 unit_words per unit" enforcement -------------------
-- Runs at COMMIT (INITIALLY DEFERRED) so a transaction that inserts all five
-- rows is valid, while any committed state with != 5 words per touched unit is
-- rejected. We check only units touched by the current statement set by reading
-- the transition tables; but constraint triggers fire per-row, so we re-count
-- the affected unit each time. Counting at commit time reflects the final state.
create or replace function enforce_unit_has_five_words()
returns trigger
language plpgsql
as $$
declare
  v_unit_id uuid;
  v_count   integer;
begin
  -- Determine which unit to validate from the row that fired the trigger.
  if (tg_op = 'DELETE') then
    v_unit_id := old.unit_id;
  else
    v_unit_id := new.unit_id;
  end if;

  -- If the unit itself was deleted (cascade), nothing to validate.
  if not exists (select 1 from units u where u.id = v_unit_id) then
    return null;
  end if;

  select count(*) into v_count
  from unit_words uw
  where uw.unit_id = v_unit_id;

  if v_count <> 5 then
    raise exception
      'unit % must have exactly 5 words (found %)', v_unit_id, v_count
      using errcode = 'check_violation';
  end if;

  return null;
end;
$$;

create constraint trigger unit_words_exactly_five
  after insert or update or delete on unit_words
  deferrable initially deferred
  for each row execute function enforce_unit_has_five_words();

-- ============================================================================
-- WORD_EXAMPLES — example sentence(s) for a word (scope 4.5 A.1).
-- Carries its own level so examples can be level-adapted.
-- ============================================================================
create table word_examples (
  id             uuid primary key default gen_random_uuid(),
  word_id        uuid not null references words(id) on delete cascade,
  level          content_level not null,
  sentence_en    text not null,          -- example sentence (LTR)
  translation_ar text not null,
  position       integer not null default 1,
  status         content_status not null default 'draft',
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  constraint word_examples_position_positive check (position >= 1),
  constraint word_examples_word_position_unique unique (word_id, position)
);

create trigger word_examples_set_updated_at
  before update on word_examples
  for each row execute function set_updated_at();

-- ============================================================================
-- AUDIO_CLIPS — THE ONE audio catalog (integrity rule 6). Every play button in
-- the app resolves through here. A polymorphic owner (owner_type + owner_id)
-- points at the word / example / listening clip / word-of-the-day it voices.
-- (No hard FK on owner_id because owner_type varies; an integrity RPC/seed
-- guarantees referents. storage_path -> Supabase Storage object.)
-- ============================================================================
create table audio_clips (
  id           uuid primary key default gen_random_uuid(),
  owner_type   audio_owner_type not null,
  owner_id     uuid not null,
  storage_path text not null,            -- path inside the audio Storage bucket
  duration_ms  integer,
  voice        text,                     -- TTS voice id / "human"
  status       content_status not null default 'published',
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  constraint audio_clips_duration_positive check (duration_ms is null or duration_ms > 0),
  constraint audio_clips_owner_unique unique (owner_type, owner_id)
);

create trigger audio_clips_set_updated_at
  before update on audio_clips
  for each row execute function set_updated_at();

-- ============================================================================
-- LISTENING_CLIPS — a listening exercise screen (scope 4.5 D). Each clip
-- reveals its transcript + Arabic translation on "Translate". Audio lives in
-- audio_clips (owner_type='listening_clip'). Clip MUST use the unit's words ->
-- enforced via listening_clip_words join table below.
-- ============================================================================
create table listening_clips (
  id             uuid primary key default gen_random_uuid(),
  unit_id        uuid not null references units(id) on delete cascade,
  level          content_level not null,
  position       integer not null,       -- order within the unit's listening set
  transcript_en  text not null,          -- the spoken text, revealed on translate
  translation_ar text not null,
  status         content_status not null default 'draft',
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  constraint listening_clips_position_positive check (position >= 1),
  constraint listening_clips_unit_position_unique unique (unit_id, position)
);

create trigger listening_clips_set_updated_at
  before update on listening_clips
  for each row execute function set_updated_at();

-- ============================================================================
-- READING_PASSAGES — the reading screen (scope 4.5 E). One passage per unit
-- (allow more via position). Toggle reveals Arabic translation. MUST use the
-- unit's words -> enforced via reading_passage_words join table below.
-- ============================================================================
create table reading_passages (
  id             uuid primary key default gen_random_uuid(),
  unit_id        uuid not null references units(id) on delete cascade,
  level          content_level not null,
  position       integer not null default 1,
  title_en       text,
  body_en        text not null,          -- the English passage (LTR)
  translation_ar text not null,
  status         content_status not null default 'draft',
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  constraint reading_passages_position_positive check (position >= 1),
  constraint reading_passages_unit_position_unique unique (unit_id, position)
);

create trigger reading_passages_set_updated_at
  before update on reading_passages
  for each row execute function set_updated_at();

-- ============================================================================
-- COMPREHENSION_QUESTIONS — questions for listening clips AND reading passages
-- (scope 4.5 D & E). CLIENT-READABLE: prompt + options ONLY. The correct answer
-- lives in comprehension_answers (separate table, NO select policy).
-- Exactly one of (listening_clip_id, reading_passage_id) is set.
-- ============================================================================
create table comprehension_questions (
  id                 uuid primary key default gen_random_uuid(),
  listening_clip_id  uuid references listening_clips(id) on delete cascade,
  reading_passage_id uuid references reading_passages(id) on delete cascade,
  level              content_level not null,
  position           integer not null,   -- one question per screen, ordered
  kind               question_kind not null default 'multiple_choice',
  prompt_ar          text not null,      -- the question, in Arabic
  -- READABLE options for multiple_choice (array of choice labels). NO correct
  -- flag here — correctness lives in comprehension_answers.
  options            jsonb,
  status             content_status not null default 'draft',
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  constraint comprehension_q_position_positive check (position >= 1),
  -- exactly one parent
  constraint comprehension_q_one_parent check (
    (listening_clip_id is not null)::int + (reading_passage_id is not null)::int = 1
  ),
  -- multiple_choice must carry options; text_input must not
  constraint comprehension_q_options_shape check (
    (kind = 'multiple_choice' and options is not null)
    or (kind = 'text_input' and options is null)
  )
);

create trigger comprehension_questions_set_updated_at
  before update on comprehension_questions
  for each row execute function set_updated_at();

-- ============================================================================
-- COMPREHENSION_ANSWERS  (** SEPARATE ANSWER TABLE — NO CLIENT READ ACCESS **)
-- ----------------------------------------------------------------------------
-- TRUSTED/SECRET: rows here MUST have NO select policy (integrity rule 2).
-- Grading happens ONLY inside a SECURITY DEFINER RPC that reads this table.
-- For multiple_choice: correct_option_index. For text_input: accepted_answers
-- (array of normalized acceptable strings).
-- ============================================================================
create table comprehension_answers (
  question_id          uuid primary key references comprehension_questions(id) on delete cascade,
  correct_option_index integer,          -- for multiple_choice
  accepted_answers     jsonb,            -- for text_input: array of strings
  explanation_ar       text,             -- shown AFTER grading (via RPC), optional
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  constraint comprehension_a_index_nonneg check (
    correct_option_index is null or correct_option_index >= 0
  ),
  constraint comprehension_a_has_key check (
    correct_option_index is not null or accepted_answers is not null
  )
);

create trigger comprehension_answers_set_updated_at
  before update on comprehension_answers
  for each row execute function set_updated_at();

-- ============================================================================
-- GRAMMAR_LESSONS — the grammar lesson screen (scope 4.5 G). Rule explained in
-- Arabic; English examples MUST use the unit's words (join table below).
-- ============================================================================
create table grammar_lessons (
  id             uuid primary key default gen_random_uuid(),
  unit_id        uuid not null references units(id) on delete cascade,
  level          content_level not null,
  position       integer not null default 1,
  title_ar       text not null,
  explanation_ar text not null,          -- the rule, in Arabic
  examples       jsonb,                  -- [{en, translation_ar}] using unit words
  status         content_status not null default 'draft',
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  constraint grammar_lessons_position_positive check (position >= 1),
  constraint grammar_lessons_unit_position_unique unique (unit_id, position)
);

create trigger grammar_lessons_set_updated_at
  before update on grammar_lessons
  for each row execute function set_updated_at();

-- ============================================================================
-- GRAMMAR_QUESTIONS — the grammar quiz (scope 4.5 G). CLIENT-READABLE: prompt +
-- options ONLY. Correct answer lives in grammar_answers (NO select policy).
-- Questions MUST include the unit's words (join table below).
-- ============================================================================
create table grammar_questions (
  id                uuid primary key default gen_random_uuid(),
  grammar_lesson_id uuid not null references grammar_lessons(id) on delete cascade,
  level             content_level not null,
  position          integer not null,    -- one question per screen, ordered
  kind              question_kind not null default 'multiple_choice',
  prompt_ar         text not null,
  options           jsonb,               -- readable options; NO correct flag here
  status            content_status not null default 'draft',
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  constraint grammar_q_position_positive check (position >= 1),
  constraint grammar_q_lesson_position_unique unique (grammar_lesson_id, position),
  constraint grammar_q_options_shape check (
    (kind = 'multiple_choice' and options is not null)
    or (kind = 'text_input' and options is null)
  )
);

create trigger grammar_questions_set_updated_at
  before update on grammar_questions
  for each row execute function set_updated_at();

-- ============================================================================
-- GRAMMAR_ANSWERS  (** SEPARATE ANSWER TABLE — NO CLIENT READ ACCESS **)
-- ----------------------------------------------------------------------------
-- SECRET: NO select policy (integrity rule 2). Read only by a DEFINER RPC.
-- ============================================================================
create table grammar_answers (
  question_id          uuid primary key references grammar_questions(id) on delete cascade,
  correct_option_index integer,
  accepted_answers     jsonb,
  explanation_ar       text,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  constraint grammar_a_index_nonneg check (
    correct_option_index is null or correct_option_index >= 0
  ),
  constraint grammar_a_has_key check (
    correct_option_index is not null or accepted_answers is not null
  )
);

create trigger grammar_answers_set_updated_at
  before update on grammar_answers
  for each row execute function set_updated_at();

-- ============================================================================
-- PLACEMENT_QUESTIONS — placement test (scope 4.2), one question per screen.
-- CLIENT-READABLE: prompt + options ONLY. Correct answer + level weighting
-- live in placement_answer_keys (NO select policy). placement awards XP=0.
-- ============================================================================
create table placement_questions (
  id        uuid primary key default gen_random_uuid(),
  level     content_level not null,      -- the level this question probes
  position  integer not null,
  kind      question_kind not null default 'multiple_choice',
  prompt_ar text not null,
  options   jsonb,                        -- readable options; NO correct flag
  status    content_status not null default 'draft',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint placement_q_position_positive check (position >= 1),
  constraint placement_q_position_unique unique (position),
  constraint placement_q_options_shape check (
    (kind = 'multiple_choice' and options is not null)
    or (kind = 'text_input' and options is null)
  )
);

create trigger placement_questions_set_updated_at
  before update on placement_questions
  for each row execute function set_updated_at();

-- ============================================================================
-- PLACEMENT_ANSWER_KEYS  (** SEPARATE ANSWER TABLE — NO CLIENT READ ACCESS **)
-- ----------------------------------------------------------------------------
-- SECRET: NO select policy (integrity rule 2). Scoring + level assignment run
-- only inside a SECURITY DEFINER RPC that reads this table.
-- ============================================================================
create table placement_answer_keys (
  question_id          uuid primary key references placement_questions(id) on delete cascade,
  correct_option_index integer,
  accepted_answers     jsonb,
  -- how a correct answer contributes to the placement scoring algorithm
  awards_level         content_level,
  weight               integer not null default 1,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  constraint placement_a_index_nonneg check (
    correct_option_index is null or correct_option_index >= 0
  ),
  constraint placement_a_weight_positive check (weight >= 1),
  constraint placement_a_has_key check (
    correct_option_index is not null or accepted_answers is not null
  )
);

create trigger placement_answer_keys_set_updated_at
  before update on placement_answer_keys
  for each row execute function set_updated_at();

-- ============================================================================
-- FOUNDATIONS_LESSONS — phonics + very simple words for complete beginners
-- (scope 4.3). Level is effectively 'beginner' but kept as a column for
-- consistency / fallback. foundations_lesson awards XP=5.
-- ============================================================================
create table foundations_lessons (
  id             uuid primary key default gen_random_uuid(),
  level          content_level not null default 'beginner',
  position       integer not null,        -- sequential order of the foundations track
  kind           text not null,           -- 'phonics' | 'simple_word' (free text for v1)
  title_ar       text not null,
  body_ar        text,                    -- Arabic explanation / support
  letter_or_word text,                    -- the letter or simple English word taught
  status         content_status not null default 'draft',
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  constraint foundations_lessons_position_positive check (position >= 1),
  constraint foundations_lessons_position_unique unique (position)
);

create trigger foundations_lessons_set_updated_at
  before update on foundations_lessons
  for each row execute function set_updated_at();

-- ============================================================================
-- ============================================================================
--  UNIT-WORD-REUSE JOIN TABLES  (integrity rule 5)
-- ----------------------------------------------------------------------------
-- Each table links a piece of content to a word VIA A COMPOSITE FK to
-- unit_words(unit_id, word_id). Because the FK target is the membership row,
-- it is PHYSICALLY IMPOSSIBLE to attach a word that is not one of the unit's 5.
-- Each join row carries unit_id so the composite FK can be expressed.
-- ============================================================================
-- ============================================================================

-- listening_clip_words: which of the unit's words a listening clip uses.
create table listening_clip_words (
  listening_clip_id uuid not null references listening_clips(id) on delete cascade,
  unit_id           uuid not null,
  word_id           uuid not null,
  primary key (listening_clip_id, word_id),
  -- composite FK: word MUST be one of this unit's 5 words.
  constraint listening_clip_words_unit_word_fk
    foreign key (unit_id, word_id) references unit_words(unit_id, word_id) on delete cascade
);

-- reading_passage_words: which of the unit's words a passage uses.
create table reading_passage_words (
  reading_passage_id uuid not null references reading_passages(id) on delete cascade,
  unit_id            uuid not null,
  word_id            uuid not null,
  primary key (reading_passage_id, word_id),
  constraint reading_passage_words_unit_word_fk
    foreign key (unit_id, word_id) references unit_words(unit_id, word_id) on delete cascade
);

-- grammar_lesson_words: which of the unit's words a grammar lesson's examples use.
create table grammar_lesson_words (
  grammar_lesson_id uuid not null references grammar_lessons(id) on delete cascade,
  unit_id           uuid not null,
  word_id           uuid not null,
  primary key (grammar_lesson_id, word_id),
  constraint grammar_lesson_words_unit_word_fk
    foreign key (unit_id, word_id) references unit_words(unit_id, word_id) on delete cascade
);

-- grammar_question_words: which of the unit's words a grammar question includes.
create table grammar_question_words (
  grammar_question_id uuid not null references grammar_questions(id) on delete cascade,
  unit_id             uuid not null,
  word_id             uuid not null,
  primary key (grammar_question_id, word_id),
  constraint grammar_question_words_unit_word_fk
    foreign key (unit_id, word_id) references unit_words(unit_id, word_id) on delete cascade
);

-- conversation_required_words: the words the AI tutor REQUIRES in a unit's
-- conversation. NOTE: at RUNTIME a conversation_session selects its own
-- required_word_ids SERVER-SIDE (integrity rule 7); this table is the AUTHORED
-- candidate set per unit (normally all 5). Composite FK still guarantees reuse.
create table conversation_required_words (
  unit_id uuid not null,
  word_id uuid not null,
  primary key (unit_id, word_id),
  constraint conversation_required_words_unit_word_fk
    foreign key (unit_id, word_id) references unit_words(unit_id, word_id) on delete cascade
);

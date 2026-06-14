-- ============================================================================
-- 0008_rpcs.sql
-- The SECURITY DEFINER RPCs that own every TRUSTED write in the app.
-- ----------------------------------------------------------------------------
-- THIS FILE IS THE TRUST CEILING. The browser can never forge progress because:
--   * every function here is SECURITY DEFINER and OWNED BY postgres (a
--     privileged role), so it — and ONLY it — may legally run
--     `set local app.trusted = 'on'`, which unlocks the guard triggers from
--     0003 / 0004 for the duration of the call;
--   * every function pins `set search_path = public` so an attacker cannot
--     shadow a table/function name on the session search_path;
--   * every function resolves the caller via auth.uid() and FAILS CLOSED
--     (raises) when there is no authenticated user — a NULL uid can never act;
--   * grading reads the SECRET answer tables (comprehension_answers,
--     grammar_answers, placement_answer_keys) that have no client select policy,
--     and returns only correct/score — never which option was right up front;
--   * XP is minted through award_xp() which inserts into xp_events with
--     ON CONFLICT DO NOTHING on UNIQUE(user_id, source_type, source_id), so
--     replays are idempotent and total_xp is only bumped by the delta actually
--     inserted;
--   * sequential unlock is enforced SERVER-SIDE: complete_unit() verifies all
--     five section flags before marking a unit complete and unlocking the next.
--
-- Product constants come from DECISIONS.md and are encoded as the
-- app_xp_amount() / app_pron_pass_threshold() immutable helpers below so there
-- is exactly one source of truth in SQL.
--
-- GRANTS: EXECUTE is granted to `authenticated`. EXECUTE is REVOKED from
-- PUBLIC / anon so an unauthenticated client cannot even call these. RLS,
-- storage, and the per-table guard triggers (0003/0004) are owned elsewhere;
-- this file only adds functions + grants.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- Resume-point storage. advance_position() needs somewhere to persist "where
-- the user stopped" so Home's "Continue learning" can jump back. We add it to
-- unit_progress as additive, nullable, low-integrity columns (a UI pointer, not
-- a gate). Only advance_position() writes them in practice.
-- ----------------------------------------------------------------------------
alter table unit_progress
  add column if not exists resume_section    unit_section,
  add column if not exists resume_word_position integer,
  add column if not exists resume_sub_screen text,
  add column if not exists resume_updated_at timestamptz;

-- ============================================================================
-- PRODUCT-CONSTANT HELPERS (single source of truth in SQL; mirror DECISIONS.md)
-- ============================================================================

-- Fixed XP amount per source_type. IMMUTABLE so it can be inlined safely.
create or replace function app_xp_amount(p_source xp_source_type)
returns integer
language sql
immutable
set search_path = public
as $$
  select case p_source
    when 'word_quiz_pass'     then 10
    when 'full_words_quiz'    then 50
    when 'listening'          then 40
    when 'reading'            then 40
    when 'grammar_quiz'       then 40
    when 'conversation'       then 60
    when 'unit_complete'      then 100
    when 'streak_daily_bonus' then 20
    when 'foundations_lesson' then 5
    when 'placement'          then 0
  end;
$$;

comment on function app_xp_amount(xp_source_type) is
  'DECISIONS.md fixed XP amount per xp_source_type. Single source of truth.';

-- Pronunciation pass threshold (0-100).
create or replace function app_pron_pass_threshold()
returns integer language sql immutable set search_path = public
as $$ select 70 $$;

-- Pronunciation retry cap per word per screen visit.
create or replace function app_pron_retry_cap()
returns integer language sql immutable set search_path = public
as $$ select 3 $$;

-- Numeric rank of a content_level for ordering / fallback (beginner < A1 < C1).
create or replace function app_level_rank(p_level content_level)
returns integer language sql immutable set search_path = public
as $$
  select case p_level
    when 'beginner' then 0
    when 'A1' then 1
    when 'A2' then 2
    when 'B1' then 3
    when 'B2' then 4
    when 'C1' then 5
  end;
$$;

-- ============================================================================
-- require_auth(): resolve the caller, FAIL CLOSED if unauthenticated.
-- Every RPC calls this first. A NULL auth.uid() can never perform a trusted
-- write. (auth.uid() is provided by Supabase GoTrue from the verified JWT.)
-- ============================================================================
create or replace function require_auth()
returns uuid
language plpgsql
stable
set search_path = public
as $$
declare
  v_uid uuid;
begin
  v_uid := auth.uid();
  if v_uid is null then
    raise exception 'forbidden: authentication required'
      using errcode = 'insufficient_privilege';
  end if;
  return v_uid;
end;
$$;

-- ============================================================================
-- award_xp(source_type, source_id, amount, unit_id) -> integer
-- ----------------------------------------------------------------------------
-- The ONE XP minting path. Inserts an xp_events row keyed by
-- (user_id, source_type, source_id) so replays are idempotent (rule 3). Only
-- the rows actually inserted bump profiles.total_xp, so calling twice awards
-- once. Returns the XP delta actually granted (0 on a replay / 0-amount source).
--
-- The amount argument is accepted for callers but is ALWAYS overridden with the
-- canonical app_xp_amount() for the source_type so a caller can never inflate
-- it. (Argument kept so the signature reads as the task describes.)
-- ============================================================================
create or replace function award_xp(
  p_source_type xp_source_type,
  p_source_id   text,
  p_amount      integer default null,
  p_unit_id     uuid default null
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid    uuid := require_auth();
  v_amount integer := app_xp_amount(p_source_type);  -- canonical; ignore p_amount
  v_inserted integer;
begin
  set local app.trusted = 'on';

  if p_source_id is null or length(btrim(p_source_id)) = 0 then
    raise exception 'award_xp: source_id is required' using errcode = 'check_violation';
  end if;

  -- Idempotent insert. ON CONFLICT means a replay inserts nothing.
  insert into xp_events (user_id, source_type, source_id, amount, unit_id)
  values (v_uid, p_source_type, p_source_id, v_amount, p_unit_id)
  on conflict (user_id, source_type, source_id) do nothing;

  get diagnostics v_inserted = row_count;

  -- Only bump the rollup when we actually inserted (delta = the new row only).
  if v_inserted > 0 and v_amount > 0 then
    update profiles
       set total_xp = total_xp + v_amount
     where id = v_uid;
  end if;

  return case when v_inserted > 0 then v_amount else 0 end;
end;
$$;

-- ============================================================================
-- touch_streak() -> jsonb
-- ----------------------------------------------------------------------------
-- Timezone-aware, lazy streak evaluation (DECISIONS.md). A qualifying day is
-- "today" in the user's timezone (from user_settings.timezone, default UTC).
-- Upserts a streak_log row for today; computes the running length from
-- yesterday's row (consecutive => +1, else reset to 1; no grace period). Then
-- maintains profiles.current_streak_days / longest_streak_days and awards the
-- once-per-day streak_daily_bonus via award_xp (idempotent on the day-key).
-- Safe to call many times per day: the day row + the bonus are both idempotent.
-- Returns {today, current_streak_days, longest_streak_days, bonus_awarded}.
-- ============================================================================
create or replace function touch_streak()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid   uuid := require_auth();
  v_tz    text;
  v_today date;
  v_len   integer;
  v_prev  record;
  v_longest integer;
  v_bonus integer := 0;
begin
  set local app.trusted = 'on';

  select coalesce(timezone, 'UTC') into v_tz
    from user_settings where user_id = v_uid;
  v_tz := coalesce(v_tz, 'UTC');

  -- "Today" in the user's local calendar.
  v_today := (now() at time zone v_tz)::date;

  -- Already counted today? Read the existing length; otherwise derive from
  -- yesterday's row.
  select streak_length into v_len
    from streak_log
   where user_id = v_uid and activity_date = v_today;

  if v_len is null then
    select activity_date, streak_length into v_prev
      from streak_log
     where user_id = v_uid
     order by activity_date desc
     limit 1;

    if v_prev.activity_date is not null and v_prev.activity_date = v_today - 1 then
      v_len := v_prev.streak_length + 1;       -- consecutive day
    else
      v_len := 1;                              -- gap (or first ever) => reset
    end if;

    insert into streak_log (user_id, activity_date, streak_length)
    values (v_uid, v_today, v_len)
    on conflict (user_id, activity_date) do nothing;

    -- Re-read in case of a concurrent insert winning the race.
    select streak_length into v_len
      from streak_log
     where user_id = v_uid and activity_date = v_today;
  end if;

  -- Maintain the profile rollups.
  select longest_streak_days into v_longest from profiles where id = v_uid;
  v_longest := greatest(coalesce(v_longest, 0), v_len);

  update profiles
     set current_streak_days = v_len,
         longest_streak_days  = v_longest,
         last_activity_date   = v_today
   where id = v_uid;

  -- Once-per-day streak bonus, idempotent on the local day-key.
  v_bonus := award_xp('streak_daily_bonus', v_today::text, null, null);

  return jsonb_build_object(
    'today', v_today,
    'current_streak_days', v_len,
    'longest_streak_days', v_longest,
    'bonus_awarded', v_bonus
  );
end;
$$;

-- ============================================================================
-- score_placement(answers jsonb) -> jsonb
-- ----------------------------------------------------------------------------
-- answers = [{ "question_id": uuid, "selected_option_index": int,
--              "text_response": text }, ...]
-- Server-side grading against placement_answer_keys (SECRET table). Writes one
-- placement_answers row per answer with the trusted is_correct flag, computes
-- the determined level via a weighted-by-level scoring pass, decides whether the
-- user is a complete beginner, resolves recommended_start_unit_id, writes a
-- placement_results row, marks profiles.placement_completed + current_level, and
-- seeds the first unit_progress row as the user's CURRENT unit (status
-- 'in_progress'). placement awards XP=0 (idempotent record kept for audit).
-- ============================================================================

-- A small results table so the client can re-read the placement outcome without
-- exposing the answer keys. Created here (additive) next to its RPC.
create table if not exists placement_results (
  id                       uuid primary key default gen_random_uuid(),
  user_id                  uuid not null references profiles(id) on delete cascade,
  determined_level         user_level not null,
  is_complete_beginner     boolean not null default false,
  recommended_start_unit_id uuid references units(id) on delete set null,
  score                    integer not null default 0,
  total                    integer not null default 0,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now(),
  constraint placement_results_user_unique unique (user_id)
);

do $$
begin
  if not exists (
    select 1 from pg_trigger where tgname = 'placement_results_set_updated_at'
  ) then
    create trigger placement_results_set_updated_at
      before update on placement_results
      for each row execute function set_updated_at();
  end if;
end;
$$;

create or replace function score_placement(answers jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid   uuid := require_auth();
  v_ans   jsonb;
  v_qid   uuid;
  v_sel   integer;
  v_txt   text;
  v_key   record;
  v_correct boolean;
  v_total integer := 0;
  v_score integer := 0;
  -- best CEFR level the user proved (max awards_level over correct answers)
  v_best_rank integer := 0;       -- 0 == beginner / proved nothing above beginner
  v_level user_level;
  v_is_beginner boolean;
  v_unit_id uuid;
begin
  set local app.trusted = 'on';

  if answers is null or jsonb_typeof(answers) <> 'array' then
    raise exception 'score_placement: answers must be a JSON array'
      using errcode = 'check_violation';
  end if;

  for v_ans in select * from jsonb_array_elements(answers)
  loop
    v_qid := nullif(v_ans->>'question_id', '')::uuid;
    if v_qid is null then
      continue;  -- skip malformed entries; fail closed by ignoring
    end if;
    v_sel := nullif(v_ans->>'selected_option_index', '')::integer;
    v_txt := v_ans->>'text_response';

    -- Read the SECRET key (never returned to the client).
    select correct_option_index, accepted_answers, awards_level, weight
      into v_key
      from placement_answer_keys
     where question_id = v_qid;

    -- Grade: multiple_choice by index, text_input by normalized membership.
    v_correct := false;
    if v_key.question_id is distinct from null or v_key.correct_option_index is not null
       or v_key.accepted_answers is not null then
      -- (record found)
    end if;

    if v_key.correct_option_index is not null and v_sel is not null then
      v_correct := (v_sel = v_key.correct_option_index);
    elsif v_key.accepted_answers is not null and v_txt is not null then
      v_correct := exists (
        select 1
        from jsonb_array_elements_text(v_key.accepted_answers) a
        where lower(btrim(a)) = lower(btrim(v_txt))
      );
    end if;

    v_total := v_total + 1;

    -- Persist the user's answer with the trusted grade (idempotent per question).
    insert into placement_answers
      (user_id, question_id, selected_option_index, text_response, is_correct)
    values (v_uid, v_qid, v_sel, v_txt, v_correct)
    on conflict (user_id, question_id) do update
      set selected_option_index = excluded.selected_option_index,
          text_response         = excluded.text_response,
          is_correct            = excluded.is_correct;

    if v_correct then
      v_score := v_score + coalesce(v_key.weight, 1);
      -- Track the highest CEFR level the user demonstrated.
      if v_key.awards_level is not null then
        v_best_rank := greatest(v_best_rank, app_level_rank(v_key.awards_level));
      end if;
    end if;
  end loop;

  -- Determine the level: the highest level proved by a correct answer. If the
  -- user proved nothing above beginner -> complete beginner -> Foundations.
  v_is_beginner := (v_best_rank <= app_level_rank('beginner'));
  v_level := case v_best_rank
    when 0 then 'beginner'
    when 1 then 'A1'
    when 2 then 'A2'
    when 3 then 'B1'
    when 4 then 'B2'
    else 'C1'
  end::user_level;

  -- Recommended starting unit: the first published unit at the determined level
  -- (lowest position). For a complete beginner there is no A1+ unit to start, so
  -- recommended_start_unit_id stays NULL (they go to Foundations first); if no
  -- exact-level published unit exists, fall back to the nearest LOWER level,
  -- else the first published unit overall.
  if not v_is_beginner then
    select u.id into v_unit_id
      from units u
     where u.status = 'published'
       and u.level = v_level::content_level
     order by u.position asc
     limit 1;

    if v_unit_id is null then
      select u.id into v_unit_id
        from units u
       where u.status = 'published'
         and app_level_rank(u.level) <= app_level_rank(v_level::content_level)
       order by app_level_rank(u.level) desc, u.position asc
       limit 1;
    end if;

    if v_unit_id is null then
      select u.id into v_unit_id
        from units u
       where u.status = 'published'
       order by u.position asc
       limit 1;
    end if;
  end if;

  -- Write the results row (re-runnable).
  insert into placement_results
    (user_id, determined_level, is_complete_beginner, recommended_start_unit_id, score, total)
  values (v_uid, v_level, v_is_beginner, v_unit_id, v_score, v_total)
  on conflict (user_id) do update
    set determined_level          = excluded.determined_level,
        is_complete_beginner      = excluded.is_complete_beginner,
        recommended_start_unit_id = excluded.recommended_start_unit_id,
        score                     = excluded.score,
        total                     = excluded.total;

  -- Update the profile (trusted): level + completed flag.
  update profiles
     set current_level       = v_level,
         placement_completed = true
   where id = v_uid;

  -- Seed the first unit as the CURRENT unit (in_progress) so the journey opens
  -- where the placement put them. Beginners get this once they leave Foundations
  -- — but seed it now if a unit was resolved.
  if v_unit_id is not null then
    insert into unit_progress (user_id, unit_id, status, started_at)
    values (v_uid, v_unit_id, 'in_progress', now())
    on conflict (user_id, unit_id) do update
      set status     = case when unit_progress.status = 'locked'
                            then 'in_progress' else unit_progress.status end,
          started_at = coalesce(unit_progress.started_at, now());
  end if;

  -- placement awards XP=0, but record it for audit/idempotency.
  perform award_xp('placement', v_uid::text, null, null);

  return jsonb_build_object(
    'determined_level', v_level,
    'is_complete_beginner', v_is_beginner,
    'recommended_start_unit_id', v_unit_id,
    'score', v_score,
    'total', v_total
  );
end;
$$;

-- ============================================================================
-- advance_position(unit_id, step, word_position, sub_screen) -> void
-- ----------------------------------------------------------------------------
-- Saves the user's resume point (auto-save of position; scope cross-cutting).
-- Low-integrity UI pointer, but written through the trusted path so the
-- unit_progress row is touched consistently. Does NOT grant any completion —
-- locking is enforced by complete_unit(). The caller may only advance within a
-- unit they actually own a progress row for; we upsert that row (locked stays
-- locked — we never silently unlock here).
-- ============================================================================
create or replace function advance_position(
  p_unit_id       uuid,
  p_step          unit_section,
  p_word_position integer default null,
  p_sub_screen    text default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := require_auth();
begin
  set local app.trusted = 'on';

  if p_unit_id is null then
    raise exception 'advance_position: unit_id is required' using errcode = 'check_violation';
  end if;
  if p_word_position is not null and p_word_position not between 1 and 5 then
    raise exception 'advance_position: word_position must be 1..5'
      using errcode = 'check_violation';
  end if;

  insert into unit_progress
    (user_id, unit_id, status, started_at,
     resume_section, resume_word_position, resume_sub_screen, resume_updated_at)
  values
    (v_uid, p_unit_id, 'in_progress', now(),
     p_step, p_word_position, p_sub_screen, now())
  on conflict (user_id, unit_id) do update
    set resume_section       = excluded.resume_section,
        resume_word_position = excluded.resume_word_position,
        resume_sub_screen    = excluded.resume_sub_screen,
        resume_updated_at     = now(),
        started_at           = coalesce(unit_progress.started_at, now());
end;
$$;

-- ============================================================================
-- build_meaning_quiz(word_id) -> jsonb
-- ----------------------------------------------------------------------------
-- Returns the meaning multiple-choice for a word: the correct Arabic
-- translation mixed with distractor translations from OTHER words, SHUFFLED, so
-- the client cannot tell which option is correct from the payload. The correct
-- index is NOT returned (grading happens in grade_quiz). Distractors are drawn
-- from words at a similar level for plausibility.
-- Returns { word_id, text_en, phonetic, options:[ar,...] }.
-- ============================================================================
create or replace function build_meaning_quiz(p_word_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := require_auth();   -- must be signed in to take a quiz
  v_word record;
  v_options text[];
begin
  -- (no trusted writes here, but keep the auth gate; DEFINER lets us read words
  -- regardless of content RLS in a uniform way)
  select id, text_en, phonetic, translation_ar, level
    into v_word
    from words
   where id = p_word_id;

  if v_word.id is null then
    raise exception 'build_meaning_quiz: word not found' using errcode = 'no_data_found';
  end if;

  -- Gather up to 3 distinct distractor translations from other words, preferring
  -- the same level, then fill from any level. Then add the correct one and
  -- shuffle the whole set.
  select array_agg(t) into v_options
  from (
    select distinct on (w.translation_ar) w.translation_ar as t
    from words w
    where w.id <> v_word.id
      and w.translation_ar is distinct from v_word.translation_ar
      and w.status = 'published'
    order by w.translation_ar,
             case when w.level = v_word.level then 0 else 1 end
    limit 3
  ) d;

  v_options := coalesce(v_options, array[]::text[]) || array[v_word.translation_ar];

  -- Shuffle (random order) so position carries no signal.
  select array_agg(o order by random()) into v_options
  from unnest(v_options) o;

  return jsonb_build_object(
    'word_id', v_word.id,
    'text_en', v_word.text_en,
    'phonetic', v_word.phonetic,
    'options', to_jsonb(v_options)
  );
end;
$$;

-- ============================================================================
-- grade_quiz(quiz_type, question_id, user_answer, unit_id, word_id) -> jsonb
-- ----------------------------------------------------------------------------
-- The single grading entry point for spelling / meaning / full_words / grammar
-- quizzes (NOT pronunciation — that is record_pronunciation). Reads the SECRET
-- answer table relevant to the quiz, decides correct/score SERVER-SIDE, records
-- an immutable quiz_attempts audit row (trusted grade), updates the relevant
-- user_word_status pass flag, recomputes `learned`, and — on a PASS — awards XP
-- idempotently (word_quiz_pass / full_words_quiz / grammar_quiz). Never trusts a
-- client-supplied correctness.
--
-- user_answer jsonb = { "selected_option_index": int } or { "text_response": text }.
-- For spelling: the canonical answer is the word's own text_en (no answer table).
-- For meaning: graded against words.translation_ar.
-- For grammar / full_words(grammar-style): graded against grammar_answers /
--   comprehension_answers as appropriate (full_words mixes word checks).
-- Returns { correct, score, xp_awarded, learned }.
-- ============================================================================
create or replace function grade_quiz(
  p_quiz_type   quiz_kind,
  p_question_id uuid default null,
  p_user_answer jsonb default '{}'::jsonb,
  p_unit_id     uuid default null,
  p_word_id     uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid     uuid := require_auth();
  v_sel     integer := nullif(p_user_answer->>'selected_option_index', '')::integer;
  v_txt     text    := p_user_answer->>'text_response';
  v_correct boolean := false;
  v_score   integer;
  v_xp      integer := 0;
  v_learned boolean := false;
  v_word    record;
  v_ans     record;
begin
  set local app.trusted = 'on';

  if p_quiz_type = 'pronunciation' then
    raise exception 'grade_quiz: use record_pronunciation for pronunciation'
      using errcode = 'check_violation';
  end if;

  -- ---- Grade by quiz type ----
  if p_quiz_type = 'spelling' then
    -- Canonical answer is the word's own English text (case/space-insensitive).
    if p_word_id is null then
      raise exception 'grade_quiz: word_id required for spelling' using errcode = 'check_violation';
    end if;
    select text_en into v_word from words where id = p_word_id;
    if v_word.text_en is null then
      raise exception 'grade_quiz: word not found' using errcode = 'no_data_found';
    end if;
    v_correct := (lower(btrim(coalesce(v_txt, ''))) = lower(btrim(v_word.text_en)));

  elsif p_quiz_type = 'meaning' then
    -- Graded against the word's Arabic translation. The client sent the chosen
    -- option LABEL as text_response (from build_meaning_quiz options) OR an
    -- index into a client-held option list; we grade on the label text to avoid
    -- trusting an index the server never issued.
    if p_word_id is null then
      raise exception 'grade_quiz: word_id required for meaning' using errcode = 'check_violation';
    end if;
    select translation_ar into v_word from words where id = p_word_id;
    if v_word.translation_ar is null then
      raise exception 'grade_quiz: word not found' using errcode = 'no_data_found';
    end if;
    v_correct := (btrim(coalesce(v_txt, '')) = btrim(v_word.translation_ar));

  elsif p_quiz_type = 'grammar' then
    if p_question_id is null then
      raise exception 'grade_quiz: question_id required for grammar' using errcode = 'check_violation';
    end if;
    select correct_option_index, accepted_answers into v_ans
      from grammar_answers where question_id = p_question_id;
    if v_ans.correct_option_index is null and v_ans.accepted_answers is null then
      raise exception 'grade_quiz: no answer key for grammar question'
        using errcode = 'no_data_found';
    end if;
    if v_ans.correct_option_index is not null and v_sel is not null then
      v_correct := (v_sel = v_ans.correct_option_index);
    elsif v_ans.accepted_answers is not null and v_txt is not null then
      v_correct := exists (
        select 1 from jsonb_array_elements_text(v_ans.accepted_answers) a
        where lower(btrim(a)) = lower(btrim(v_txt))
      );
    end if;

  elsif p_quiz_type = 'full_words' then
    -- The mixed full words quiz. A question is either a per-word check (spelling
    -- or meaning, keyed by word_id) or a comprehension/grammar-style question
    -- (keyed by question_id). Resolve accordingly.
    if p_word_id is not null then
      select text_en, translation_ar into v_word from words where id = p_word_id;
      if v_word.text_en is null then
        raise exception 'grade_quiz: word not found' using errcode = 'no_data_found';
      end if;
      if v_txt is not null and lower(btrim(v_txt)) = lower(btrim(v_word.text_en)) then
        v_correct := true;
      elsif v_txt is not null and btrim(v_txt) = btrim(v_word.translation_ar) then
        v_correct := true;
      end if;
    elsif p_question_id is not null then
      select correct_option_index, accepted_answers into v_ans
        from grammar_answers where question_id = p_question_id;
      if v_ans.correct_option_index is null and v_ans.accepted_answers is null then
        select correct_option_index, accepted_answers into v_ans
          from comprehension_answers where question_id = p_question_id;
      end if;
      if v_ans.correct_option_index is not null and v_sel is not null then
        v_correct := (v_sel = v_ans.correct_option_index);
      elsif v_ans.accepted_answers is not null and v_txt is not null then
        v_correct := exists (
          select 1 from jsonb_array_elements_text(v_ans.accepted_answers) a
          where lower(btrim(a)) = lower(btrim(v_txt))
        );
      end if;
    else
      raise exception 'grade_quiz: full_words needs word_id or question_id'
        using errcode = 'check_violation';
    end if;
  else
    raise exception 'grade_quiz: unsupported quiz_type %', p_quiz_type
      using errcode = 'check_violation';
  end if;

  v_score := case when v_correct then 100 else 0 end;

  -- ---- Immutable audit row (trusted grade) ----
  insert into quiz_attempts
    (user_id, unit_id, quiz_kind, question_id, word_id,
     selected_option_index, text_response, is_correct, score)
  values
    (v_uid, p_unit_id, p_quiz_type, p_question_id, p_word_id,
     v_sel, v_txt, v_correct, v_score);

  -- ---- Update per-word mastery flags for per-word quiz types ----
  if v_correct and p_word_id is not null and p_unit_id is not null
     and p_quiz_type in ('spelling', 'meaning') then
    insert into user_word_status (user_id, unit_id, word_id,
        spelling_passed, meaning_passed)
    values (v_uid, p_unit_id, p_word_id,
        (p_quiz_type = 'spelling'), (p_quiz_type = 'meaning'))
    on conflict (user_id, unit_id, word_id) do update
      set spelling_passed = user_word_status.spelling_passed or (p_quiz_type = 'spelling'),
          meaning_passed  = user_word_status.meaning_passed  or (p_quiz_type = 'meaning');

    -- learned == all three per-word checks passed.
    update user_word_status
       set learned = (spelling_passed and pronunciation_passed and meaning_passed),
           learned_at = case
             when (spelling_passed and pronunciation_passed and meaning_passed)
                  and learned_at is null then now()
             else learned_at end
     where user_id = v_uid and unit_id = p_unit_id and word_id = p_word_id
     returning learned into v_learned;

    -- Keep profiles.words_learned_count in sync (count of learned words).
    update profiles p
       set words_learned_count = (
         select count(*) from user_word_status s
          where s.user_id = v_uid and s.learned = true)
     where p.id = v_uid;
  end if;

  -- ---- Award XP on pass, idempotently ----
  if v_correct then
    if p_quiz_type in ('spelling', 'meaning') then
      -- One word_quiz_pass award per (word + quiz type) screen.
      v_xp := award_xp('word_quiz_pass',
                       p_word_id::text || ':' || p_quiz_type::text,
                       null, p_unit_id);
    elsif p_quiz_type = 'grammar' then
      v_xp := award_xp('grammar_quiz', coalesce(p_question_id::text, p_unit_id::text),
                       null, p_unit_id);
    elsif p_quiz_type = 'full_words' then
      v_xp := award_xp('full_words_quiz',
                       coalesce(p_unit_id::text, p_question_id::text, p_word_id::text),
                       null, p_unit_id);
    end if;
  end if;

  return jsonb_build_object(
    'correct', v_correct,
    'score', v_score,
    'xp_awarded', v_xp,
    'learned', v_learned
  );
end;
$$;

-- ============================================================================
-- record_pronunciation(word_id, unit_id, score, accuracy, fluency, phonemes,
--                      recording_path) -> jsonb
-- ----------------------------------------------------------------------------
-- The assessment provider's raw numbers arrive here (already produced server-
-- side by the speech function); THIS RPC is the trust boundary that decides
-- passed = (score >= 70) — never the client. Enforces retry_cap=3 per word per
-- screen visit by deriving attempt_no, writes pronunciation_attempts, updates
-- user_word_status.best_pronunciation_score + pronunciation_passed, recomputes
-- learned, and (on first pass) awards word_quiz_pass XP idempotently.
-- Returns { passed, score, best, attempt_no, learned, xp_awarded }.
-- ============================================================================
create or replace function record_pronunciation(
  p_word_id        uuid,
  p_unit_id        uuid,
  p_score          integer,
  p_accuracy       numeric default null,
  p_fluency        numeric default null,
  p_phonemes       jsonb default null,
  p_recording_path text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid    uuid := require_auth();
  v_pass_threshold integer := app_pron_pass_threshold();
  v_passed boolean;
  v_attempt integer;
  v_used    integer;
  v_best    integer;
  v_assess  jsonb;
  v_learned boolean := false;
  v_xp      integer := 0;
begin
  set local app.trusted = 'on';

  if p_unit_id is null or p_word_id is null then
    raise exception 'record_pronunciation: unit_id and word_id are required'
      using errcode = 'check_violation';
  end if;
  if p_score is null or p_score not between 0 and 100 then
    raise exception 'record_pronunciation: score must be 0..100'
      using errcode = 'check_violation';
  end if;

  -- SERVER decides passed.
  v_passed := (p_score >= v_pass_threshold);

  -- Retry cap = 3 per word "per screen visit". We model a screen visit as the
  -- attempts since the last PASS for this word: count attempts after the most
  -- recent passed=true (or all, if never passed).
  select count(*) into v_used
    from pronunciation_attempts pa
   where pa.user_id = v_uid and pa.unit_id = p_unit_id and pa.word_id = p_word_id
     and pa.created_at > coalesce((
        select max(created_at) from pronunciation_attempts
         where user_id = v_uid and unit_id = p_unit_id and word_id = p_word_id
           and passed = true
     ), '-infinity'::timestamptz);

  v_attempt := v_used + 1;
  if v_attempt > app_pron_retry_cap() then
    raise exception 'record_pronunciation: retry cap (%) reached for this word'
      , app_pron_retry_cap()
      using errcode = 'check_violation';
  end if;

  -- Assemble the diagnostic blob the client shows (highlighted phoneme errors).
  v_assess := jsonb_strip_nulls(jsonb_build_object(
    'accuracy', p_accuracy,
    'fluency', p_fluency,
    'phonemes', p_phonemes
  ));

  insert into pronunciation_attempts
    (user_id, unit_id, word_id, score, passed, assessment, recording_path, attempt_no)
  values
    (v_uid, p_unit_id, p_word_id, p_score, v_passed, v_assess, p_recording_path, v_attempt);

  -- Update best score + pass flag on user_word_status.
  insert into user_word_status (user_id, unit_id, word_id,
      pronunciation_passed, best_pronunciation_score)
  values (v_uid, p_unit_id, p_word_id, v_passed, p_score)
  on conflict (user_id, unit_id, word_id) do update
    set pronunciation_passed = user_word_status.pronunciation_passed or v_passed,
        best_pronunciation_score = greatest(
          coalesce(user_word_status.best_pronunciation_score, 0), p_score);

  select best_pronunciation_score into v_best
    from user_word_status
   where user_id = v_uid and unit_id = p_unit_id and word_id = p_word_id;

  -- Recompute learned.
  update user_word_status
     set learned = (spelling_passed and pronunciation_passed and meaning_passed),
         learned_at = case
           when (spelling_passed and pronunciation_passed and meaning_passed)
                and learned_at is null then now()
           else learned_at end
   where user_id = v_uid and unit_id = p_unit_id and word_id = p_word_id
   returning learned into v_learned;

  update profiles p
     set words_learned_count = (
       select count(*) from user_word_status s
        where s.user_id = v_uid and s.learned = true)
   where p.id = v_uid;

  -- Award XP once per word for clearing the pronunciation gate.
  if v_passed then
    v_xp := award_xp('word_quiz_pass', p_word_id::text || ':pronunciation',
                     null, p_unit_id);
  end if;

  return jsonb_build_object(
    'passed', v_passed,
    'score', p_score,
    'best', v_best,
    'attempt_no', v_attempt,
    'learned', v_learned,
    'xp_awarded', v_xp
  );
end;
$$;

-- ============================================================================
-- complete_unit(unit_id) -> jsonb
-- ----------------------------------------------------------------------------
-- SERVER-SIDE locking gate (rule 4). Verifies the user's unit_progress row has
-- ALL FIVE section flags set (words/listening/reading/conversation/grammar)
-- before it will mark the unit completed. On success it: sets status='completed'
-- + completed_at, awards unit_complete XP idempotently (xp_awarded flag +
-- xp_events unique both guard double-award), and UNLOCKS the next unit (by
-- position) as the new CURRENT unit ('in_progress'). Refuses (raises) if any
-- section is incomplete. Returns { completed, xp_awarded, next_unit_id }.
-- ============================================================================
create or replace function complete_unit(p_unit_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid  uuid := require_auth();
  v_up   record;
  v_unit record;
  v_next_id uuid;
  v_xp   integer := 0;
  v_just_completed boolean := false;
begin
  set local app.trusted = 'on';

  if p_unit_id is null then
    raise exception 'complete_unit: unit_id is required' using errcode = 'check_violation';
  end if;

  select * into v_up
    from unit_progress
   where user_id = v_uid and unit_id = p_unit_id;

  if v_up.id is null then
    raise exception 'complete_unit: no progress for this unit'
      using errcode = 'no_data_found';
  end if;

  -- The current unit must be unlocked (not 'locked') — server-side locking.
  if v_up.status = 'locked' then
    raise exception 'complete_unit: unit is locked' using errcode = 'insufficient_privilege';
  end if;

  -- Verify ALL sections are done.
  if not (v_up.words_completed and v_up.listening_completed
          and v_up.reading_completed and v_up.conversation_completed
          and v_up.grammar_completed) then
    raise exception 'complete_unit: not all sections complete'
      using errcode = 'check_violation';
  end if;

  -- Mark complete (idempotent: only act on the transition).
  if v_up.status <> 'completed' then
    update unit_progress
       set status = 'completed',
           completed_at = coalesce(completed_at, now())
     where user_id = v_uid and unit_id = p_unit_id;
    v_just_completed := true;
  end if;

  -- Award unit_complete XP idempotently (keyed by unit_id).
  v_xp := award_xp('unit_complete', p_unit_id::text, null, p_unit_id);
  if v_xp > 0 then
    update unit_progress set xp_awarded = true
     where user_id = v_uid and unit_id = p_unit_id;
  end if;

  -- Unlock the next published unit by position as the new CURRENT unit.
  select * into v_unit from units where id = p_unit_id;
  if v_unit.id is not null then
    select id into v_next_id
      from units
     where status = 'published' and position > v_unit.position
     order by position asc
     limit 1;

    if v_next_id is not null then
      insert into unit_progress (user_id, unit_id, status, started_at)
      values (v_uid, v_next_id, 'in_progress', now())
      on conflict (user_id, unit_id) do update
        set status = case when unit_progress.status = 'locked'
                          then 'in_progress' else unit_progress.status end,
            started_at = coalesce(unit_progress.started_at, now());
    end if;
  end if;

  -- Touch the streak (this counts as activity today).
  perform touch_streak();

  return jsonb_build_object(
    'completed', true,
    'just_completed', v_just_completed,
    'xp_awarded', v_xp,
    'next_unit_id', v_next_id
  );
end;
$$;

-- ============================================================================
-- get_leaderboard(period default 'all_time', limit default 50) -> setof
-- ----------------------------------------------------------------------------
-- Public-safe leaderboard projection: ONLY display_name, avatar_url, total_xp,
-- and a dense rank. NO email / age / goal / ids leak. v1 ranks all-time by
-- total_xp DESC (DECISIONS.md); the `period` arg is the reserved hook for
-- 'weekly' later (currently both behave as all-time). The caller's own row is
-- always resolvable client-side by matching display_name is NOT reliable, so we
-- also expose is_me computed from auth.uid() without revealing other users' ids.
-- ============================================================================
create or replace function get_leaderboard(
  p_period leaderboard_period default 'all_time',
  p_limit  integer default 50
)
returns table (
  rank         bigint,
  display_name text,
  avatar_url   text,
  total_xp     integer,
  is_me        boolean
)
language plpgsql
security definer
stable
set search_path = public
as $$
declare
  v_uid uuid := require_auth();
  v_limit integer := least(greatest(coalesce(p_limit, 50), 1), 200);
begin
  -- p_period is a reserved hook; v1 always ranks all-time by total_xp.
  return query
    select
      rank() over (order by p.total_xp desc, p.created_at asc) as rank,
      p.display_name,
      p.avatar_url,
      p.total_xp,
      (p.id = v_uid) as is_me
    from profiles p
    where p.total_xp > 0
    order by p.total_xp desc, p.created_at asc
    limit v_limit;
end;
$$;

-- ============================================================================
-- OWNERSHIP + GRANTS
-- ----------------------------------------------------------------------------
-- Every function is owned by `postgres` (the privileged role allowed to flip
-- app.trusted). Supabase runs migrations as the owner role; we set ownership
-- explicitly to be safe. EXECUTE is granted to `authenticated` only; revoked
-- from PUBLIC/anon so unauthenticated callers can't even invoke them (and they
-- would fail closed at require_auth() anyway).
-- ============================================================================

do $$
declare
  fn text;
  fns text[] := array[
    'app_xp_amount(xp_source_type)',
    'app_pron_pass_threshold()',
    'app_pron_retry_cap()',
    'app_level_rank(content_level)',
    'require_auth()',
    'award_xp(xp_source_type, text, integer, uuid)',
    'touch_streak()',
    'score_placement(jsonb)',
    'advance_position(uuid, unit_section, integer, text)',
    'build_meaning_quiz(uuid)',
    'grade_quiz(quiz_kind, uuid, jsonb, uuid, uuid)',
    'record_pronunciation(uuid, uuid, integer, numeric, numeric, jsonb, text)',
    'complete_unit(uuid)',
    'get_leaderboard(leaderboard_period, integer)'
  ];
begin
  foreach fn in array fns loop
    -- Own by postgres so SECURITY DEFINER runs with the privileged role.
    execute format('alter function %s owner to postgres', fn);
    -- Lock down then grant to authenticated users only.
    execute format('revoke all on function %s from public', fn);
    execute format('grant execute on function %s to authenticated', fn);
  end loop;
end;
$$;

-- ----------------------------------------------------------------------------
-- COMMENTS (developer-facing summary of the trust contract)
-- ----------------------------------------------------------------------------
comment on function score_placement(jsonb) is
  'SECURITY DEFINER. Grades placement vs placement_answer_keys (secret), writes placement_answers/results, sets profiles.current_level+placement_completed, seeds first unit_progress=current. Auth-gated.';
comment on function advance_position(uuid, unit_section, integer, text) is
  'SECURITY DEFINER. Saves the user resume point on unit_progress. Never unlocks. Auth-gated.';
comment on function build_meaning_quiz(uuid) is
  'SECURITY DEFINER. Returns shuffled Arabic options (correct + distractors) WITHOUT revealing the correct index. Auth-gated.';
comment on function grade_quiz(quiz_kind, uuid, jsonb, uuid, uuid) is
  'SECURITY DEFINER. Grades spelling/meaning/grammar/full_words server-side, records quiz_attempts, updates user_word_status, awards XP idempotently. Auth-gated.';
comment on function record_pronunciation(uuid, uuid, integer, numeric, numeric, jsonb, text) is
  'SECURITY DEFINER. Server decides passed=score>=70, enforces retry cap, writes pronunciation_attempts + user_word_status best/passed, awards XP. Auth-gated.';
comment on function complete_unit(uuid) is
  'SECURITY DEFINER. Verifies all sections done (server-side locking), marks unit completed, unlocks next as current, awards unit_complete XP. Auth-gated.';
comment on function award_xp(xp_source_type, text, integer, uuid) is
  'SECURITY DEFINER. Idempotent XP mint via xp_events UNIQUE; bumps profiles.total_xp by the inserted delta only. Auth-gated.';
comment on function touch_streak() is
  'SECURITY DEFINER. Timezone-aware lazy streak upsert into streak_log + profiles counters; awards streak_daily_bonus once/day. Auth-gated.';
comment on function get_leaderboard(leaderboard_period, integer) is
  'SECURITY DEFINER. Returns ONLY display_name, avatar_url, total_xp, rank (no PII). all_time by total_xp; period is a hook. Auth-gated.';

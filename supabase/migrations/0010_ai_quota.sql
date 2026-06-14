-- ============================================================================
-- 0010_ai_quota.sql
-- AI abuse-control + conversation persistence helpers for the Edge Functions
-- (supabase/functions/{conversation,stt-proxy,tts-fallback,speech-token}).
-- ----------------------------------------------------------------------------
-- WHY THIS EXISTS (integrity rule 7):
--   ai_usage, conversation_sessions, conversation_messages are all TRUSTED:
--   their guard triggers (0003/0004) reject any write unless the session set
--   app.trusted='on'. ONLY a SECURITY DEFINER function owned by a privileged
--   role may set that GUC. The Edge Functions therefore call the DEFINER RPCs
--   below (with the service role) instead of writing those tables directly, so:
--     * the browser can never forge AI usage or a conversation transcript;
--     * required_word_ids are chosen SERVER-SIDE (client cannot pick the words);
--     * per-user daily quotas are enforced atomically before any paid work.
--
-- This file adds:
--   1. an owner-READ RLS policy on ai_usage (so the app can show "x/20 left");
--   2. ai_usage_check_and_increment()  — atomic quota check + increment;
--   3. conversation_start()            — creates the session + required words;
--   4. conversation_append_messages()  — persists a turn (user + assistant);
--   5. conversation_finalize()         — sets the final outcome.
--
-- DEFAULT daily caps (DECISIONS.md): conversation_session<=20,
-- speech_token_mint<=200, stt<=200, tts_fallback<=100.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- Helper: a (user, kind) -> DEFAULT daily cap lookup. Single source of truth so
-- the Edge Functions and the DB never disagree.
-- ----------------------------------------------------------------------------
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
    else 0
  end;
$$;

comment on function ai_usage_daily_cap(ai_usage_kind) is
  'DEFAULT per-user daily AI quota cap per kind (DECISIONS.md).';

-- ----------------------------------------------------------------------------
-- Helper: resolve "today" in the caller's timezone. Streaks + quotas use the
-- user's local calendar day (DECISIONS.md). Falls back to UTC when no setting.
-- ----------------------------------------------------------------------------
create or replace function user_local_date(p_user_id uuid)
returns date
language sql
stable
as $$
  select (now() at time zone coalesce(
            (select s.timezone from user_settings s where s.user_id = p_user_id),
            'UTC'))::date;
$$;

-- ----------------------------------------------------------------------------
-- 1) OWNER-READ RLS on ai_usage.
-- ai_usage already has guard triggers making it server-WRITE-only. Reads are
-- harmless and useful (showing remaining quota), so allow each user to read
-- ONLY their own rows. Writes still go through the DEFINER RPC below.
-- (Other agents own RLS broadly; we add just this one policy for our table.)
-- ----------------------------------------------------------------------------
alter table ai_usage enable row level security;

drop policy if exists ai_usage_owner_read on ai_usage;
create policy ai_usage_owner_read
  on ai_usage
  for select
  using (user_id = auth.uid());

-- Index supporting the owner-read + quota lookup is in 0005
-- (ai_usage_user_date_idx) plus the UNIQUE(user_id, kind, usage_date).

-- ============================================================================
-- 2) ai_usage_check_and_increment(): atomic per-user daily quota gate.
-- Returns (allowed, count, cap). When allowed, count reflects the POST-increment
-- value. When the cap is already reached, allowed=false and NOTHING is written.
-- SECURITY DEFINER + set local app.trusted='on' so the guard trigger permits the
-- write. search_path pinned to public for safety.
-- ============================================================================
create or replace function ai_usage_check_and_increment(
  p_user_id uuid,
  p_kind    ai_usage_kind
)
returns table (allowed boolean, count integer, cap integer)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_cap   integer := ai_usage_daily_cap(p_kind);
  v_date  date    := user_local_date(p_user_id);
  v_count integer;
begin
  -- Authorize via the trusted GUC so the ai_usage guard trigger allows writes.
  perform set_config('app.trusted', 'on', true);

  -- Ensure today's row exists (idempotent on the unique key).
  insert into ai_usage (user_id, kind, usage_date, count)
  values (p_user_id, p_kind, v_date, 0)
  on conflict (user_id, kind, usage_date) do nothing;

  -- Lock the row, then increment IFF under cap. FOR UPDATE serializes
  -- concurrent function invocations for the same (user, kind, day).
  select au.count into v_count
  from ai_usage au
  where au.user_id = p_user_id
    and au.kind = p_kind
    and au.usage_date = v_date
  for update;

  if v_count >= v_cap then
    return query select false, v_count, v_cap;
    return;
  end if;

  update ai_usage au
     set count = au.count + 1
   where au.user_id = p_user_id
     and au.kind = p_kind
     and au.usage_date = v_date
  returning au.count into v_count;

  return query select true, v_count, v_cap;
end;
$$;

comment on function ai_usage_check_and_increment(uuid, ai_usage_kind) is
  'Atomic per-user daily AI quota gate. Returns (allowed,count,cap); increments only when under cap.';

revoke all on function ai_usage_check_and_increment(uuid, ai_usage_kind) from public;
-- service_role calls this from the Edge Functions.
grant execute on function ai_usage_check_and_increment(uuid, ai_usage_kind) to service_role;

-- ============================================================================
-- 3) conversation_start(): SERVER creates the session and chooses the required
-- words. The CLIENT CANNOT pick the words (integrity rule 7). required_word_ids
-- is the unit's 5 unit_words (the authored conversation_required_words set when
-- present, else all unit_words). ends_at = started_at + 180s (duration_cap).
-- Returns the new session id + required_word_ids + ends_at.
-- ============================================================================
create or replace function conversation_start(
  p_user_id uuid,
  p_unit_id uuid
)
returns table (session_id uuid, required_word_ids uuid[], ends_at timestamptz)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_required uuid[];
  v_started  timestamptz := now();
  v_ends     timestamptz := now() + interval '180 seconds';
  v_session  uuid;
begin
  -- Choose required words SERVER-SIDE: prefer the authored candidate set, else
  -- fall back to the unit's 5 membership words. Either way it is impossible to
  -- include a foreign word (composite FK -> unit_words).
  select coalesce(array_agg(word_id order by word_id), '{}')
    into v_required
  from (
    select crw.word_id
    from conversation_required_words crw
    where crw.unit_id = p_unit_id
    union
    select uw.word_id
    from unit_words uw
    where uw.unit_id = p_unit_id
      and not exists (
        select 1 from conversation_required_words crw2
        where crw2.unit_id = p_unit_id
      )
  ) chosen;

  if v_required is null or array_length(v_required, 1) is null then
    raise exception 'unit % has no words to converse with', p_unit_id
      using errcode = 'no_data_found';
  end if;

  perform set_config('app.trusted', 'on', true);

  insert into conversation_sessions (
    user_id, unit_id, required_word_ids, outcome,
    words_used_ids, turns_used, started_at, ends_at
  )
  values (
    p_user_id, p_unit_id, v_required, 'in_progress',
    '{}', 0, v_started, v_ends
  )
  returning id into v_session;

  return query select v_session, v_required, v_ends;
end;
$$;

comment on function conversation_start(uuid, uuid) is
  'Creates a conversation_session with SERVER-chosen required_word_ids + 180s window. Client cannot pick the words.';

revoke all on function conversation_start(uuid, uuid) from public;
grant execute on function conversation_start(uuid, uuid) to service_role;

-- ============================================================================
-- 3b) conversation_append_opener(): persist the assistant's OPENING message
-- (turn_index 0). The AI starts the chat (scope 4.5 F) before the user replies,
-- so this is a one-off assistant insert with no user message and no turn count.
-- ============================================================================
create or replace function conversation_append_opener(
  p_user_id           uuid,
  p_session_id        uuid,
  p_assistant_content text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_sess conversation_sessions%rowtype;
  v_has_msg boolean;
begin
  select * into v_sess
  from conversation_sessions cs
  where cs.id = p_session_id
  for update;

  if not found then
    raise exception 'conversation session % not found', p_session_id
      using errcode = 'no_data_found';
  end if;
  if v_sess.user_id <> p_user_id then
    raise exception 'forbidden: session does not belong to user'
      using errcode = 'insufficient_privilege';
  end if;

  -- Idempotency: only insert the opener once.
  select exists (
    select 1 from conversation_messages m where m.session_id = p_session_id
  ) into v_has_msg;
  if v_has_msg then
    return;
  end if;

  perform set_config('app.trusted', 'on', true);

  insert into conversation_messages (session_id, role, content, used_word_ids, turn_index)
  values (p_session_id, 'assistant', p_assistant_content, '{}', 0);
end;
$$;

comment on function conversation_append_opener(uuid, uuid, text) is
  'Persists the assistant opening message (turn 0) once. The AI starts the chat.';

revoke all on function conversation_append_opener(uuid, uuid, text) from public;
grant execute on function conversation_append_opener(uuid, uuid, text) to service_role;

-- ============================================================================
-- 4) conversation_append_messages(): persist one turn — the user's transcribed
-- message and the assistant's typed reply — and roll up the session's
-- words_used_ids + turns_used. The ENTIRE conversation_messages row is trusted,
-- so this DEFINER RPC is the only writer. Enforces 180s + max_turns=12
-- SERVER-SIDE (it ignores attempts past the cap by raising).
-- p_used_word_ids = words detected in the USER message (server-detected).
-- Returns the updated (turns_used, words_used_ids).
-- ============================================================================
create or replace function conversation_append_messages(
  p_user_id            uuid,
  p_session_id         uuid,
  p_user_content       text,
  p_user_used_word_ids uuid[],
  p_assistant_content  text
)
returns table (turns_used integer, words_used_ids uuid[])
language plpgsql
security definer
set search_path = public
as $$
declare
  v_sess        conversation_sessions%rowtype;
  v_next_turn   integer;
  v_new_used    uuid[];
  v_new_turns   integer;
begin
  select * into v_sess
  from conversation_sessions cs
  where cs.id = p_session_id
  for update;

  if not found then
    raise exception 'conversation session % not found', p_session_id
      using errcode = 'no_data_found';
  end if;

  -- Ownership check: the session must belong to the caller.
  if v_sess.user_id <> p_user_id then
    raise exception 'forbidden: session does not belong to user'
      using errcode = 'insufficient_privilege';
  end if;

  -- turn_index is a monotonic message ordinal; derive it from existing rows so
  -- it stays correct regardless of whether an opener (index 0) was inserted.
  select coalesce(max(m.turn_index) + 1, 0)
    into v_next_turn
  from conversation_messages m
  where m.session_id = p_session_id;

  -- SERVER-enforced limits (DECISIONS.md): 180s window + max 12 turns.
  if v_sess.outcome <> 'in_progress' then
    raise exception 'conversation already ended (outcome=%)', v_sess.outcome
      using errcode = 'check_violation';
  end if;
  if now() > v_sess.ends_at then
    raise exception 'conversation time window has expired'
      using errcode = 'check_violation';
  end if;
  if v_sess.turns_used >= 12 then
    raise exception 'conversation turn limit (12) reached'
      using errcode = 'check_violation';
  end if;

  -- Only count words that are actually in this session's required set.
  select coalesce(array_agg(distinct w), '{}')
    into v_new_used
  from (
    select unnest(coalesce(v_sess.words_used_ids, '{}'::uuid[])) as w
    union
    select unnest(coalesce(p_user_used_word_ids, '{}'::uuid[])) as w
  ) merged
  where w = any (v_sess.required_word_ids);

  v_new_turns := v_sess.turns_used + 1;
  v_next_turn := v_sess.turns_used * 2; -- 0-based: user then assistant per turn

  perform set_config('app.trusted', 'on', true);

  -- Persist the user (voice-transcribed) message then the assistant reply.
  insert into conversation_messages (session_id, role, content, used_word_ids, turn_index)
  values (p_session_id, 'user', p_user_content, coalesce(p_user_used_word_ids, '{}'), v_next_turn);

  insert into conversation_messages (session_id, role, content, used_word_ids, turn_index)
  values (p_session_id, 'assistant', p_assistant_content, '{}', v_next_turn + 1);

  update conversation_sessions cs
     set turns_used = v_new_turns,
         words_used_ids = v_new_used
   where cs.id = p_session_id;

  return query select v_new_turns, v_new_used;
end;
$$;

comment on function conversation_append_messages(uuid, uuid, text, uuid[], text) is
  'Persists one user+assistant turn and rolls up words_used/turns. Enforces 180s + 12-turn caps server-side.';

revoke all on function conversation_append_messages(uuid, uuid, text, uuid[], text) from public;
grant execute on function conversation_append_messages(uuid, uuid, text, uuid[], text) to service_role;

-- ============================================================================
-- 5) conversation_finalize(): set the final outcome. SUCCESS when >= 4 of the
-- session's required words were used (DECISIONS.md). Does NOT award XP here (XP
-- is the progress agent's RPC, idempotent on session id). Returns the outcome.
-- p_reason maps a client/caller signal to the outcome enum.
-- ============================================================================
create or replace function conversation_finalize(
  p_user_id    uuid,
  p_session_id uuid,
  p_reason     text  -- 'completed' | 'expired' | 'abandoned'
)
returns table (outcome conversation_outcome, words_used_count integer)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_sess     conversation_sessions%rowtype;
  v_used_cnt integer;
  v_outcome  conversation_outcome;
begin
  select * into v_sess
  from conversation_sessions cs
  where cs.id = p_session_id
  for update;

  if not found then
    raise exception 'conversation session % not found', p_session_id
      using errcode = 'no_data_found';
  end if;
  if v_sess.user_id <> p_user_id then
    raise exception 'forbidden: session does not belong to user'
      using errcode = 'insufficient_privilege';
  end if;

  -- Already finalized? Return the existing outcome idempotently.
  if v_sess.outcome <> 'in_progress' then
    v_used_cnt := coalesce(array_length(v_sess.words_used_ids, 1), 0);
    return query select v_sess.outcome, v_used_cnt;
    return;
  end if;

  v_used_cnt := coalesce(array_length(
    array(select unnest(v_sess.words_used_ids)
          intersect
          select unnest(v_sess.required_word_ids)), 1), 0);

  if v_used_cnt >= 4 then
    v_outcome := 'success';
  elsif p_reason = 'expired' then
    v_outcome := 'expired';
  elsif p_reason = 'abandoned' then
    v_outcome := 'abandoned';
  else
    v_outcome := 'incomplete';
  end if;

  perform set_config('app.trusted', 'on', true);

  update conversation_sessions cs
     set outcome = v_outcome,
         ended_at = now()
   where cs.id = p_session_id;

  return query select v_outcome, v_used_cnt;
end;
$$;

comment on function conversation_finalize(uuid, uuid, text) is
  'Sets the conversation outcome (success when >=4 required words used). XP awarded separately + idempotently.';

revoke all on function conversation_finalize(uuid, uuid, text) from public;
grant execute on function conversation_finalize(uuid, uuid, text) to service_role;

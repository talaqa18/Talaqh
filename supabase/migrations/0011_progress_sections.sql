-- ============================================================================
-- 0011_progress_sections.sql
-- The MISSING link in the unit flow: a server-authoritative way to mark each
-- section (words / listening / reading / conversation / grammar) complete.
-- ----------------------------------------------------------------------------
-- WHY THIS EXISTS
--   complete_unit() (0008) refuses to finish a unit until ALL FIVE section flags
--   on unit_progress are true — but nothing in 0008 SETS those flags. They are
--   TRUSTED columns (guard triggers in 0003), so the browser cannot write them
--   directly. complete_section() is the single SECURITY DEFINER path that flips
--   one section flag and awards that section's XP idempotently, keeping the whole
--   journey server-authoritative (integrity rules 1 + 4).
--
--   Section -> XP source:
--     words        -> (none here; per-word + full_words XP already granted by grade_quiz)
--     listening    -> 'listening'        (40)
--     reading      -> 'reading'          (40)
--     grammar      -> 'grammar_quiz'     (40)
--     conversation -> 'conversation'     (60)
--
--   XP is minted through award_xp() so it is idempotent per (unit, section):
--   replaying complete_section never double-awards. The 'words' section grants no
--   extra XP (the words it contains were already rewarded), but still flips the
--   flag so complete_unit() can proceed.
--
-- NOTE on locking: within a unit, section ORDER is UI-enforced (the client only
-- surfaces the next section). The hard server gate that matters — no skipping to
-- the NEXT UNIT — lives in complete_unit(), which verifies every flag. v1
-- intentionally does not re-derive per-section prerequisites server-side; that
-- can be tightened later without a schema change.
-- ============================================================================

create or replace function complete_section(
  p_unit_id uuid,
  p_section unit_section
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := require_auth();
  v_xp  integer := 0;
begin
  set local app.trusted = 'on';

  if p_unit_id is null or p_section is null then
    raise exception 'complete_section: unit_id and section are required'
      using errcode = 'check_violation';
  end if;

  -- Ensure a progress row exists and is at least in_progress (never silently
  -- unlock a locked unit — if it is locked, refuse: that is a skip attempt).
  insert into unit_progress (user_id, unit_id, status, started_at)
  values (v_uid, p_unit_id, 'in_progress', now())
  on conflict (user_id, unit_id) do nothing;

  if (select status from unit_progress
        where user_id = v_uid and unit_id = p_unit_id) = 'locked' then
    raise exception 'complete_section: unit is locked'
      using errcode = 'insufficient_privilege';
  end if;

  -- Flip the matching flag (idempotent: OR-ing true stays true).
  update unit_progress
     set words_completed        = words_completed        or (p_section = 'words'),
         listening_completed    = listening_completed    or (p_section = 'listening'),
         reading_completed      = reading_completed      or (p_section = 'reading'),
         conversation_completed = conversation_completed or (p_section = 'conversation'),
         grammar_completed      = grammar_completed      or (p_section = 'grammar'),
         started_at             = coalesce(started_at, now())
   where user_id = v_uid and unit_id = p_unit_id;

  -- Award the section XP idempotently (keyed by unit + section).
  v_xp := case p_section
    when 'listening'    then award_xp('listening',    p_unit_id::text || ':listening',    null, p_unit_id)
    when 'reading'      then award_xp('reading',      p_unit_id::text || ':reading',      null, p_unit_id)
    when 'grammar'      then award_xp('grammar_quiz', p_unit_id::text || ':grammar',      null, p_unit_id)
    when 'conversation' then award_xp('conversation', p_unit_id::text || ':conversation', null, p_unit_id)
    else 0
  end;

  -- Any section activity counts toward today's streak.
  perform touch_streak();

  return jsonb_build_object(
    'section', p_section,
    'xp_awarded', v_xp
  );
end;
$$;

comment on function complete_section(uuid, unit_section) is
  'SECURITY DEFINER. Marks one unit section complete (trusted flag) + awards that section''s XP idempotently. Auth-gated. Feeds complete_unit().';

-- Ownership + grants (mirror 0008): owned by postgres so it may flip app.trusted;
-- execute granted to authenticated only.
do $$
begin
  execute 'alter function complete_section(uuid, unit_section) owner to postgres';
  execute 'revoke all on function complete_section(uuid, unit_section) from public';
  execute 'grant execute on function complete_section(uuid, unit_section) to authenticated';
end;
$$;

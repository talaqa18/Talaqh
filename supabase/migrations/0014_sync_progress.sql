-- ============================================================================
-- 0014_sync_progress.sql
-- Client-authoritative progress MIRROR. Talaqa computes XP/level/streak locally
-- and pushes them here so the leaderboard (get_leaderboard, WHERE total_xp>0)
-- shows real users and the level/streak survive cross-device. Forward-only
-- (greatest) so XP can't be lowered. SECURITY DEFINER + app.trusted unlocks the
-- guard triggers on the trusted columns (same pattern as award_xp/touch_streak).
-- (Already applied live via the Management API; this file is for reproducibility.)
-- ============================================================================
create or replace function public.sync_progress(
  p_total_xp integer,
  p_level    user_level default null,
  p_streak   integer default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare v_uid uuid := auth.uid();
begin
  if v_uid is null then
    raise exception 'forbidden' using errcode = 'insufficient_privilege';
  end if;
  perform set_config('app.trusted', 'on', true);
  update profiles set
    total_xp            = greatest(0, coalesce(p_total_xp, total_xp)),
    current_level       = coalesce(p_level, current_level),
    current_streak_days = coalesce(p_streak, current_streak_days),
    longest_streak_days = greatest(coalesce(longest_streak_days, 0), coalesce(p_streak, 0)),
    last_activity_date  = (now())::date
  where id = v_uid;
end;
$$;

alter function public.sync_progress(integer, user_level, integer) owner to postgres;
revoke all on function public.sync_progress(integer, user_level, integer) from public;
grant execute on function public.sync_progress(integer, user_level, integer) to authenticated;

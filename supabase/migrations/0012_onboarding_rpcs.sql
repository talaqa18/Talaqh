-- ============================================================================
-- 0012_onboarding_rpcs.sql
-- Trusted-write RPCs for ONBOARDING and FOUNDATIONS completion.
-- ----------------------------------------------------------------------------
-- profiles.onboarding_completed and profiles.foundations_completed are TRUSTED
-- columns (guard triggers in 0003 reject direct client writes). The Talaqa
-- onboarding flow needs to flip them, so — exactly like complete_section (0011)
-- — these run SECURITY DEFINER, owned by postgres, and set app.trusted='on'.
-- display_name / goal / age are NON-trusted profile fields, written here too for
-- convenience (a single call from the onboarding screen).
-- ============================================================================

create or replace function complete_onboarding(
  p_display_name text default null,
  p_goal learning_goal default null,
  p_age integer default null
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

  update profiles
     set display_name        = coalesce(p_display_name, display_name),
         goal                = coalesce(p_goal, goal),
         age                 = coalesce(p_age, age),
         onboarding_completed = true
   where id = v_uid;

  -- Keep a raw copy of the onboarding answers (1 row per user).
  insert into onboarding_responses (user_id, display_name, goal, age)
  values (v_uid, p_display_name, p_goal, p_age)
  on conflict (user_id) do update
    set display_name = coalesce(excluded.display_name, onboarding_responses.display_name),
        goal         = coalesce(excluded.goal,         onboarding_responses.goal),
        age          = coalesce(excluded.age,          onboarding_responses.age);
end;
$$;

comment on function complete_onboarding(text, learning_goal, integer) is
  'SECURITY DEFINER. Saves onboarding answers + flips profiles.onboarding_completed (trusted). Auth-gated.';

create or replace function complete_foundations()
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := require_auth();
begin
  set local app.trusted = 'on';
  update profiles set foundations_completed = true where id = v_uid;
end;
$$;

comment on function complete_foundations() is
  'SECURITY DEFINER. Flips profiles.foundations_completed (trusted). Auth-gated.';

do $$
begin
  execute 'alter function complete_onboarding(text, learning_goal, integer) owner to postgres';
  execute 'revoke all on function complete_onboarding(text, learning_goal, integer) from public';
  execute 'grant execute on function complete_onboarding(text, learning_goal, integer) to authenticated';

  execute 'alter function complete_foundations() owner to postgres';
  execute 'revoke all on function complete_foundations() from public';
  execute 'grant execute on function complete_foundations() to authenticated';
end;
$$;

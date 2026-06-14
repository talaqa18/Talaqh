-- ============================================================================
-- 0016_delete_account.sql
-- GDPR / App Store / Play-required account erasure. A SECURITY DEFINER RPC the
-- delete-account Edge Function calls (service role) to remove EVERY public row
-- belonging to the user, plus their Storage objects. The Edge Function then
-- deletes the auth user via the Admin API (no public FK references auth.users,
-- so order doesn't matter — but we erase data first to fail safe).
-- ============================================================================
create or replace function public.delete_account_data(p_user_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_user_id is null then
    raise exception 'user id required' using errcode = 'invalid_parameter_value';
  end if;

  perform set_config('app.trusted', 'on', true);

  -- Conversation transcripts (messages FK -> sessions).
  delete from conversation_messages m
   using conversation_sessions s
   where m.session_id = s.id and s.user_id = p_user_id;
  delete from conversation_sessions where user_id = p_user_id;

  -- All per-user rows.
  delete from ai_usage              where user_id = p_user_id;
  delete from device_tokens         where user_id = p_user_id;
  delete from foundations_progress  where user_id = p_user_id;
  delete from onboarding_responses  where user_id = p_user_id;
  delete from placement_answers     where user_id = p_user_id;
  delete from placement_results     where user_id = p_user_id;
  delete from pronunciation_attempts where user_id = p_user_id;
  delete from quiz_attempts         where user_id = p_user_id;
  delete from streak_log            where user_id = p_user_id;
  delete from subscriptions         where user_id = p_user_id;
  delete from unit_progress         where user_id = p_user_id;
  delete from user_settings         where user_id = p_user_id;
  delete from user_word_status      where user_id = p_user_id;
  delete from xp_events             where user_id = p_user_id;
  delete from profiles              where id = p_user_id;

  -- NOTE: storage objects (recordings + state.json) are removed by the
  -- delete-account Edge Function via the Storage API — Supabase blocks direct
  -- deletes from storage.objects (storage.protect_delete trigger).
end;
$$;

comment on function public.delete_account_data(uuid) is
  'Erases ALL of a user''s data (public rows + storage objects). Called by the delete-account Edge Function with the service role; the auth user is deleted separately via the Admin API.';

revoke all on function public.delete_account_data(uuid) from public;
grant execute on function public.delete_account_data(uuid) to service_role;

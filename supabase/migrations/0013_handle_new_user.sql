-- ============================================================================
-- 0013_handle_new_user.sql
-- The MISSING auth glue: auto-create a profile (and default settings) row for
-- every new auth user. Without this, sign-up succeeds but profiles stays empty,
-- so RLS reads return nothing and any FK to profiles (onboarding_responses,
-- progress, …) fails. This is the canonical Supabase pattern.
-- ----------------------------------------------------------------------------
-- SECURITY DEFINER + pinned search_path so it runs with the privileged owner and
-- can flip app.trusted='on' to satisfy the profiles guard trigger (0003). Kept
-- minimal (id/email/display_name only) so it can never break sign-up; everything
-- else is filled later by onboarding/placement RPCs.
-- ============================================================================

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  -- Allow the trusted-column guard to accept this server-side insert.
  perform set_config('app.trusted', 'on', true);

  insert into public.profiles (id, email, display_name)
  values (
    new.id,
    new.email,
    coalesce(nullif(new.raw_user_meta_data->>'display_name', ''), split_part(new.email, '@', 1))
  )
  on conflict (id) do nothing;

  insert into public.user_settings (user_id)
  values (new.id)
  on conflict (user_id) do nothing;

  return new;
end;
$$;

comment on function public.handle_new_user() is
  'Auto-creates profiles + user_settings rows on auth.users insert. SECURITY DEFINER, search_path pinned.';

-- Own by postgres so SECURITY DEFINER runs privileged.
alter function public.handle_new_user() owner to postgres;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- Backfill: create profiles for any existing auth users that lack one
-- (idempotent; safe to re-run). Wrapped so the trusted-column guard accepts it.
do $$
begin
  perform set_config('app.trusted', 'on', true);
  insert into public.profiles (id, email, display_name)
  select u.id, u.email,
         coalesce(nullif(u.raw_user_meta_data->>'display_name', ''), split_part(u.email, '@', 1))
  from auth.users u
  left join public.profiles p on p.id = u.id
  where p.id is null;

  insert into public.user_settings (user_id)
  select u.id from auth.users u
  left join public.user_settings s on s.user_id = u.id
  where s.user_id is null;
end;
$$;

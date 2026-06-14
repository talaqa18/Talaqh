-- ============================================================================
-- 0018_referrals.sql
-- Referral reward system: invite friends -> when 5 of them COMPLETE THEIR FIRST
-- UNIT, the referrer earns 1 free month of premium (stacking: +1 month per 5).
-- ----------------------------------------------------------------------------
-- Trust model (matches the rest of the schema):
--   * referral_code / premium_until / referral_months_granted are TRUSTED columns
--     on profiles — clients CANNOT write them (guard_profiles_trusted is extended
--     below). They are only set by the SECURITY DEFINER RPCs in this file.
--   * the referrals table is deny-all to clients (RLS on, no policies). Every read
--     and write goes through the DEFINER RPCs, which run as postgres and bypass RLS.
--   * the reward goes to the REFERRER; the referred user only triggers qualify.
-- ============================================================================

-- 1) New entitlement + referral columns on profiles -------------------------
alter table profiles
  add column if not exists referral_code            text,
  add column if not exists premium_until            timestamptz,          -- TRUSTED: referral-earned premium expiry
  add column if not exists referral_months_granted  integer not null default 0;  -- TRUSTED: months already rewarded (anti double-grant)

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'profiles_referral_code_unique') then
    alter table profiles add constraint profiles_referral_code_unique unique (referral_code);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'profiles_referral_months_nonneg') then
    alter table profiles add constraint profiles_referral_months_nonneg check (referral_months_granted >= 0);
  end if;
end;
$$;

-- 2) Extend the profiles trusted-column guard to cover the new columns -------
--    (create-or-replace overrides the version from 0003; the trigger keeps using it).
create or replace function guard_profiles_trusted()
returns trigger
language plpgsql
as $$
begin
  if coalesce(current_setting('app.trusted', true), 'off') = 'on' then
    return new;  -- privileged DEFINER RPC: allow everything
  end if;

  if (tg_op = 'INSERT') then
    if new.current_level <> 'beginner'
       or new.total_xp <> 0
       or new.current_streak_days <> 0
       or new.longest_streak_days <> 0
       or new.words_learned_count <> 0
       or new.last_activity_date is not null
       or new.onboarding_completed <> false
       or new.placement_completed <> false
       or new.foundations_completed <> false
       or new.referral_code is not null
       or new.premium_until is not null
       or new.referral_months_granted <> 0 then
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
     or new.foundations_completed is distinct from old.foundations_completed
     or new.referral_code is distinct from old.referral_code
     or new.premium_until is distinct from old.premium_until
     or new.referral_months_granted is distinct from old.referral_months_granted then
    perform assert_trusted_session();  -- always raises
  end if;

  return new;
end;
$$;

-- 3) referrals ledger -------------------------------------------------------
create table if not exists referrals (
  id               uuid primary key default gen_random_uuid(),
  referrer_id      uuid not null references profiles(id) on delete cascade,
  referred_user_id uuid not null references profiles(id) on delete cascade,
  created_at       timestamptz not null default now(),
  qualified_at     timestamptz,                                  -- set when the referred user completes their first unit
  constraint referrals_unique_referred  unique (referred_user_id),   -- a user can be referred only once
  constraint referrals_no_self          check (referrer_id <> referred_user_id),
  constraint referrals_qualified_after  check (qualified_at is null or qualified_at >= created_at)
);

create index if not exists referrals_referrer_idx on referrals(referrer_id);

-- deny-all to clients: RLS on, NO policies. Only the DEFINER RPCs (owned by
-- postgres) can read/write, so referral counts can never be forged client-side.
alter table referrals enable row level security;

-- 4) Helper: generate a short, unique, URL-safe referral code ---------------
create or replace function app_new_referral_code()
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_code text;
  v_try  integer := 0;
begin
  loop
    -- 8 uppercase hex chars from a random uuid (no extension needed).
    v_code := upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 8));
    exit when not exists (select 1 from profiles where referral_code = v_code);
    v_try := v_try + 1;
    if v_try > 25 then
      raise exception 'app_new_referral_code: could not generate a unique code' using errcode = 'check_violation';
    end if;
  end loop;
  return v_code;
end;
$$;

-- 5) claim_referral — link the CURRENT (new) user to a referrer by code -----
create or replace function claim_referral(p_code text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := require_auth();
  v_ref uuid;
begin
  if p_code is null or length(btrim(p_code)) = 0 then
    return jsonb_build_object('ok', false, 'reason', 'no_code');
  end if;

  select id into v_ref from profiles where referral_code = upper(btrim(p_code));
  if v_ref is null then
    return jsonb_build_object('ok', false, 'reason', 'code_not_found');
  end if;
  if v_ref = v_uid then
    return jsonb_build_object('ok', false, 'reason', 'self_referral');
  end if;

  -- One referrer per user, set once. Replays / self-share links are no-ops.
  insert into referrals (referrer_id, referred_user_id)
  values (v_ref, v_uid)
  on conflict (referred_user_id) do nothing;

  return jsonb_build_object('ok', true);
end;
$$;

-- 6) qualify_referral — called when the CURRENT user finishes their first unit
--    Marks their referral qualified, then grants the REFERRER 1 month per 5.
create or replace function qualify_referral()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid       uuid := require_auth();
  v_referrer  uuid;
  v_qualified integer;
  v_should    integer;
  v_granted   integer;
  v_add       integer;
begin
  set local app.trusted = 'on';

  -- Anti-abuse: require real progress (a proxy for "completed the first unit").
  -- This app is client-authoritative — progress lives in a storage blob and the
  -- single-file client syncs total_xp via sync_progress (it does NOT populate
  -- unit_progress) — so total_xp is the only server-visible work signal here. This
  -- is defense-in-depth atop the phone-OTP signup barrier: it blocks the trivial
  -- "sign up + instantly call qualify" abuse. A completed first unit is well over
  -- 100 XP (sections + quizzes + unit-complete bonus). NOTE: total_xp is itself
  -- client-synced, so this is not airtight; harden once progress is server-authoritative.
  if coalesce((select total_xp from profiles where id = v_uid), 0) < 100 then
    return jsonb_build_object('qualified', false, 'reason', 'insufficient_progress');
  end if;

  -- Idempotent: only a still-pending referral row flips to qualified.
  update referrals
     set qualified_at = now()
   where referred_user_id = v_uid
     and qualified_at is null
  returning referrer_id into v_referrer;

  if v_referrer is null then
    return jsonb_build_object('qualified', false);  -- not referred, or already qualified
  end if;

  -- Recompute the referrer's reward from the source of truth (the ledger).
  select count(*) into v_qualified
    from referrals
   where referrer_id = v_referrer and qualified_at is not null;

  v_should := v_qualified / 5;   -- integer division: 1 month per completed group of 5

  select coalesce(referral_months_granted, 0) into v_granted
    from profiles where id = v_referrer;

  if v_should > v_granted then
    v_add := v_should - v_granted;
    update profiles
       set premium_until = greatest(coalesce(premium_until, now()), now()) + make_interval(months => v_add),
           referral_months_granted = v_should
     where id = v_referrer;
  end if;

  return jsonb_build_object('qualified', true);
end;
$$;

-- 7) get_referral_stats — the caller's code, progress, and entitlement ------
--    Lazily mints the caller's referral_code on first read.
create or replace function get_referral_stats()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid       uuid := require_auth();
  v_code      text;
  v_until     timestamptz;
  v_granted   integer;
  v_qualified integer;
  v_pending   integer;
begin
  set local app.trusted = 'on';

  select referral_code, premium_until, coalesce(referral_months_granted, 0)
    into v_code, v_until, v_granted
    from profiles where id = v_uid;

  if v_code is null then
    v_code := app_new_referral_code();
    update profiles set referral_code = v_code where id = v_uid;
  end if;

  select count(*) filter (where qualified_at is not null),
         count(*) filter (where qualified_at is null)
    into v_qualified, v_pending
    from referrals where referrer_id = v_uid;

  return jsonb_build_object(
    'code',          v_code,
    'qualified',     coalesce(v_qualified, 0),
    'pending',       coalesce(v_pending, 0),
    'months_earned', v_granted,
    'toward_next',   coalesce(v_qualified, 0) % 5,   -- 0..4 toward the next free month
    'per_reward',    5,
    'premium_until', v_until
  );
end;
$$;

-- 8) Ownership + grants (authenticated only; anon/public revoked) -----------
do $$
declare
  fn  text;
  fns text[] := array[
    'app_new_referral_code()',
    'claim_referral(text)',
    'qualify_referral()',
    'get_referral_stats()'
  ];
begin
  foreach fn in array fns loop
    execute format('alter function %s owner to postgres', fn);
    execute format('revoke all on function %s from public', fn);
    execute format('grant execute on function %s to authenticated', fn);
  end loop;
  -- internal helper: not directly client-callable
  execute 'revoke execute on function app_new_referral_code() from authenticated';
end;
$$;

comment on function claim_referral(text)   is 'SECURITY DEFINER. Links the caller (new user) to a referrer by referral_code. One-time, idempotent. Auth-gated.';
comment on function qualify_referral()     is 'SECURITY DEFINER. Marks the caller''s referral qualified (first unit done) and grants the referrer 1 month premium per 5 qualified. Idempotent. Auth-gated.';
comment on function get_referral_stats()   is 'SECURITY DEFINER. Returns the caller''s referral code (minted on first read), qualified/pending counts, months earned, and premium_until. Auth-gated.';

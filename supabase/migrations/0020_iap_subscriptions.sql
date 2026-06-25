-- ============================================================================
-- 0020_iap_subscriptions.sql
-- Apple IAP (Auto-Renewable Subscription) entitlement model + free-tier daily
-- limit. Webhook entry point for RevenueCat → Supabase. Banked referral months.
-- ----------------------------------------------------------------------------
-- Product model (DECISIONS):
--   * 3 auto-renewable subscriptions: weekly 29 SAR, monthly 49, yearly 399.
--   * 3-day free trial on each (Apple Introductory Offer; status='trialing').
--   * Free tier = ONE section per day (any of words/listening/reading/
--     conversation/grammar). 2nd attempt → paywall.
--   * Paid tier = unlimited + higher AI quotas (handled separately).
--
-- Trust model (matches the rest of the schema):
--   * subscriptions row is TRUSTED (guard_subscriptions_trusted, 0004) — only a
--     SECURITY DEFINER RPC running app.trusted='on' can change tier/status/etc.
--   * subscription_events is the idempotency log for RevenueCat webhook
--     deliveries (every event has a unique event_id; retries are no-ops).
--   * Webhook → revenuecat-webhook Edge Function → apply_subscription_event RPC.
--     The client NEVER calls apply_subscription_event; entitlement is read-only
--     from the client's perspective.
--
-- Referral banking (DECISIONS):
--   * Existing referral system (0018) grants premium_until directly. To honor
--     "banked — referral months only kick in after the paid sub ends," a NEW
--     referral grant earned DURING an active paid sub goes into the new column
--     profiles.referral_months_banked (integer count) instead of extending
--     premium_until. When the paid sub later ends (CANCELLATION/EXPIRATION), the
--     webhook redeems the bank by extending premium_until from now() by N months
--     and zeroing the bank.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1) New ai_usage kind for the daily-section gate.
--    NOTE: ALTER TYPE ... ADD VALUE must commit before the literal can appear
--    as an enum constant in DDL. plpgsql function BODIES are parsed at execute
--    time, so referencing 'lesson_start' inside a function body in this file is
--    safe across Supabase's per-statement dashboard execution.
-- ----------------------------------------------------------------------------
alter type ai_usage_kind add value if not exists 'lesson_start';

-- Refresh the daily-cap lookup so 'lesson_start' returns 1 (free tier = 1/day).
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
    when 'generate_lesson'      then 100
    when 'tts'                  then 800
    when 'lesson_start'         then 1
    else 0
  end;
$$;

-- ----------------------------------------------------------------------------
-- 2) Referral bank column on profiles + extend the trusted-column guard.
-- ----------------------------------------------------------------------------
alter table profiles
  add column if not exists referral_months_banked integer not null default 0;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'profiles_referral_banked_nonneg') then
    alter table profiles add constraint profiles_referral_banked_nonneg
      check (referral_months_banked >= 0);
  end if;
end;
$$;

-- Replace the profiles guard so referral_months_banked is also server-only.
-- (Mirrors 0018; the trigger keeps using the same function name.)
create or replace function guard_profiles_trusted()
returns trigger
language plpgsql
as $$
begin
  if coalesce(current_setting('app.trusted', true), 'off') = 'on' then
    return new;
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
       or new.referral_months_granted <> 0
       or new.referral_months_banked <> 0 then
      perform assert_trusted_session();
    end if;
    return new;
  end if;

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
     or new.referral_months_granted is distinct from old.referral_months_granted
     or new.referral_months_banked is distinct from old.referral_months_banked then
    perform assert_trusted_session();
  end if;

  return new;
end;
$$;

-- ----------------------------------------------------------------------------
-- 3) subscription_events: webhook idempotency log. Every RevenueCat delivery
--    writes a row here keyed on event_id; replays are no-ops.
-- ----------------------------------------------------------------------------
create table if not exists subscription_events (
  id           uuid primary key default gen_random_uuid(),
  event_id     text not null unique,                                   -- RevenueCat event id
  event_type   text not null,                                          -- INITIAL_PURCHASE / RENEWAL / ...
  user_id      uuid references profiles(id) on delete cascade,
  product_id   text,                                                   -- e.g. talaqh_monthly
  payload      jsonb not null,
  received_at  timestamptz not null default now()
);

create index if not exists subscription_events_user_idx on subscription_events(user_id);
create index if not exists subscription_events_received_at_idx on subscription_events(received_at desc);

-- Server-only (deny-all to clients). Reads + writes go through the DEFINER RPC.
alter table subscription_events enable row level security;

-- ============================================================================
-- 4) is_entitled(uid): SINGLE SOURCE OF TRUTH for "does this user have paid
--    access right now?" Called from every gated Edge Function and RPC.
--    Returns true when EITHER:
--      a) an active/trialing subscription row whose current_period_end > now(),
--      b) profiles.premium_until > now() (referral-earned months elapsing).
--    SECURITY DEFINER so it can see subscriptions/profiles without RLS friction.
-- ============================================================================
create or replace function is_entitled(p_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select
    exists (
      select 1
      from subscriptions s
      where s.user_id = p_user_id
        and s.tier <> 'free'
        and s.status in ('active', 'trialing')
        and (s.current_period_end is null or s.current_period_end > now())
    )
    or exists (
      select 1
      from profiles p
      where p.id = p_user_id
        and p.premium_until is not null
        and p.premium_until > now()
    );
$$;

comment on function is_entitled(uuid) is
  'Returns true if the user has paid access (active sub OR unexpired premium_until). Single source of truth for paywall gating.';

revoke all on function is_entitled(uuid) from public;
grant execute on function is_entitled(uuid) to authenticated, service_role;

-- ============================================================================
-- 5) consume_daily_section(uid): atomic gate for opening a section (words /
--    listening / reading / conversation / grammar). Paid users get a free pass;
--    free users are limited to 1 section per local-tz day via the ai_usage
--    ledger (kind='lesson_start', cap=1 from ai_usage_daily_cap).
--    Returns (allowed, entitled, count, cap). When allowed=false, the caller
--    shows the paywall ("you used today's free lesson — subscribe or come back
--    tomorrow"). When entitled=true, count/cap are 0 (no counter touched).
-- ============================================================================
create or replace function consume_daily_section(p_user_id uuid)
returns table (allowed boolean, entitled boolean, count integer, cap integer)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_entitled boolean;
  v_row      record;
begin
  v_entitled := is_entitled(p_user_id);
  if v_entitled then
    return query select true, true, 0, 0;
    return;
  end if;

  -- Free-tier path: reuse the existing per-user-per-day atomic ledger.
  -- ai_usage_check_and_increment is itself a DEFINER RPC that sets app.trusted.
  for v_row in
    select allowed, count, cap
    from ai_usage_check_and_increment(p_user_id, 'lesson_start'::ai_usage_kind)
  loop
    return query select v_row.allowed, false, v_row.count, v_row.cap;
    return;
  end loop;
end;
$$;

comment on function consume_daily_section(uuid) is
  'Atomic free-tier daily-section gate. Paid users always allowed; free users limited to 1/day via ai_usage (lesson_start).';

revoke all on function consume_daily_section(uuid) from public;
grant execute on function consume_daily_section(uuid) to authenticated, service_role;

-- ============================================================================
-- 6) apply_subscription_event(...): the webhook entry point. Idempotent via the
--    subscription_events.event_id unique constraint. Upserts the subscriptions
--    row and, when a sub transitions FROM entitled TO not-entitled, redeems any
--    referral_months_banked by extending premium_until.
--
-- p_status accepts any subscription_status enum value as text:
--   'active' | 'trialing' | 'past_due' | 'canceled' | 'expired'
-- The webhook maps RevenueCat event_type → status before calling.
-- ============================================================================
create or replace function apply_subscription_event(
  p_event_id      text,
  p_event_type    text,
  p_user_id       uuid,
  p_tier          text,                          -- 'free' | 'premium'
  p_status        text,                          -- subscription_status value
  p_provider      text default 'apple',
  p_provider_ref  text default null,
  p_product_id    text default null,
  p_period_end    timestamptz default null,
  p_payload       jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_was_entitled boolean;
  v_now_entitled boolean;
  v_banked       integer;
  v_dup          boolean := false;
begin
  if p_user_id is null then
    raise exception 'apply_subscription_event: p_user_id is required'
      using errcode = 'check_violation';
  end if;
  if not exists (select 1 from profiles where id = p_user_id) then
    raise exception 'apply_subscription_event: profile % not found', p_user_id
      using errcode = 'no_data_found';
  end if;

  -- Idempotency: insert the event row. Duplicate event_id => no-op + early exit.
  begin
    insert into subscription_events (event_id, event_type, user_id, product_id, payload)
    values (p_event_id, p_event_type, p_user_id, p_product_id, coalesce(p_payload, '{}'::jsonb));
  exception when unique_violation then
    v_dup := true;
  end;

  if v_dup then
    return jsonb_build_object('ok', true, 'duplicate', true, 'entitled', is_entitled(p_user_id));
  end if;

  v_was_entitled := is_entitled(p_user_id);

  perform set_config('app.trusted', 'on', true);

  insert into subscriptions (user_id, tier, status, provider, provider_ref, current_period_end)
  values (
    p_user_id,
    coalesce(nullif(p_tier, '')::subscription_tier, 'free'::subscription_tier),
    coalesce(nullif(p_status, '')::subscription_status, 'active'::subscription_status),
    p_provider,
    p_provider_ref,
    p_period_end
  )
  on conflict (user_id) do update set
    tier               = excluded.tier,
    status             = excluded.status,
    provider           = excluded.provider,
    provider_ref       = coalesce(excluded.provider_ref, subscriptions.provider_ref),
    current_period_end = excluded.current_period_end,
    updated_at         = now();

  v_now_entitled := is_entitled(p_user_id);

  -- Bank redemption: if the user JUST lost entitlement (sub ended and no
  -- premium_until safety net), redeem referral_months_banked into premium_until.
  if v_was_entitled and not v_now_entitled then
    select coalesce(referral_months_banked, 0) into v_banked
      from profiles where id = p_user_id;
    if v_banked > 0 then
      update profiles
         set premium_until = greatest(coalesce(premium_until, now()), now())
                             + make_interval(months => v_banked),
             referral_months_banked = 0
       where id = p_user_id;
      v_now_entitled := is_entitled(p_user_id);
    end if;
  end if;

  return jsonb_build_object(
    'ok',          true,
    'duplicate',   false,
    'entitled',    v_now_entitled,
    'redeemed',    v_was_entitled and not v_now_entitled and coalesce(v_banked, 0) > 0
  );
end;
$$;

comment on function apply_subscription_event(text, text, uuid, text, text, text, text, text, timestamptz, jsonb) is
  'Webhook entry point. Idempotent on event_id. Upserts subscriptions; redeems referral bank on sub-end transitions.';

revoke all on function apply_subscription_event(text, text, uuid, text, text, text, text, text, timestamptz, jsonb) from public;
grant execute on function apply_subscription_event(text, text, uuid, text, text, text, text, text, timestamptz, jsonb) to service_role;

-- ============================================================================
-- 7) qualify_referral() — REPLACED to bank months when the referrer has an
--    active paid sub. Unchanged behavior otherwise (anti-double-grant via
--    referral_months_granted is preserved).
-- ============================================================================
create or replace function qualify_referral()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid          uuid := require_auth();
  v_referrer     uuid;
  v_qualified    integer;
  v_should       integer;
  v_granted      integer;
  v_add          integer;
  v_referrer_sub boolean;
begin
  set local app.trusted = 'on';

  if coalesce((select total_xp from profiles where id = v_uid), 0) < 100 then
    return jsonb_build_object('qualified', false, 'reason', 'insufficient_progress');
  end if;

  update referrals
     set qualified_at = now()
   where referred_user_id = v_uid
     and qualified_at is null
  returning referrer_id into v_referrer;

  if v_referrer is null then
    return jsonb_build_object('qualified', false);
  end if;

  select count(*) into v_qualified
    from referrals
   where referrer_id = v_referrer and qualified_at is not null;

  v_should := v_qualified / 5;

  select coalesce(referral_months_granted, 0) into v_granted
    from profiles where id = v_referrer;

  if v_should > v_granted then
    v_add := v_should - v_granted;

    -- Bank vs grant: if the referrer has an active paid sub, stash these months
    -- in referral_months_banked so they kick in after the sub ends. Otherwise,
    -- extend premium_until immediately (legacy behavior from 0018).
    v_referrer_sub := exists (
      select 1 from subscriptions s
      where s.user_id = v_referrer
        and s.tier <> 'free'
        and s.status in ('active', 'trialing')
        and (s.current_period_end is null or s.current_period_end > now())
    );

    if v_referrer_sub then
      update profiles
         set referral_months_banked = coalesce(referral_months_banked, 0) + v_add,
             referral_months_granted = v_should
       where id = v_referrer;
    else
      update profiles
         set premium_until = greatest(coalesce(premium_until, now()), now()) + make_interval(months => v_add),
             referral_months_granted = v_should
       where id = v_referrer;
    end if;
  end if;

  return jsonb_build_object('qualified', true);
end;
$$;

-- ============================================================================
-- 8) get_referral_stats() — REPLACED to surface banked months alongside the
--    existing fields. Lazy-mints referral_code on first read (unchanged).
-- ============================================================================
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
  v_banked    integer;
  v_qualified integer;
  v_pending   integer;
begin
  set local app.trusted = 'on';

  select referral_code, premium_until,
         coalesce(referral_months_granted, 0),
         coalesce(referral_months_banked, 0)
    into v_code, v_until, v_granted, v_banked
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
    'months_banked', v_banked,
    'toward_next',   coalesce(v_qualified, 0) % 5,
    'per_reward',    5,
    'premium_until', v_until
  );
end;
$$;

-- ============================================================================
-- 9) Ownership + grants for the new + replaced functions.
-- ============================================================================
do $$
declare
  fn  text;
  fns text[] := array[
    'is_entitled(uuid)',
    'consume_daily_section(uuid)',
    'qualify_referral()',
    'get_referral_stats()'
  ];
begin
  foreach fn in array fns loop
    execute format('alter function %s owner to postgres', fn);
  end loop;
end;
$$;

-- service_role-only: webhook entry point (never callable from a browser).
alter function apply_subscription_event(text, text, uuid, text, text, text, text, text, timestamptz, jsonb)
  owner to postgres;

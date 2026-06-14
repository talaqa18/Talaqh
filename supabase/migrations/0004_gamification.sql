-- ============================================================================
-- 0004_gamification.sql
-- xp_events (idempotent), streak_log, word_of_the_day, subscriptions,
-- device_tokens, ai_usage.
-- ----------------------------------------------------------------------------
-- INTEGRITY:
--   * Rule 3 (XP idempotency): xp_events has UNIQUE(user_id, source_type,
--     source_id) so retries/replays cannot inflate XP. ALL xp_events rows are
--     TRUSTED — written ONLY by DEFINER RPCs (guard trigger below).
--   * streak_log rows are TRUSTED (streak computed server-side, lazy eval).
--   * ai_usage is the per-user daily quota ledger checked INSIDE each Edge
--     Function (rule 7). Written by service-role functions -> TRUSTED.
--   * word_of_the_day is authored content (not user-trusted).
--   * subscriptions reflect billing state -> TRUSTED (written by billing
--     webhook / service role), never by the client.
--   * device_tokens are client-registerable (push registration), NOT trusted.
--
-- TRUSTED COLUMNS / TABLES PROTECTED HERE (server-only writes):
--   xp_events: entire row
--   streak_log: entire row
--   ai_usage: entire row
--   subscriptions: tier, status, current_period_end, provider fields
-- ============================================================================

-- ============================================================================
-- XP_EVENTS — the immutable XP ledger. profiles.total_xp is a server-maintained
-- rollup of these. (user_id, source_type, source_id) is UNIQUE for IDEMPOTENCY
-- (rule 3): the same achievement can be requested twice but only awards once.
-- Fixed amounts per source_type (DECISIONS.md):
--   word_quiz_pass=10 full_words_quiz=50 listening=40 reading=40
--   grammar_quiz=40 conversation=60 unit_complete=100 streak_daily_bonus=20
--   foundations_lesson=5 placement=0
-- source_id = the unit_id / question_id / session_id / day-key that the award
-- is tied to (stable so replays collide on the unique constraint).
-- ============================================================================
create table xp_events (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references profiles(id) on delete cascade,
  source_type xp_source_type not null,
  source_id   text not null,            -- stable idempotency key (uuid or day-key)
  amount      integer not null,
  -- optional context for auditing / leaderboard period bucketing
  unit_id     uuid references units(id) on delete set null,
  created_at  timestamptz not null default now(),
  -- *** IDEMPOTENCY: the whole point of rule 3 ***
  constraint xp_events_idempotent unique (user_id, source_type, source_id),
  constraint xp_events_amount_nonneg check (amount >= 0)
);

-- Entire row is TRUSTED: only a DEFINER RPC may write xp_events.
create or replace function guard_xp_events_trusted()
returns trigger
language plpgsql
as $$
begin
  if coalesce(current_setting('app.trusted', true), 'off') = 'on' then
    return new;
  end if;
  perform assert_trusted_session();  -- always raises for untrusted clients
  return new;
end;
$$;

create trigger xp_events_guard_trusted
  before insert or update or delete on xp_events
  for each row execute function guard_xp_events_trusted();

-- ============================================================================
-- STREAK_LOG — one row per qualifying day per user. A qualifying day = >=1
-- xp_event that day in the user's timezone (DECISIONS.md). Streak is lazily
-- evaluated on next activity; no grace period in v1. Entire row TRUSTED.
-- ============================================================================
create table streak_log (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references profiles(id) on delete cascade,
  -- the local calendar day (in the user's tz) that qualified
  activity_date date not null,
  -- the running streak length as of this day (server-computed)
  streak_length integer not null default 1,
  created_at    timestamptz not null default now(),
  constraint streak_log_user_day_unique unique (user_id, activity_date),
  constraint streak_log_length_positive check (streak_length >= 1)
);

create or replace function guard_streak_log_trusted()
returns trigger
language plpgsql
as $$
begin
  if coalesce(current_setting('app.trusted', true), 'off') = 'on' then
    return new;
  end if;
  perform assert_trusted_session();  -- always raises for untrusted clients
  return new;
end;
$$;

create trigger streak_log_guard_trusted
  before insert or update or delete on streak_log
  for each row execute function guard_streak_log_trusted();

-- ============================================================================
-- WORD_OF_THE_DAY — authored schedule for the Home screen (scope 4.4).
-- One word per calendar day. Audio resolves via audio_clips
-- (owner_type='word_of_the_day', owner_id = this row's id OR the word id —
-- seed convention documented in DECISIONS.md). NOT user-trusted (content).
-- ============================================================================
create table word_of_the_day (
  id            uuid primary key default gen_random_uuid(),
  scheduled_for date not null,
  word_id       uuid not null references words(id) on delete cascade,
  -- optional override example to feature on Home
  example_id    uuid references word_examples(id) on delete set null,
  level         content_level not null default 'A1',
  status        content_status not null default 'published',
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  constraint word_of_the_day_date_unique unique (scheduled_for)
);

create trigger word_of_the_day_set_updated_at
  before update on word_of_the_day
  for each row execute function set_updated_at();

-- ============================================================================
-- SUBSCRIPTIONS — per-user billing state. Written by the billing webhook /
-- service role ONLY (rule: clients cannot grant themselves premium). TRUSTED.
-- ============================================================================
create table subscriptions (
  id                  uuid primary key default gen_random_uuid(),
  user_id             uuid not null references profiles(id) on delete cascade,
  tier                subscription_tier not null default 'free',     -- TRUSTED
  status              subscription_status not null default 'active',  -- TRUSTED
  provider            text,                                          -- 'apple' | 'google' | 'stripe'
  provider_ref        text,                                          -- store transaction / subscription id
  current_period_end  timestamptz,                                   -- TRUSTED
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  constraint subscriptions_user_unique unique (user_id)
);

create trigger subscriptions_set_updated_at
  before update on subscriptions
  for each row execute function set_updated_at();

-- Entire subscriptions row is server-owned.
create or replace function guard_subscriptions_trusted()
returns trigger
language plpgsql
as $$
begin
  if coalesce(current_setting('app.trusted', true), 'off') = 'on' then
    return new;
  end if;
  -- Allow an untrusted client to create only the default free/active stub for
  -- itself; reject anything that grants entitlement.
  if (tg_op = 'INSERT') then
    if new.tier <> 'free'
       or new.status <> 'active'
       or new.provider is not null
       or new.provider_ref is not null
       or new.current_period_end is not null then
      perform assert_trusted_session();
    end if;
    return new;
  end if;
  if new.tier is distinct from old.tier
     or new.status is distinct from old.status
     or new.provider is distinct from old.provider
     or new.provider_ref is distinct from old.provider_ref
     or new.current_period_end is distinct from old.current_period_end then
    perform assert_trusted_session();
  end if;
  return new;
end;
$$;

create trigger subscriptions_guard_trusted
  before insert or update on subscriptions
  for each row execute function guard_subscriptions_trusted();

-- ============================================================================
-- DEVICE_TOKENS — push notification registrations (scope 4.6 notifications;
-- Capacitor Phase 2). Client-registerable; NOT trusted. Unique per token.
-- ============================================================================
create table device_tokens (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references profiles(id) on delete cascade,
  platform    device_platform not null,
  token       text not null,
  last_seen_at timestamptz not null default now(),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  constraint device_tokens_token_unique unique (token)
);

create trigger device_tokens_set_updated_at
  before update on device_tokens
  for each row execute function set_updated_at();

-- ============================================================================
-- AI_USAGE — per-user daily quota ledger (rule 7 / abuse control). Each Edge
-- Function increments + checks the relevant bucket INSIDE the function before
-- doing work. Daily caps (DECISIONS.md):
--   conversation_session<=20  speech_token_mint<=200  stt<=200  tts_fallback<=100
-- One row per (user, kind, usage_date); count incremented atomically. TRUSTED
-- (written only by service-role functions).
-- ============================================================================
create table ai_usage (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references profiles(id) on delete cascade,
  kind       ai_usage_kind not null,
  usage_date date not null,            -- in the user's tz; the quota window
  count      integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint ai_usage_user_kind_day_unique unique (user_id, kind, usage_date),
  constraint ai_usage_count_nonneg check (count >= 0)
);

create trigger ai_usage_set_updated_at
  before update on ai_usage
  for each row execute function set_updated_at();

-- Entire ai_usage row is server-owned (service-role functions only).
create or replace function guard_ai_usage_trusted()
returns trigger
language plpgsql
as $$
begin
  if coalesce(current_setting('app.trusted', true), 'off') = 'on' then
    return new;
  end if;
  perform assert_trusted_session();  -- always raises for untrusted clients
  return new;
end;
$$;

create trigger ai_usage_guard_trusted
  before insert or update or delete on ai_usage
  for each row execute function guard_ai_usage_trusted();

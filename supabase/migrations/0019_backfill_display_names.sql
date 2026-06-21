-- ============================================================================
-- 0019_backfill_display_names.sql
-- Fix the leaderboard showing "متعلّم" instead of real names.
-- ----------------------------------------------------------------------------
-- Some profiles ended up with a NULL/empty display_name (accounts created before
-- the name was saved, a dropped best-effort onboarding call, or a phone sign-up
-- with no email prefix for handle_new_user to fall back on). get_leaderboard
-- returns that NULL and the client renders the "متعلّم" placeholder.
--
-- This one-off backfill fills the blanks from the best source we have, in order:
--   1) the saved onboarding answer (onboarding_responses.display_name)
--   2) the email prefix (split_part(email,'@',1))
-- Rows with no usable source are left NULL (the client keeps showing the
-- placeholder for them; they self-heal once that device pushes its local name
-- via saveDisplayName). Idempotent + safe to re-run. display_name is a NON-trusted
-- column, so no app.trusted unlock is needed.
-- ============================================================================

update public.profiles p
   set display_name = coalesce(
         nullif(btrim(orr.display_name), ''),
         nullif(split_part(p.email, '@', 1), '')
       )
  from public.onboarding_responses orr
 where orr.user_id = p.id
   and coalesce(btrim(p.display_name), '') = ''
   and coalesce(
         nullif(btrim(orr.display_name), ''),
         nullif(split_part(p.email, '@', 1), '')
       ) is not null;

-- Catch profiles with no onboarding_responses row but a usable email prefix.
update public.profiles p
   set display_name = nullif(split_part(p.email, '@', 1), '')
 where coalesce(btrim(p.display_name), '') = ''
   and nullif(split_part(p.email, '@', 1), '') is not null;

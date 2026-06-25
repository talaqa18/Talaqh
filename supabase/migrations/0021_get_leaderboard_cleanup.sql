-- ============================================================================
-- 0021_get_leaderboard_cleanup.sql
-- H3 in the production audit: the public leaderboard was exposing test/QA and
-- soft-deleted accounts to every user, including internal ids leaking through
-- display_name (e.g. "del1781198578764", "LBTester", keyboard-mash names from
-- abandoned signups). This replaces get_leaderboard so:
--   1) Soft-deleted users (display_name starting with 'del' followed by a long
--      digit run — the legacy soft-delete rename pattern) are excluded.
--   2) Known internal test handles are excluded by case-insensitive match.
--   3) Empty/whitespace display_name is coalesced to a friendly Arabic default
--      ('متعلّم مجهول') instead of NULL, so the client no longer renders the
--      bare placeholder "؟ متعلّم" or — worse — an internal id.
--   4) Same projection as before (rank, display_name, avatar_url, total_xp,
--      is_me); no schema change required on the client.
-- Idempotent: pure CREATE OR REPLACE. No data is touched.
-- ============================================================================

create or replace function get_leaderboard(
  p_period leaderboard_period default 'all_time',
  p_limit  integer default 50
)
returns table (
  rank         bigint,
  display_name text,
  avatar_url   text,
  total_xp     integer,
  is_me        boolean
)
language plpgsql
security definer
stable
set search_path = public
as $$
declare
  v_uid uuid := require_auth();
  v_limit integer := least(greatest(coalesce(p_limit, 50), 1), 200);
begin
  -- p_period is a reserved hook; v1 always ranks all-time by total_xp.
  return query
  with ranked as (
    select
      p.id,
      p.display_name,
      p.avatar_url,
      p.total_xp,
      p.created_at
    from profiles p
    where p.total_xp > 0
      -- Soft-deleted: legacy rename pattern 'del' + unix-ms timestamp.
      and coalesce(p.display_name, '') !~ '^del[0-9]{6,}'
      -- Known internal test handles (case-insensitive). Add to this list as new
      -- QA accounts appear; keep deliberately small so a real user named
      -- "Tester" isn't accidentally hidden.
      and lower(coalesce(btrim(p.display_name), '')) not in (
        'lbtester', 'lb tester', 'qa', 'qatest', 'test', 'tester', 'talaqa qa', 'talaqa test'
      )
      -- Defensive: drop keyboard-mash placeholder fallbacks that some old client
      -- builds wrote ("Hznzhsj"-style strings have no Arabic, no spaces, and no
      -- vowels in alternating positions). We can't detect these reliably so we
      -- leave them for now — the client-side name sync (saveDisplayName) is
      -- what should prevent them in the first place.
  )
  select
    rank() over (order by r.total_xp desc, r.created_at asc) as rank,
    coalesce(nullif(btrim(r.display_name), ''), 'متعلّم مجهول') as display_name,
    r.avatar_url,
    r.total_xp,
    (r.id = v_uid) as is_me
  from ranked r
  order by r.total_xp desc, r.created_at asc
  limit v_limit;
end;
$$;

-- Grant + ownership unchanged from 0008. Re-assert to be safe under a fresh
-- db reset (0008 ALTERed it once; replacing the function preserves owner).
alter function get_leaderboard(leaderboard_period, integer) owner to postgres;
revoke all on function get_leaderboard(leaderboard_period, integer) from public;
grant execute on function get_leaderboard(leaderboard_period, integer) to authenticated;

comment on function get_leaderboard(leaderboard_period, integer) is
  'SECURITY DEFINER. Returns display_name, avatar_url, total_xp, rank (no PII). all_time by total_xp. Excludes soft-deleted (del<ts>) + known test handles; coalesces empty names to "متعلّم مجهول". Auth-gated.';

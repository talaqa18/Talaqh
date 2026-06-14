-- ============================================================================
-- seed.sql — Notice-only seed stub run by `supabase db reset`.
-- ----------------------------------------------------------------------------
-- WHAT THIS FILE IS
--   `supabase db reset` applies all migrations and then runs this file
--   automatically (configured in supabase/config.toml under `[db.seed]`,
--   sql_paths = ["seed/seed.sql"]). It is therefore the LAST thing to touch a
--   freshly reset database.
--
-- WHY IT DOESN'T CONTAIN THE CONTENT
--   The canonical learning content (unit-01, placement, foundations) is authored
--   as JSON in supabase/seed/content/*.json and loaded by the Node loader
--   supabase/seed/load.mjs. That loader is the SINGLE SOURCE OF TRUTH because:
--
--     1. It must write the SECRET answer tables (comprehension_answers,
--        grammar_answers, placement_answer_keys), which have NO client select
--        policy. Those writes require the Supabase SERVICE-ROLE key, which the
--        local `db reset` SQL session does not carry.
--     2. It derives every primary key as a DETERMINISTIC UUID v5 from a stable
--        string key, keeping re-runs idempotent. Duplicating that whole graph as
--        hand-written SQL here would create a second source of truth that could
--        silently drift from the JSON + loader.
--
--   So seed.sql deliberately stays EMPTY of content and instead RAISES A NOTICE
--   telling the developer to finish seeding with the Node loader. It is valid,
--   side-effect-free SQL that applies cleanly on every reset.
--
-- RELATIONSHIP TO load.mjs (keep in sync)
--   * load.mjs reads supabase/seed/content/*.json and upserts content + answer
--     tables + unit-word-reuse join tables in FK order, using SERVICE-ROLE.
--   * If load.mjs's deterministic-id scheme (SEED_NAMESPACE / uuidv5) ever
--     changes, nothing here needs to change — this file holds no ids — but any
--     future SQL seed that DOES encode ids must match load.mjs's uuidv5() byte
--     for byte (see the SEED_NAMESPACE note at the top of load.mjs).
--
-- THE FULL RESET WORKFLOW
--   supabase db reset          -- migrations + this notice
--   npm run seed               -- node supabase/seed/load.mjs   (content + answers)
--   npm run seed:validate      -- node supabase/seed/validate.mjs (integrity gate)
--   npm run audio:generate     -- node supabase/scripts/generate-audio.mjs (TTS)
-- ============================================================================

do $$
begin
  raise notice '====================================================================';
  raise notice 'seed.sql: schema reset complete. NO content was seeded by this file.';
  raise notice 'Content + answer tables live in JSON and are loaded by the';
  raise notice 'SERVICE-ROLE Node loader (single source of truth):';
  raise notice '';
  raise notice '    npm run seed            # node supabase/seed/load.mjs';
  raise notice '    npm run seed:validate   # node supabase/seed/validate.mjs';
  raise notice '    npm run audio:generate  # node supabase/scripts/generate-audio.mjs';
  raise notice '';
  raise notice 'Why: the answer tables (comprehension_answers, grammar_answers,';
  raise notice 'placement_answer_keys) have no client select policy and require the';
  raise notice 'service-role key, so they are seeded via the Node loader only.';
  raise notice '====================================================================';
end
$$;

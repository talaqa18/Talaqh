# Supabase backend

This is the **target backend** for the app: Postgres + Auth + Storage + Edge
Functions, all owned by Supabase. The React PWA (and later the Capacitor shell)
talk to it through `src/lib/supabase`. Product/backend constants live in
[`../DECISIONS.md`](../DECISIONS.md); this README covers the layout, the two
integrity ideas you must understand before touching anything, and the deploy
workflow.

> The `tools/*.cjs` harness in the repo root tests an **older single-file**
> prototype, not this backend. See [`../docs/backend.md`](../docs/backend.md).

---

## Layout

```
supabase/
  migrations/      ← ordered SQL (see "Migration order" below)
  functions/       ← Deno Edge Functions (server-only secrets)
    _shared/       ←   cors.ts and other shared helpers
    speech-token/  ←   mints short-lived Azure Speech tokens
    .env.example   ←   COMMITTED secrets template (names only)
  seed/            ← authored content loader + validator (service-role)
  scripts/         ← generate-audio.mjs (TTS pre-generation, service-role)
```

## Migration order (0001 – 0010)

Migrations are applied in filename order. **0001 – 0005 exist now** and are the
schema foundation; **0006 – 0010 are reserved slots** for the access layer owned
by other agents (RLS policies, RPCs, Storage policies, content-helper views).
Do not renumber existing files.

| #    | File                    | Owner        | Purpose |
|------|-------------------------|--------------|---------|
| 0001 | `0001_enums.sql`        | schema       | Extensions (`pgcrypto`, `citext`), every enum type, and the shared `set_updated_at()` trigger fn. Grants nothing. |
| 0002 | `0002_content_tables.sql` | schema     | Authored content (units, words, examples, listening, reading, grammar, placement, foundations), the **single `audio_clips` catalog**, the separate **answer tables**, the **unit-word-reuse join tables**, and the **deferred "exactly 5 words per unit" trigger**. |
| 0003 | `0003_user_tables.sql`  | schema       | Per-user tables (profiles, progress, attempts, conversation, settings) **and the trust boundary**: `assert_trusted_session()` + `guard_<table>_trusted()` BEFORE INSERT/UPDATE triggers. |
| 0004 | `0004_gamification.sql` | schema       | `xp_events` (idempotent), `streak_log`, `word_of_the_day`, `subscriptions`, `device_tokens`, `ai_usage` (daily quota ledger). |
| 0005 | `0005_indexes.sql`      | schema       | Secondary FK-lookup and query indexes (e.g. `profiles_leaderboard_idx`, `units_status_position_idx`). No integrity logic. |
| 0006 | _reserved_              | RLS agent    | Row-Level Security: `enable row level security` + per-user `select/insert` policies. The trust boundary (0003) protects **columns**; RLS protects **rows**. Answer tables get **NO select policy**. |
| 0007 | _reserved_              | RPC agent    | `SECURITY DEFINER` RPCs (grading, progress advance, XP award, streak roll-up). These are the **only** code allowed to `set local app.trusted = 'on'`. |
| 0008 | _reserved_              | RPC agent    | Conversation/pronunciation RPCs + any RPC that mints/links `audio_clips`. |
| 0009 | _reserved_              | storage agent | Storage buckets (`unit-audio` public-read, `user-recordings` 30-day TTL) + Storage RLS policies. |
| 0010 | _reserved_              | content agent | Content-resolution helpers (level-fallback views/functions) consumed by the client. |

### Two integrity ideas you must not break

**1. Unit-word reuse (rule 5).** Every unit owns **exactly 5 words**
(`unit_words`, positions 1–5, enforced by a *deferred* constraint trigger that
fires at COMMIT). Listening clips, reading passages, grammar lessons/questions,
and the conversation candidate set link to words **only** through join tables
whose **composite FK references `unit_words(unit_id, word_id)`**. Because the FK
is `(unit_id, word_id)` — not just `word_id` — it is *physically impossible* to
attach a word that does not belong to that unit. Enforce this in the seed data
too; `seed:validate` checks it.

**2. Trust boundary (rule 1).** The browser must not be able to forge progress.
Postgres RLS cannot restrict **columns**, so per-user "trusted" columns
(`profiles.total_xp`, `unit_progress.status`, `user_word_status.*_passed`,
whole `xp_events` rows, etc. — full list in `DECISIONS.md`) are protected by
`BEFORE INSERT/UPDATE` guard triggers. A guarded write is rejected unless the
transaction ran `set local app.trusted = 'on'`, and **only a `SECURITY DEFINER`
RPC owned by a privileged role may set that GUC**. Net effect:

- A direct client write to a trusted column → **rejected**.
- The same change made *through a DEFINER RPC* → allowed, because the RPC sets
  the GUC after validating the request server-side.

Companion rule: **answers are never client-readable** (rule 2). Correct answers
live in `comprehension_answers`, `grammar_answers`, `placement_answer_keys` —
tables with no select policy, read only by grading DEFINER RPCs. The readable
`*_questions` rows expose `prompt_ar` + `options` only.

## Trust boundary at the app tier (what runs as whom)

There are two privilege levels above the anon client:

- **`SECURITY DEFINER` RPCs** — run as the function owner (a privileged role),
  set `app.trusted = 'on'`, and are the normal path for client-initiated
  progress changes after server-side validation.
- **Service-role Edge Functions / scripts** — hold `SUPABASE_SERVICE_ROLE_KEY`,
  bypass RLS entirely, and are used for things the client never initiates:
  **seeding/authoring content** and **pre-generating audio**. The service-role
  key is server-only (Edge Function env / a local operator shell) and must never
  be bundled into the PWA.

### Seeding & authoring is a service-role-only workflow

Content (units, words, examples, listening/reading/grammar, placement,
foundations, answer keys, `word_of_the_day`) is **authored data, not user data**.
It is loaded by `npm run seed` (`supabase/seed/load.mjs`) using the
**service-role key**, which bypasses RLS and the column guards. The browser app
has **no** insert/update path to content tables — there are no client write
policies for them. Likewise `npm run audio:generate`
(`supabase/scripts/generate-audio.mjs`) runs server-side with the service-role
key to TTS-render each unit's words/examples, upload them to the audio Storage
bucket, and upsert the matching `audio_clips` rows (the one audio catalog).

> `seed/load.mjs`, `seed/validate.mjs`, and `scripts/generate-audio.mjs` are the
> author-side tooling the npm scripts point at. Run `npm run seed:validate`
> before `npm run seed` to catch any unit that doesn't have exactly 5 words or
> that references a foreign word.

## Deploy steps

Prerequisite: the [Supabase CLI](https://supabase.com/docs/guides/cli) is
installed and the project is linked (`supabase link --project-ref <ref>`).

```bash
# 1. Apply all migrations (0001..0010) to the linked project.
supabase db push

# 2. Deploy the Edge Functions.
supabase functions deploy speech-token
#    (deploy each additional function as it is added)

# 3. Set SERVER-ONLY secrets (names mirror functions/.env.example).
#    SUPABASE_URL / SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY are
#    auto-injected into deployed functions — you only set the third-party keys.
supabase secrets set \
  SPEECH_API_KEY=... SPEECH_REGION=eastus \
  LLM_API_KEY=... TTS_API_KEY=...

# 4. Load authored content (service-role; validate first).
npm run seed:validate
npm run seed

# 5. Pre-generate and upload unit audio, then upsert audio_clips rows.
npm run audio:generate

# 6. (after pulling new migrations) regenerate the typed DB client.
npm run db:types
```

### Local development

```bash
supabase start                 # local Postgres + Auth + Storage
npm run db:reset               # apply migrations from scratch (DESTROYS local data)
npm run db:types               # regenerate src/lib/supabase/types.ts from local DB
cp supabase/functions/.env.example supabase/functions/.env   # fill real values
npm run functions:serve        # serve Edge Functions locally
npm run seed:validate && npm run seed
```

`npm run db:reset` drops and recreates the local database from the migrations
(and any configured `supabase/seed.sql`) — never run it against a remote
project with real users.

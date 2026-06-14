# DECISIONS.md — Product & Backend Constants (source of truth)

These are the **exact** values every layer (DB, RPCs, Edge Functions, client)
must use. Do not redefine them anywhere else; reference this file. Each entry
records **what** the default is and **why** it was chosen, so a future change is
a deliberate, traceable decision rather than a guess.

> The schema in `supabase/migrations/0001..0005` encodes these via enums, CHECK
> constraints, the deferred 5-words trigger, the XP idempotency unique, and the
> trusted-column guard triggers. RLS, RPCs, and Storage are owned by other
> agents and must align with the values below.

## These are defaults — how to override one

Every number below is a **product default**, intentionally centralized so it can
be tuned without hunting through code. To change one:

1. Edit the value **here first** (and the rationale, if the reasoning changed).
2. Update wherever it is *encoded*: enums / CHECK constraints / triggers in the
   migrations, the XP/quota tables, the grading & quota RPCs and Edge Functions,
   and any client copy that surfaces the value.
3. Note that several values are also enforced as DB constraints (e.g. the
   "exactly 5 words" trigger, `turns_used` CHECK 0–12, the `xp_events`
   idempotency unique). Changing those requires a **new migration**, not an edit
   to an applied one.

If a value here and a value in code ever disagree, **this file wins** — fix the
code to match.

---

## XP amounts (`xp_events.amount`, fixed server-side)

| source_type (`xp_source_type`) | amount |
|---|---|
| `word_quiz_pass`     | 10  |
| `full_words_quiz`    | 50  |
| `listening`          | 40  |
| `reading`            | 40  |
| `grammar_quiz`       | 40  |
| `conversation`       | 60  |
| `unit_complete`      | 100 |
| `streak_daily_bonus` | 20  |
| `foundations_lesson` | 5   |
| `placement`          | 0   |

**Idempotency (integrity rule 3):** `xp_events UNIQUE(user_id, source_type, source_id)`.
`source_id` is the stable key the award is tied to (unit_id / question_id /
session_id / day-key). Re-requesting the same achievement collides and awards once.

**Why these amounts:** they form a deliberate effort curve — a single word quiz
is the smallest unit of progress (10), section-level work (full words quiz,
listening, reading, grammar) clusters at 40–50, the harder speaking task pays
more (conversation 60), and finishing a whole unit gives the largest single
reward (100) so the unit is the headline milestone. `placement = 0` because
placement only *measures* level, it should not inflate the leaderboard. Tune the
spread, but keep `unit_complete` the largest and `word_quiz_pass` the smallest.

## Pronunciation

- `pass_threshold = 70` (score range 0–100). `pronunciation_attempts.passed = (score >= 70)`.
- `retry_cap = 3` per word **per screen visit** (`attempt_no` 1–3; enforced by the RPC).
- Score + `passed` + `assessment` are **server-trusted** (assessed from audio, never client-set).

**Why:** 70 is a "clearly understandable, not native-perfect" bar — high enough
to be meaningful for a learner, low enough not to wall off beginners on accent
alone. A 3-try cap keeps a struggling learner moving (they can revisit later)
instead of being stuck on one word. Raise the threshold for stricter levels, but
keep a finite retry cap so the screen always terminates.

## Conversation (3-minute AI tutor)

- `duration_cap = 180s` (`conversation_sessions.ends_at = started_at + 180s`).
- `max_turns = 12` (`turns_used` CHECK 0–12).
- **Success** when **>= 4 of the unit's 5 words** are used (`words_used_ids`, server-detected).
- LLM output capped at **~300 tokens/reply**.
- The session and its `required_word_ids` are **chosen server-side** (rule 7); the
  client cannot pick the words. `conversation_required_words` is the authored
  candidate set per unit (normally all 5).

**Why:** 180s matches the scope's "3-minute tutor" and is long enough for a real
exchange but short enough to feel low-pressure and to bound LLM cost. The 12-turn
cap is a hard backstop so a fast typer can't run the bill up inside the timer.
Success at 4 of 5 words rewards *using* the unit vocabulary without demanding a
perfect transcript that includes every word. The ~300-token reply cap keeps the
tutor concise and predictable in cost. Adjusting any of these is a cost/UX trade.

## Streak

- A **qualifying day** = **>= 1 `xp_event` that day in the user's timezone**.
- **Lazy evaluation** on next activity; **no grace period** in v1.
- `streak_log` has one row per qualifying day; `profiles.current_streak_days` /
  `longest_streak_days` are server-maintained rollups.
- `streak_daily_bonus` (20 XP) is awarded once per qualifying day
  (`source_id` = the local day-key for idempotency).

**Why:** tying a qualifying day to "earned any XP today" means *any* genuine
learning keeps the streak alive (not a hollow app-open). Lazy evaluation avoids a
nightly cron — the streak is recomputed when the user next acts. No grace period
in v1 keeps the rule simple and honest; a grace/freeze mechanic can be added
later. The user's own timezone is the boundary so "today" matches their day.

## Leaderboard

- v1: **all-time by `profiles.total_xp` DESC**.
- A `'period'` hook (`leaderboard_period` enum: `all_time` | `weekly`) is reserved
  so **weekly** can be added later with no schema change.

**Why:** all-time-by-XP is the simplest ranking that needs no rollover job and
reuses `total_xp` (already maintained for the home screen). The reserved
`weekly` enum value means switching to (or adding) a weekly board is a query/RPC
change, not a migration.

## Recordings

- `user-recordings` Storage bucket has a **30-day retention TTL**
  (`pronunciation_attempts.recording_path` points here; cleanup owned by storage agent).

## Level fallback (content resolution)

When a unit lacks a row at the user's exact level:
1. Use the **nearest LOWER level**, else
2. Any **published** row for that unit.

(`content_level` order: `beginner` < `A1` < `A2` < `B1` < `B2` < `C1`.)

## Auth

- **Email/password only** in v1, **PKCE** flow (Capacitor-safe). OAuth deferred.

## AI per-user DAILY quotas (enforced inside each Edge Function via `ai_usage`)

| `ai_usage_kind`        | daily cap |
|---|---|
| `conversation_session` | 20  |
| `speech_token_mint`    | 200 |
| `stt`                  | 200 |
| `tts_fallback`         | 100 |

Each function increments + checks the relevant `ai_usage` bucket
(`UNIQUE(user_id, kind, usage_date)`) **before** doing work; fail-closed on the cap.

---

## Trust boundary (integrity rule 1) — trusted columns

Postgres RLS cannot restrict **columns**, so `BEFORE INSERT/UPDATE` guard
triggers reject writes to trusted columns unless the transaction set
`app.trusted = 'on'` via `set local app.trusted = 'on'` — and **only** a
`SECURITY DEFINER` RPC owned by a privileged role is allowed to set that GUC.
Guard helper: `assert_trusted_session()`.

**Trusted columns (server-only writes):**

- `profiles`: `total_xp`, `current_streak_days`, `longest_streak_days`,
  `words_learned_count`, `current_level`, `last_activity_date`,
  `onboarding_completed`, `placement_completed`, `foundations_completed`
- `unit_progress`: `status`, `words_completed`, `listening_completed`,
  `reading_completed`, `conversation_completed`, `grammar_completed`,
  `completed_at`, `xp_awarded`
- `user_word_status`: `spelling_passed`, `pronunciation_passed`,
  `meaning_passed`, `best_pronunciation_score`, `learned`, `learned_at`
- `foundations_progress`: `completed`, `completed_at`
- `placement_answers`: `is_correct`
- `quiz_attempts`: `is_correct`, `score`
- `pronunciation_attempts`: `score`, `passed`, `assessment`
- `conversation_sessions`: `required_word_ids`, `outcome`, `words_used_ids`,
  `turns_used`, `xp_awarded`
- `conversation_messages`: **entire row** (written by the conversation RPC)
- `xp_events`: **entire row**
- `streak_log`: **entire row**
- `ai_usage`: **entire row**
- `subscriptions`: `tier`, `status`, `provider`, `provider_ref`, `current_period_end`

## Answers are never client-readable (integrity rule 2)

Correct answers live in **separate tables with NO select policy**, read only by
grading DEFINER RPCs:
- `comprehension_answers` (for `comprehension_questions`)
- `grammar_answers` (for `grammar_questions`)
- `placement_answer_keys` (for `placement_questions`)

The readable `*_questions` rows expose **`prompt_ar` + `options`** only — no
correct flag.

---

## Naming conventions

- Tables/columns: `snake_case`, plural table names.
- PKs: `id uuid primary key default gen_random_uuid()` (join/membership tables
  use composite PKs instead).
- FKs: `<entity>_id`. Timestamps: `created_at`, `updated_at` (`timestamptz`),
  maintained by the `set_updated_at()` trigger.
- Enums: singular type name (e.g. `content_level`, `xp_source_type`).
- Levels: `content_level` / `user_level` = `beginner | A1 | A2 | B1 | B2 | C1`.
  Every learning-content row carries a `level` column.
- Unit-word reuse join tables carry `(unit_id, word_id)` with a **composite FK**
  to `unit_words(unit_id, word_id)`.
- Guard trigger functions: `guard_<table>_trusted()`; updated_at triggers:
  `<table>_set_updated_at`.

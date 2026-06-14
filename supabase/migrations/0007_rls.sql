-- ============================================================================
-- 0007_rls.sql
-- Row-Level Security: enable RLS on EVERY table and add the row-scoping policies.
-- ----------------------------------------------------------------------------
-- THE MODEL (read together with the trust boundary in 0003/0004/0006):
--
--   RLS restricts which ROWS a role can see/modify. It CANNOT restrict columns —
--   per-column "trusted" protection is enforced by the guard triggers (0003/4/6).
--   So RLS + guards compose:
--     * RLS  => you can only touch YOUR OWN rows.
--     * GUARDS => even on your own rows you cannot write TRUSTED columns
--                 (XP, progress, grades, scores, billing) from the client.
--
--   Supabase runs client requests as the `authenticated` (or `anon`) role; the
--   `service_role` and SECURITY DEFINER RPC owners BYPASS RLS, which is how the
--   server reads answer keys and writes trusted columns. Therefore:
--     * CONTENT tables: readable by any signed-in user; NO write policy (only the
--       service role / seed may write).
--     * ANSWER tables: RLS ON, NO policies at all => deny-all to clients; only the
--       grading DEFINER RPC / service role can read them (integrity rule 2).
--     * PER-USER tables: a user may do everything to rows where the row belongs to
--       them (user_id = auth.uid()), and NOTHING to other users' rows.
--     * Child tables without a user_id column scope through their parent via EXISTS.
--
--   CROSS-USER DENIAL (stated as intent throughout): because EVERY per-user policy
--   pins the row to auth.uid() in BOTH USING (visibility / update-old-row) and
--   WITH CHECK (insert / update-new-row), there is NO policy under which user A can
--   read, insert, update, or delete a row owned by user B. With RLS enabled and no
--   permissive policy matching another user's rows, those rows are invisible and
--   immutable to that user. Anonymous (unauthenticated) users match no policy on
--   per-user or answer tables and are denied.
--
--   This file creates NO functions and does NOT define the leaderboard function
--   (that public ranking view/RPC is owned by the RPC agent).
-- ============================================================================


-- ============================================================================
-- SECTION 1 — CONTENT TABLES
-- ----------------------------------------------------------------------------
-- Authored learning content. Any signed-in user may SELECT; there are NO write
-- policies, so clients cannot INSERT/UPDATE/DELETE (writes come from the seed /
-- service role, which bypasses RLS). `units` is additionally gated to published
-- rows only (drafts/archived units must not leak to clients).
-- ============================================================================

-- --- units (gated to published) --------------------------------------------
alter table units enable row level security;
-- Only published units are visible to clients; draft/archived stay server-only.
create policy units_select_published on units
  for select to authenticated
  using (status = 'published');

-- --- words ------------------------------------------------------------------
alter table words enable row level security;
create policy words_select_all on words
  for select to authenticated
  using (true);

-- --- unit_words (the 5-word membership) ------------------------------------
alter table unit_words enable row level security;
create policy unit_words_select_all on unit_words
  for select to authenticated
  using (true);

-- --- word_examples ----------------------------------------------------------
alter table word_examples enable row level security;
create policy word_examples_select_all on word_examples
  for select to authenticated
  using (true);

-- --- audio_clips (the one audio catalog) -----------------------------------
alter table audio_clips enable row level security;
create policy audio_clips_select_all on audio_clips
  for select to authenticated
  using (true);

-- --- listening_clips --------------------------------------------------------
alter table listening_clips enable row level security;
create policy listening_clips_select_all on listening_clips
  for select to authenticated
  using (true);

-- --- reading_passages -------------------------------------------------------
alter table reading_passages enable row level security;
create policy reading_passages_select_all on reading_passages
  for select to authenticated
  using (true);

-- --- comprehension_questions (PROMPT + OPTIONS ONLY) -----------------------
-- The readable question rows expose prompt_ar + options only; the correct answer
-- lives in comprehension_answers (Section 2, deny-all). Column-level secrecy of
-- the answer is achieved by it being a SEPARATE table, not a hidden column here.
alter table comprehension_questions enable row level security;
create policy comprehension_questions_select_all on comprehension_questions
  for select to authenticated
  using (true);

-- --- grammar_lessons --------------------------------------------------------
alter table grammar_lessons enable row level security;
create policy grammar_lessons_select_all on grammar_lessons
  for select to authenticated
  using (true);

-- --- grammar_questions (PROMPT + OPTIONS ONLY) -----------------------------
alter table grammar_questions enable row level security;
create policy grammar_questions_select_all on grammar_questions
  for select to authenticated
  using (true);

-- --- foundations_lessons ----------------------------------------------------
alter table foundations_lessons enable row level security;
create policy foundations_lessons_select_all on foundations_lessons
  for select to authenticated
  using (true);

-- --- placement_questions (PROMPT + OPTIONS ONLY) ---------------------------
alter table placement_questions enable row level security;
create policy placement_questions_select_all on placement_questions
  for select to authenticated
  using (true);

-- --- word_of_the_day --------------------------------------------------------
alter table word_of_the_day enable row level security;
create policy word_of_the_day_select_all on word_of_the_day
  for select to authenticated
  using (true);

-- --- unit-word-reuse JOIN tables (content) ---------------------------------
-- These describe which of a unit's 5 words each piece of content uses. They are
-- authored content (composite FK to unit_words enforces reuse, rule 5).
alter table listening_clip_words enable row level security;
create policy listening_clip_words_select_all on listening_clip_words
  for select to authenticated
  using (true);

alter table reading_passage_words enable row level security;
create policy reading_passage_words_select_all on reading_passage_words
  for select to authenticated
  using (true);

alter table grammar_lesson_words enable row level security;
create policy grammar_lesson_words_select_all on grammar_lesson_words
  for select to authenticated
  using (true);

alter table grammar_question_words enable row level security;
create policy grammar_question_words_select_all on grammar_question_words
  for select to authenticated
  using (true);

-- conversation_required_words is the AUTHORED candidate set per unit (content).
-- The RUNTIME required_word_ids are chosen server-side per session; this table is
-- safe to expose so the client knows which words a unit's conversation targets.
alter table conversation_required_words enable row level security;
create policy conversation_required_words_select_all on conversation_required_words
  for select to authenticated
  using (true);


-- ============================================================================
-- SECTION 2 — ANSWER TABLES  (** DENY-ALL TO CLIENTS **)
-- ----------------------------------------------------------------------------
-- Integrity rule 2: correct answers are NEVER client-readable. We ENABLE RLS but
-- add NO policies whatsoever. With RLS on and zero policies, the `authenticated`
-- and `anon` roles can neither SELECT nor write ANY row. Grading happens only in
-- a SECURITY DEFINER RPC (and the service role) which BYPASSES RLS to read these.
--
-- CROSS-USER / ALL-USER DENIAL INTENT: no user (owner or otherwise) may read,
-- insert, update, or delete these rows. There is deliberately no policy to grant
-- any access — absence of a policy under enabled RLS is a hard deny.
-- ============================================================================

alter table comprehension_answers enable row level security;
-- (no policies: deny-all to clients; read only by grading DEFINER RPC)

alter table grammar_answers enable row level security;
-- (no policies: deny-all to clients; read only by grading DEFINER RPC)

alter table placement_answer_keys enable row level security;
-- (no policies: deny-all to clients; scoring read only by placement DEFINER RPC)


-- ============================================================================
-- SECTION 3 — PER-USER TABLES
-- ----------------------------------------------------------------------------
-- A signed-in user may do everything to rows they OWN; nothing to others' rows.
-- USING pins visibility + the OLD row (update/delete); WITH CHECK pins the NEW
-- row (insert/update) so a user cannot create or move a row to another user_id.
-- Per-column trusted protection is still enforced by the 0003/0004/0006 guards —
-- e.g. a user can INSERT their own unit_progress stub but cannot set status,
-- xp_awarded, etc. without app.trusted=on.
--
-- CROSS-USER DENIAL INTENT (applies to every policy in this section): the
-- predicate `<owner col> = auth.uid()` on BOTH USING and WITH CHECK means there
-- is no code path by which user A touches user B's row. Forging user_id on insert
-- fails WITH CHECK; reading/updating someone else's row fails USING.
-- ============================================================================

-- --- profiles (owner key is `id`, == auth.users.id) ------------------------
alter table profiles enable row level security;
create policy profiles_owner_all on profiles
  for all to authenticated
  using (id = auth.uid())
  with check (id = auth.uid());

-- --- onboarding_responses ---------------------------------------------------
alter table onboarding_responses enable row level security;
create policy onboarding_responses_owner_all on onboarding_responses
  for all to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

-- --- placement_answers (selection client-writable; is_correct guarded) ------
alter table placement_answers enable row level security;
create policy placement_answers_owner_all on placement_answers
  for all to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

-- --- foundations_progress (completed flags guarded) ------------------------
alter table foundations_progress enable row level security;
create policy foundations_progress_owner_all on foundations_progress
  for all to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

-- --- unit_progress (all state columns guarded; advance via DEFINER RPC) -----
alter table unit_progress enable row level security;
create policy unit_progress_owner_all on unit_progress
  for all to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

-- --- user_word_status (*_passed + score guarded) ---------------------------
alter table user_word_status enable row level security;
create policy user_word_status_owner_all on user_word_status
  for all to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

-- --- quiz_attempts (insert-only audit; is_correct/score guarded; no DELETE) -
alter table quiz_attempts enable row level security;
create policy quiz_attempts_owner_all on quiz_attempts
  for all to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

-- --- pronunciation_attempts (score/passed/assessment guarded; no DELETE) ----
alter table pronunciation_attempts enable row level security;
create policy pronunciation_attempts_owner_all on pronunciation_attempts
  for all to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

-- --- conversation_sessions (trusted fields guarded; created by DEFINER RPC) --
alter table conversation_sessions enable row level security;
create policy conversation_sessions_owner_all on conversation_sessions
  for all to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

-- --- user_settings (PK is user_id; client-writable preferences) ------------
alter table user_settings enable row level security;
create policy user_settings_owner_all on user_settings
  for all to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

-- --- subscriptions (entitlement columns guarded; webhook/service role writes) -
alter table subscriptions enable row level security;
create policy subscriptions_owner_all on subscriptions
  for all to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

-- --- device_tokens (push registration; not trusted) ------------------------
alter table device_tokens enable row level security;
create policy device_tokens_owner_all on device_tokens
  for all to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

-- --- ai_usage (entire row trusted; written only by service-role functions) --
-- Owner may READ their own quota usage; all writes are blocked by the trust
-- guard (0004) regardless of this policy.
alter table ai_usage enable row level security;
create policy ai_usage_owner_all on ai_usage
  for all to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());


-- ============================================================================
-- SECTION 4 — CHILD TABLES WITHOUT A user_id (scope via parent EXISTS)
-- ----------------------------------------------------------------------------
-- conversation_messages has no user_id of its own; ownership is derived from its
-- parent conversation_sessions row. We scope visibility through an EXISTS check
-- on the parent owned by auth.uid(). Writes are additionally fully blocked by the
-- conversation_messages trust guard (0003: entire row server-only) and the
-- no-DELETE guard (0006); the policy below governs SELECT (read your own
-- transcript) and keeps WITH CHECK consistent for the DEFINER RPC path.
--
-- CROSS-USER DENIAL INTENT: a message is visible/writable only if its session
-- belongs to auth.uid(); messages in another user's session match no policy.
-- ============================================================================

alter table conversation_messages enable row level security;
create policy conversation_messages_via_session on conversation_messages
  for all to authenticated
  using (
    exists (
      select 1
      from conversation_sessions s
      where s.id = conversation_messages.session_id
        and s.user_id = auth.uid()
    )
  )
  with check (
    exists (
      select 1
      from conversation_sessions s
      where s.id = conversation_messages.session_id
        and s.user_id = auth.uid()
    )
  );


-- ============================================================================
-- SECTION 5 — APPEND-ONLY GAMIFICATION LEDGERS
-- ----------------------------------------------------------------------------
-- xp_events: the immutable XP ledger. Clients may READ their own events (to show
-- XP history) and the policy permits INSERT of their own rows, but the entire row
-- is TRUSTED (0004 guard) so an untrusted INSERT is still rejected by the trigger
-- — i.e. only the DEFINER RPC (which sets app.trusted='on') actually writes. We
-- intentionally grant SELECT + INSERT only (append-only): NO update/delete policy,
-- so events can never be edited or removed by a client.
--
-- streak_log: same shape — owner-readable streak history; entire row TRUSTED so
-- the server (not the client) writes it. SELECT only for clients.
--
-- CROSS-USER DENIAL INTENT: both pin user_id = auth.uid(); no user can see or
-- append another user's XP/streak rows.
-- ============================================================================

alter table xp_events enable row level security;
-- Read own XP history.
create policy xp_events_select_owner on xp_events
  for select to authenticated
  using (user_id = auth.uid());
-- Append-only: own rows only. (Trusted-row guard still requires app.trusted=on,
-- so in practice only the DEFINER RPC inserts; no UPDATE/DELETE policy exists.)
create policy xp_events_insert_owner on xp_events
  for insert to authenticated
  with check (user_id = auth.uid());

alter table streak_log enable row level security;
-- Read own streak history; all writes blocked by the trust guard (server-only).
create policy streak_log_select_owner on streak_log
  for select to authenticated
  using (user_id = auth.uid());

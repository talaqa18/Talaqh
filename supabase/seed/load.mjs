#!/usr/bin/env node
// ============================================================================
// load.mjs — Idempotent golden-content seed loader (SERVICE-ROLE ONLY).
// ----------------------------------------------------------------------------
// WHAT IT DOES
//   Reads the authored JSON in ./content/ (unit-01, placement, foundations) and
//   upserts it into the content tables, the SEPARATE answer tables, and the
//   unit-word-reuse JOIN tables — in correct FK order. Safe to run repeatedly:
//   every row's primary key is a DETERMINISTIC UUID v5 derived from a stable
//   string key, so re-running updates in place instead of duplicating.
//
// WHY SERVICE-ROLE
//   The answer tables (comprehension_answers, grammar_answers,
//   placement_answer_keys) have NO client select policy and content tables are
//   not client-writable. Seeding writes them directly, so it MUST use the
//   Supabase SERVICE-ROLE key, which bypasses RLS. NEVER expose this key to the
//   browser or commit it. See the "SERVICE-ROLE-ONLY WORKFLOW" doc at the
//   bottom of this file and supabase/seed/README.md.
//
// INTEGRITY GUARANTEES HONORED HERE
//   * Rule 5 (exactly 5 words / unit): the 5 unit_words rows for a unit are sent
//     in ONE upsert array -> PostgREST runs a single request in a single
//     transaction, so the DEFERRED `unit_words_exactly_five` constraint (checked
//     at COMMIT) sees all 5 rows and passes.
//   * Rule 5 (no foreign words): join-table rows carry (unit_id, word_id) whose
//     composite FK -> unit_words(unit_id, word_id). We only ever insert pairs
//     that come from this unit's own 5 words; the DB rejects anything else.
//   * Rule 2 (answers separated): readable question rows and their secret answer
//     rows are written to DIFFERENT tables.
//   * Rule 6 (one audio catalog): audio is NOT authored here. Audio is attached
//     later by the audio pipeline writing audio_clips(owner_type, owner_id).
//     This loader is audio-agnostic; validate.mjs enforces audio coverage once
//     audio exists.
//
// USAGE
//   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... node supabase/seed/load.mjs
//   (or put them in supabase/seed/.env — git-ignored — see README.)
// ============================================================================

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createHash } from 'node:crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CONTENT_DIR = join(__dirname, 'content');

// ---------------------------------------------------------------------------
// Deterministic UUID v5 (RFC 4122) from a stable string key.
// Namespace is fixed so Node (load.mjs) and SQL (seed.sql) MUST agree. If you
// change SEED_NAMESPACE here, change uuid_seed() in seed.sql identically.
// ---------------------------------------------------------------------------
const SEED_NAMESPACE = '6f9b1c3e-2a4d-5b6e-8c0f-1a2b3c4d5e6f'; // arbitrary, fixed

function uuidv5(name, namespace = SEED_NAMESPACE) {
  const nsBytes = Buffer.from(namespace.replace(/-/g, ''), 'hex'); // 16 bytes
  const nameBytes = Buffer.from(name, 'utf8');
  const hash = createHash('sha1')
    .update(nsBytes)
    .update(nameBytes)
    .digest(); // 20 bytes
  const b = hash.subarray(0, 16);
  b[6] = (b[6] & 0x0f) | 0x50; // version 5
  b[8] = (b[8] & 0x3f) | 0x80; // RFC 4122 variant
  const h = b.toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
// Stable id for a content row: id('word', 'word-water') etc. The prefix keeps
// ids in different tables from colliding even if two keys were ever identical.
const id = (kind, key) => uuidv5(`${kind}:${key}`);

// ---------------------------------------------------------------------------
// Env + client
// ---------------------------------------------------------------------------
const SUPABASE_URL =
  process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL || '';
const SERVICE_ROLE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  process.env.SERVICE_ROLE_KEY ||
  '';

function fail(msg) {
  console.error(`\n[seed:load] ERROR: ${msg}\n`);
  process.exit(1);
}

if (!SUPABASE_URL) fail('SUPABASE_URL (or VITE_SUPABASE_URL) is not set.');
if (!SERVICE_ROLE_KEY) {
  fail(
    'SUPABASE_SERVICE_ROLE_KEY is not set. The seed loader writes answer tables\n' +
      '  and content directly, so it requires the SERVICE-ROLE key (server-only).\n' +
      '  NEVER use the anon key here, and NEVER commit the service-role key.'
  );
}

let createClient;
try {
  ({ createClient } = await import('@supabase/supabase-js'));
} catch {
  fail(
    "Cannot import '@supabase/supabase-js'. Install deps first: `npm install`.\n" +
      '  (Network may be disabled in this environment; install locally.)'
  );
}

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

// ---------------------------------------------------------------------------
// Tiny upsert helper. Sends ONE request per call (one transaction). `onConflict`
// is the conflict target (PK or unique). Throws on error so the run aborts in
// FK order rather than leaving half-written content.
// ---------------------------------------------------------------------------
async function upsert(table, rows, onConflict) {
  if (!rows || rows.length === 0) return;
  const { error } = await supabase
    .from(table)
    .upsert(rows, { onConflict, ignoreDuplicates: false });
  if (error) {
    throw new Error(
      `upsert into "${table}" failed: ${error.message}` +
        (error.details ? ` | ${error.details}` : '') +
        (error.hint ? ` | hint: ${error.hint}` : '')
    );
  }
  console.log(`  [+] ${table}: upserted ${rows.length} row(s)`);
}

function readJson(name) {
  return JSON.parse(readFileSync(join(CONTENT_DIR, name), 'utf8'));
}

// ===========================================================================
// LOADERS
// ===========================================================================

async function loadUnit(file) {
  const data = readJson(file);
  const u = data.unit;
  const unitId = id('unit', u.key);
  console.log(`\n=== Unit: ${u.slug} (${u.key}) ===`);

  // -- precompute word ids --------------------------------------------------
  const wordId = {};
  for (const w of data.words) wordId[w.key] = id('word', w.key);
  const resolveWords = (keys) =>
    (keys || []).map((k) => {
      if (!wordId[k]) throw new Error(`word key "${k}" not in unit ${u.key}`);
      return wordId[k];
    });

  // ---- 1. unit (parent) ---------------------------------------------------
  await upsert(
    'units',
    [
      {
        id: unitId,
        position: u.position,
        level: u.level,
        slug: u.slug,
        title_ar: u.title_ar,
        subtitle_ar: u.subtitle_ar ?? null,
        description_ar: u.description_ar ?? null,
        status: u.status,
      },
    ],
    'id'
  );

  // ---- 2. words -----------------------------------------------------------
  await upsert(
    'words',
    data.words.map((w) => ({
      id: wordId[w.key],
      level: w.level,
      text_en: w.text_en,
      phonetic: w.phonetic ?? null,
      translation_ar: w.translation_ar,
      part_of_speech: w.part_of_speech ?? null,
      status: w.status,
    })),
    'id'
  );

  // ---- 3. unit_words — ALL 5 IN ONE REQUEST (one txn) ---------------------
  // The deferred `unit_words_exactly_five` trigger is checked at COMMIT; a
  // single upsert array commits once with all 5 rows present, so it passes.
  if (data.words.length !== 5) {
    throw new Error(
      `unit ${u.key} has ${data.words.length} words; schema requires EXACTLY 5.`
    );
  }
  await upsert(
    'unit_words',
    data.words.map((w) => ({
      unit_id: unitId,
      word_id: wordId[w.key],
      position: w.position,
    })),
    'unit_id,word_id'
  );

  // ---- 4. word_examples ---------------------------------------------------
  const examples = [];
  for (const w of data.words) {
    for (const ex of w.examples) {
      examples.push({
        id: id('word_example', ex.key),
        word_id: wordId[w.key],
        level: ex.level,
        sentence_en: ex.sentence_en,
        translation_ar: ex.translation_ar,
        position: ex.position,
        status: ex.status,
      });
    }
  }
  await upsert('word_examples', examples, 'id');

  // ---- 5. listening_clips + comprehension Qs/answers + join ---------------
  for (const lc of data.listening_clips || []) {
    const clipId = id('listening_clip', lc.key);
    await upsert(
      'listening_clips',
      [
        {
          id: clipId,
          unit_id: unitId,
          level: lc.level,
          position: lc.position,
          transcript_en: lc.transcript_en,
          translation_ar: lc.translation_ar,
          status: lc.status,
        },
      ],
      'id'
    );
    // join: which of the unit's words this clip uses (composite FK guards reuse)
    await upsert(
      'listening_clip_words',
      resolveWords(lc.uses_word_keys).map((w) => ({
        listening_clip_id: clipId,
        unit_id: unitId,
        word_id: w,
      })),
      'listening_clip_id,word_id'
    );
    // questions (readable) then answers (secret) — different tables, FK order
    const lq = lc.comprehension_questions || [];
    await upsert(
      'comprehension_questions',
      lq.map((q) => ({
        id: id('comprehension_question', q.key),
        listening_clip_id: clipId,
        reading_passage_id: null,
        level: q.level,
        position: q.position,
        kind: q.kind,
        prompt_ar: q.prompt_ar,
        options: q.kind === 'multiple_choice' ? q.options : null,
        status: lc.status,
      })),
      'id'
    );
    await upsert(
      'comprehension_answers',
      lq.map((q) => ({
        question_id: id('comprehension_question', q.key),
        correct_option_index: q.answer.correct_option_index ?? null,
        accepted_answers: q.answer.accepted_answers ?? null,
        explanation_ar: q.answer.explanation_ar ?? null,
      })),
      'question_id'
    );
  }

  // ---- 6. reading_passages + comprehension Qs/answers + join --------------
  for (const rp of data.reading_passages || []) {
    const passageId = id('reading_passage', rp.key);
    await upsert(
      'reading_passages',
      [
        {
          id: passageId,
          unit_id: unitId,
          level: rp.level,
          position: rp.position,
          title_en: rp.title_en ?? null,
          body_en: rp.body_en,
          translation_ar: rp.translation_ar,
          status: rp.status,
        },
      ],
      'id'
    );
    await upsert(
      'reading_passage_words',
      resolveWords(rp.uses_word_keys).map((w) => ({
        reading_passage_id: passageId,
        unit_id: unitId,
        word_id: w,
      })),
      'reading_passage_id,word_id'
    );
    const rq = rp.comprehension_questions || [];
    await upsert(
      'comprehension_questions',
      rq.map((q) => ({
        id: id('comprehension_question', q.key),
        listening_clip_id: null,
        reading_passage_id: passageId,
        level: q.level,
        position: q.position,
        kind: q.kind,
        prompt_ar: q.prompt_ar,
        options: q.kind === 'multiple_choice' ? q.options : null,
        status: rp.status,
      })),
      'id'
    );
    await upsert(
      'comprehension_answers',
      rq.map((q) => ({
        question_id: id('comprehension_question', q.key),
        correct_option_index: q.answer.correct_option_index ?? null,
        accepted_answers: q.answer.accepted_answers ?? null,
        explanation_ar: q.answer.explanation_ar ?? null,
      })),
      'question_id'
    );
  }

  // ---- 7. grammar_lessons + lesson-words join, then Qs/answers/Q-words ----
  for (const gl of data.grammar_lessons || []) {
    const lessonId = id('grammar_lesson', gl.key);
    await upsert(
      'grammar_lessons',
      [
        {
          id: lessonId,
          unit_id: unitId,
          level: gl.level,
          position: gl.position,
          title_ar: gl.title_ar,
          explanation_ar: gl.explanation_ar,
          examples: gl.examples ?? null,
          status: gl.status,
        },
      ],
      'id'
    );
    await upsert(
      'grammar_lesson_words',
      resolveWords(gl.uses_word_keys).map((w) => ({
        grammar_lesson_id: lessonId,
        unit_id: unitId,
        word_id: w,
      })),
      'grammar_lesson_id,word_id'
    );
    const gq = gl.questions || [];
    await upsert(
      'grammar_questions',
      gq.map((q) => ({
        id: id('grammar_question', q.key),
        grammar_lesson_id: lessonId,
        level: q.level,
        position: q.position,
        kind: q.kind,
        prompt_ar: q.prompt_ar,
        options: q.kind === 'multiple_choice' ? q.options : null,
        status: gl.status,
      })),
      'id'
    );
    await upsert(
      'grammar_answers',
      gq.map((q) => ({
        question_id: id('grammar_question', q.key),
        correct_option_index: q.answer.correct_option_index ?? null,
        accepted_answers: q.answer.accepted_answers ?? null,
        explanation_ar: q.answer.explanation_ar ?? null,
      })),
      'question_id'
    );
    // per-question word join (composite FK guards reuse)
    const gqWords = [];
    for (const q of gq) {
      for (const w of resolveWords(q.uses_word_keys)) {
        gqWords.push({
          grammar_question_id: id('grammar_question', q.key),
          unit_id: unitId,
          word_id: w,
        });
      }
    }
    await upsert('grammar_question_words', gqWords, 'grammar_question_id,word_id');
  }

  // ---- 8. conversation_required_words (authored candidate set) ------------
  await upsert(
    'conversation_required_words',
    resolveWords(data.conversation_required_word_keys).map((w) => ({
      unit_id: unitId,
      word_id: w,
    })),
    'unit_id,word_id'
  );
}

async function loadPlacement(file) {
  const data = readJson(file);
  console.log(`\n=== Placement test ===`);
  await upsert(
    'placement_questions',
    data.placement_questions.map((q) => ({
      id: id('placement_question', q.key),
      level: q.level,
      position: q.position,
      kind: q.kind,
      prompt_ar: q.prompt_ar,
      options: q.kind === 'multiple_choice' ? q.options : null,
      status: 'published',
    })),
    'id'
  );
  await upsert(
    'placement_answer_keys',
    data.placement_questions.map((q) => ({
      question_id: id('placement_question', q.key),
      correct_option_index: q.answer.correct_option_index ?? null,
      accepted_answers: q.answer.accepted_answers ?? null,
      awards_level: q.answer.awards_level ?? null,
      weight: q.answer.weight ?? 1,
    })),
    'question_id'
  );
}

async function loadFoundations(file) {
  const data = readJson(file);
  console.log(`\n=== Foundations lessons ===`);
  await upsert(
    'foundations_lessons',
    data.foundations_lessons.map((l) => ({
      id: id('foundations_lesson', l.key),
      level: l.level ?? 'beginner',
      position: l.position,
      kind: l.kind,
      title_ar: l.title_ar,
      body_ar: l.body_ar ?? null,
      letter_or_word: l.letter_or_word ?? null,
      status: l.status,
    })),
    'id'
  );
}

// ===========================================================================
// MAIN
// ===========================================================================
async function main() {
  console.log(`[seed:load] target: ${SUPABASE_URL}`);
  try {
    await loadUnit('unit-01.json');
    await loadPlacement('placement.json');
    await loadFoundations('foundations.json');
  } catch (err) {
    fail(err.message);
  }
  console.log('\n[seed:load] done. Run `node supabase/seed/validate.mjs` to verify.\n');
}

await main();

// ============================================================================
// SERVICE-ROLE-ONLY WORKFLOW
// ----------------------------------------------------------------------------
// 1. This script REQUIRES the Supabase service-role key. It bypasses RLS to
//    write content + the no-select answer tables. The anon key CANNOT do this.
// 2. Provide credentials via env (preferred) or supabase/seed/.env (git-ignored):
//       SUPABASE_URL=https://<ref>.supabase.co
//       SUPABASE_SERVICE_ROLE_KEY=<service-role-key>     # NEVER VITE_-prefixed
// 3. Run AFTER migrations are applied:
//       supabase db push           # or `supabase db reset` (which runs seed.sql)
//       node supabase/seed/load.mjs
//       node supabase/seed/validate.mjs
// 4. The service-role key is SECRET: never commit it, never ship it in the Vite
//    bundle, never give it the VITE_ prefix. Rotate it if it ever leaks.
// 5. `supabase db reset` runs supabase/seed/seed.sql automatically (configured
//    in supabase/config.toml `[db.seed]`). seed.sql encodes the SAME data with
//    the SAME deterministic ids, so the SQL path and this Node path are
//    interchangeable and idempotent against each other.
// ============================================================================

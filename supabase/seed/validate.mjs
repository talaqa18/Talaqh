#!/usr/bin/env node
// ============================================================================
// validate.mjs — Idempotent, READ-ONLY integrity checks (SERVICE-ROLE).
// ----------------------------------------------------------------------------
// WHAT IT DOES
//   Runs assertions against the LIVE database (via the same env + service-role
//   client setup as load.mjs) and prints a ✓/✗ line per check. Exits non-zero
//   (1) if ANY check fails, so it works as a CI / pre-deploy gate. It NEVER
//   writes or mutates anything — every query is a plain SELECT and the
//   comparison happens in JS.
//
// WHY SERVICE-ROLE
//   Some checks read the no-select ANSWER tables (comprehension_answers,
//   grammar_answers, placement_answer_keys), which have NO client select policy.
//   Reading them to verify answer coverage requires the SERVICE-ROLE key, which
//   bypasses RLS. Same secrecy rules as load.mjs apply: never expose this key.
//
// EACH RULE MAPS TO A CLAUDE.md HARD RULE / INTEGRITY GUARANTEE
//   Check 1 (exactly 5 unit_words per PUBLISHED unit)
//       -> CLAUDE.md hard rule 4 "Unit-word reuse" + the unit's fixed FIVE words.
//          The whole journey (words/listening/reading/conversation/grammar) is
//          built on a unit having EXACTLY 5 words; this asserts the invariant.
//   Check 2 (exactly 3 word_examples per referenced word)
//       -> Teaching/quiz content depends on a consistent example count per word
//          (the words teaching screen + meaning/spelling material). Enforces the
//          authored shape (3 examples/word) the loader produces.
//   Check 3 (no FOREIGN words in any reuse join table)
//       -> CLAUDE.md hard rule 4 "Unit-word reuse": listening clips, the reading
//          passage, conversation, and grammar examples MUST use the current
//          unit's 5 words. Every (unit_id, word_id) in a join table must exist in
//          unit_words — no word from outside the unit may leak in.
//   Check 4 (answer coverage)
//       -> Every gradable question MUST have a stored answer. The readable
//          question tables and the secret answer tables are SEPARATE (security);
//          a question with no matching answer row is ungradable. Covers
//          comprehension, grammar, and placement.
//   Check 5 (audio coverage)
//       -> CLAUDE.md hard rule 5 "One audio source" + the pre-generation audio
//          strategy: every word / example / listening clip / word-of-the-day that
//          needs audio should resolve through exactly one audio_clips row. SOFT
//          (warning) while no audio exists yet; HARD once audio_clips is
//          non-empty but some owners still lack a clip.
//
// USAGE
//   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... node supabase/seed/validate.mjs
//   (or put them in supabase/seed/.env — git-ignored — see README.) Run AFTER
//   `node supabase/seed/load.mjs`.
// ============================================================================

// ---------------------------------------------------------------------------
// Env + client — copied from load.mjs so both scripts behave identically.
// ---------------------------------------------------------------------------
const SUPABASE_URL =
  process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL || '';
const SERVICE_ROLE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  process.env.SERVICE_ROLE_KEY ||
  '';

function fail(msg) {
  console.error(`\n[seed:validate] ERROR: ${msg}\n`);
  process.exit(1);
}

if (!SUPABASE_URL) fail('SUPABASE_URL (or VITE_SUPABASE_URL) is not set.');
if (!SERVICE_ROLE_KEY) {
  fail(
    'SUPABASE_SERVICE_ROLE_KEY is not set. The validator reads the no-select\n' +
      '  answer tables, so it requires the SERVICE-ROLE key (server-only).\n' +
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
// Tiny read helper: select() and throw on error so a query failure aborts the
// run (rather than silently passing a check). Read-only by construction.
// ---------------------------------------------------------------------------
async function selectAll(table, columns) {
  const { data, error } = await supabase.from(table).select(columns);
  if (error) {
    throw new Error(
      `select from "${table}" failed: ${error.message}` +
        (error.details ? ` | ${error.details}` : '') +
        (error.hint ? ` | hint: ${error.hint}` : '')
    );
  }
  return data || [];
}

// Result accumulators. `failures` drives the exit code; `warnings` does not.
let failures = 0;
let warnings = 0;

function pass(msg) {
  console.log(`  ✓ ${msg}`);
}
function flunk(msg) {
  failures += 1;
  console.log(`  ✗ ${msg}`);
}
function warn(msg) {
  warnings += 1;
  console.log(`  ⚠ ${msg}`);
}

// Group an array of rows by a key function -> Map<key, rows[]>.
function groupBy(rows, keyFn) {
  const m = new Map();
  for (const r of rows) {
    const k = keyFn(r);
    const arr = m.get(k);
    if (arr) arr.push(r);
    else m.set(k, [r]);
  }
  return m;
}

// ===========================================================================
// CHECK 1 — Every PUBLISHED unit has EXACTLY 5 unit_words rows.
// (CLAUDE.md rule 4 + the unit's fixed FIVE words.)
// ===========================================================================
async function check1PublishedUnitsHaveFiveWords() {
  console.log('\n[1] Every published unit has exactly 5 unit_words');
  const units = await selectAll('units', 'id, slug, status');
  const unitWords = await selectAll('unit_words', 'unit_id, word_id');
  const byUnit = groupBy(unitWords, (r) => r.unit_id);

  const published = units.filter((u) => u.status === 'published');
  if (published.length === 0) {
    warn('no published units found — nothing to check (run `npm run seed`?)');
    return;
  }
  for (const u of published) {
    const count = (byUnit.get(u.id) || []).length;
    if (count === 5) {
      pass(`unit "${u.slug}" has 5 words`);
    } else {
      flunk(`unit "${u.slug}" has ${count} words (expected EXACTLY 5)`);
    }
  }
}

// ===========================================================================
// CHECK 2 — Every word referenced by a PUBLISHED unit has EXACTLY 3
// word_examples. (Authored shape: 3 examples per word.)
// ===========================================================================
async function check2WordsHaveThreeExamples() {
  console.log('\n[2] Every published-unit word has exactly 3 word_examples');
  const units = await selectAll('units', 'id, status');
  const publishedUnitIds = new Set(
    units.filter((u) => u.status === 'published').map((u) => u.id)
  );
  const unitWords = await selectAll('unit_words', 'unit_id, word_id');
  const words = await selectAll('words', 'id, text_en');
  const examples = await selectAll('word_examples', 'id, word_id');

  // Words that belong to at least one published unit.
  const referencedWordIds = new Set(
    unitWords.filter((uw) => publishedUnitIds.has(uw.unit_id)).map((uw) => uw.word_id)
  );
  if (referencedWordIds.size === 0) {
    warn('no published-unit words found — nothing to check');
    return;
  }
  const textById = new Map(words.map((w) => [w.id, w.text_en]));
  const examplesByWord = groupBy(examples, (e) => e.word_id);

  for (const wid of referencedWordIds) {
    const count = (examplesByWord.get(wid) || []).length;
    const label = textById.get(wid) || wid;
    if (count === 3) {
      pass(`word "${label}" has 3 examples`);
    } else {
      flunk(`word "${label}" has ${count} examples (expected EXACTLY 3)`);
    }
  }
}

// ===========================================================================
// CHECK 3 — Unit-word reuse: NO foreign words. Every (unit_id, word_id) pair in
// each reuse join table must exist in unit_words. (CLAUDE.md rule 4.)
// ===========================================================================
async function check3NoForeignWords() {
  console.log('\n[3] Unit-word reuse: no foreign words in any join table');
  const unitWords = await selectAll('unit_words', 'unit_id, word_id');
  const allowed = new Set(unitWords.map((uw) => `${uw.unit_id}|${uw.word_id}`));

  const joinTables = [
    'listening_clip_words',
    'reading_passage_words',
    'grammar_lesson_words',
    'grammar_question_words',
    'conversation_required_words',
  ];

  for (const table of joinTables) {
    const rows = await selectAll(table, 'unit_id, word_id');
    if (rows.length === 0) {
      warn(`${table}: no rows to check`);
      continue;
    }
    const foreign = rows.filter(
      (r) => !allowed.has(`${r.unit_id}|${r.word_id}`)
    );
    if (foreign.length === 0) {
      pass(`${table}: all ${rows.length} pair(s) exist in unit_words`);
    } else {
      flunk(
        `${table}: ${foreign.length} foreign (unit_id, word_id) pair(s) not in unit_words ` +
          `e.g. ${foreign[0].unit_id}/${foreign[0].word_id}`
      );
    }
  }
}

// ===========================================================================
// CHECK 4 — Answer coverage. Every readable question row must have a matching
// secret answer row (different tables). Covers comprehension, grammar, placement.
// ===========================================================================
async function check4AnswerCoverage() {
  console.log('\n[4] Answer coverage (questions <-> answer tables)');

  const pairs = [
    {
      label: 'comprehension',
      questionTable: 'comprehension_questions',
      answerTable: 'comprehension_answers',
    },
    {
      label: 'grammar',
      questionTable: 'grammar_questions',
      answerTable: 'grammar_answers',
    },
    {
      label: 'placement',
      questionTable: 'placement_questions',
      answerTable: 'placement_answer_keys',
    },
  ];

  for (const p of pairs) {
    const questions = await selectAll(p.questionTable, 'id');
    const answers = await selectAll(p.answerTable, 'question_id');
    if (questions.length === 0) {
      warn(`${p.label}: no questions to check`);
      continue;
    }
    const answered = new Set(answers.map((a) => a.question_id));
    const missing = questions.filter((q) => !answered.has(q.id));
    if (missing.length === 0) {
      pass(`${p.label}: all ${questions.length} question(s) have an answer row`);
    } else {
      flunk(
        `${p.label}: ${missing.length} question(s) missing an answer row in ` +
          `${p.answerTable} (e.g. ${missing[0].id})`
      );
    }
  }
}

// ===========================================================================
// CHECK 5 — Audio coverage. For every word / word_example / listening_clip /
// word_of_the_day owner, an audio_clips row should exist with the matching
// owner_type + owner_id. SOFT (warning) until audio exists; HARD once it does.
// (CLAUDE.md rule 5 + the pre-generation audio strategy.)
// ===========================================================================
async function check5AudioCoverage() {
  console.log('\n[5] Audio coverage (audio_clips owner_type + owner_id)');

  const audioClips = await selectAll('audio_clips', 'owner_type, owner_id');
  const haveAudio = new Set(
    audioClips.map((c) => `${c.owner_type}|${c.owner_id}`)
  );

  // Only check owners that belong to PUBLISHED content where applicable.
  const units = await selectAll('units', 'id, status');
  const publishedUnitIds = new Set(
    units.filter((u) => u.status === 'published').map((u) => u.id)
  );
  const unitWords = await selectAll('unit_words', 'unit_id, word_id');
  const referencedWordIds = new Set(
    unitWords.filter((uw) => publishedUnitIds.has(uw.unit_id)).map((uw) => uw.word_id)
  );

  const words = (await selectAll('words', 'id, status')).filter(
    (w) => w.status === 'published' && referencedWordIds.has(w.id)
  );
  const wordIdSet = new Set(words.map((w) => w.id));
  const examples = (await selectAll('word_examples', 'id, word_id, status')).filter(
    (e) => e.status === 'published' && wordIdSet.has(e.word_id)
  );
  const listeningClips = (
    await selectAll('listening_clips', 'id, unit_id, status')
  ).filter((c) => c.status === 'published' && publishedUnitIds.has(c.unit_id));
  const wotd = (
    await selectAll('word_of_the_day', 'id, status')
  ).filter((w) => w.status === 'published');

  // The full work list of (owner_type, owner_id) that SHOULD have audio.
  const owners = [
    ...words.map((w) => ['word', w.id]),
    ...examples.map((e) => ['word_example', e.id]),
    ...listeningClips.map((c) => ['listening_clip', c.id]),
    ...wotd.map((w) => ['word_of_the_day', w.id]),
  ];

  if (owners.length === 0) {
    warn('no audio-bearing content found — nothing to check');
    return;
  }

  // SOFT path: no audio generated yet. A warning, not a failure.
  if (audioClips.length === 0) {
    warn(
      `audio_clips is EMPTY — ${owners.length} clip(s) not yet generated. ` +
        'Run `npm run audio:generate` to pre-generate audio.'
    );
    return;
  }

  // HARD path: audio exists but some owners still lack a clip.
  const missing = owners.filter(([t, id]) => !haveAudio.has(`${t}|${id}`));
  const byType = groupBy(missing, ([t]) => t);
  if (missing.length === 0) {
    pass(`all ${owners.length} audio owner(s) have an audio_clips row`);
  } else {
    for (const [t, list] of byType) {
      flunk(
        `${t}: ${list.length} owner(s) missing an audio_clips row ` +
          `(e.g. ${list[0][1]}) — run \`npm run audio:generate\``
      );
    }
  }
}

// ===========================================================================
// MAIN
// ===========================================================================
async function main() {
  console.log(`[seed:validate] target: ${SUPABASE_URL}`);
  try {
    await check1PublishedUnitsHaveFiveWords();
    await check2WordsHaveThreeExamples();
    await check3NoForeignWords();
    await check4AnswerCoverage();
    await check5AudioCoverage();
  } catch (err) {
    fail(err.message);
  }

  console.log('');
  if (failures > 0) {
    console.log(
      `[seed:validate] FAILED: ${failures} check(s) ✗` +
        (warnings ? `, ${warnings} warning(s) ⚠` : '') +
        '\n'
    );
    process.exit(1);
  }
  console.log(
    `[seed:validate] OK: all checks passed` +
      (warnings ? ` (${warnings} warning(s) ⚠)` : '') +
      '\n'
  );
}

await main();

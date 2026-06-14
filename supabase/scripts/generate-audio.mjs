#!/usr/bin/env node
// ============================================================================
// generate-audio.mjs — TTS pre-generation pipeline (SERVICE-ROLE).
// ----------------------------------------------------------------------------
// AUDIO STRATEGY (CLAUDE.md): PRE-GENERATION IS PRIMARY.
//   We synthesize the FIXED, finite text of each unit ONCE — every word, example
//   sentence, listening transcript, and word-of-the-day — upload the mp3 to the
//   PUBLIC `unit-audio` bucket, and catalog it in audio_clips (the ONE audio
//   catalog, integrity rule 6). This is cheap (pay per character once),
//   consistent (same voice everywhere), installable/offline-friendly (static
//   CDN assets), and means the app never calls a TTS API at runtime for core
//   content. The `tts-fallback` Edge Function is ONLY for DYNAMIC text that
//   cannot be pre-generated (e.g. ad-hoc strings) — it is NOT the primary path.
//
// WHY SERVICE-ROLE
//   This writes audio_clips (a CONTENT table, not client-writable) and uploads
//   to a service-role-only bucket. Both require the SERVICE-ROLE key, which
//   bypasses RLS. Writing audio_clips here is correct and intentional. Same
//   secrecy rules as load.mjs: never expose or commit the key.
//
// IDEMPOTENT / RESUMABLE
//   Before synthesizing, we read existing audio_clips and SKIP any
//   (owner_type, owner_id) that already has a row. A crashed run can be re-run
//   and only does the remaining work. Uploads use upsert:true so a partially
//   uploaded object is overwritten safely.
//
// FLAGS
//   --dry-run            compute the work list + a cost estimate; synthesize
//                        nothing, upload nothing, write nothing.
//   --only=<scope>       restrict scope: words | examples | listening | wotd.
//                        (default: all four.)
//
// USAGE
//   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... \
//   TTS_API_KEY=... SPEECH_REGION=eastus \
//   node supabase/scripts/generate-audio.mjs [--dry-run] [--only=words]
// ============================================================================

import { Buffer } from 'node:buffer';

// ---------------------------------------------------------------------------
// Env + client — same pattern as load.mjs, PLUS the TTS provider credentials.
// TTS_API_KEY + SPEECH_REGION are only REQUIRED when actually synthesizing
// (i.e. NOT in --dry-run), so we defer that check until after flag parsing.
// ---------------------------------------------------------------------------
const SUPABASE_URL =
  process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL || '';
const SERVICE_ROLE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  process.env.SERVICE_ROLE_KEY ||
  '';
const TTS_API_KEY = process.env.TTS_API_KEY || process.env.SPEECH_API_KEY || '';
const SPEECH_REGION = process.env.SPEECH_REGION || '';

function fail(msg) {
  console.error(`\n[audio:generate] ERROR: ${msg}\n`);
  process.exit(1);
}

if (!SUPABASE_URL) fail('SUPABASE_URL (or VITE_SUPABASE_URL) is not set.');
if (!SERVICE_ROLE_KEY) {
  fail(
    'SUPABASE_SERVICE_ROLE_KEY is not set. The audio pipeline writes audio_clips\n' +
      '  and uploads to the service-role-only bucket, so it requires the\n' +
      '  SERVICE-ROLE key (server-only). NEVER use the anon key, NEVER commit it.'
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
// Flags.
// ---------------------------------------------------------------------------
const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const onlyArg = args.find((a) => a.startsWith('--only='));
const ONLY = onlyArg ? onlyArg.slice('--only='.length) : null;
const VALID_SCOPES = ['words', 'examples', 'listening', 'wotd'];
if (ONLY && !VALID_SCOPES.includes(ONLY)) {
  fail(`--only must be one of: ${VALID_SCOPES.join(' | ')} (got "${ONLY}")`);
}
const wants = (scope) => !ONLY || ONLY === scope;

// ---------------------------------------------------------------------------
// Config: bucket, voice, output format, throttle, cost model.
// ---------------------------------------------------------------------------
const BUCKET = 'unit-audio';
// Neutral en-US neural voice for the LTR English content.
const VOICE = 'en-US-AriaNeural';
const OUTPUT_FORMAT = 'audio-24khz-48kbitrate-mono-mp3';
const CONTENT_TYPE = 'audio/mpeg';
// Throttle: a small delay between synthesis calls keeps us under Azure's RPS
// limits and makes the run resumable rather than rate-limited.
const SYNTH_DELAY_MS = 250;
// Azure Neural TTS pricing is ~$16 per 1,000,000 characters. Used only for the
// --dry-run estimate; not load-bearing.
const USD_PER_MILLION_CHARS = 16;

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Storage path convention. NOTE: the task spec fixes these flat paths
// (words/{id}.mp3, examples/{id}.mp3, listening/{id}.mp3, wotd/{YYYY-MM-DD}.mp3)
// inside the `unit-audio` bucket. (The 0009_storage.sql comment sketches a
// unit-nested layout; the flat convention here is the authoritative one this
// pipeline writes and stores on audio_clips.storage_path.)
// ---------------------------------------------------------------------------
const pathFor = {
  word: (id) => `words/${id}.mp3`,
  word_example: (id) => `examples/${id}.mp3`,
  listening_clip: (id) => `listening/${id}.mp3`,
  // word-of-the-day is keyed by its calendar date for a stable, guessable path.
  word_of_the_day: (_id, scheduledFor) => `wotd/${scheduledFor}.mp3`,
};

// ---------------------------------------------------------------------------
// Read helper (throws on error so the run aborts loudly).
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

// ---------------------------------------------------------------------------
// upsert helper — mirrors load.mjs's upsert() (one request, onConflict target).
// audio_clips conflict target is the UNIQUE(owner_type, owner_id) constraint.
// ---------------------------------------------------------------------------
async function upsertAudioClip(row) {
  const { error } = await supabase
    .from('audio_clips')
    .upsert([row], { onConflict: 'owner_type,owner_id', ignoreDuplicates: false });
  if (error) {
    throw new Error(
      `upsert into "audio_clips" failed: ${error.message}` +
        (error.details ? ` | ${error.details}` : '') +
        (error.hint ? ` | hint: ${error.hint}` : '')
    );
  }
}

// ===========================================================================
// SYNTHESIS — *** SWAPPABLE *** provider boundary.
// ---------------------------------------------------------------------------
// synthesize(text) -> Promise<Buffer> of mp3 bytes. To swap providers (e.g. to
// another TTS vendor), replace ONLY this function; the rest of the pipeline is
// provider-agnostic. Current impl: Azure Neural TTS REST.
//   POST https://<SPEECH_REGION>.tts.speech.microsoft.com/cognitiveservices/v1
//   headers: Ocp-Apim-Subscription-Key, X-Microsoft-OutputFormat, Content-Type
//   body: SSML with a neutral en-US neural voice.
// Throws on non-200 so the caller can log + continue (resumable).
// ===========================================================================
function escapeXml(s) {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

async function synthesize(text) {
  const endpoint = `https://${SPEECH_REGION}.tts.speech.microsoft.com/cognitiveservices/v1`;
  const ssml =
    `<speak version="1.0" xml:lang="en-US">` +
    `<voice xml:lang="en-US" name="${VOICE}">${escapeXml(text)}</voice>` +
    `</speak>`;

  const res = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Ocp-Apim-Subscription-Key': TTS_API_KEY,
      'X-Microsoft-OutputFormat': OUTPUT_FORMAT,
      'Content-Type': 'application/ssml+xml',
      'User-Agent': 'arabic-english-pwa-audio-gen',
    },
    body: ssml,
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`TTS HTTP ${res.status} ${res.statusText} ${detail}`.trim());
  }
  const arrayBuf = await res.arrayBuffer();
  return Buffer.from(arrayBuf);
}

// ===========================================================================
// WORK LIST — build the (owner_type, owner_id, text, path) records to generate.
// ===========================================================================
async function buildWorkList() {
  const items = [];

  if (wants('words')) {
    const words = (await selectAll('words', 'id, text_en, status')).filter(
      (w) => w.status === 'published'
    );
    for (const w of words) {
      items.push({
        owner_type: 'word',
        owner_id: w.id,
        text: w.text_en,
        path: pathFor.word(w.id),
      });
    }
  }

  if (wants('examples')) {
    const examples = (
      await selectAll('word_examples', 'id, sentence_en, status')
    ).filter((e) => e.status === 'published');
    for (const e of examples) {
      items.push({
        owner_type: 'word_example',
        owner_id: e.id,
        text: e.sentence_en,
        path: pathFor.word_example(e.id),
      });
    }
  }

  if (wants('listening')) {
    const clips = (
      await selectAll('listening_clips', 'id, transcript_en, status')
    ).filter((c) => c.status === 'published');
    for (const c of clips) {
      items.push({
        owner_type: 'listening_clip',
        owner_id: c.id,
        text: c.transcript_en,
        path: pathFor.listening_clip(c.id),
      });
    }
  }

  if (wants('wotd')) {
    const wotd = (
      await selectAll('word_of_the_day', 'id, word_id, scheduled_for, status')
    ).filter((w) => w.status === 'published');
    // word-of-the-day audio speaks the underlying word's text.
    const words = await selectAll('words', 'id, text_en');
    const textById = new Map(words.map((w) => [w.id, w.text_en]));
    for (const w of wotd) {
      const text = textById.get(w.word_id);
      if (!text) {
        console.log(
          `  [skip] word_of_the_day ${w.id}: word_id ${w.word_id} not found`
        );
        continue;
      }
      items.push({
        owner_type: 'word_of_the_day',
        owner_id: w.id,
        text,
        path: pathFor.word_of_the_day(w.id, w.scheduled_for),
      });
    }
  }

  return items;
}

// ===========================================================================
// MAIN
// ===========================================================================
async function main() {
  console.log(`[audio:generate] target: ${SUPABASE_URL}`);
  console.log(
    `[audio:generate] scope: ${ONLY || 'all'}` +
      (DRY_RUN ? '  (DRY RUN — nothing will be synthesized or written)' : '')
  );

  // Synthesis credentials are only needed when we actually call the TTS API.
  if (!DRY_RUN) {
    if (!TTS_API_KEY) {
      fail('TTS_API_KEY (or SPEECH_API_KEY) is not set — required to synthesize.');
    }
    if (!SPEECH_REGION) {
      fail('SPEECH_REGION is not set — required to build the Azure TTS endpoint.');
    }
  }

  let work;
  let existing;
  try {
    work = await buildWorkList();
    existing = await selectAll('audio_clips', 'owner_type, owner_id');
  } catch (err) {
    fail(err.message);
  }

  const have = new Set(existing.map((c) => `${c.owner_type}|${c.owner_id}`));
  const todo = work.filter((w) => !have.has(`${w.owner_type}|${w.owner_id}`));
  const skipped = work.length - todo.length;

  console.log(
    `[audio:generate] work list: ${work.length} owner(s), ` +
      `${skipped} already generated, ${todo.length} to do.`
  );

  // --- DRY RUN: print the would-do count + a rough cost estimate, then exit. --
  if (DRY_RUN) {
    const totalChars = todo.reduce((sum, w) => sum + (w.text?.length || 0), 0);
    const estUsd = (totalChars / 1_000_000) * USD_PER_MILLION_CHARS;
    console.log('');
    console.log(`  WOULD generate: ${todo.length} clip(s)`);
    console.log(`  total characters: ${totalChars}`);
    console.log(
      `  rough cost: ~$${estUsd.toFixed(4)} ` +
        `(Azure Neural TTS ~ $${USD_PER_MILLION_CHARS} / 1M chars)`
    );
    console.log('\n[audio:generate] dry run complete. Nothing was changed.\n');
    return;
  }

  // --- REAL RUN: synthesize -> upload -> catalog, resumably. -----------------
  let done = 0;
  let errored = 0;
  for (const item of todo) {
    const label = `${item.owner_type}/${item.owner_id}`;
    try {
      const buffer = await synthesize(item.text);

      const { error: upErr } = await supabase.storage
        .from(BUCKET)
        .upload(item.path, buffer, { contentType: CONTENT_TYPE, upsert: true });
      if (upErr) {
        throw new Error(`upload to ${BUCKET}/${item.path} failed: ${upErr.message}`);
      }

      await upsertAudioClip({
        owner_type: item.owner_type,
        owner_id: item.owner_id,
        storage_path: item.path,
        voice: VOICE,
      });

      done += 1;
      console.log(`  [+] ${label} -> ${item.path}`);
    } catch (err) {
      // Log + continue: a single failure must not abort the resumable run.
      errored += 1;
      console.log(`  [!] ${label} FAILED: ${err.message}`);
    }
    // Throttle between calls to stay under the provider's RPS limit.
    await delay(SYNTH_DELAY_MS);
  }

  console.log('');
  console.log(
    `[audio:generate] done. generated ${done}, skipped ${skipped}, ` +
      `failed ${errored}, of ${work.length} total owner(s).`
  );
  if (errored > 0) {
    console.log(
      '[audio:generate] some clips failed — re-run to resume (idempotent).\n'
    );
    process.exit(1);
  }
  console.log('');
}

await main();

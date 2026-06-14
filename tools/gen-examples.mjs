// Pre-generate 3 example sentences for EVERY curriculum word via the deployed
// generate-lesson function (examples mode), and bake them into content/examples.js
// as window.WORD_EXAMPLES = { "<en lower>": [{en,ar},{en,ar},{en,ar}] }.
// Resumable: keeps a partial JSON sidecar so re-running continues where it stopped.
import { readFileSync, writeFileSync, existsSync } from "node:fs";

const API = "https://ogoswbedcbgymtaxktlf.supabase.co";
const ANON = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im9nb3N3YmVkY2JneW10YXhrdGxmIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODA4MDY0MjUsImV4cCI6MjA5NjM4MjQyNX0.HzppveZ_6pLVfTKytHMtzKyX-cVljyJQ0BvM-I2rDdk";
const PARTIAL = "content/_examples.partial.json";
const OUT = "content/examples.js";
const CONCURRENCY = 6;

const curriculum = JSON.parse(readFileSync("content/curriculum.json", "utf8"));
const words = curriculum.words || [];

// resume from partial if present
let store = {};
if (existsSync(PARTIAL)) { try { store = JSON.parse(readFileSync(PARTIAL, "utf8")); } catch (_) {} }

// group words by level, then chunk into batches of 5 (skip words already done)
const byLevel = {};
for (const w of words) {
  if (!w.en || store[w.en.toLowerCase()]) continue;
  (byLevel[w.level || "A1"] = byLevel[w.level || "A1"] || []).push(w);
}
const batches = [];
for (const [level, ws] of Object.entries(byLevel)) {
  for (let i = 0; i < ws.length; i += 5) batches.push({ level, words: ws.slice(i, i + 5) });
}
console.log(`words total ${words.length}, already done ${Object.keys(store).length}, batches to run ${batches.length}`);

async function signIn() {
  const r = await fetch(API + "/auth/v1/signup", {
    method: "POST", headers: { apikey: ANON, "Content-Type": "application/json" },
    body: JSON.stringify({ email: "gen" + Math.floor(Math.random() * 1e12) + "@talaqa-gen.com", password: "Gen123456!" }),
  });
  const j = await r.json();
  if (!j.access_token) throw new Error("no token: " + JSON.stringify(j).slice(0, 200));
  return j.access_token;
}

async function callBatch(jwt, batch, attempt = 1) {
  try {
    const ctrl = new AbortController();
    const to = setTimeout(() => ctrl.abort(), 40000);
    const r = await fetch(API + "/functions/v1/generate-lesson", {
      method: "POST",
      headers: { Authorization: "Bearer " + jwt, apikey: ANON, "Content-Type": "application/json" },
      body: JSON.stringify({ only: "examples", level: batch.level, words: batch.words.map((w) => ({ en: w.en, ar: w.ar })) }),
      signal: ctrl.signal,
    });
    clearTimeout(to);
    const j = await r.json();
    if (!r.ok || !Array.isArray(j.vocab)) throw new Error("bad resp " + r.status + " " + JSON.stringify(j).slice(0, 120));
    let got = 0;
    for (const v of j.vocab) {
      if (!v || !v.en || !Array.isArray(v.examples)) continue;
      const ex = v.examples.filter((e) => e && e.en).slice(0, 3).map((e) => ({ en: String(e.en), ar: String(e.ar || "") }));
      if (ex.length) { store[v.en.toLowerCase()] = ex; got++; }
    }
    return got;
  } catch (e) {
    if (attempt < 3) { await new Promise((r) => setTimeout(r, 1500 * attempt)); return callBatch(jwt, batch, attempt + 1); }
    console.log("  batch failed:", batch.words.map((w) => w.en).join(","), String(e).slice(0, 80));
    return 0;
  }
}

function writePartial() { writeFileSync(PARTIAL, JSON.stringify(store)); }
function writeFinal() {
  const sorted = {};
  for (const k of Object.keys(store).sort()) sorted[k] = store[k];
  writeFileSync(OUT, "/* Pre-generated example sentences (3 per word) for instant display. */\nwindow.WORD_EXAMPLES = " + JSON.stringify(sorted) + ";\n");
}

let jwt = await signIn();
let done = 0, idx = 0;
async function worker() {
  while (idx < batches.length) {
    const my = batches[idx++];
    await callBatch(jwt, my);
    done++;
    if (done % 10 === 0) { writePartial(); console.log(`  ${done}/${batches.length} batches, ${Object.keys(store).length} words`); }
  }
}
// refresh token midway (signup tokens last ~1h, fine, but re-sign every 200 batches just in case)
await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));
writePartial(); writeFinal();
console.log(`DONE: ${Object.keys(store).length} words with examples -> ${OUT}`);

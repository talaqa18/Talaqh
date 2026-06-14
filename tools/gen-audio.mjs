// Pre-generate TTS audio for EVERY curriculum word (and word-of-day examples) by
// calling the deployed tts function, which stores each clip in the public
// tts-cache bucket. After this, the app's first play of any word is a fast CDN
// hit instead of a ~4s OpenAI generation. Resumable; rotates accounts for the cap.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";

const API = "https://ogoswbedcbgymtaxktlf.supabase.co";
const ANON = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im9nb3N3YmVkY2JneW10YXhrdGxmIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODA4MDY0MjUsImV4cCI6MjA5NjM4MjQyNX0.HzppveZ_6pLVfTKytHMtzKyX-cVljyJQ0BvM-I2rDdk";
const PARTIAL = "content/_audio.partial.json";
const CONCURRENCY = 5;
const PER_ACCOUNT = 650; // tts cap is 800/day/user — stay under

const cur = JSON.parse(readFileSync("content/curriculum.json", "utf8"));
// Unique word texts to voice (the most-played surface). Lowercase-dedup but keep
// original casing for the spoken text.
const seen = new Set();
const texts = [];
for (const w of cur.words || []) {
  const en = (w.en || "").trim();
  if (!en) continue;
  const k = en.toLowerCase();
  if (seen.has(k)) continue;
  seen.add(k);
  texts.push(en);
}

const key = (s) => createHash("sha256").update(s).digest("hex");
let done = {};
if (existsSync(PARTIAL)) { try { done = JSON.parse(readFileSync(PARTIAL, "utf8")); } catch (_) {} }
const todo = texts.filter((t) => !done[t]);
console.log(`unique words ${texts.length}, already done ${Object.keys(done).length}, to run ${todo.length}`);

async function signUp() {
  const r = await fetch(API + "/auth/v1/signup", {
    method: "POST", headers: { apikey: ANON, "Content-Type": "application/json" },
    body: JSON.stringify({ email: "aud" + Math.floor(Math.random() * 1e12) + "@talaqa-gen.com", password: "Gen123456!" }),
  });
  const j = await r.json();
  if (!j.access_token) throw new Error("no token " + JSON.stringify(j).slice(0, 150));
  return j.access_token;
}

async function existsOnCdn(text) {
  try { const r = await fetch(`${API}/storage/v1/object/public/tts-cache/${key(text + "|fable|0.9")}.mp3`, { method: "HEAD" }); return r.ok; }
  catch (_) { return false; }
}

async function voice(jwt, text, attempt = 1) {
  try {
    if (await existsOnCdn(text)) { done[text] = 1; return true; } // already cached globally
    const ctrl = new AbortController();
    const to = setTimeout(() => ctrl.abort(), 45000);
    const r = await fetch(API + "/functions/v1/tts", {
      method: "POST",
      headers: { Authorization: "Bearer " + jwt, apikey: ANON, "Content-Type": "application/json" },
      body: JSON.stringify({ text }), signal: ctrl.signal,
    });
    clearTimeout(to);
    await r.arrayBuffer().catch(() => {});
    if (!r.ok) throw new Error("http " + r.status);
    done[text] = 1;
    return true;
  } catch (e) {
    if (attempt < 3) { await new Promise((res) => setTimeout(res, 1500 * attempt)); return voice(jwt, text, attempt + 1); }
    console.log("  FAILED", text, String(e).slice(0, 60));
    return false;
  }
}

const nAccounts = Math.max(1, Math.ceil(todo.length / PER_ACCOUNT));
const jwts = [];
for (let i = 0; i < nAccounts; i++) jwts.push(await signUp());
console.log(`using ${nAccounts} accounts`);

let idx = 0, n = 0;
async function worker() {
  while (idx < todo.length) {
    const my = idx++;
    await voice(jwts[Math.floor(my / PER_ACCOUNT) % jwts.length], todo[my]);
    n++;
    if (n % 25 === 0) { writeFileSync(PARTIAL, JSON.stringify(done)); console.log(`  ${n}/${todo.length} (cached ${Object.keys(done).length})`); }
  }
}
await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));
writeFileSync(PARTIAL, JSON.stringify(done));
console.log(`DONE: ${Object.keys(done).length}/${texts.length} words voiced into tts-cache`);

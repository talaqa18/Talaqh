// Pre-generate TTS for every chapter's LISTENING transcript (and reading passage)
// by calling the deployed tts function, which caches each clip in the public
// tts-cache bucket. After this the listening clip plays instantly (CDN hit) instead
// of a ~5s on-demand generation. Resumable; rotates accounts for the daily cap.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";

const API = "https://ogoswbedcbgymtaxktlf.supabase.co";
const ANON = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im9nb3N3YmVkY2JneW10YXhrdGxmIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODA4MDY0MjUsImV4cCI6MjA5NjM4MjQyNX0.HzppveZ_6pLVfTKytHMtzKyX-cVljyJQ0BvM-I2rDdk";
const PARTIAL = "content/_listen_audio.partial.json";
const CONCURRENCY = 4;
const PER_ACCOUNT = 600;

global.window = {};
import("../content/lessons.js").catch(() => {}); // best-effort; we read the file directly below instead
const lessonsSrc = readFileSync("content/lessons.js", "utf8");
const LESSONS = JSON.parse(lessonsSrc.replace(/^[^=]*=\s*/, "").replace(/;\s*$/, ""));

// Collect the exact texts the app plays: listening transcript_en + reading passage
// (joined the same way the app joins READING.lines).
const seen = new Set();
const texts = [];
function add(t) { t = (t || "").trim(); if (t && !seen.has(t)) { seen.add(t); texts.push(t); } }
for (const k of Object.keys(LESSONS)) {
  const L = LESSONS[k];
  if (L && L.listening && L.listening.transcript_en) add(L.listening.transcript_en);
  if (L && L.reading && L.reading.passage_en) add(L.reading.passage_en);
}
console.log("unique listening/reading texts:", texts.length);

const key = (s) => createHash("sha256").update(s).digest("hex");
let done = {};
if (existsSync(PARTIAL)) { try { done = JSON.parse(readFileSync(PARTIAL, "utf8")); } catch (_) {} }
const todo = texts.filter((t) => !done[t]);
console.log(`already done ${Object.keys(done).length}, to run ${todo.length}`);

async function signUp() {
  const r = await fetch(API + "/auth/v1/signup", { method: "POST", headers: { apikey: ANON, "Content-Type": "application/json" }, body: JSON.stringify({ email: "la" + Math.floor(Math.random() * 1e12) + "@talaqa-gen.com", password: "Gen123456!" }) });
  const j = await r.json(); if (!j.access_token) throw new Error("no token"); return j.access_token;
}
async function existsOnCdn(text) { try { const r = await fetch(`${API}/storage/v1/object/public/tts-cache/${key(text + "|fable|0.9")}.mp3`, { method: "HEAD" }); return r.ok; } catch (_) { return false; } }
async function voice(jwt, text, attempt = 1) {
  try {
    if (await existsOnCdn(text)) { done[text] = 1; return true; }
    const ctrl = new AbortController(); const to = setTimeout(() => ctrl.abort(), 60000);
    const r = await fetch(API + "/functions/v1/tts", { method: "POST", headers: { Authorization: "Bearer " + jwt, apikey: ANON, "Content-Type": "application/json" }, body: JSON.stringify({ text }), signal: ctrl.signal });
    clearTimeout(to); await r.arrayBuffer().catch(() => {});
    if (!r.ok) throw new Error("http " + r.status);
    done[text] = 1; return true;
  } catch (e) { if (attempt < 3) { await new Promise((res) => setTimeout(res, 1500 * attempt)); return voice(jwt, text, attempt + 1); } console.log("  FAILED", String(e).slice(0, 50)); return false; }
}

const nAcc = Math.max(1, Math.ceil(todo.length / PER_ACCOUNT));
const jwts = []; for (let i = 0; i < nAcc; i++) jwts.push(await signUp());
console.log("accounts:", nAcc);
let idx = 0, n = 0;
async function worker() { while (idx < todo.length) { const my = idx++; await voice(jwts[Math.floor(my / PER_ACCOUNT) % jwts.length], todo[my]); n++; if (n % 20 === 0) { writeFileSync(PARTIAL, JSON.stringify(done)); console.log(`  ${n}/${todo.length} (cached ${Object.keys(done).length})`); } } }
await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));
writeFileSync(PARTIAL, JSON.stringify(done));
console.log(`DONE: ${Object.keys(done).length}/${texts.length} listening/reading clips cached`);

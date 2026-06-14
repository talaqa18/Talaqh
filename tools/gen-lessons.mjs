// Pre-generate the FULL lesson (listening/reading/grammar/writing) for EVERY
// curriculum chapter via the deployed generate-lesson function, and bake them
// into content/lessons.js as window.LESSONS = { "LEVEL:NO": <lesson json> }.
// Resumable via a partial sidecar. Rotates accounts to respect the daily cap.
import { readFileSync, writeFileSync, existsSync } from "node:fs";

const API = "https://ogoswbedcbgymtaxktlf.supabase.co";
const ANON = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im9nb3N3YmVkY2JneW10YXhrdGxmIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODA4MDY0MjUsImV4cCI6MjA5NjM4MjQyNX0.HzppveZ_6pLVfTKytHMtzKyX-cVljyJQ0BvM-I2rDdk";
const PARTIAL = "content/_lessons.partial.json";
const OUT = "content/lessons.js";
const CONCURRENCY = 5;
const PER_ACCOUNT = 70; // generate_lesson cap is 100/day/user — stay well under

const cur = JSON.parse(readFileSync("content/curriculum.json", "utf8"));
const topicMap = {};
(cur.chapters || []).forEach((c) => { topicMap[c.level + "|" + c.number] = c.topic_en || ""; });

// Group words into chapters exactly like the app's chaptersFor(): by (level, chapter_no), 5 words each.
const byKey = {}, order = [];
for (const w of cur.words || []) {
  if (!w.en) continue;
  const key = (w.level || "A1") + ":" + (w.chapter_no || w.chapter_title);
  if (!byKey[key]) { byKey[key] = { level: w.level || "A1", no: w.chapter_no, title: w.chapter_title, topic: topicMap[(w.level || "A1") + "|" + w.chapter_no] || "", words: [] }; order.push(key); }
  byKey[key].words.push({ en: w.en, ar: w.ar });
}

let store = {};
if (existsSync(PARTIAL)) { try { store = JSON.parse(readFileSync(PARTIAL, "utf8")); } catch (_) {} }
const todo = order.filter((k) => !store[k]);
console.log(`chapters total ${order.length}, done ${Object.keys(store).length}, to run ${todo.length}`);

async function signUp() {
  const r = await fetch(API + "/auth/v1/signup", {
    method: "POST", headers: { apikey: ANON, "Content-Type": "application/json" },
    body: JSON.stringify({ email: "les" + Math.floor(Math.random() * 1e12) + "@talaqa-gen.com", password: "Gen123456!" }),
  });
  const j = await r.json();
  if (!j.access_token) throw new Error("no token " + JSON.stringify(j).slice(0, 150));
  return j.access_token;
}

function validLesson(L) {
  return L && L.listening && L.listening.transcript_en && Array.isArray(L.listening.questions) && L.listening.questions.length >= 2
    && L.reading && L.reading.passage_en && Array.isArray(L.reading.questions) && L.reading.questions.length >= 2
    && L.grammar && Array.isArray(L.grammar.questions) && L.grammar.questions.length >= 1;
}

async function genChapter(jwt, key, attempt = 1) {
  const ch = byKey[key];
  try {
    const ctrl = new AbortController();
    const to = setTimeout(() => ctrl.abort(), 90000);
    const r = await fetch(API + "/functions/v1/generate-lesson", {
      method: "POST",
      headers: { Authorization: "Bearer " + jwt, apikey: ANON, "Content-Type": "application/json" },
      body: JSON.stringify({ level: ch.level, topic: ch.topic || ch.title, words: ch.words.slice(0, 5) }),
      signal: ctrl.signal,
    });
    clearTimeout(to);
    const j = await r.json();
    if (!r.ok) throw new Error("http " + r.status + " " + JSON.stringify(j).slice(0, 100));
    if (!validLesson(j)) throw new Error("invalid lesson shape");
    store[key] = j;
    return true;
  } catch (e) {
    if (attempt < 3) { await new Promise((res) => setTimeout(res, 2000 * attempt)); return genChapter(jwt, key, attempt + 1); }
    console.log("  FAILED", key, String(e).slice(0, 90));
    return false;
  }
}

function writePartial() { writeFileSync(PARTIAL, JSON.stringify(store)); }
function writeFinal() {
  const sorted = {};
  for (const k of order) if (store[k]) sorted[k] = store[k];
  writeFileSync(OUT, "/* Pre-generated full lessons per chapter (listening/reading/grammar/writing). */\nwindow.LESSONS = " + JSON.stringify(sorted) + ";\n");
}

// pre-mint enough accounts for the workload
const nAccounts = Math.max(1, Math.ceil(todo.length / PER_ACCOUNT));
const jwts = [];
for (let i = 0; i < nAccounts; i++) jwts.push(await signUp());
console.log(`using ${nAccounts} accounts`);

let idx = 0, done = 0;
async function worker() {
  while (idx < todo.length) {
    const my = idx++;
    const key = todo[my];
    await genChapter(jwts[Math.floor(my / PER_ACCOUNT) % jwts.length], key);
    done++;
    if (done % 10 === 0) { writePartial(); console.log(`  ${done}/${todo.length} chapters, stored ${Object.keys(store).length}`); }
  }
}
await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));
writePartial(); writeFinal();
console.log(`DONE: ${Object.keys(store).length}/${order.length} lessons -> ${OUT}`);

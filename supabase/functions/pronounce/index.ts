// Edge Function: pronounce
// ----------------------------------------------------------------------------
// v1 pronunciation scoring WITHOUT a phoneme API: transcribe the learner's audio
// with Whisper, then compare the transcript to the expected word/phrase to derive
// a 0-100 score. This is a STOPGAP (word-level, not phoneme-level). To upgrade to
// true phoneme scoring later, swap the body for SpeechAce/ELSA behind this same
// endpoint — the client contract stays the same.
//
// Provider: OpenAI Whisper (audio/transcriptions). Key SERVER-ONLY.
// Auth: verify_jwt + fail-closed. Quota: counts against the "stt" daily cap.
// Request: multipart/form-data { audio: <file/blob>, expected: <text> }
// Response: { score: 0-100, passed: boolean, transcript, expected }
// deno-lint-ignore-file no-explicit-any
import { getAuthedUser, getServiceClient, HttpError } from "../_shared/auth.ts";
import { checkAndIncrement } from "../_shared/quota.ts";
import { fetchWithRetry } from "../_shared/http.ts";
import { corsHeadersFor } from "../_shared/cors.ts";

const PASS = 75; // mirrors the app's pronunciation pass threshold

function norm(s: string): string {
  return (s || "").toLowerCase().normalize("NFKD").replace(/[^a-z0-9\s']/g, " ").replace(/\s+/g, " ").trim();
}
function levenshtein(a: string, b: string): number {
  const m = a.length, n = b.length;
  if (!m) return n; if (!n) return m;
  const dp = Array.from({ length: m + 1 }, (_, i) => i);
  for (let j = 1; j <= n; j++) {
    let prev = dp[0]; dp[0] = j;
    for (let i = 1; i <= m; i++) {
      const tmp = dp[i];
      dp[i] = Math.min(dp[i] + 1, dp[i - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return dp[m];
}
function similarity(a: string, b: string): number {
  if (!a && !b) return 1;
  const L = Math.max(a.length, b.length) || 1;
  return 1 - levenshtein(a, b) / L;
}
// ----------------------------------------------------------------------------
// ACCENT TOLERANCE. Whisper transcribes what it HEARS, so an Arabic speaker's
// natural accent (which neutralises sounds English distinguishes — p/b, v/f, the
// interdental "th", and most vowel qualities) used to be transcribed as a near-word
// ("three"->"tree", "very"->"berry", "this"->"dis") and then punished by raw string
// distance. We fix that by scoring against a PHONETIC skeleton too, folding exactly
// the distinctions accented-but-correct speech collapses, and taking the BEST of the
// raw / folded / skeleton signals — leniency can only RAISE a correct attempt, never
// rescue a genuinely different word (the whole-word/string match still has to be close).
// ----------------------------------------------------------------------------
// Fold the consonant confusions common to Arabic-accented English; vowels kept.
function accentFold(s: string): string {
  let x = norm(s).replace(/[^a-z\s]/g, "");
  x = x
    .replace(/tch/g, "ch").replace(/sch/g, "sh")
    .replace(/ph/g, "f").replace(/gh/g, "").replace(/ck/g, "k")
    .replace(/qu/g, "kw").replace(/wh/g, "w")
    .replace(/th/g, "t")   // interdental -> t (also commonly s/z) : fold to one
    .replace(/sh/g, "s").replace(/ch/g, "s")  // sh/ch <-> s
    .replace(/x/g, "ks");
  x = x
    .replace(/p/g, "b")    // p <-> b
    .replace(/v/g, "f")    // v <-> f
    .replace(/z/g, "s")    // z <-> s
    .replace(/g/g, "j")    // soft g <-> j
    .replace(/c/g, "k").replace(/q/g, "k");
  return x.replace(/(.)\1+/g, "$1").replace(/\s+/g, " ").trim();  // collapse doubles
}
// Coarse phonetic skeleton: accent-fold, fold the voiced interdental (the "th" in
// "this", commonly heard as "d"), then collapse vowel runs (Arabic accents shift
// vowel QUALITY the most) so only the consonant frame has to line up.
function phon(s: string): string {
  return accentFold(s).replace(/\s+/g, "").replace(/d/g, "t").replace(/[aeiou]+/g, "a").replace(/(.)\1+/g, "$1");
}
// Best similarity of `expected` vs the whole transcript or any single word, under a
// given normalisation transform.
function bestUnder(transcript: string, expected: string, tf: (s: string) => string): number {
  const e = tf(expected);
  if (!e) return 0;
  let best = similarity(tf(transcript), e);
  for (const w of transcript.split(/\s+/)) { if (!w) continue; const tw = tf(w); if (tw) best = Math.max(best, similarity(tw, e)); }
  return best;
}
// 0-100 score: exact/substring -> 100, else the most forgiving of the three signals.
function scoreOf(transcript: string, expected: string): number {
  const t = norm(transcript), e = norm(expected);
  if (!e) return 0;
  if (t === e || t.includes(e)) return 100;
  const best = Math.max(
    bestUnder(transcript, expected, norm),
    bestUnder(transcript, expected, accentFold),
    bestUnder(transcript, expected, phon),
  );
  return Math.round(Math.max(0, Math.min(1, best)) * 100);
}
// Per-word feedback: for each expected word, did ANY transcript word match it closely
// (under any signal)? Lets the client highlight the actual mispronounced part.
function wordFeedback(transcript: string, expected: string): { word: string; ok: boolean }[] {
  const tWords = norm(transcript).split(" ").filter(Boolean);
  return norm(expected).split(" ").filter(Boolean).map((ew) => {
    let best = 0;
    for (const tw of tWords) {
      best = Math.max(
        best,
        similarity(ew, tw),
        similarity(accentFold(ew), accentFold(tw)),
        similarity(phon(ew), phon(tw)),
      );
    }
    return { word: ew, ok: best >= 0.6 };
  });
}

Deno.serve(async (req: Request) => {
  const cors = corsHeadersFor(req);
  const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...cors, "Content-Type": "application/json" } });
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  try {
    const { user } = await getAuthedUser(req);
    const service = getServiceClient();
    await checkAndIncrement(service, user.id, "stt");

    const form = await req.formData().catch(() => null);
    if (!form) throw new HttpError(400, "Expected multipart/form-data");
    const audio = form.get("audio");
    const expected = String(form.get("expected") ?? "");
    if (!(audio instanceof File) && !(audio instanceof Blob)) throw new HttpError(400, "Missing 'audio'");
    if (!expected.trim()) throw new HttpError(400, "Missing 'expected'");

    const key = Deno.env.get("STT_API_KEY") || Deno.env.get("LLM_API_KEY");
    if (!key) throw new HttpError(500, "Server misconfigured: STT_API_KEY / LLM_API_KEY missing");

    const fd = new FormData();
    fd.append("file", audio, "audio.webm");
    fd.append("model", "whisper-1");
    fd.append("language", "en");
    fd.append("response_format", "verbose_json"); // gives per-segment no_speech_prob
    const res = await fetchWithRetry("https://api.openai.com/v1/audio/transcriptions", {
      method: "POST",
      headers: { "Authorization": `Bearer ${key}` },
      body: fd,
    });
    if (!res.ok) { await res.body?.cancel().catch(() => {}); throw new HttpError(502, `STT failed (${res.status})`); }
    const data = await res.json().catch(() => null) as any;
    const transcript = String(data?.text ?? "").trim();
    const segs: any[] = Array.isArray(data?.segments) ? data.segments : [];
    // Whisper HALLUCINATES text on silence — reject it. Treat as "no speech" when
    // there's no transcript or the average no-speech probability is high.
    const avgNoSpeech = segs.length
      ? segs.reduce((a: number, s: any) => a + (s?.no_speech_prob || 0), 0) / segs.length
      : (transcript ? 0 : 1);
    const heard = transcript.length > 0 && avgNoSpeech < 0.6;
    const score = heard ? scoreOf(transcript, expected) : 0;
    const words = heard ? wordFeedback(transcript, expected) : [];
    return json({ score, passed: heard && score >= PASS, transcript: heard ? transcript : "", heard, expected, words });
  } catch (err) {
    if (err instanceof HttpError) return json({ error: err.message }, err.status);
    return json({ error: "Internal error" }, 500);
  }
});

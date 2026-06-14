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
// Best match of the expected text against the whole transcript or any single word.
function scoreOf(transcript: string, expected: string): number {
  const t = norm(transcript), e = norm(expected);
  if (!e) return 0;
  if (t === e || t.includes(e)) return 100;
  let best = similarity(t, e);
  for (const w of t.split(" ")) best = Math.max(best, similarity(w, e));
  return Math.round(Math.max(0, Math.min(1, best)) * 100);
}
// Per-word feedback: for each expected word, did ANY transcript word match it
// closely? Lets the client highlight the actual mispronounced part (word-level).
function wordFeedback(transcript: string, expected: string): { word: string; ok: boolean }[] {
  const tWords = norm(transcript).split(" ").filter(Boolean);
  return norm(expected).split(" ").filter(Boolean).map((ew) => {
    let best = 0;
    for (const tw of tWords) best = Math.max(best, similarity(ew, tw));
    return { word: ew, ok: best >= 0.72 };
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

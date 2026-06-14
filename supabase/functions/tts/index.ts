// Edge Function: tts — real, natural text-to-speech via OpenAI.
// ----------------------------------------------------------------------------
// Replaces the robotic browser speechSynthesis voice. Returns audio/mpeg bytes
// the client plays + caches per phrase (so repeats are free). Key is SERVER-ONLY.
// Auth: verify_jwt + fail-closed. Quota-gated (kind 'tts', generous daily cap)
// so a single JWT can't loop unique strings forever at tts-1 pricing.
//
// Request (POST JSON): { text: string, voice?: "nova"|"alloy"|"shimmer"|... }
// Response: audio/mpeg (mp3 bytes)
// deno-lint-ignore-file no-explicit-any
import { getAuthedUser, getServiceClient, HttpError } from "../_shared/auth.ts";
import { checkAndIncrement } from "../_shared/quota.ts";
import { fetchWithRetry } from "../_shared/http.ts";
import { corsHeadersFor } from "../_shared/cors.ts";

const BUCKET = "tts-cache";
// Stable key so the SAME (text,voice,speed) maps to one cached clip globally —
// the client fetches it straight from the public CDN URL, so playback is instant
// and the OpenAI call happens at most ONCE per phrase ever.
async function clipKey(text: string, voice: string, speed: number): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${text}|${voice}|${speed}`));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

Deno.serve(async (req: Request) => {
  const cors = corsHeadersFor(req);
  const jsonErr = (b: unknown, s: number) =>
    new Response(JSON.stringify(b), { status: s, headers: { ...cors, "Content-Type": "application/json" } });
  const audio = (buf: ArrayBuffer) => new Response(buf, { status: 200, headers: { ...cors, "Content-Type": "audio/mpeg", "Cache-Control": "public, max-age=31536000, immutable" } });

  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return jsonErr({ error: "Method not allowed" }, 405);

  try {
    const { user } = await getAuthedUser(req); // must be a signed-in user
    const body = await req.json().catch(() => null) as any;
    const text = String(body?.text ?? "").slice(0, 800).trim();
    if (!text) throw new HttpError(400, "Missing 'text'");
    // "fable" = British accent. Default to it for a clearer, more human voice.
    const voice = String(body?.voice || "fable");
    // Slower than conversational pace so learners can follow each word.
    let speed = Number(body?.speed);
    if (!Number.isFinite(speed)) speed = 0.9;
    speed = Math.min(4, Math.max(0.25, speed));

    const service = getServiceClient();
    const path = (await clipKey(text, voice, speed)) + ".mp3";
    const store = service.storage.from(BUCKET);

    // 1) CACHE HIT -> return the stored clip (no OpenAI, no quota).
    try {
      const { data: cached } = await store.download(path);
      if (cached) return audio(await cached.arrayBuffer());
    } catch (_) { /* miss -> generate below */ }

    // 2) MISS -> quota-gate (cost/abuse) then generate.
    await checkAndIncrement(service, user.id, "tts");
    const key = Deno.env.get("TTS_API_KEY") || Deno.env.get("LLM_API_KEY");
    if (!key) throw new HttpError(500, "Server misconfigured: TTS/LLM key missing");

    const res = await fetchWithRetry("https://api.openai.com/v1/audio/speech", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      // "tts-1" (standard) generates MUCH faster than "tts-1-hd".
      body: JSON.stringify({ model: "tts-1", input: text, voice, speed, response_format: "mp3" }),
    });
    if (!res.ok) { await res.body?.cancel().catch(() => {}); throw new HttpError(502, `TTS failed (${res.status})`); }
    const buf = await res.arrayBuffer();
    // 3) Store for everyone (best-effort) so the next play is an instant CDN hit.
    try { await store.upload(path, new Uint8Array(buf), { contentType: "audio/mpeg", upsert: true }); } catch (_) {}
    return audio(buf);
  } catch (err) {
    if (err instanceof HttpError) return jsonErr({ error: err.message }, err.status);
    return jsonErr({ error: "Internal error" }, 500);
  }
});

// Edge Function: stt-proxy
// ----------------------------------------------------------------------------
// SWAPPABLE FALLBACK speech-to-text (Whisper).
//
// The PRIMARY STT path is the Azure token mint (the speech-token function):
// the browser Speech SDK uses that short-lived token to do STT client-side,
// which is cheaper and lower-latency. This proxy is the fallback for when the
// Azure SDK path is unavailable (e.g. some Capacitor webviews / network edge
// cases). It forwards audio to OpenAI Whisper server-side so the key never
// reaches the browser, and counts against the per-user `stt` daily quota.
//
// Request: POST audio as multipart/form-data field "audio", OR a raw audio body.
// Response: ONLY { text, confidence: null }  (Whisper doesn't return a numeric
// confidence; the client treats null as "unknown").
//
// Deno runtime — `Deno` globals are provided by the Supabase Edge runtime.
// deno-lint-ignore-file no-explicit-any

import { getAuthedUser, getServiceClient, HttpError } from "../_shared/auth.ts";
import { checkAndIncrement } from "../_shared/quota.ts";
import { fetchWithRetry } from "../_shared/http.ts";
import { corsHeadersFor } from "../_shared/cors.ts";

const WHISPER_URL = "https://api.openai.com/v1/audio/transcriptions";

Deno.serve(async (req: Request) => {
  const corsHeaders = corsHeadersFor(req);

  function json(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  if (req.method !== "POST") {
    return json({ error: "Method not allowed" }, 405);
  }

  try {
    const { user } = await getAuthedUser(req);
    const service = getServiceClient();

    // Quota gate BEFORE any paid work (fail closed at the cap).
    await checkAndIncrement(service, user.id, "stt");

    // STT_API_KEY is preferred; fall back to LLM_API_KEY (same OpenAI account).
    const key = Deno.env.get("STT_API_KEY") ?? Deno.env.get("LLM_API_KEY");
    if (!key) {
      throw new HttpError(500, "Server misconfigured: STT key missing");
    }

    // Accept either multipart/form-data (field "audio") or a raw audio body.
    const audio = await extractAudio(req);

    // Build the Whisper multipart request.
    const form = new FormData();
    form.append("file", audio, "audio.webm");
    form.append("model", "whisper-1");
    form.append("language", "en");

    const res = await fetchWithRetry(WHISPER_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}` },
      body: form,
    });

    if (!res.ok) {
      // Never leak the provider error body verbatim — status only.
      await res.body?.cancel().catch(() => {});
      throw new HttpError(502, `STT request failed (${res.status})`);
    }

    const data = await res.json().catch(() => null) as any;
    const text = typeof data?.text === "string" ? data.text.trim() : "";

    // Whisper provides no numeric confidence; surface null explicitly.
    return json({ text, confidence: null });
  } catch (err) {
    if (err instanceof HttpError) {
      return json({ error: err.message }, err.status);
    }
    return json({ error: "Internal error" }, 500);
  }
});

// ----------------------------------------------------------------------------
// Pull the audio Blob from the request: a multipart "audio" field if present,
// otherwise the raw request body. Fails closed if neither yields bytes.
// ----------------------------------------------------------------------------
async function extractAudio(req: Request): Promise<Blob> {
  const contentType = req.headers.get("content-type") ?? "";

  if (contentType.includes("multipart/form-data")) {
    const form = await req.formData();
    const field = form.get("audio");
    if (field instanceof File || field instanceof Blob) {
      if (field.size > 0) return field;
    }
    throw new HttpError(400, "Missing 'audio' field");
  }

  // Raw body: read as a Blob, tagging the upstream content-type if we have one.
  const buf = await req.arrayBuffer();
  if (!buf || buf.byteLength === 0) {
    throw new HttpError(400, "Empty audio body");
  }
  return new Blob([buf], { type: contentType || "application/octet-stream" });
}

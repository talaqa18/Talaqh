// Edge Function: tts-fallback
// ----------------------------------------------------------------------------
// DYNAMIC-TEXT TTS fallback ONLY.
//
// The PRIMARY audio path is PRE-GENERATED unit audio stored in Supabase Storage
// (CLAUDE.md: pre-generate each unit's fixed words + example sentences — cheaper,
// consistent, installable). This function exists for the rare case of DYNAMIC
// text that has no prebuilt clip (e.g. a one-off tutor line). It is rate-limited
// via the per-user `tts_fallback` daily quota to avoid per-play cost creep.
//
// Provider: Azure Cognitive Services TTS REST (same Speech resource as
// speech-token). We mint a short-lived token from SPEECH_API_KEY the same way
// speech-token does, rather than sending a raw subscription key on every call.
// (If TTS_API_KEY / a dedicated resource is configured, it is used as the
// Ocp-Apim-Subscription-Key directly instead.) Region from SPEECH_REGION.
//
// Request:  { text, voice? }
// Response: audio/mpeg bytes (MP3) with CORS headers.
//
// Deno runtime — `Deno` globals are provided by the Supabase Edge runtime.
// deno-lint-ignore-file no-explicit-any

import { getAuthedUser, getServiceClient, HttpError } from "../_shared/auth.ts";
import { checkAndIncrement } from "../_shared/quota.ts";
import { fetchWithRetry } from "../_shared/http.ts";
import { corsHeadersFor } from "../_shared/cors.ts";

// Default English neural voice; the example sentences are LTR English content.
const DEFAULT_VOICE = "en-US-JennyNeural";
// MP3 keeps payloads small and is broadly playable in PWA + Capacitor webviews.
const OUTPUT_FORMAT = "audio-16khz-128kbitrate-mono-mp3";

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

    // Quota gate BEFORE any paid work (reserve the fallback; fail closed at cap).
    await checkAndIncrement(service, user.id, "tts_fallback");

    const body = await req.json().catch(() => null) as any;
    const text: string = typeof body?.text === "string" ? body.text.trim() : "";
    if (!text) throw new HttpError(400, "Missing 'text'");
    if (text.length > 1000) {
      // Guard against abuse / runaway synthesis cost on the fallback path.
      throw new HttpError(400, "Text too long for TTS fallback");
    }
    const voice: string = typeof body?.voice === "string" && body.voice.trim()
      ? body.voice.trim()
      : DEFAULT_VOICE;

    const region = Deno.env.get("SPEECH_REGION");
    if (!region) {
      throw new HttpError(500, "Server misconfigured: SPEECH_REGION missing");
    }

    // Auth header for the TTS endpoint: prefer a Bearer token minted from the
    // Speech key; if only a dedicated TTS subscription key is set, use it raw.
    const authHeaders = await ttsAuthHeaders(region);

    const ssml = buildSsml(voice, text);
    const ttsUrl =
      `https://${region}.tts.speech.microsoft.com/cognitiveservices/v1`;

    const res = await fetchWithRetry(ttsUrl, {
      method: "POST",
      headers: {
        ...authHeaders,
        "Content-Type": "application/ssml+xml",
        "X-Microsoft-OutputFormat": OUTPUT_FORMAT,
        "User-Agent": "arabic-english-pwa",
      },
      body: ssml,
    });

    if (!res.ok) {
      // Never leak the provider error body verbatim — status only.
      await res.body?.cancel().catch(() => {});
      throw new HttpError(502, `TTS request failed (${res.status})`);
    }

    // Stream the audio bytes straight back with the correct content type.
    const audio = await res.arrayBuffer();
    return new Response(audio, {
      status: 200,
      headers: {
        ...corsHeaders,
        "Content-Type": "audio/mpeg",
        "Cache-Control": "no-store",
      },
    });
  } catch (err) {
    if (err instanceof HttpError) {
      return json({ error: err.message }, err.status);
    }
    return json({ error: "Internal error" }, 500);
  }
});

// ----------------------------------------------------------------------------
// Build the auth headers for the Azure TTS endpoint.
//   * If TTS_API_KEY is set (dedicated TTS resource), send it as the
//     Ocp-Apim-Subscription-Key directly.
//   * Otherwise mint a short-lived Bearer token from SPEECH_API_KEY (the same
//     resource speech-token uses) so no raw key is held per request.
// Fails closed if neither key is configured.
// ----------------------------------------------------------------------------
async function ttsAuthHeaders(region: string): Promise<Record<string, string>> {
  const ttsKey = Deno.env.get("TTS_API_KEY");
  if (ttsKey) {
    return { "Ocp-Apim-Subscription-Key": ttsKey };
  }

  const speechKey = Deno.env.get("SPEECH_API_KEY");
  if (!speechKey) {
    throw new HttpError(
      500,
      "Server misconfigured: TTS_API_KEY / SPEECH_API_KEY missing",
    );
  }

  // Exchange the subscription key for a short-lived authorization token, just
  // like the speech-token function does.
  const issueTokenUrl =
    `https://${region}.api.cognitive.microsoft.com/sts/v1.0/issueToken`;
  const res = await fetchWithRetry(issueTokenUrl, {
    method: "POST",
    headers: { "Ocp-Apim-Subscription-Key": speechKey },
  });
  if (!res.ok) {
    await res.body?.cancel().catch(() => {});
    throw new HttpError(502, `Azure issueToken failed (${res.status})`);
  }
  const token = await res.text();
  return { Authorization: `Bearer ${token}` };
}

// ----------------------------------------------------------------------------
// Minimal SSML. The text is English (LTR) example/dynamic content; we XML-escape
// it to keep the SSML well-formed regardless of input.
// ----------------------------------------------------------------------------
function buildSsml(voice: string, text: string): string {
  const escaped = text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
  return `<speak version="1.0" xml:lang="en-US">` +
    `<voice name="${voice}">${escaped}</voice>` +
    `</speak>`;
}

// Edge Function: speech-token
// ----------------------------------------------------------------------------
// Mints a SHORT-LIVED Azure AI Speech authorization token so the raw Azure
// subscription key NEVER reaches the browser.
//
// The browser Speech SDK then uses the returned token + region with
// `SpeechConfig.fromAuthorizationToken(token, region)` for both pronunciation
// assessment and speech-to-text. Tokens are valid for ~10 minutes; the client
// re-requests one when it nears expiry (see src/lib/ai/speechToken.ts).
//
// Secrets live server-side only (CLAUDE.md: "keep secret keys server-side"):
//   supabase secrets set SPEECH_API_KEY=xxxx SPEECH_REGION=eastus
//
// Runs with verify_jwt = true (default), so only authenticated app users can
// obtain a token. We additionally resolve the caller to fail closed.
//
// Deno runtime — `Deno` globals are provided by the Supabase Edge runtime.
// deno-lint-ignore-file no-explicit-any

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { corsHeadersFor } from "../_shared/cors.ts";
import { getServiceClient, HttpError } from "../_shared/auth.ts";
import { checkAndIncrement } from "../_shared/quota.ts";

// Azure tokens are valid for 10 minutes. Surface the lifetime so the client can
// schedule a refresh before expiry.
const AZURE_TOKEN_TTL_SECONDS = 9 * 60; // refresh a minute early, conservatively

Deno.serve(async (req: Request) => {
  const corsHeaders = corsHeadersFor(req);

  function json(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  // CORS preflight.
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return json({ error: "Method not allowed" }, 405);
  }

  // --- Authn: confirm the caller is a signed-in app user (fail closed) -------
  const authHeader = req.headers.get("Authorization");
  if (!authHeader) {
    return json({ error: "Missing Authorization header" }, 401);
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
  if (!supabaseUrl || !anonKey) {
    return json({ error: "Server misconfigured: Supabase env missing" }, 500);
  }

  const supabase = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: authHeader } },
  });
  const { data: { user }, error: userError } = await supabase.auth.getUser();
  if (userError || !user) {
    return json({ error: "Unauthorized" }, 401);
  }

  // Per-user daily quota — each minted token unlocks ~10 min of billable Azure
  // STT/pronunciation, so cap minting to stop loop abuse (cap already exists).
  try {
    await checkAndIncrement(getServiceClient(), user.id, "speech_token_mint");
  } catch (e) {
    const status = e instanceof HttpError ? e.status : 429;
    return json({ error: e instanceof Error ? e.message : "Daily limit reached" }, status);
  }

  // --- Read SERVER-ONLY Azure secrets ----------------------------------------
  const speechKey = Deno.env.get("SPEECH_API_KEY");
  const region = Deno.env.get("SPEECH_REGION");
  if (!speechKey || !region) {
    return json(
      { error: "Server misconfigured: SPEECH_API_KEY / SPEECH_REGION missing" },
      500,
    );
  }

  // --- Exchange the secret key for a short-lived token (issueToken) -----------
  // https://learn.microsoft.com/azure/ai-services/speech-service/rest-speech-to-text-short#authentication
  const issueTokenUrl =
    `https://${region}.api.cognitive.microsoft.com/sts/v1.0/issueToken`;

  let azureRes: Response;
  try {
    azureRes = await fetch(issueTokenUrl, {
      method: "POST",
      headers: {
        "Ocp-Apim-Subscription-Key": speechKey,
      },
      // Empty body; the runtime sets Content-Length: 0 automatically.
    });
  } catch (_e) {
    return json({ error: "Failed to reach Azure token endpoint" }, 502);
  }

  if (!azureRes.ok) {
    // Do NOT leak the Azure response body verbatim; just the status.
    return json(
      { error: `Azure issueToken failed (${azureRes.status})` },
      502,
    );
  }

  const token = await azureRes.text();

  // The browser never sees the subscription key — only this short-lived token.
  return json({
    token,
    region,
    expiresInSeconds: AZURE_TOKEN_TTL_SECONDS,
  });
});

// Client-side Azure Speech token provider.
// ----------------------------------------------------------------------------
// The browser NEVER holds the Azure subscription key. Instead it calls the
// `speech-token` Supabase Edge Function, which mints a short-lived Azure auth
// token server-side (see supabase/functions/speech-token/index.ts).
//
// Use the result with the Azure Speech SDK in pronunciation/STT screens:
//
//   import * as sdk from "microsoft-cognitiveservices-speech-sdk";
//   const { authorizationToken, region } = await getSpeechToken();
//   const speechConfig = sdk.SpeechConfig.fromAuthorizationToken(
//     authorizationToken,
//     region,
//   );
//
// Tokens last ~10 minutes; we cache and refresh shortly before expiry so a
// single recording session doesn't make redundant network round-trips.

import { supabase } from "../supabase/client";

export interface SpeechAuth {
  authorizationToken: string;
  region: string;
}

interface CachedToken extends SpeechAuth {
  /** epoch ms after which we should fetch a fresh token */
  refreshAt: number;
}

// Refresh this many ms before the server-reported expiry to avoid using a token
// that lapses mid-request.
const REFRESH_SKEW_MS = 60_000;

let cached: CachedToken | null = null;
let inFlight: Promise<SpeechAuth> | null = null;

/**
 * Returns a valid Azure Speech authorization token + region for the SDK.
 * Caches across calls and de-dupes concurrent requests.
 */
export async function getSpeechToken(
  { forceRefresh = false }: { forceRefresh?: boolean } = {},
): Promise<SpeechAuth> {
  if (!forceRefresh && cached && Date.now() < cached.refreshAt) {
    return { authorizationToken: cached.authorizationToken, region: cached.region };
  }

  // Coalesce concurrent callers (e.g. SDK + warm-up) onto one request.
  if (!inFlight) {
    inFlight = fetchToken().finally(() => {
      inFlight = null;
    });
  }
  return inFlight;
}

async function fetchToken(): Promise<SpeechAuth> {
  // `invoke` automatically attaches the user's Supabase JWT as the
  // Authorization header, which the Edge Function verifies before issuing.
  const { data, error } = await supabase.functions.invoke<{
    token: string;
    region: string;
    expiresInSeconds: number;
  }>("speech-token", { method: "POST" });

  if (error || !data?.token || !data?.region) {
    throw new Error(`Could not obtain speech token: ${error?.message ?? "empty response"}`);
  }

  cached = {
    authorizationToken: data.token,
    region: data.region,
    refreshAt: Date.now() + data.expiresInSeconds * 1000 - REFRESH_SKEW_MS,
  };

  return { authorizationToken: data.token, region: data.region };
}

/** Clears the cached token (e.g. on sign-out). */
export function clearSpeechToken(): void {
  cached = null;
}

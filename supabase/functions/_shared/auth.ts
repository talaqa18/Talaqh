// Shared auth helpers for Edge Functions.
// ----------------------------------------------------------------------------
// Two clients, two purposes:
//
//   getAuthedUser(req)  -> resolves the CALLER from their Supabase JWT, FAIL
//                          CLOSED. Uses the anon key + the request's
//                          Authorization header so RLS / auth.getUser apply.
//                          Every AI function calls this first (integrity rule 7:
//                          "every function verify_jwt + fail-closed user
//                          resolve").
//
//   getServiceClient()  -> a SERVICE-ROLE client used to call the SECURITY
//                          DEFINER RPCs that perform trusted writes (ai_usage,
//                          conversation_sessions / _messages). The service role
//                          bypasses RLS, but the trusted-column guard triggers
//                          still require app.trusted='on', which only the
//                          DEFINER RPCs set — so we go through RPCs, never raw
//                          table writes, and the trust boundary stays intact.
//
// Secrets stay server-side only (Deno.env). SUPABASE_URL / SUPABASE_ANON_KEY /
// SUPABASE_SERVICE_ROLE_KEY are injected into the function runtime by the
// platform — no need to set them as secrets.
// deno-lint-ignore-file no-explicit-any

import {
  createClient,
  type SupabaseClient,
  type User,
} from "https://esm.sh/@supabase/supabase-js@2";

export interface AuthedUser {
  user: User;
  /** The raw Authorization header value, for downstream forwarding if needed. */
  authHeader: string;
  /** A Supabase client scoped to the caller (anon key + their JWT). */
  client: SupabaseClient;
}

/** Thrown to short-circuit a request with a specific HTTP status. */
export class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
    this.name = "HttpError";
  }
}

function requireEnv(name: string): string {
  const v = Deno.env.get(name);
  if (!v) {
    // Misconfiguration is a 500, surfaced without leaking which key is missing
    // to the client (the message is logged server-side only by the caller).
    throw new HttpError(500, `Server misconfigured: ${name} missing`);
  }
  return v;
}

/**
 * Resolve the signed-in app user from the request's Authorization header.
 * FAIL CLOSED: throws HttpError(401) on any missing/invalid token. Even though
 * functions run with verify_jwt=true, we re-resolve the user so a function can
 * never operate without a concrete user id.
 */
export async function getAuthedUser(req: Request): Promise<AuthedUser> {
  const authHeader = req.headers.get("Authorization");
  if (!authHeader) {
    throw new HttpError(401, "Missing Authorization header");
  }

  const supabaseUrl = requireEnv("SUPABASE_URL");
  const anonKey = requireEnv("SUPABASE_ANON_KEY");

  const client = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { data, error } = await client.auth.getUser();
  if (error || !data?.user) {
    throw new HttpError(401, "Unauthorized");
  }

  return { user: data.user, authHeader, client };
}

/**
 * A service-role client. Used ONLY to invoke SECURITY DEFINER RPCs that perform
 * trusted writes. Never expose the service role key to the browser.
 */
export function getServiceClient(): SupabaseClient {
  const supabaseUrl = requireEnv("SUPABASE_URL");
  const serviceKey = requireEnv("SUPABASE_SERVICE_ROLE_KEY");
  return createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

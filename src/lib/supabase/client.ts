// Supabase browser client.
// ----------------------------------------------------------------------------
// Reads ONLY publishable values from the Vite env (CLAUDE.md: "never hardcode
// keys"). The URL and anon key are designed to be public and are protected by
// Row Level Security — they are the only env values allowed a VITE_ prefix.
//
// Secret keys (Azure Speech, LLM, TTS) are NEVER read here. They live server-
// side in Supabase Edge Functions and are reached through `supabase.functions
// .invoke(...)`.

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "./types";

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

if (!supabaseUrl || !supabaseAnonKey) {
  throw new Error(
    "Missing VITE_SUPABASE_URL or VITE_SUPABASE_ANON_KEY. Copy .env.example to .env and fill them in.",
  );
}

// Fully typed against the hand-written Database schema (./types.ts), so every
// `.from(...)`, `.select(...)`, and `.rpc(...)` is checked at compile time.
//
// Auth options (DECISIONS.md: email/password, PKCE, Capacitor-safe):
//   * persistSession      — keep the user signed in across reloads / app restarts.
//   * autoRefreshToken     — silently refresh the JWT before it expires.
//   * detectSessionInUrl   — complete the PKCE redirect (email confirm / reset).
//   * flowType: "pkce"     — PKCE is mandatory for native (Capacitor) shells and
//                            is the safer browser default.
export const supabase: SupabaseClient<Database> = createClient<Database>(
  supabaseUrl,
  supabaseAnonKey,
  {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: true,
      flowType: "pkce",
    },
  },
);

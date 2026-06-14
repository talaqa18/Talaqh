// Thin auth wrappers around supabase.auth.
// ----------------------------------------------------------------------------
// These are intentionally minimal pass-throughs so screens never touch the raw
// client. Email/password + PKCE only (see client.ts / DECISIONS.md). The
// display name is passed in `options.data.display_name` at sign-up so the
// `handle_new_user` DB trigger can seed profiles.display_name from the JWT
// metadata — we never write the profiles row from the client.

import type {
  AuthChangeEvent,
  Session,
  Subscription,
} from "@supabase/supabase-js";
import { supabase } from "./client";

/**
 * Create a new account with email + password.
 * `displayName`, if provided, is stored in user metadata as `display_name` so
 * the `handle_new_user` trigger can populate the profile.
 */
export function signUpWithEmail(
  email: string,
  password: string,
  displayName?: string,
) {
  return supabase.auth.signUp({
    email,
    password,
    options: displayName
      ? { data: { display_name: displayName } }
      : undefined,
  });
}

/** Sign in with email + password. */
export function signInWithEmail(email: string, password: string) {
  return supabase.auth.signInWithPassword({ email, password });
}

/** Sign the current user out (clears the persisted session). */
export function signOut() {
  return supabase.auth.signOut();
}

/** Read the current session (null when signed out). */
export function getSession() {
  return supabase.auth.getSession();
}

/**
 * Subscribe to auth state changes (SIGNED_IN / SIGNED_OUT / TOKEN_REFRESHED …).
 * Returns the underlying `Subscription` — call `.unsubscribe()` to stop.
 */
export function onAuthChange(
  cb: (event: AuthChangeEvent, session: Session | null) => void,
): Subscription {
  const {
    data: { subscription },
  } = supabase.auth.onAuthStateChange(cb);
  return subscription;
}

// Auth store (Zustand).
// ----------------------------------------------------------------------------
// Holds the live Supabase session plus the caller's profile + settings rows,
// and keeps them in sync with auth events. Screens read `session` to gate
// routes and `profile` to decide onboarding / placement / foundations flow via
// the derived selector helpers exported at the bottom.
//
// We never WRITE trusted profile columns here — those are owned by the DEFINER
// RPCs. This store only READS the profile/settings for the signed-in user.

import { create } from "zustand";
import type { Session } from "@supabase/supabase-js";
import { supabase } from "../lib/supabase/client";
import { onAuthChange } from "../lib/supabase/auth";
import type {
  ProfileRow,
  UserSettingsRow,
} from "../lib/supabase/types";

interface AuthState {
  session: Session | null;
  profile: ProfileRow | null;
  settings: UserSettingsRow | null;
  loading: boolean;

  /** Bootstrap: read the session, load profile+settings, subscribe to changes. */
  init: () => Promise<void>;
  /** Re-fetch the profile + settings for the current user. */
  refreshProfile: () => Promise<void>;
  /** Sign out and clear local state. */
  signOut: () => Promise<void>;
}

/** Internal: load profile + settings for a user id, writing them into the store. */
async function loadUserRows(
  userId: string,
  set: (partial: Partial<AuthState>) => void,
): Promise<void> {
  const [profileRes, settingsRes] = await Promise.all([
    supabase.from("profiles").select("*").eq("id", userId).maybeSingle(),
    supabase
      .from("user_settings")
      .select("*")
      .eq("user_id", userId)
      .maybeSingle(),
  ]);

  set({
    profile: profileRes.data ?? null,
    settings: settingsRes.data ?? null,
  });
}

// Guard so we only attach the auth listener once across HMR / re-init.
let authSubscribed = false;

export const useAuthStore = create<AuthState>((set, get) => ({
  session: null,
  profile: null,
  settings: null,
  loading: true,

  init: async () => {
    set({ loading: true });

    const {
      data: { session },
    } = await supabase.auth.getSession();

    set({ session });

    if (session?.user) {
      await loadUserRows(session.user.id, set);
    } else {
      set({ profile: null, settings: null });
    }

    set({ loading: false });

    if (!authSubscribed) {
      authSubscribed = true;
      onAuthChange((event, nextSession) => {
        switch (event) {
          case "SIGNED_IN":
          case "TOKEN_REFRESHED": {
            set({ session: nextSession });
            if (nextSession?.user) {
              void loadUserRows(nextSession.user.id, set);
            }
            break;
          }
          case "SIGNED_OUT": {
            set({ session: null, profile: null, settings: null });
            break;
          }
          default:
            // USER_UPDATED, PASSWORD_RECOVERY, etc. — keep the session fresh.
            set({ session: nextSession });
        }
      });
    }
  },

  refreshProfile: async () => {
    const userId = get().session?.user.id;
    if (!userId) {
      set({ profile: null, settings: null });
      return;
    }
    await loadUserRows(userId, set);
  },

  signOut: async () => {
    await supabase.auth.signOut();
    set({ session: null, profile: null, settings: null });
  },
}));

// ============================================================================
// Derived selector helpers — plain functions over a ProfileRow so they can be
// used anywhere (in selectors, route guards, or tests) without the store.
// ============================================================================

/** True until the user finishes onboarding (name / age / goal). */
export function needsOnboarding(p: ProfileRow | null): boolean {
  return !p?.onboarding_completed;
}

/** True when onboarding is done but the placement test has not been taken. */
export function needsPlacement(p: ProfileRow | null): boolean {
  return !!p && p.onboarding_completed && !p.placement_completed;
}

/**
 * True for a complete beginner who has finished placement but not the
 * Foundations track (phonics + simple words).
 */
export function needsFoundations(p: ProfileRow | null): boolean {
  return (
    !!p &&
    p.placement_completed &&
    p.current_level === "beginner" &&
    !p.foundations_completed
  );
}

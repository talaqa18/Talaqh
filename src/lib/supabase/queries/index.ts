// Typed client data layer — barrel.
// ----------------------------------------------------------------------------
// Single import surface for every read query + progress-mutating RPC wrapper.
// Screens import from here (e.g. `import { getJourney, gradeQuiz } from
// "@/lib/supabase/queries"`); they never touch the raw supabase client for
// trusted writes — those go exclusively through progress.ts.

export * from "./_level";
export * from "./journey";
export * from "./word-teaching";
export * from "./listening";
export * from "./reading";
export * from "./grammar";
export * from "./placement";
export * from "./home";
export * from "./leaderboard";
export * from "./progress";

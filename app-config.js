// ============================================================================
//  Talaqa runtime config — CONNECTED to Supabase.
//  All values here are PUBLISHABLE (anon key is RLS-protected; RevenueCat
//  public SDK keys are designed to ship in the client). To go back to the
//  offline demo, blank these out.
// ============================================================================
window.__TALAQA_CONFIG__ = {
  supabaseUrl: "https://ogoswbedcbgymtaxktlf.supabase.co",
  supabaseAnonKey: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im9nb3N3YmVkY2JneW10YXhrdGxmIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODA4MDY0MjUsImV4cCI6MjA5NjM4MjQyNX0.HzppveZ_6pLVfTKytHMtzKyX-cVljyJQ0BvM-I2rDdk",

  // RevenueCat — public SDK key for the Talaqh (App Store) app. Safe to ship
  // in the client (publishable). The "appl_" prefix means the App Store Connect
  // IAP key (.p8) has been uploaded and RevenueCat can talk to Apple directly.
  revenueCatPublicKey: "appl_wrKDrUQjwZXvhENPAYfWQAuiQTD",
  // Entitlement identifier configured in the RevenueCat dashboard.
  entitlementId: "talaqh_pro",
};

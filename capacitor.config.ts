import type { CapacitorConfig } from "@capacitor/cli";

// Phase 2: wrap the PWA as native iOS/Android for the app stores.
// IMPORTANT: this app has NO build step. NEVER run `npm run build` (tsc+vite would
// mangle the single-file index.html). Refresh the bundled web assets with
// `npm run dist:copy`, then `npm run ios:add` / `npm run ios:sync` (these chain it).
const config: CapacitorConfig = {
  appId: "com.talaqh.app", // reverse-DNS of talaqh.com — change before store submission if needed
  appName: "طلاقة",
  webDir: "dist",
  // The app ships its web shell bundled inside the binary (offline-capable, store-
  // compliant). Network calls (Supabase auth/AI/storage) still go out normally;
  // CORS already allows capacitor://localhost + https://localhost (functions/_shared/cors.ts).
  android: { allowMixedContent: false },
  ios: {
    // The web shell already reserves the device safe areas itself via CSS
    // `env(safe-area-inset-*)` (status-bar spacer at the top, bottom nav/footer
    // padding) together with the `viewport-fit=cover` meta. So the WKWebView must
    // NOT add its own safe-area content inset on top — that double-pads the notch
    // and the home-indicator. "never" leaves the insets entirely to CSS.
    contentInset: "never",
    // Keep false so the WKWebView can reach external API origins (Supabase/Azure/fonts).
    // Setting this true would restrict navigation to app-bound domains and break login/AI.
    limitsNavigationsToAppBoundDomains: false,
  },
  plugins: {
    // Branded launch screen; we hide it manually from boot() once the first frame paints
    // (launchAutoHide:false) so there is no white flash before the Arabic UI renders.
    SplashScreen: {
      launchAutoHide: false,
      backgroundColor: "#eef1ff",
      showSpinner: false,
    },
  },
};

export default config;

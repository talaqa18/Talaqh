import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";

// PWA-first config. Service worker makes the app shell installable.
// NOTE: full offline CONTENT sync is out of scope for this version.
export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: "autoUpdate",
      manifest: false, // using public/manifest.webmanifest
      workbox: {
        // Precache the built app shell. Without an explicit glob, workbox-build
        // aborts with "Couldn't find configuration for precaching or runtime
        // caching" (the generated SW would have nothing to cache).
        globPatterns: ["**/*.{js,css,html,svg,png,ico,woff2,webmanifest}"],
      },
    }),
  ],
});

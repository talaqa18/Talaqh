/** @type {import('tailwindcss').Config} */
// Design tokens live in src/styles/tokens.css and are surfaced here as theme colors.
// RTL is handled at the document level (dir="rtl"); use logical utilities (ms-/me-/ps-/pe-).
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        brand: "var(--color-brand)",      // emerald/teal primary
        gold: "var(--color-gold)",        // points / streak / rewards
        surface: "var(--color-surface)",  // warm-gray background
      },
      fontFamily: {
        ar: ["Cairo", "Tajawal", "sans-serif"], // Arabic UI
        en: ["Inter", "sans-serif"],            // English content
      },
    },
  },
  plugins: [],
};

# Seed content

Authored learning content loaded with the **service-role key** (bypasses RLS and
the column guards — content is authored data, not user data). Each unit seeds its
**exactly 5 words** plus listening/reading/grammar/conversation content that
reuses only those words.

- `npm run seed:validate` — checks every unit has exactly 5 words and references
  no foreign word, before loading.
- `npm run seed` — loads the content (`load.mjs`).

Audio is generated separately by `npm run audio:generate`
(`../scripts/generate-audio.mjs`). Full workflow + deploy steps in
[`../README.md`](../README.md).

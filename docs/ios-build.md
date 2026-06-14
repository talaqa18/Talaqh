# Shipping طلاقة to the iOS App Store (from Windows)

This is the end-to-end runbook for wrapping the web app as a native iOS app with
Capacitor and submitting it to the App Store. You're on **Windows**, so the build is
split into **(A) everything already done / doable here** and **(B) the macOS-only
steps** (compile, sign, upload) — with a no-Mac cloud option.

> **The one hard rule:** this app has **no build step**. `npm run build` (tsc + vite)
> would mangle the single-file `index.html`. Capacitor bundles whatever is in `dist/`,
> so **always run `npm run dist:copy` (never `npm run build`) before any `cap copy/sync`.**
> The `ios:copy` / `ios:sync` / `ios:add` scripts already chain `dist:copy` for you.

---

## 0. What's already configured (done on Windows)

- ✅ `@capacitor/ios` + plugins installed: `app`, `splash-screen`, `status-bar`, `local-notifications`, and `@capacitor/assets` (dev).
- ✅ `capacitor.config.ts` — appId `com.talaqh.app`, name `طلاقة`, `webDir: "dist"`, iOS WKWebView posture, splash config. **No `server.url`** (the shell ships inside the binary = offline-capable + App-Store-compliant).
- ✅ **Mic codec fix** — recorder now prefers `audio/mp4` (AAC) on iOS instead of mislabelling as `webm`, so pronunciation + voice chat work on iPhone.
- ✅ **Native daily reminder** — uses `@capacitor/local-notifications` on the app (Web Push is dead in iOS WKWebView); the web build still uses Web Push.
- ✅ **Native deep-link capture** — `?ref=` is read from `appUrlOpen` so referrals attribute on native (needs Universal Links, see §6).
- ✅ **Native share links** — `appBaseUrl()` always returns `https://talaqh.com` on native (never `capacitor://localhost`).
- ✅ **Service worker skipped on native** + any leftover SW unregistered.
- ✅ **Splash auto-hide + status-bar styling** wired in `boot()`.
- ✅ **No-build plugin bridge** — because this app has no bundler, the Capacitor plugin
  JS is never imported, so `window.Capacitor.Plugins.*` is **never populated** in the
  native shell. We call the native plugins through the low-level bridge the runtime
  *does* inject (`Capacitor.nativePromise` / `Capacitor.addListener`) via the
  `capInvoke()` / `capAddListener()` helpers in `index.html`. **Do not** rewrite these
  back to `Capacitor.Plugins.X` — that path is dead here (splash, status bar, local
  notifications, and `appUrlOpen` deep links all depend on the helpers).
- ✅ **No double safe-area inset** — `ios.contentInset: "never"` in `capacitor.config.ts`,
  because the web shell already pads the notch / home-indicator with CSS
  `env(safe-area-inset-*)`. "always"/"automatic" would double-pad.
- ✅ **Icon + splash source art** generated into `assets/` (placeholder — swap with final brand art, then `npm run assets:gen`).
- ✅ Pinch-zoom re-enabled (accessibility), `esm.sh` remote fallback disabled on native (App-Review safe).

## 1. Apple prerequisites (do these once — needed for ANY path)

1. **Apple Developer Program** — enroll at <https://developer.apple.com/programs/> (**~$99 USD/year**). Required to ship to the store.
2. **Register the App ID** — Developer portal → Identifiers → `com.talaqh.app`. Enable **Associated Domains** (for referral deep links). You do **not** need the Push capability (we use *local* notifications, not APNs).
3. **App Store Connect record** — <https://appstoreconnect.apple.com> → create the app, bundle id `com.talaqh.app`, Arabic primary language.
4. **Privacy** — you must provide a **privacy policy URL** and fill the **privacy nutrition label**: the app records the user's **voice/audio** and sends it to the server for speech-to-text + pronunciation scoring. Declare *Audio Data* (or *User Content*) used for *App Functionality*.

---

## 2. Path A — Cloud build, NO Mac (recommended for Windows)

A cloud macOS machine runs the Xcode steps for you. **Codemagic** is the best fit for
Capacitor (free tier ≈ **500 macOS build-minutes/month**; automatic code signing).
> Avoid Ionic Appflow (being wound down). Expo EAS does **not** support Capacitor.
> Alternatives that also work: GitHub Actions `macos-latest` runners, Bitrise.

**Steps**

1. Finish §1 (Apple Developer + App Store Connect record).
2. On Windows, generate the native project so it's in git (see §4 — `cap add ios` needs
   macOS for the CocoaPods step, so on Codemagic let the build run `cap add ios` itself,
   **or** commit a `ci_post_clone` that runs it). Simplest: commit everything except
   `ios/` and let Codemagic's Capacitor workflow scaffold + build.
3. Push the repo to GitHub/GitLab/Bitbucket.
4. In Codemagic: **Add application → pick the repo → Capacitor workflow (iOS)**.
5. Connect Apple: create an **App Store Connect API key** (App Store Connect → Users
   and Access → Integrations → API keys), add it to Codemagic, enable **automatic code
   signing** for `com.talaqh.app`.
6. Add the build steps: `npm ci` → `npm run dist:copy` → `npx cap sync ios` →
   `npx @capacitor/assets generate --ios` → build & sign → **publish to App Store
   Connect (TestFlight)**.
7. Submit for review from App Store Connect.

**Pros:** no Mac, built for Capacitor, free tier. **Cons:** free minutes can be tight;
debugging native crashes is harder without a local Xcode.

## 2b. Path B — Use a Mac (rent or buy)

- **Rent:** MacinCloud (~$1/hr or ~$20/mo managed) or AWS EC2 Mac (note: 24-hour
  minimum billing). RDP/VNC in, install Xcode, run §4–§5.
- **Buy:** a used Mac mini (~$450–600) is the best long-term option — real local Xcode
  for debugging and instant rebuilds.

Either way you still need the §1 Apple Developer account ($99/yr).

---

## 3. Swap in final brand art (optional, anytime)

`assets/icon-only.png` (1024², opaque), `assets/splash.png` + `assets/splash-dark.png`
(2732²) are on-brand **placeholders** (indigo speech-bubble + gold fluency wave). To
use your own art, replace those files (icon must be **square, opaque, no rounded
corners** — Apple rounds it) and regenerate later with `npm run ios:assets`. To
re-render the placeholders: `npm run assets:gen`.

## 4. Generate the native iOS project (macOS / cloud)

```bash
npm ci
npm run dist:copy            # refresh dist/ from root (NEVER npm run build)
npx cap add ios              # scaffolds ios/ (needs macOS + Xcode + CocoaPods)
npx cap sync ios             # copies dist/ in + installs the 5 plugins' pods
npx @capacitor/assets generate --ios   # AppIcon set + LaunchScreen + 1024 marketing icon
```

After any web edit, re-bundle with: `npm run ios:sync` (or `npm run ios:copy`).

## 5. Xcode: permissions, signing, archive (macOS / cloud)

1. `npx cap open ios` → set the **Signing Team** (Xcode → Signing & Capabilities).
2. Add the **Associated Domains** capability → `applinks:talaqh.com` (for §6).
3. Edit **`ios/App/App/Info.plist`** — add the microphone purpose string (REQUIRED —
   the app is rejected / mic silently fails without it):

   ```xml
   <key>NSMicrophoneUsageDescription</key>
   <string>نحتاج الميكروفون لتسجيل نطقك وتقييمه وللمحادثة الصوتية مع المعلّم.</string>
   <!-- Skips the export-compliance prompt: the app uses only standard HTTPS. -->
   <key>ITSAppUsesNonExemptEncryption</key>
   <false/>
   ```

   > Do **NOT** add `NSSpeechRecognitionUsageDescription` (speech-to-text is server-side,
   > not Apple's on-device recognizer) and do **NOT** add `NSAllowsArbitraryLoads`
   > (every endpoint is HTTPS — App Transport Security passes as-is).
4. Confirm **portrait-only** orientation (matches the PWA) and `CFBundleDisplayName` = `طلاقة`.
   (The Codemagic path in §2 injects the portrait lock into `Info.plist` automatically;
   on a manual Mac build, set it in Xcode → General → Deployment Info → Portrait only.)
5. **Product → Archive → Distribute App → App Store Connect.** Then submit for review.

## 6. Referral deep links (Universal Links) — optional but recommended

So a tapped `https://talaqh.com/?ref=CODE` opens the installed app (not Safari), and the
"5 friends finish unit 1 = 1 free month" attribution works on native:

1. Host **`https://talaqh.com/.well-known/apple-app-site-association`** (served as
   `application/json`, **no** `.json` extension, HTTP 200) on Netlify:

   ```json
   { "applinks": { "apps": [], "details": [
     { "appID": "TEAMID.com.talaqh.app", "paths": ["/", "/?ref=*"] }
   ] } }
   ```
   Replace `TEAMID` with your Apple **Team ID**.
2. Add the **Associated Domains** entitlement `applinks:talaqh.com` (done in §5.2).

The app already captures `?ref=` from `appUrlOpen` (see `boot()`); until Universal Links
are live, the share link still works — it just opens the website instead of the app.

## 7. Backend notes (no code changes needed)

- Edge Function CORS already allows `capacitor://localhost` (`functions/_shared/cors.ts`).
- Auth is phone-OTP + localStorage session — works in WKWebView, no cookie/redirect traps.
- The Supabase anon key shipped in the binary is publishable (RLS-protected) — expected.
- Twilio SMS / TTS quota issues are **operational** (Twilio/Supabase dashboards), not code.

## 8. Quick command reference

| Task | Command | Where |
|---|---|---|
| Refresh `dist/` from root | `npm run dist:copy` | Windows/mac |
| Regenerate placeholder art | `npm run assets:gen` | Windows/mac |
| Add iOS project | `npm run ios:add` | macOS |
| Re-bundle web edits → app | `npm run ios:sync` | macOS |
| Generate icons/splash | `npm run ios:assets` | macOS (after `ios:add`) |
| Open in Xcode | `npm run ios:open` | macOS |

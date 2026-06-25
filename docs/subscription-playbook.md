# Talaqh Subscription Playbook

iOS paid subscriptions via Apple IAP + RevenueCat + Supabase. Source of truth
for the model, the schema, and the rollout order. Web stays free until further
notice.

---

## Product model

| Setting | Value |
|---|---|
| Prices | **29 SAR / week**, **49 SAR / month**, **399 SAR / year** |
| Free trial | **3 days** (Apple Introductory Offer, same on all 3 products) |
| Free tier | **1 section per day** (any one of Words / Listening / Reading / Conversation / Grammar) |
| Paid tier | **Unlimited** sections + higher AI quotas |
| Reviewer access | **Apple sandbox IAP** — no comp account needed |
| Web (talaqh.com) | **Stays free** until told otherwise — no Stripe, no web billing |
| Apple commission | **15%** (Small Business Program approved) |

**What happens at the 2nd section that day (free user):** paywall. CTA = "Try again tomorrow" OR "Unlock unlimited (3-day free trial)".

---

## Phases (rollout order)

### ✅ Phase 0 — Apple account-level (already done)

- Paid Applications Agreement — Active
- Tax + Banking — done
- Small Business Program (15%) — enrolled
- App Store Connect invite — accepted

### ✅ Phase 2 — Backend foundation (THIS REPO)

**Migration `0020_iap_subscriptions.sql` (written, not yet applied):**
- `subscription_events` table — webhook idempotency log (unique `event_id`)
- `profiles.referral_months_banked int` — months banked while a paid sub is active
- `ai_usage_kind` enum gains `'lesson_start'` with daily cap 1
- `is_entitled(uid)` — single source of truth: active sub OR `premium_until > now()`
- `consume_daily_section(uid)` — atomic gate, paid users free-pass, free users limited to 1/day
- `apply_subscription_event(...)` — DEFINER RPC, idempotent on `event_id`, redeems banked months on sub-end transitions
- `qualify_referral()` replaced to **bank** months when referrer has an active paid sub (instead of extending `premium_until` in parallel)
- `get_referral_stats()` replaced to surface `months_banked`

**Edge Function `revenuecat-webhook` (written, not yet deployed):**
- Verifies `Authorization: Bearer $REVENUECAT_WEBHOOK_AUTH`
- Maps RevenueCat `event.type` → `subscription_status`:
  - `INITIAL_PURCHASE` / `RENEWAL` / `UNCANCELLATION` / `PRODUCT_CHANGE` / `SUBSCRIPTION_EXTENDED` → `active` (or `trialing` if `period_type='TRIAL'`)
  - `BILLING_ISSUE` → `past_due`
  - `CANCELLATION` → `canceled` (entitlement continues until `expiration_at_ms`)
  - `EXPIRATION` / `SUBSCRIPTION_PAUSED` / `REFUND` → `expired`
  - `TEST` / `TRANSFER` / `INVOICE_ISSUANCE` → logged, no upsert
- Validates `app_user_id` is a Supabase uuid (anonymous purchases are logged but skipped)
- Calls `apply_subscription_event` RPC via service role

**To apply (manual — CLI is broken on OneDrive per `deployment-runbook`):**
1. Paste `supabase/migrations/0020_iap_subscriptions.sql` into the Supabase dashboard SQL editor → Run.
2. Deploy the function via Management API: `supabase functions deploy revenuecat-webhook --no-verify-jwt --project-ref <ref>` (or use the dashboard).
3. Set the secret: `supabase secrets set REVENUECAT_WEBHOOK_AUTH=<random-32-byte-hex> --project-ref <ref>`.

### Phase 3 — RevenueCat dashboard

1. Create app: bundle `com.talaqh.app`, App Store platform.
2. Upload **In-App Purchase Key** (`SubscriptionKey_*.p8`) + Issuer ID — from App Store Connect → Users and Access → Integrations → In-App Purchase.
3. Entitlement: `talaqh_pro`.
4. Products (after Phase 4 creates them in ASC): `talaqh_weekly`, `talaqh_monthly`, `talaqh_yearly` — all attached to `talaqh_pro`.
5. Offering: `default` with three packages.
6. Webhook URL: `https://<project>.supabase.co/functions/v1/revenuecat-webhook` with `Authorization: Bearer $REVENUECAT_WEBHOOK_AUTH`.
7. Save the **public SDK key** (`appl_…`) for the client.

### Phase 4 — App Store Connect

1. Apple Developer portal: register App ID `com.talaqh.app` with **In-App Purchase** capability.
2. App Store Connect: create the Talaqh app record (Arabic primary language, category Education, SKU `talaqh-ios-001`).
3. Subscription Group: `Talaqh Premium`.
4. Three auto-renewable subscriptions in that group:
   - `talaqh_weekly` — 1 week — 29 SAR
   - `talaqh_monthly` — 1 month — 49 SAR
   - `talaqh_yearly` — 1 year — 399 SAR
5. Each product: 3-day Introductory Offer (Free), Arabic + English localization, 1024×1024 review screenshot.
6. App-level: privacy policy URL `https://talaqh.com/privacy`, privacy nutrition label (Audio Data + Phone Number), age rating, screenshots (6.7" required).
7. Reviewer: **Sign-In Required** = phone-OTP demo number (via Supabase Management API `sms_test_otp`). Sandbox IAP is automatic.

### Phase 5 — Client integration (`index.html`)

The shipped app is the single-file `index.html` + `supabase-bridge.js`, NOT the `src/` React tree. All IAP wiring goes in `index.html` behind `isNativeApp()`.

1. Add `<script>` loading `@revenuecat/purchases-capacitor` (Capacitor 8 SPM resolves it as a Swift package — no pod install).
2. On boot (after auth): `Purchases.configure({ apiKey: 'appl_...' })` then `Purchases.logIn({ appUserID: userId })`.
3. Paywall card (RTL):
   - 3 plans with prices read from `Purchases.getOfferings()` (NEVER hardcoded)
   - Trial CTA + Restore Purchases + Terms + Privacy links
   - Auto-renew disclosure (Apple-required)
4. Server entitlement: every gated screen calls a new `entitlement()` Edge Function (or piggybacks on existing function responses) that returns `is_entitled(uid)`. The client uses this as the truth source; RevenueCat's customer info is optimistic display only.
5. Free-tier gate: each section-opening path (`words`, `listening`, `reading`, `conversation`, `grammar`) calls `consume_daily_section` RPC before rendering. If `allowed=false`, render the paywall.

### Phase 6 — Native build (on Mac)

Per `ios-capacitor` memory, Talaqh runs Capacitor 8 with SPM. Steps on the friend's Mac:
```sh
cd ~/dev/Talaqh
git pull
npm install
npm run dist:copy        # NEVER `npm run build`
npm run ios:sync         # NOT `ios:add` — that wipes Info.plist customizations
# Open Xcode, build to device, test the paywall.
```

### Phase 7 — Env / config

| Key | Where | Value |
|---|---|---|
| `REVENUECAT_WEBHOOK_AUTH` | Supabase function secrets | random 32-byte hex |
| `PAYWALL_ENABLED` | `app-config.js` | `true` to flip on |
| `REVENUECAT_PUBLIC_KEY` | `app-config.js` | `appl_…` (public, safe in client) |

### Phase 8 — Sandbox test (on real iPhone)

1. App Store Connect → Users and Access → Sandbox → Testers → create one with a fresh Apple ID.
2. On the device: Settings → App Store → sign out, then sign into the sandbox tester at purchase time.
3. Install the dev build via Xcode → open the paywall → buy any plan (no real charge, trial compressed).
4. Verify in Supabase: a row in `subscription_events` matching `event.id`, a row in `subscriptions` with `tier='premium' status='active'` (or `trialing`), and `is_entitled(uid)` returns true.
5. Cancel from Settings → confirm webhook fires `CANCELLATION` then `EXPIRATION`, `is_entitled` flips false.

### Phase 9 — Pre-submission audit

25-item checklist before hitting **Submit for Review**:

- [ ] **Restore Purchases** button on paywall (Apple requires it)
- [ ] **Terms** + **Privacy Policy** links visible on paywall
- [ ] Auto-renew disclosure text on paywall (Apple-required exact phrasing)
- [ ] Prices read from `Purchases.getOfferings()`, never hardcoded
- [ ] No web-checkout URL reachable from the iOS build
- [ ] Webhook auth verified server-side (`REVENUECAT_WEBHOOK_AUTH` set in prod)
- [ ] Webhook idempotent (duplicate `event_id` → no double-grant)
- [ ] `subscriptions` row is server-only (RLS + trusted-column guard verified)
- [ ] Account deletion (`delete-account` Edge Function) cascades into `subscriptions` + `subscription_events`
- [ ] Reviewer account NOT pre-comped (sandbox IAP must work as-is)
- [ ] App icon set (no placeholder)
- [ ] Privacy nutrition label declares Audio Data + Phone Number → Linked to App Functionality
- [ ] Privacy Policy URL = `https://talaqh.com/privacy`
- [ ] Reviewer demo phone + OTP in App Review Information
- [ ] Screenshots: 6.7" iPhone (required), Arabic RTL
- [ ] Age rating questionnaire submitted
- [ ] Category = Education
- [ ] No third-party-payment language anywhere in the app (Apple bans non-IAP language inside the iOS build)
- [ ] Build uploaded via Xcode/Transporter, processed in ASC
- [ ] `NSMicrophoneUsageDescription` (Arabic) in Info.plist
- [ ] `ITSAppUsesNonExemptEncryption=false` in Info.plist
- [ ] Portrait orientation locked
- [ ] Local notification permission prompt is honest (not on launch)
- [ ] OTA web changes frozen during review (or behind a flag) — no surprise behavior changes mid-review
- [ ] `is_entitled` returns true for the sandbox tester after purchase, false after expiration

---

## Key differences from sibling app (AJWAH)

| Concern | AJWAH | Talaqh |
|---|---|---|
| Apple agreements | Done at same account → carries over | (carries over) |
| Backend runtime | Netlify Functions (Node) | Supabase Edge Functions (Deno) — port logic, don't copy files |
| iOS dependency manager | CocoaPods (pod install) | Capacitor 8 + SPM — RevenueCat is a Swift package, no pods |
| OTA updates | Capgo | None — native changes need an App Store update; web changes ship via the normal Netlify deploy |
| Bundle ID | (other) | `com.talaqh.app` |
| Entitlement ID | (other) | `talaqh_pro` |
| Product IDs | (other) | `talaqh_weekly`, `talaqh_monthly`, `talaqh_yearly` |
| Backend project | (other) | Talaqh's own Supabase project |

---

## References

- [RevenueCat webhook event types](https://www.revenuecat.com/docs/integrations/webhooks/event-types)
- [Apple StoreKit server notifications v2](https://developer.apple.com/documentation/appstoreservernotifications)
- [`@revenuecat/purchases-capacitor`](https://www.revenuecat.com/docs/getting-started/installation/capacitor)
- Memory: `ios-capacitor`, `launch-readiness`, `deployment-runbook`, `live-app-is-single-file`

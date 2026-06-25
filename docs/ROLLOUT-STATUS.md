# Talaqh IAP rollout — current status

Updated 2026-06-25. The IAP system is **fully wired**. The only remaining steps are running an iOS build on a Mac.

---

## ✅ DONE

### Backend (live in production)
- [x] Migration `0020_iap_subscriptions.sql` applied via Supabase dashboard. Verified objects: `subscription_events`, `is_entitled`, `consume_daily_section`, `apply_subscription_event`, `referral_months_banked`.
- [x] Edge Function `revenuecat-webhook` deployed (`--no-verify-jwt`). Verified: returns 401 without auth, 200 with valid event.
- [x] Webhook secret `REVENUECAT_WEBHOOK_AUTH` set in Supabase function secrets.

### App Store Connect
- [x] App record created: bundle `com.talaqh.app`, primary language Arabic, category Education.
- [x] Subscription Group: `Talaqh Premium` with Arabic localization.
- [x] 3 subscription products created and **🔵 Ready to Submit**:
  - `talaqh_yearly` — 1 year — 399.99 SAR
  - `talaqh_monthly` — 1 month — 49.99 SAR
  - `talaqh_weekly` — 1 week — 29.99 SAR
- [x] 3-day Introductory Offer (Free) on all 3.
- [x] Arabic localization + review screenshots uploaded on all 3.
- [x] App Privacy questionnaire (declared: Name, Phone, Audio Data, User ID, Purchases, Product Interaction — all App Functionality + linked + no tracking).
- [x] Tax + Banking + Paid Apps Agreement all **Active**.
- [x] Privacy Policy live at https://talaqh.com/privacy.
- [x] Sandbox tester created (Saudi Arabia).

### RevenueCat
- [x] Project `Talaqh` (`proj29343493`) created on app.revenuecat.com.
- [x] App Store Connect API key uploaded: `AuthKey_46QAWTLQ3T.p8`, Key ID `46QAWTLQ3T`, Issuer ID `38272187-01fd-4713-80c3-2aeefe22efa4`.
- [x] In-App Purchase Key uploaded: `SubscriptionKey_S5XB3JXX8G.p8`, Key ID `S5XB3JXX8G`.
- [x] Bundle ID `com.talaqh.app` linked.
- [x] Entitlement `talaqh_pro` configured.
- [x] Webhook configured + tested: HTTP 200 response from Supabase.
- [x] Public SDK Key issued: `appl_wrKDrUQjwZXvhENPAYfWQAuiQTD`.

### Client code (live on talaqh.com — deployed)
- [x] [app-config.js](../app-config.js) — `revenueCatPublicKey: "appl_wrKDrUQjwZXvhENPAYfWQAuiQTD"`, `entitlementId: "talaqh_pro"`.
- [x] [supabase-bridge.js](../supabase-bridge.js) — `TB.isEntitled()` + `TB.consumeDailySection()` RPC wrappers.
- [x] [index.html](../index.html):
  - `IAP` namespace (`configure`, `logIn`, `getOfferings`, `purchasePackage`, `restorePurchases`, `refreshEntitlementFromServer`).
  - `app.state.entitled` server-authoritative flag.
  - `isSubbed()` reads server entitlement first, then legacy flags.
  - `launchSection()` calls `consume_daily_section` on native; routes to paywall with `paywallReason='daily_limit'` on 2nd-section-of-day attempt.
  - Paywall reads live prices from RevenueCat offerings, Restore Purchases button, real `Purchases.purchasePackage`.
  - Boot hooks: `IAP.configure()` after auth, `IAP.refreshEntitlementFromServer()` on `talaqa:ready`.
- [x] Plan prices updated to `.99` versions: 29.99 / 49.99 / 399.99 SAR.
- [x] [package.json](../package.json) — `@revenuecat/purchases-capacitor` added as a dependency (Hussain's `npm install` on the Mac will pull it in).
- [x] [privacy.html](../privacy.html) — bilingual privacy policy, contact = `Talaqh18@gmail.com`.

### Web deploy
- [x] Latest `dist/` deployed to https://talaqh.com (via Netlify).
- [x] Privacy URL live: https://talaqh.com/privacy → HTTP 200.
- [x] IAP code is dormant on web (`isNativeApp()=false` short-circuits everything) — existing free users unaffected.

---

## ⏳ REMAINING — needs Hussain's Mac + a physical iPhone

The entire IAP system is built. The only thing left is **running a native build**.

### On Hussain's Mac
```sh
cd ~/dev/Talaqh
git pull                                # picks up package.json with the RevenueCat plugin
npm install                             # installs @revenuecat/purchases-capacitor + others
npm run ios:sync                        # NOT ios:add — that wipes Info.plist customizations
                                        # NEVER `npm run build`
```

Then in Xcode:
1. Open `ios/App/App.xcworkspace` (or whatever Capacitor scaffolded).
2. Plug in a physical iPhone (signed in with the **Sandbox tester** account in Settings → App Store).
3. Build & run on the device.
4. Sign in to the app with a Talaqh phone OTP account.
5. Open the paywall → tap **اشترك الحين** → Apple's sandbox purchase sheet appears → confirm.
6. Expected results:
   - Sandbox purchase completes (no real money).
   - `app.state.entitled` flips to `true`.
   - RevenueCat fires the `INITIAL_PURCHASE` webhook → Supabase `subscription_events` row inserted, `subscriptions` row upserted with tier=`premium`, status=`trialing`.
   - Daily-limit lockout disappears.

### Verification queries (run in Supabase SQL editor after sandbox purchase)
```sql
-- Should show the test purchase event:
select event_id, event_type, user_id, product_id, received_at
from subscription_events
order by received_at desc limit 5;

-- Should show the subscriber:
select user_id, tier, status, current_period_end
from subscriptions
where tier <> 'free'
order by updated_at desc limit 5;

-- Should return true for the test user:
select is_entitled('<test-user-uuid>'::uuid);
```

---

## 📋 Submission readiness

Before hitting "Submit for Review" in App Store Connect:

- [x] Privacy policy URL works
- [x] App Privacy nutrition label published
- [x] 3 subscriptions Ready to Submit
- [x] Paid Apps Agreement + Tax + Banking active
- [ ] Age Rating (1 min — just answer the questionnaire, will be 4+)
- [ ] App Information (subtitle, category)
- [ ] Pricing and Availability (set as Free)
- [ ] App screenshots (6.7" iPhone — Hussain captures from simulator)
- [ ] Sandbox purchase test passed (above)
- [ ] App Review demo account info filled in (use the sandbox tester credentials or the test SMS OTP from Supabase Management API)
- [ ] Build uploaded via Xcode/Transporter, processed in ASC

---

## 🔑 Reference values

| What | Value |
|---|---|
| Bundle ID | `com.talaqh.app` |
| Apple App ID | `6783956365` |
| Supabase project ref | `ogoswbedcbgymtaxktlf` |
| RevenueCat project ID | `proj29343493` |
| RevenueCat entitlement | `talaqh_pro` |
| RevenueCat public SDK key | `appl_wrKDrUQjwZXvhENPAYfWQAuiQTD` |
| Apple Issuer ID | `38272187-01fd-4713-80c3-2aeefe22efa4` |
| IAP Key ID | `S5XB3JXX8G` |
| ASC API Key ID | `46QAWTLQ3T` |
| Privacy policy URL | https://talaqh.com/privacy |
| Webhook URL | https://ogoswbedcbgymtaxktlf.supabase.co/functions/v1/revenuecat-webhook |

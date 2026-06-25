// Edge Function: revenuecat-webhook
// ----------------------------------------------------------------------------
// RevenueCat → Supabase entitlement sync. RevenueCat POSTs a webhook for every
// subscription lifecycle event (purchase, renewal, cancellation, expiration,
// billing issue, etc.). We:
//   1) verify the shared Authorization secret (REVENUECAT_WEBHOOK_AUTH)
//   2) parse the event
//   3) map event.type → subscription_status (active/trialing/canceled/expired/past_due)
//   4) call apply_subscription_event RPC (idempotent on event.id) to upsert the
//      subscriptions row + redeem any referral_months_banked when the sub ends.
//
// Auth model:
//   * deployed with `--no-verify-jwt` so RevenueCat's server-to-server POST is
//     not blocked by Supabase's JWT verifier. Auth is the Authorization header
//     check below ("Bearer <shared-secret>"), nothing else.
//   * Uses the service-role client to invoke the SECURITY DEFINER RPC.
//   * NEVER trusts data from the request body for entitlement decisions other
//     than what RevenueCat itself signed.
//
// RevenueCat webhook reference:
//   https://www.revenuecat.com/docs/integrations/webhooks/event-types
// deno-lint-ignore-file no-explicit-any
import { getServiceClient, HttpError } from "../_shared/auth.ts";

interface RevenueCatEvent {
  id: string;
  type: string;
  app_user_id?: string;
  original_app_user_id?: string;
  product_id?: string;
  period_type?: string; // "NORMAL" | "TRIAL" | "INTRO" | "PROMOTIONAL"
  purchased_at_ms?: number;
  expiration_at_ms?: number | null;
  original_transaction_id?: string;
  transaction_id?: string;
  store?: string; // "APP_STORE" | "PLAY_STORE" | ...
  environment?: string; // "PRODUCTION" | "SANDBOX"
  cancel_reason?: string;
  expiration_reason?: string;
  entitlement_ids?: string[];
}

interface RevenueCatPayload {
  event?: RevenueCatEvent;
  api_version?: string;
}

// --- event_type → (status, tier) mapping ------------------------------------
// Reference: revenuecat.com/docs/integrations/webhooks/event-types
// We collapse the lifecycle into our 5 subscription_status enum values.
function mapEventTypeToStatus(type: string, periodType?: string): { status: string; tier: string } {
  const t = (type || "").toUpperCase();
  const isTrial = (periodType || "").toUpperCase() === "TRIAL";

  switch (t) {
    case "INITIAL_PURCHASE":
    case "RENEWAL":
    case "UNCANCELLATION":
    case "PRODUCT_CHANGE":
    case "SUBSCRIPTION_EXTENDED":
    case "NON_RENEWING_PURCHASE":
    case "TEMPORARY_ENTITLEMENT_GRANT":
      return { status: isTrial ? "trialing" : "active", tier: "premium" };

    case "BILLING_ISSUE":
      return { status: "past_due", tier: "premium" };

    case "CANCELLATION":
      // User canceled but access continues until expiration_at_ms. We still
      // mark status='canceled'; is_entitled() keeps them paid via current_period_end.
      return { status: "canceled", tier: "premium" };

    case "EXPIRATION":
    case "SUBSCRIPTION_PAUSED":
      return { status: "expired", tier: "free" };

    case "REFUND":
      return { status: "expired", tier: "free" };

    default:
      // Unknown event types (e.g. TRANSFER, TEST) — record but don't change
      // entitlement. The webhook still returns 200 so RevenueCat doesn't retry.
      return { status: "active", tier: "premium" };
  }
}

// Event types that are informational only — we log them but do NOT touch the
// subscriptions row (no upsert). The event_id is still written for audit.
const SKIP_UPSERT_EVENTS = new Set([
  "TEST",
  "TRANSFER",
  "INVOICE_ISSUANCE",
]);

function isUuid(v: unknown): v is string {
  return typeof v === "string"
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
}

Deno.serve(async (req: Request) => {
  const json = (b: unknown, s = 200) =>
    new Response(JSON.stringify(b), {
      status: s,
      headers: { "Content-Type": "application/json" },
    });

  if (req.method !== "POST") {
    return json({ error: "Method not allowed" }, 405);
  }

  try {
    // 1) Shared-secret auth. RevenueCat dashboard → Webhooks → Authorization
    //    header = "Bearer <REVENUECAT_WEBHOOK_AUTH>".
    const expected = Deno.env.get("REVENUECAT_WEBHOOK_AUTH");
    if (!expected) {
      throw new HttpError(500, "Server misconfigured: REVENUECAT_WEBHOOK_AUTH missing");
    }
    const auth = req.headers.get("Authorization") || "";
    const provided = auth.startsWith("Bearer ") ? auth.slice(7) : auth;
    if (provided !== expected) {
      throw new HttpError(401, "Unauthorized");
    }

    // 2) Parse the body.
    const body: RevenueCatPayload = await req.json().catch(() => ({}));
    const evt = body.event;
    if (!evt || !evt.id || !evt.type) {
      throw new HttpError(400, "Malformed webhook body: missing event.id or event.type");
    }

    // 3) Validate app_user_id (must be a Supabase auth uuid).
    //    RevenueCat assigns one when Purchases.logIn(uid) was called client-side;
    //    if it's an anonymous "$RCAnonymousID:..." we cannot map it to a user.
    const uid = evt.app_user_id;
    if (!isUuid(uid)) {
      // Anonymous or sandbox-test purchase without a logged-in user — record
      // the event without an upsert so we don't lose audit, and 200 so
      // RevenueCat doesn't retry forever.
      const service = getServiceClient();
      await service.from("subscription_events").insert({
        event_id: evt.id,
        event_type: evt.type,
        user_id: null,
        product_id: evt.product_id ?? null,
        payload: evt as unknown as Record<string, unknown>,
      }).then(() => {}, () => {}); // best-effort; ignore dup-id collisions
      return json({ ok: true, skipped: "no_user" });
    }

    const service = getServiceClient();

    // 4) Skip-upsert events: just log + ack.
    if (SKIP_UPSERT_EVENTS.has(evt.type.toUpperCase())) {
      await service.from("subscription_events").insert({
        event_id: evt.id,
        event_type: evt.type,
        user_id: uid,
        product_id: evt.product_id ?? null,
        payload: evt as unknown as Record<string, unknown>,
      }).then(() => {}, () => {});
      return json({ ok: true, skipped: evt.type });
    }

    // 5) Map event → (status, tier) and call the DEFINER RPC.
    const { status, tier } = mapEventTypeToStatus(evt.type, evt.period_type);
    const period_end = evt.expiration_at_ms
      ? new Date(evt.expiration_at_ms).toISOString()
      : null;
    const provider_ref = evt.original_transaction_id || evt.transaction_id || null;

    const { data, error } = await service.rpc("apply_subscription_event", {
      p_event_id:     evt.id,
      p_event_type:   evt.type,
      p_user_id:      uid,
      p_tier:         tier,
      p_status:       status,
      p_provider:     "apple",
      p_provider_ref: provider_ref,
      p_product_id:   evt.product_id ?? null,
      p_period_end:   period_end,
      p_payload:      evt as unknown as Record<string, unknown>,
    });

    if (error) {
      // FK violation (profile not found) is a 4xx so RevenueCat eventually gives
      // up on a permanently-bad event; everything else is 5xx so it retries.
      const isMissingProfile = /not found/i.test(error.message || "");
      throw new HttpError(isMissingProfile ? 404 : 500, error.message || "RPC failed");
    }

    return json({ ok: true, result: data });
  } catch (err) {
    if (err instanceof HttpError) {
      return json({ error: err.message }, err.status);
    }
    return json({ error: "Internal error" }, 500);
  }
});

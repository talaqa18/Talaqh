// Edge Function: send-reminders
// ----------------------------------------------------------------------------
// Web-Push daily reminders that fire even when the PWA is CLOSED. Invoked every
// minute by pg_cron (with the x-cron-secret header). It claims the users whose
// local time matches their reminder time and pushes a notification to each of
// their registered web subscriptions. Expired subscriptions are pruned.
//
// Secrets: VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT, CRON_SECRET.
// Deployed with --no-verify-jwt (cron has no user JWT); guarded by CRON_SECRET.
// deno-lint-ignore-file no-explicit-any
import webpush from "npm:web-push@3.6.7";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

function svc() {
  return createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return new Response("method", { status: 405 });
  // Only the cron may call this.
  if (req.headers.get("x-cron-secret") !== Deno.env.get("CRON_SECRET")) {
    return new Response("forbidden", { status: 401 });
  }

  const pub = Deno.env.get("VAPID_PUBLIC_KEY");
  const priv = Deno.env.get("VAPID_PRIVATE_KEY");
  const subject = Deno.env.get("VAPID_SUBJECT") || "mailto:admin@talaqa.app";
  if (!pub || !priv) return new Response(JSON.stringify({ error: "VAPID missing" }), { status: 500 });
  webpush.setVapidDetails(subject, pub, priv);

  const service = svc();
  const { data, error } = await service.rpc("claim_due_reminders");
  if (error) return new Response(JSON.stringify({ error: error.message }), { status: 500 });

  const payload = JSON.stringify({
    title: "طلاقة 🔔",
    body: "حان وقت درس اليوم — لا تكسر سلسلتك! 🔥",
    url: "/",
  });

  let sent = 0, pruned = 0;
  for (const row of (data as any[]) ?? []) {
    for (const tokenStr of (row.tokens as string[]) ?? []) {
      let sub: any;
      try { sub = JSON.parse(tokenStr); } catch (_) { continue; }
      try {
        await webpush.sendNotification(sub, payload);
        sent++;
      } catch (e: any) {
        const code = e?.statusCode;
        if (code === 404 || code === 410) { // gone -> prune the dead subscription
          try { await service.from("device_tokens").delete().eq("token", tokenStr); pruned++; } catch (_) {}
        }
      }
    }
  }
  return new Response(JSON.stringify({ ok: true, users: (data as any[])?.length ?? 0, sent, pruned }), {
    status: 200, headers: { "Content-Type": "application/json" },
  });
});

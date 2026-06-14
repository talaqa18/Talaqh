// Edge Function: delete-account
// ----------------------------------------------------------------------------
// GDPR / App Store / Play-required account erasure. The signed-in caller deletes
// THEIR OWN account: all public rows + storage objects (via the
// delete_account_data DEFINER RPC), then the auth user (Admin API).
// Auth: verify_jwt + fail-closed — a user can only ever delete themselves.
// deno-lint-ignore-file no-explicit-any
import { getAuthedUser, getServiceClient, HttpError } from "../_shared/auth.ts";
import { corsHeadersFor } from "../_shared/cors.ts";

Deno.serve(async (req: Request) => {
  const cors = corsHeadersFor(req);
  const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...cors, "Content-Type": "application/json" } });
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  try {
    const { user } = await getAuthedUser(req);
    const service = getServiceClient();

    // 1) Erase all public data (single transaction in the RPC).
    const { error: rpcErr } = await service.rpc("delete_account_data", { p_user_id: user.id });
    if (rpcErr) throw new HttpError(500, "Failed to erase account data");

    // 2) Remove the user's storage objects (recordings + state.json) via the
    //    Storage API — direct storage.objects deletes are blocked by Supabase.
    try {
      const bucket = service.storage.from("user-recordings");
      const paths: string[] = [];
      const { data: top } = await bucket.list(user.id, { limit: 1000 });
      for (const f of top ?? []) {
        if (f.id) paths.push(`${user.id}/${f.name}`);
        else { // folder -> one level deep is enough for our layout
          const { data: sub } = await bucket.list(`${user.id}/${f.name}`, { limit: 1000 });
          for (const s2 of sub ?? []) if (s2.id) paths.push(`${user.id}/${f.name}/${s2.name}`);
        }
      }
      if (paths.length) await bucket.remove(paths);
    } catch (_) { /* best-effort: data rows are already erased */ }

    // 3) Delete the auth user itself (sessions/identities cascade in auth schema).
    const { error: authErr } = await service.auth.admin.deleteUser(user.id);
    if (authErr) throw new HttpError(500, "Failed to delete the account");

    return json({ ok: true });
  } catch (err) {
    if (err instanceof HttpError) return json({ error: err.message }, err.status);
    return json({ error: "Internal error" }, 500);
  }
});

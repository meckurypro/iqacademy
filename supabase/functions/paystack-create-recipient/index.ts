// Edge Function: paystack-create-recipient
// Saves a bank account for payouts. Stores only Paystack's recipient code, the bank, the account NAME and the last 4 digits.
// Who may use it:
//   * an instructor        -> saves THEIR OWN account            { target: "instructor" }
//   * a centre director    -> saves THEIR centre's account       { centre_id }
//   * an admin             -> may save a centre's account        { centre_id }   (admins are no longer required to)
// Deploy with "Enforce JWT verification" ON. Needs the PAYSTACK_SECRET_KEY secret; without it every Paystack action answers 503 payouts_not_configured.
// Requests (POST):
//   { "action": "status" }                                                    -> { configured: boolean }
//   { "action": "list_banks" }                                                -> live list from Paystack (never hard-coded)
//   { "action": "resolve", "bank_code": "058", "account_number": "0123456789" } -> { account_name } for the person to confirm
//   { "action": "save", "bank_code": "...", "account_number": "...", "target": "instructor" | "centre_id": "<uuid>" }
import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });

const SECRET = () => Deno.env.get("PAYSTACK_SECRET_KEY") || "";

async function paystack(path: string, init: RequestInit = {}) {
  const res = await fetch(`https://api.paystack.co${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${SECRET()}`, "Content-Type": "application/json" },
  });
  const body = await res.json().catch(() => ({}));
  return { ok: res.ok && body.status !== false, body };
}

// Word-level comparison of the bank's account name with the profile name (order and case do not matter, 2+ shared words = match).
const words = (s: string) => (s || "").toUpperCase().replace(/[^A-Z ]/g, " ").split(/\s+/).filter((w) => w.length > 1);
function namesMatch(accountName: string, profileName: string): boolean {
  const a = new Set(words(accountName));
  const p = words(profileName);
  if (!p.length) return false;
  const shared = p.filter((w) => a.has(w)).length;
  return shared >= Math.min(2, p.length);
}

async function listBanks() {
  const out = new Map<string, string>();
  let next = "";
  for (let page = 0; page < 10; page++) {
    const r = await paystack(`/bank?country=nigeria&currency=NGN&perPage=100&use_cursor=true${next ? `&next=${encodeURIComponent(next)}` : ""}`);
    if (!r.ok) return { error: r.body?.message ?? "paystack_error" };
    for (const b of r.body.data ?? []) if (b.active !== false && b.is_deleted !== true && b.code && b.name) out.set(String(b.code), String(b.name));
    next = r.body?.meta?.next ?? "";
    if (!next) break;
  }
  return { banks: [...out].map(([code, name]) => ({ code, name })).sort((x, y) => x.name.localeCompare(y.name)) };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) return json({ error: "not_authenticated" }, 401);
    const url = Deno.env.get("SUPABASE_URL")!;
    const userClient = createClient(url, Deno.env.get("SUPABASE_ANON_KEY")!, { global: { headers: { Authorization: authHeader } } });
    const admin = createClient(url, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

    const { data: userData } = await userClient.auth.getUser();
    const uid = userData?.user?.id;
    if (!uid) return json({ error: "not_authenticated" }, 401);
    const { data: scope } = await userClient.rpc("my_payout_scope");
    const isAdmin = scope?.admin === true, isInstructor = scope?.instructor === true;
    const centreIds: string[] = scope?.centre_ids ?? [];
    if (!isAdmin && !isInstructor && centreIds.length === 0) return json({ error: "forbidden" }, 403);

    const body = await req.json();
    const action = body.action;

    if (action === "status") return json({ configured: SECRET().length > 0 });
    if (!SECRET()) return json({ error: "payouts_not_configured", detail: "Bank lookups are switched off until the payment provider key is configured." }, 503);

    if (action === "list_banks") {
      const r = await listBanks();
      if ("error" in r) return json({ error: "paystack_error", detail: r.error }, 502);
      return json(r);
    }

    const { bank_code, account_number } = body;
    if (!bank_code || !/^\d{10}$/.test(String(account_number ?? ""))) {
      return json({ error: "invalid_account", detail: "bank_code and a 10-digit account_number are required" }, 400);
    }

    // Decide, before spending any Paystack call, whose account this is and whether the caller may change it.
    const forInstructor = body.target === "instructor";
    const centreId: string | undefined = body.centre_id;
    if (action === "save") {
      if (forInstructor) {
        if (!isInstructor) return json({ error: "forbidden" }, 403);
        const { count } = await admin.from("instructor_withdrawals").select("id", { count: "exact", head: true }).eq("instructor_id", uid).in("status", ["draft", "processing"]);
        if ((count ?? 0) > 0) return json({ error: "withdrawal_pending", detail: "Finish or cancel your open withdrawal before changing your bank account." }, 409);
      } else {
        if (!centreId) return json({ error: "centre_id_required" }, 400);
        if (!isAdmin && !centreIds.includes(centreId)) return json({ error: "forbidden" }, 403);
        const { count } = await admin.from("payouts").select("id", { count: "exact", head: true }).eq("centre_id", centreId).in("status", ["draft", "processing"]);
        if ((count ?? 0) > 0) return json({ error: "payout_pending", detail: "A payout for this centre is in progress. Change the account after it completes." }, 409);
      }
    } else if (action !== "resolve") return json({ error: "unknown_action" }, 400);

    const resolved = await paystack(`/bank/resolve?account_number=${account_number}&bank_code=${encodeURIComponent(bank_code)}`);
    if (!resolved.ok) return json({ error: "could_not_resolve_account", detail: resolved.body?.message }, 422);
    const accountName: string = resolved.body.data.account_name;
    if (action === "resolve") return json({ account_name: accountName });

    const created = await paystack("/transferrecipient", {
      method: "POST",
      body: JSON.stringify({ type: "nuban", name: accountName, account_number, bank_code, currency: "NGN" }),
    });
    if (!created.ok) return json({ error: "could_not_create_recipient", detail: created.body?.message }, 502);
    const d = created.body.data;
    const last4 = String(account_number).slice(-4);
    const row = {
      provider_recipient_code: d.recipient_code, bank_code, bank_name: d.details?.bank_name ?? null,
      account_name: accountName, account_last4: last4, updated_at: new Date().toISOString(),
    };

    if (forInstructor) {
      const { data: prof } = await admin.from("profiles").select("full_name").eq("id", uid).maybeSingle();
      const match = namesMatch(accountName, prof?.full_name ?? "");
      const { error } = await admin.from("instructor_payout_accounts").upsert({ instructor_id: uid, ...row, name_match: match });
      if (error) return json({ error: "save_failed", detail: error.message }, 500);
      await admin.rpc("log_payout_account_change", { p_kind: "instructor", p_id: uid, p_actor: uid });
      return json({ ok: true, account_name: accountName, bank_name: row.bank_name, account_last4: last4, name_match: match });
    }

    const { error } = await admin.from("centre_payout_accounts").upsert({ centre_id: centreId, ...row });
    if (error) return json({ error: "save_failed", detail: error.message }, 500);
    await admin.rpc("log_payout_account_change", { p_kind: "centre", p_id: centreId, p_actor: uid });
    return json({ ok: true, account_name: accountName, bank_name: row.bank_name, account_last4: last4 });
  } catch (e) {
    console.error("paystack-create-recipient", e);
    return json({ error: "internal_error" }, 500);
  }
});

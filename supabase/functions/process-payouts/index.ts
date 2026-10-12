// Edge Function: process-payouts
// Admin-only. Prepares and sends payouts via Paystack Transfers: monthly centre payouts AND instructor withdrawals.
// Deploy with "Enforce JWT verification" ON. Needs the PAYSTACK_SECRET_KEY secret.
// Until that secret exists, nothing is approved, reserved or sent: every sending action answers 503 payouts_not_configured
// BEFORE any database change, so no money is ever shown as moving when it is not.
// Requests (POST):
//   { "action": "status" }                                     -> { configured }
//   { "action": "create_drafts" }                              -> one draft payout per centre that is owed money
//   { "action": "send", "payout_id": "<uuid>" }                -> centre: approves the draft and starts the Paystack transfer
//   { "action": "cancel", "payout_id": "<uuid>" }              -> centre: cancels a draft
//   { "action": "send_instructor", "withdrawal_id": "<uuid>" } -> instructor: approves the request and starts the transfer
//   { "action": "reject_instructor", "withdrawal_id": "<uuid>", "reason": "..." }
//   { "action": "reconcile", "reference": "<reference>" }      -> asks Paystack what happened to a transfer and applies it (idempotent)
//   { "action": "retry_instructor", "withdrawal_id": "<uuid>" }-> re-sends a "processing" withdrawal ONLY if Paystack has no record of its reference
// The final result (paid / failed / reversed) normally arrives via the paystack-webhook function (transfer.* events).
// Paystack account requirement: Transfers enabled, enough balance, transfer OTP disabled (otherwise the transfer waits for OTP approval).
import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });

const SECRET = () => Deno.env.get("PAYSTACK_SECRET_KEY") || "";
const NOT_CONFIGURED = { error: "payouts_not_configured", detail: "Live payouts are switched off until the Paystack secret key is stored as a Supabase secret." };

function startTransfer(a: { amount: number; recipient_code: string; reference: string; currency: string }) {
  return fetch("https://api.paystack.co/transfer", {
    method: "POST",
    headers: { Authorization: `Bearer ${SECRET()}`, "Content-Type": "application/json" },
    body: JSON.stringify({ source: "balance", amount: a.amount, recipient: a.recipient_code, reason: `IQ Academy payout ${a.reference}`, reference: a.reference, currency: a.currency }),
  });
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

    const { data: isAdmin } = await userClient.rpc("am_i_admin");
    if (isAdmin !== true) return json({ error: "forbidden" }, 403);

    const { action, payout_id, withdrawal_id, reason, reference } = await req.json();

    if (action === "status") return json({ configured: SECRET().length > 0 });

    if (action === "create_drafts") {
      const { data, error } = await userClient.rpc("create_payout_drafts");
      if (error) return json({ error: error.message }, 400);
      return json({ drafts_created: data });
    }

    if (action === "cancel") {
      const { error } = await userClient.rpc("cancel_payout", { p_payout_id: payout_id });
      if (error) return json({ error: error.message }, 400);
      return json({ ok: true });
    }

    if (action === "reject_instructor") {
      const { error } = await userClient.rpc("reject_instructor_withdrawal", { p_id: withdrawal_id, p_reason: reason });
      if (error) return json({ error: error.message }, 400);
      return json({ ok: true });
    }

    if (action === "reconcile") {
      if (!SECRET()) return json(NOT_CONFIGURED, 503);
      if (!reference) return json({ error: "reference_required" }, 400);
      const res = await fetch(`https://api.paystack.co/transfer/verify/${encodeURIComponent(reference)}`, { headers: { Authorization: `Bearer ${SECRET()}` } });
      const body = await res.json().catch(() => ({}));
      if (res.status === 404) return json({ status: "not_found", message: "Paystack has no transfer with this reference." });
      if (!res.ok || body.status === false) return json({ error: "paystack_error", detail: body?.message }, 502);
      const st = String(body.data?.status ?? "");
      const mapped = st === "success" ? "success" : st === "reversed" ? "reversed" : st === "failed" ? "failed" : null;
      if (!mapped) return json({ status: st || "pending", message: "Still in progress at Paystack." });
      const { data, error } = await admin.rpc("handle_transfer_event", { p_reference: reference, p_status: mapped, p_transfer_code: body.data?.transfer_code ?? null, p_raw: body.data ?? null });
      if (error) return json({ error: error.message }, 400);
      return json({ status: st, applied: data });
    }

    if (action === "send" || action === "send_instructor" || action === "retry_instructor") {
      if (!SECRET()) return json(NOT_CONFIGURED, 503); // checked first: nothing is approved or reserved while payouts are unconfigured
      const instructor = action !== "send";
      const id = instructor ? withdrawal_id : payout_id;
      if (!id) return json({ error: instructor ? "withdrawal_id_required" : "payout_id_required" }, 400);

      let appr: any;
      if (action === "retry_instructor") {
        const { data: w } = await admin.from("instructor_withdrawals").select("id,reference,amount,currency,recipient_code,status,provider_transfer_code").eq("id", id).maybeSingle();
        if (!w || w.status !== "processing" || !w.reference) return json({ error: "not_retryable" }, 409);
        if (w.provider_transfer_code) return json({ error: "already_sent", detail: "Paystack already has this transfer. Use reconcile instead." }, 409);
        const chk = await fetch(`https://api.paystack.co/transfer/verify/${encodeURIComponent(w.reference)}`, { headers: { Authorization: `Bearer ${SECRET()}` } });
        if (chk.status !== 404) return json({ error: "already_sent", detail: "Paystack knows this reference. Use reconcile instead." }, 409);
        appr = { amount: w.amount, recipient_code: w.recipient_code, reference: w.reference, currency: w.currency };
      } else {
        // 1) Reserve/approve in the database (admin-checked, atomic). Centre: ledger debit. Instructor: the money was reserved when they asked.
        const { data, error } = instructor
          ? await userClient.rpc("approve_instructor_withdrawal", { p_id: id })
          : await userClient.rpc("approve_payout", { p_payout_id: id });
        if (error) return json({ error: error.message }, 400);
        appr = data;
      }

      // 2) Ask Paystack to move the money
      let res: Response;
      try {
        res = await startTransfer(appr);
      } catch (_networkError) {
        // We do not know whether Paystack received it. Leave it "processing"; use reconcile (or the webhook) to settle it.
        return json({ status: "unknown", message: "Network error talking to Paystack. Use Reconcile in a few minutes before retrying." }, 202);
      }

      const body = await res.json().catch(() => ({}));
      if (!res.ok || body.status === false) {
        if (instructor) await admin.rpc("fail_instructor_withdrawal", { p_id: id, p_reason: body?.message ?? "transfer_rejected" });
        else await admin.rpc("fail_payout", { p_payout_id: id, p_reason: body?.message ?? "transfer_rejected" });
        return json({ error: "transfer_rejected", detail: body?.message }, 502);
      }

      await admin.from(instructor ? "instructor_withdrawals" : "payouts").update({
        provider_transfer_code: body.data?.transfer_code ?? null,
        raw: body.data ?? null,
      }).eq("id", id);

      return json({
        status: body.data?.status ?? "pending",
        reference: appr.reference,
        message: body.data?.status === "otp"
          ? "Paystack is waiting for OTP approval. Approve it in the Paystack dashboard, or disable transfer OTP in settings."
          : "Transfer started. You will be notified when it completes.",
      });
    }

    return json({ error: "unknown_action" }, 400);
  } catch (e) {
    console.error("process-payouts", e);
    return json({ error: "internal_error" }, 500);
  }
});

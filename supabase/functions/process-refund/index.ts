// Edge Function: process-refund
// Admin-only. Sends a refund to a student's bank account via Paystack Transfers.
// (To refund by hand instead, the app calls the record_manual_refund database function: no Edge Function needed.)
// Deploy with "Enforce JWT verification" ON.
// Request (POST):
//   { "payment_id": "<uuid>", "amount": 500000 /* kobo */, "reason": "…", "cancel_enrolment": true|false,
//     "bank_code": "058", "account_number": "0123456789" }
// What happens: the refund is checked against the classes the student attended (those are not refundable), the account is verified with
// Paystack, the refund protocol runs in the database (payment marked refunded, centre's share reversed, student + centre notified),
// then the transfer starts. The final result (sent / failed) arrives via the paystack-webhook function; a failed transfer automatically
// undoes the protocol and alerts you.
import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });

async function paystack(path: string, init: RequestInit = {}) {
  const res = await fetch(`https://api.paystack.co${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${Deno.env.get("PAYSTACK_SECRET_KEY")}`, "Content-Type": "application/json" },
  });
  const body = await res.json().catch(() => ({}));
  return { ok: res.ok && body.status !== false, body };
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

    const { payment_id, amount, reason, cancel_enrolment, bank_code, account_number } = await req.json();
    if (!payment_id || !Number.isInteger(amount) || amount <= 0) return json({ error: "payment_id and a whole-number kobo amount are required" }, 400);
    if (!bank_code || !/^\d{10}$/.test(String(account_number ?? ""))) return json({ error: "invalid_account" }, 400);

    // 0) Classes the student already attended are not refundable. Checked first so no Paystack call is wasted (the database enforces it again).
    const { data: info } = await userClient.rpc("payment_refund_info", { p_payment_id: payment_id });
    if (info && amount > Number(info.max_refund)) {
      return json({ error: "refund_exceeds_unused_classes", detail: "Classes the student already attended can't be refunded. Refund only the part for classes they haven't attended." }, 400);
    }

    // 1) Verify the account and create the Paystack recipient (the full account number is never stored by us)
    const resolved = await paystack(`/bank/resolve?account_number=${account_number}&bank_code=${encodeURIComponent(bank_code)}`);
    if (!resolved.ok) return json({ error: "could_not_resolve_account", detail: resolved.body?.message }, 422);
    const accountName: string = resolved.body.data.account_name;
    const rec = await paystack("/transferrecipient", {
      method: "POST",
      body: JSON.stringify({ type: "nuban", name: accountName, account_number, bank_code, currency: "NGN" }),
    });
    if (!rec.ok) return json({ error: "could_not_create_recipient", detail: rec.body?.message }, 502);

    // 2) Run the refund protocol in the database (admin check + validation happen inside)
    const { data: begun, error: beginErr } = await userClient.rpc("begin_paystack_refund", {
      p_payment_id: payment_id, p_amount: amount, p_reason: reason ?? null, p_cancel_enrolment: !!cancel_enrolment,
      p_recipient_code: rec.body.data.recipient_code, p_bank_name: rec.body.data.details?.bank_name ?? null,
      p_account_name: accountName, p_account_last4: String(account_number).slice(-4),
    });
    if (beginErr) return json({ error: beginErr.message }, 400);

    // 3) Start the transfer
    let res: Response;
    try {
      res = await fetch("https://api.paystack.co/transfer", {
        method: "POST",
        headers: { Authorization: `Bearer ${Deno.env.get("PAYSTACK_SECRET_KEY")}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          source: "balance", amount: begun.amount, recipient: begun.recipient_code, currency: begun.currency,
          reason: `IQ Academy refund ${begun.reference}`, reference: begun.reference,
        }),
      });
    } catch (_networkError) {
      // Unknown whether Paystack received it: leave the refund "processing"; the webhook will settle it.
      return json({ status: "unknown", message: "Network error talking to Paystack. Check the refund in a few minutes before retrying." }, 202);
    }
    const body = await res.json().catch(() => ({}));
    if (!res.ok || body.status === false) {
      await admin.rpc("fail_refund", { p_refund_id: begun.refund_id, p_reason: body?.message ?? "transfer_rejected" });
      return json({ error: "transfer_rejected", detail: body?.message }, 502);
    }
    await admin.from("refunds").update({ provider_transfer_code: body.data?.transfer_code ?? null, raw: body.data ?? null }).eq("id", begun.refund_id);

    return json({
      status: body.data?.status ?? "pending", account_name: accountName, reference: begun.reference,
      message: body.data?.status === "otp"
        ? "Paystack is waiting for OTP approval. Approve it in the Paystack dashboard, or disable transfer OTP in settings."
        : "Refund started. The student has been notified and you'll be alerted if it fails.",
    });
  } catch (e) {
    console.error("process-refund", e);
    return json({ error: "internal_error" }, 500);
  }
});

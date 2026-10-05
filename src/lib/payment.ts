import { supabase } from "./supabase";

export async function startPayment(instalmentId: string) {
  const { data, error } = await supabase.functions.invoke("paystack-init-payment", {
    body: { instalment_id: instalmentId, callback_url: `${location.origin}/pay/callback` },
  });
  if (error || !data?.authorization_url) throw new Error(data?.error ?? error?.message ?? "payment_failed");
  location.href = data.authorization_url;
}

// src/pages/PayReturn.tsx
// Where Paystack sends someone who started a payment in the IQ Academy APP (the app asks for this address as the payment's return page).
// The app's payment window is a separate browser with no website sign-in, so this page must work signed out. It must also NOT say anything about the
// payment: Paystack sends people here whether the payment went through or they pressed cancel. It only hands them back to the app, which then asks the
// server what really happened. (The website's own payments return to /pay/callback instead and are not affected.)
import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { Button, Card } from "../components/ui";

const APP_RETURN = "iqacademy://pay/return"; // the app's own address (its URL scheme)

export default function PayReturn() {
  const [q] = useSearchParams();
  const ref = q.get("reference") || q.get("trxref") || "";
  const back = `${APP_RETURN}${ref ? `?reference=${encodeURIComponent(ref)}` : ""}`;
  const [slow, setSlow] = useState(false);

  useEffect(() => {
    window.location.replace(back); // in the app's payment window this closes it and returns to the app
    const t = setTimeout(() => setSlow(true), 1500); // still here: the phone did not switch by itself, so offer the button
    return () => clearTimeout(t);
  }, [back]);

  return (
    <Card className="anim-rise mx-auto mt-10 max-w-sm space-y-4 p-8 text-center">
      <div className="mx-auto h-10 w-10 animate-spin rounded-full border-[3px] border-accent border-t-transparent" aria-hidden />
      <h1 className="text-[22px] leading-tight">Taking you back to IQ Academy…</h1>
      <p className="text-muted">Your payment status shows in the app as soon as we have it.</p>
      {slow && <>
        <a href={back}><Button className="w-full">Open the IQ Academy app</Button></a>
        <p className="text-sm text-muted">If nothing happens, close this window and open the app yourself. Nothing is lost.</p>
      </>}
    </Card>
  );
}

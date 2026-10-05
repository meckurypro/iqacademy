import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { supabase } from "../lib/supabase";
import { Button, Card } from "../components/ui";

import Icon from "../components/Icon";
export default function PayCallback() {
  const [q] = useSearchParams();
  const ref = q.get("reference") || q.get("trxref");
  const [status, setStatus] = useState<"checking" | "succeeded" | "failed" | "pending">("checking");

  useEffect(() => {
    if (!ref) { setStatus("failed"); return; }
    let tries = 0, stop = false;
    const tick = async () => {
      const { data } = await supabase.functions.invoke("paystack-verify-payment", { body: { reference: ref } });
      const s = data?.status;
      if (stop) return;
      if (s === "succeeded") return setStatus("succeeded");
      if (s === "failed") return setStatus("failed");
      if (++tries < 6) setTimeout(tick, 2500); else setStatus("pending");
    };
    tick();
    return () => { stop = true; };
  }, [ref]);

  return (
    <Card className="anim-rise mx-auto mt-10 max-w-sm space-y-4 p-8 text-center">
      {status === "checking" && <><div className="mx-auto h-10 w-10 animate-spin rounded-full border-[3px] border-accent border-t-transparent" /><p>Confirming your payment…</p></>}
      {status === "succeeded" && <><div className="anim-pop mx-auto grid h-16 w-16 place-items-center rounded-full bg-ok/15 text-ok"><Icon name="check" size={32} strokeWidth={2.25} /></div><h1 className="text-[26px] leading-tight">You're in!</h1><p className="text-muted">Payment received. See your classes on Home.</p></>}
      {status === "pending" && <><h1 className="text-[26px] leading-tight">Still confirming</h1><p className="text-muted">Your bank is taking a moment. We'll update your account as soon as it lands.</p></>}
      {status === "failed" && <><h1 className="text-[26px] leading-tight">Payment not completed</h1><p className="text-muted">No money was taken. You can try again from Home.</p></>}
      <Link to="/"><Button className="w-full">Go to Home</Button></Link>
    </Card>
  );
}

// src/components/PinGate.tsx
// After a student's first successful payment they must choose a check-in PIN before they can use the app. The server says when
// (pin_required): a student who has paid and has no PIN. The gate covers the whole app until the PIN is saved.
import { useCallback, useEffect, useState } from "react";
import { supabase } from "../lib/supabase";
import { Button, IconTile } from "./ui";
import { useFeedback } from "./feedback";
import { PinSetup } from "./PinInput";
import Icon from "./Icon";

export default function PinGate() {
  const { run } = useFeedback();
  const [required, setRequired] = useState(false);
  const check = useCallback(() => { supabase.rpc("pin_required").then((r) => { if (!r.error) setRequired(r.data === true); }); }, []);
  // asked when the app opens and whenever it comes back to the foreground (a payment may have just gone through)
  useEffect(() => {
    check();
    const onShow = () => { if (document.visibilityState === "visible") check(); };
    document.addEventListener("visibilitychange", onShow);
    return () => document.removeEventListener("visibilitychange", onShow);
  }, [check]);
  if (!required) return null;
  return (
    <div role="dialog" aria-modal="true" aria-label="Set your check-in PIN" className="fixed inset-0 z-[60] overflow-y-auto bg-bg pb-[env(safe-area-inset-bottom)] pt-[env(safe-area-inset-top)]">
      <div className="mx-auto flex min-h-full max-w-sm flex-col justify-center gap-6 px-6 py-10">
        <div className="space-y-3 text-center">
          <div className="flex justify-center"><IconTile size={56}><Icon name="lock" size={26} /></IconTile></div>
          <h1 className="text-[26px] leading-tight">Set your check-in PIN</h1>
          <p className="text-[15px] leading-relaxed text-muted">Thanks for your payment. One last step. If you can't scan the class code, the person at the door will ask you to type this PIN on their phone, so nobody can check you in without you.</p>
        </div>
        <PinSetup onDone={() => setRequired(false)} />
        <p className="text-center text-xs leading-snug text-muted">Never tell your PIN to anyone, and type it yourself. You'll be notified every time someone checks you in.</p>
        <Button variant="ghost" className="text-muted" onClick={() => run("Signing out…", () => supabase.auth.signOut())}>Sign out</Button>
      </div>
    </div>
  );
}

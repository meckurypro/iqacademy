// src/components/DoorPinSheet.tsx
// Asks an instructor or coordinator for their door PIN before the class code is shown or a student is checked in by hand.
// First time (no PIN yet): they choose one here, then carry on. The PIN is checked on the server; this only collects it.
import { useEffect, useState } from "react";
import { supabase, friendly } from "../lib/supabase";
import { useAuth } from "../lib/auth";
import { unlockDoor } from "../lib/doorLock";
import { Err, IconTile, Sheet } from "./ui";
import { PinInput, PinSetup } from "./PinInput";
import Icon from "./Icon";

const WRONG: Record<string, string> = {
  pin_incorrect: "That PIN is wrong. Try again.",
  pin_locked: "Too many wrong PINs. Door tools are paused for 15 minutes.",
};

function Body({ onUnlocked }: { onUnlocked: () => void }) {
  const { session } = useAuth(); const uid = session!.user.id;
  const [has, setHas] = useState<boolean | null>(null); const [pin, setPin] = useState(""); const [err, setErr] = useState(""); const [busy, setBusy] = useState(false);
  useEffect(() => { supabase.rpc("has_staff_pin").then((r) => { if (r.error) setErr(friendly(r.error)); else setHas(r.data === true); }); }, []);

  const done = () => { unlockDoor(uid); onUnlocked(); };
  const check = async (v: string) => {
    if (busy) return; setBusy(true); setErr("");
    const r = await supabase.rpc("verify_staff_pin", { p_pin: v });
    setBusy(false);
    if (r.error) { setPin(""); return setErr(friendly(r.error)); }
    if (r.data === "ok") return done();
    setPin("");
    if (r.data === "pin_not_set") return setHas(false);
    setErr(WRONG[String(r.data)] ?? "Something went wrong. Please try again.");
  };

  if (has === null) return <p className="py-6 text-center text-sm text-muted">{err || "One moment…"}</p>;
  return (
    <div className="space-y-5">
      <div className="flex justify-center"><IconTile size={48}><Icon name="lock" size={24} /></IconTile></div>
      {has ? <>
        <p className="text-center text-sm text-muted">Enter your door PIN to continue. It keeps the class code and check-in safe if your phone is left unlocked.</p>
        <PinInput value={pin} onChange={(v) => { setPin(v); setErr(""); }} autoFocus invalid={!!err} onComplete={check} />
        <Err>{err}</Err>
      </> : <>
        <p className="text-center text-sm text-muted">Choose a door PIN. You'll type it before showing the class code or checking a student in. It's yours alone: never share it.</p>
        <PinSetup staff onDone={done} />
      </>}
    </div>
  );
}

export default function DoorPinSheet({ open, onClose, onUnlocked }: { open: boolean; onClose: () => void; onUnlocked: () => void }) {
  return <Sheet open={open} onClose={onClose} title="Enter your PIN"><Body onUnlocked={onUnlocked} /></Sheet>;
}

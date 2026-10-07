// src/components/PinInput.tsx
// The student's check-in PIN: exactly four digits, always on a numeric keypad, always shown as dots.
//   <PinInput>      four boxes over one real input (so paste, autofill and the OS keypad all behave)
//   <PinSetup>      choose a PIN, then type it again to confirm before it is saved
//   <ChangePinForm> a new PIN (twice) plus the account password (twice), as the server requires
// PinSetup and ChangePinForm take `staff`: the same screens for the door PIN that instructors and coordinators use (migration 55).
import { useRef, useState } from "react";
import { supabase } from "../lib/supabase";
import { Button, cx, Err } from "./ui";
import { useFeedback } from "./feedback";
import { PasswordField } from "./PasswordFields";

export const PIN_LENGTH = 4;

export function PinInput({ value, onChange, label, autoFocus, disabled, invalid, onComplete }:
  { value: string; onChange: (v: string) => void; label?: string; autoFocus?: boolean; disabled?: boolean; invalid?: boolean; onComplete?: (v: string) => void }) {
  const ref = useRef<HTMLInputElement>(null); const [focused, setFocused] = useState(false);
  const set = (raw: string) => { const v = raw.replace(/\D/g, "").slice(0, PIN_LENGTH); onChange(v); if (v.length === PIN_LENGTH) onComplete?.(v); };
  return (
    <div>
      {label && <p className="mb-2 text-center text-sm font-medium">{label}</p>}
      <div className="relative mx-auto w-fit" onClick={() => ref.current?.focus()}>
        <div className="flex gap-3" aria-hidden="true">
          {Array.from({ length: PIN_LENGTH }, (_, i) => (
            <span key={i} className={cx("grid h-14 w-12 place-items-center rounded-xl bg-surface text-2xl ring-1 transition",
              invalid ? "ring-bad/60" : focused && i === Math.min(value.length, PIN_LENGTH - 1) ? "ring-2 ring-accent" : "ring-line")}>
              {value[i] ? <span className="h-3 w-3 rounded-full bg-ink" /> : null}</span>))}
        </div>
        {/* the real input sits invisibly over the boxes: numeric keypad, never autofilled, never shown as text */}
        <input ref={ref} value={value} onChange={(e) => set(e.target.value)} onFocus={() => setFocused(true)} onBlur={() => setFocused(false)}
          inputMode="numeric" pattern="[0-9]*" maxLength={PIN_LENGTH} autoComplete="off" autoCorrect="off" autoCapitalize="off" spellCheck={false}
          enterKeyHint="done" autoFocus={autoFocus} disabled={disabled} aria-label={label ?? "4-digit PIN"}
          className="absolute inset-0 h-full w-full cursor-pointer bg-transparent text-[16px] text-transparent caret-transparent opacity-0 outline-none" />
      </div>
    </div>
  );
}

/** First-time PIN: choose it, type it again, then save. */
export function PinSetup({ onDone, staff }: { onDone: () => void; staff?: boolean }) {
  const { run } = useFeedback();
  const [first, setFirst] = useState(""); const [again, setAgain] = useState(""); const [step, setStep] = useState<"choose" | "confirm">("choose"); const [err, setErr] = useState("");
  const back = (msg = "") => { setFirst(""); setAgain(""); setStep("choose"); setErr(msg); };
  const save = async () => {
    if (again !== first) return back("Those two PINs don't match. Let's start again.");
    const r = await run("Saving your PIN…", async () => { const { error } = await supabase.rpc(staff ? "set_staff_pin" : "set_pin", { p_pin: first }); if (error) throw error; }, { success: "PIN saved", quiet: true });
    if (!r.ok) return setErr(r.message);
    onDone();
  };
  return (
    <div className="space-y-5">
      {step === "choose"
        ? <PinInput key="a" value={first} onChange={(v) => { setFirst(v); setErr(""); }} label="Choose a 4-digit PIN" autoFocus onComplete={() => setTimeout(() => setStep("confirm"), 180)} />
        : <PinInput key="b" value={again} onChange={(v) => { setAgain(v); setErr(""); }} label="Type it again to confirm" autoFocus invalid={!!err}
            onComplete={(v) => { if (v !== first) back("Those two PINs don't match. Let's start again."); }} />}
      <Err>{err}</Err>
      {step === "confirm" && <div className="space-y-2">
        <Button className="w-full" disabled={again.length !== PIN_LENGTH} onClick={save}>Save PIN</Button>
        <Button variant="ghost" className="w-full" onClick={() => back()}>Start again</Button>
      </div>}
    </div>
  );
}

/** Change an existing PIN. The server checks the password, so this can't be done from a phone that was just left unlocked. */
export function ChangePinForm({ onDone, staff }: { onDone: () => void; staff?: boolean }) {
  const { run } = useFeedback();
  const [pin, setPin] = useState(""); const [pin2, setPin2] = useState(""); const [pw, setPw] = useState(""); const [pw2, setPw2] = useState(""); const [err, setErr] = useState("");
  const submit = async () => {
    if (pin.length !== PIN_LENGTH) return setErr("A PIN is exactly 4 digits.");
    if (pin !== pin2) return setErr("The two new PINs don't match.");
    if (!pw) return setErr("Enter your password.");
    if (pw !== pw2) return setErr("The two passwords don't match.");
    setErr("");
    const r = await run("Changing your PIN…", async () => {
      const { data, error } = await supabase.rpc(staff ? "change_staff_pin" : "change_pin", { p_new_pin: pin, p_password: pw, p_password_confirm: pw2 });
      if (error) throw error;
      if (data !== "ok") throw new Error(String(data));
    }, { success: "PIN changed", quiet: true });
    if (!r.ok) { setPw(""); setPw2(""); return setErr(r.message); }
    onDone();
  };
  return (
    <div className="space-y-5">
      <PinInput value={pin} onChange={(v) => { setPin(v); setErr(""); }} label="New 4-digit PIN" />
      <PinInput value={pin2} onChange={(v) => { setPin2(v); setErr(""); }} label="Type the new PIN again" invalid={pin2.length === PIN_LENGTH && pin2 !== pin} />
      <div className="space-y-3 border-t border-line pt-4">
        <p className="text-sm text-muted">To make sure it's you, type your account password twice.</p>
        <PasswordField label="Password" value={pw} onValue={(v) => { setPw(v); setErr(""); }} autoComplete="current-password" />
        <PasswordField label="Password again" value={pw2} onValue={(v) => { setPw2(v); setErr(""); }} autoComplete="current-password" />
      </div>
      <Err>{err}</Err>
      <Button className="w-full" disabled={pin.length !== PIN_LENGTH || pin2.length !== PIN_LENGTH || !pw || !pw2} onClick={submit}>Change PIN</Button>
    </div>
  );
}


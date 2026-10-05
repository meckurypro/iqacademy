// src/components/PasswordFields.tsx
import { useId, useState, type InputHTMLAttributes } from "react";
import { cx } from "./ui";
import { RULES, generatePassword, strength } from "../lib/password";

import Icon from "./Icon";
const Eye = ({ off }: { off?: boolean }) => <Icon name={off ? "eyeOff" : "eye"} size={20} />;

type PwProps = Omit<InputHTMLAttributes<HTMLInputElement>, "type" | "onChange" | "value"> & {
  label: string; value: string; onValue: (v: string) => void;
  /** Optional controlled visibility (used when a generated password should be revealed). */
  show?: boolean; onShow?: (s: boolean) => void;
};

// Password input with a show/hide toggle.
export function PasswordField({ label, value, onValue, show, onShow, className, ...p }: PwProps) {
  const id = useId(); const [inner, setInner] = useState(false);
  const visible = show ?? inner; const set = (s: boolean) => (onShow ? onShow(s) : setInner(s));
  return (
    <div>
      <label htmlFor={id} className="mb-1.5 block text-sm text-muted">{label}</label>
      <div className="relative">
        <input {...p} id={id} type={visible ? "text" : "password"} value={value} onChange={(e) => onValue(e.target.value)}
          autoCapitalize="none" autoCorrect="off" spellCheck={false}
          className={cx("h-12 w-full rounded-xl bg-sunken pl-4 pr-12 text-[15px] outline-none ring-accent/40 transition focus:ring-2", className)} />
        <button type="button" onClick={() => set(!visible)} aria-label={visible ? "Hide password" : "Show password"} aria-pressed={visible}
          className="absolute right-1.5 top-1/2 grid h-9 w-9 -translate-y-1/2 place-items-center rounded-lg text-muted transition hover:text-ink active:scale-95">
          <Eye off={visible} />
        </button>
      </div>
    </div>
  );
}

const meterTone = ["", "bg-bad", "bg-warn", "bg-ok/60", "bg-ok"];
const labelTone = ["", "text-bad", "text-warn", "text-ok", "text-ok"];

export function StrengthMeter({ password }: { password: string }) {
  const { level, label } = strength(password);
  return (
    <div className="flex items-center gap-3" aria-live="polite">
      <div className="grid flex-1 grid-cols-4 gap-1.5" aria-hidden="true">
        {[1, 2, 3, 4].map((i) => <span key={i} className={cx("h-1.5 rounded-full transition-colors duration-300", i <= level ? meterTone[level] : "bg-line")} />)}
      </div>
      <span className={cx("w-14 text-right text-xs font-medium", labelTone[level])}>{label || "\u00A0"}</span>
    </div>
  );
}

export function PasswordChecklist({ password }: { password: string }) {
  return (
    <ul className="grid gap-1.5 sm:grid-cols-2" aria-label="Password requirements">
      {RULES.map((r) => {
        const ok = r.test(password);
        return (
          <li key={r.id} className={cx("flex items-center gap-2 text-[13px] transition-colors", ok ? "text-ok" : "text-muted")}>
            <span className={cx("grid h-4 w-4 shrink-0 place-items-center rounded-full text-[10px] leading-none transition", ok ? "anim-pop bg-ok text-white" : "ring-1 ring-inset ring-line")} aria-hidden="true">{ok && <Icon name="check" size={10} strokeWidth={3.5} />}</span>
            {r.label}<span className="sr-only">{ok ? " (done)" : " (not yet)"}</span>
          </li>);
      })}
    </ul>
  );
}

// Everything needed to create a strong password: input + eye toggle, strength meter, live checklist, generator.
export function PasswordCreator({ label = "Password", value, onValue, onGenerate, autoComplete = "new-password", ...p }:
  { label?: string; value: string; onValue: (v: string) => void; onGenerate?: (pw: string) => void; autoComplete?: string } &
  Omit<InputHTMLAttributes<HTMLInputElement>, "type" | "onChange" | "value">) {
  const [show, setShow] = useState(false); const [generated, setGenerated] = useState(false); const [copied, setCopied] = useState(false);
  const suggest = () => { const pw = generatePassword(); onValue(pw); onGenerate?.(pw); setShow(true); setGenerated(true); setCopied(false); };
  const copy = async () => { try { await navigator.clipboard.writeText(value); setCopied(true); setTimeout(() => setCopied(false), 1800); } catch { /* clipboard blocked: the password is visible, so it can be copied by hand */ } };
  return (
    <div className="space-y-3">
      <PasswordField {...p} label={label} value={value} onValue={(v) => { setGenerated(false); onValue(v); }} show={show} onShow={setShow} autoComplete={autoComplete} />
      <StrengthMeter password={value} />
      <PasswordChecklist password={value} />
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" onClick={suggest} className="inline-flex items-center gap-2 rounded-xl bg-accent/10 px-3.5 py-2 text-sm font-medium text-accent transition active:scale-95"><Icon name="key" size={16} />Suggest a strong password</button>
        {generated && value && <button type="button" onClick={copy} className="rounded-xl bg-sunken px-3.5 py-2 text-sm font-medium transition active:scale-95">{copied ? <span className="inline-flex items-center gap-1.5"><Icon name="check" size={15} />Copied</span> : "Copy"}</button>}
      </div>
      {generated && <p className="text-xs text-muted">Save it in your password manager or copy it now. You'll need it to sign in.</p>}
    </div>
  );
}

export function MatchHint({ a, b }: { a: string; b: string }) {
  if (!b) return null;
  const ok = a === b;
  return <p className={cx("-mt-1 text-xs", ok ? "text-ok" : "text-bad")} aria-live="polite">{ok ? <span className="inline-flex items-center gap-1"><Icon name="check" size={14} />Passwords match</span> : "Passwords don't match yet"}</p>;
}

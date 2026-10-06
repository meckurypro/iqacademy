// src/components/CheckInVerdict.tsx
// Full-screen answer after a student checks in: green and "go in", or red and "stop at the desk".
// Colours are fixed (not theme tokens) so the answer reads the same in light and dark mode, from across a room.
import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { useNavigate } from "react-router-dom";
import Icon from "./Icon";
import { deniedText, type Verdict } from "../lib/checkin";

export default function CheckInVerdict({ v, onDone, onRetry }: { v: Verdict; onDone: () => void; onRetry: () => void }) {
  const btn = useRef<HTMLButtonElement>(null); const nav = useNavigate();
  useEffect(() => {
    navigator.vibrate?.(v.ok ? 40 : [90, 60, 90]);
    btn.current?.focus();
    document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = ""; };
  }, [v]);
  const name = v.first_name ? `, ${v.first_name}` : "";
  const d = deniedText(v.reason);
  const title = v.ok ? (v.already_checked_in ? `Already in${name}` : v.makeup ? `Make-up class${name}` : v.emergency ? `Custom class${name}` : `You're in${name}!`) : `${d.title}${v.reason === "not_enrolled" || v.reason === "not_invited" || v.reason === "payment_required" ? name : ""}`;
  const sub = v.ok ? (v.already_checked_in ? "You're already marked present. Go on in." : "You're cleared for this class. Go on in!") : d.detail;
  return createPortal(
    <div role="alertdialog" aria-modal="true" aria-live="assertive" aria-label={v.ok ? "Checked in" : "Check-in refused"}
      className={`anim-fade fixed inset-0 z-[60] flex flex-col items-center justify-center gap-6 px-8 text-center text-white ${v.ok ? "bg-[#15803d]" : "bg-[#b91c1c]"}`}>
      <div className="anim-pop grid h-28 w-28 place-items-center rounded-full bg-white/20"><Icon name={v.ok ? "check" : "close"} size={64} strokeWidth={2.25} /></div>
      <div className="space-y-2">
        <h1 className="text-4xl font-bold tracking-tight">{title}</h1>
        <p className="text-lg opacity-95">{sub}</p>
        {(v.course_title || v.centre_name) && <p className="pt-2 text-sm opacity-85">{[v.course_title, v.lesson_title, v.centre_name].filter(Boolean).join(" · ")}</p>}
        {v.ok && <p className="text-sm opacity-85">Messages from your instructor will appear in Messages.</p>}
        {!v.ok && <p className="text-sm opacity-85">See the front desk if you think this is a mistake.</p>}
      </div>
      <div className="w-full max-w-xs space-y-2">
        <button ref={btn} onClick={onDone} className="h-12 w-full rounded-xl bg-white font-semibold text-black transition active:scale-[.98]">{v.ok ? "Done" : "Close"}</button>
        {v.ok && v.session_id && <button onClick={() => { onDone(); nav(`/messages/${v.session_id}`); }} className="h-10 w-full text-sm font-medium text-white/90 underline underline-offset-4">Open class messages</button>}
        {!v.ok && <button onClick={onRetry} className="h-10 w-full text-sm font-medium text-white/90 underline underline-offset-4">Try another code</button>}
      </div>
    </div>, document.body);
}

// src/components/ClockWatch.tsx
// Keeps the app on the server's clock (see lib/time.ts) and tells the person when their phone's clock is off.
import { useEffect, useState } from "react";
import { syncClock } from "../lib/time";
import Icon from "./Icon";

const TOLERANCE_MS = 2 * 60000;   // a couple of minutes either way is normal and not worth a warning
const RESYNC_MS = 10 * 60000;

/** Measures the clock gap once before the app shows (it waits at most 2.5s), then keeps re-measuring. */
export function useClockSync(enabled: boolean) {
  const [ready, setReady] = useState(false); const [skew, setSkew] = useState(0);
  useEffect(() => {
    if (!enabled) { setReady(false); return; }
    let alive = true;
    const measure = () => syncClock().then((k) => { if (alive && k !== null) setSkew(k); });
    Promise.race([measure(), new Promise((r) => setTimeout(r, 2500))]).finally(() => { if (alive) setReady(true); });
    const i = setInterval(measure, RESYNC_MS);
    const vis = () => { if (document.visibilityState === "visible") measure(); };
    document.addEventListener("visibilitychange", vis);
    return () => { alive = false; clearInterval(i); document.removeEventListener("visibilitychange", vis); };
  }, [enabled]);
  return { ready: !enabled || ready, skew };
}

export default function ClockNotice({ skew }: { skew: number }) {
  const [hidden, setHidden] = useState(false);
  if (hidden || Math.abs(skew) < TOLERANCE_MS) return null;
  const mins = Math.round(Math.abs(skew) / 60000);
  const gap = mins >= 120 ? `${Math.round(mins / 60)} hours` : mins >= 60 ? `${Math.round(mins / 6) / 10} hours` : `${mins} minutes`;
  return (
    <div role="status" className="mb-4 flex items-start gap-3 rounded-xl bg-warn/10 px-3 py-2.5 text-sm text-ink">
      <Icon name="alert" size={18} className="mt-0.5 shrink-0 text-warn" />
      <p className="flex-1">Your phone's clock is about {gap} {skew > 0 ? "slow" : "fast"}. The app shows the correct time, but turn on automatic date and time in your phone's settings so other apps and alarms agree.</p>
      <button onClick={() => setHidden(true)} aria-label="Dismiss" className="shrink-0 text-muted"><Icon name="close" size={16} /></button>
    </div>
  );
}

// src/lib/online.ts — is the app actually able to reach the server?
// The browser's own "online" flag is true on Wi-Fi with no internet, so it is only a hint. We also ask the backend (any reply at all,
// even an error, means we can reach it; only a network failure means we can't). Two failed asks in a row are needed before we say
// "offline", so one slow moment doesn't flash a warning, and we ask more often while offline so the notice clears quickly.
import { useEffect, useState } from "react";

const SERVER = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const CALM_MS = 20_000, RETRY_MS = 4_000, TIMEOUT_MS = 6_000;

async function reachable(): Promise<boolean> {
  if (!navigator.onLine) return false;
  if (!SERVER) return true;
  const stop = new AbortController(); const t = setTimeout(() => stop.abort(), TIMEOUT_MS);
  try { await fetch(`${SERVER}/auth/v1/health`, { mode: "no-cors", cache: "no-store", signal: stop.signal }); return true; }
  catch { return false; }
  finally { clearTimeout(t); }
}

export function useOnline(): boolean {
  const [online, setOnline] = useState(() => navigator.onLine);
  useEffect(() => {
    let alive = true, fails = 0, timer = 0;
    const check = async () => {
      window.clearTimeout(timer);
      const ok = await reachable();
      if (!alive) return;
      fails = ok ? 0 : fails + 1;
      if (ok) setOnline(true); else if (fails >= 2 || !navigator.onLine) setOnline(false);
      timer = window.setTimeout(check, ok ? CALM_MS : RETRY_MS);
    };
    const lost = () => { fails = 2; setOnline(false); window.clearTimeout(timer); timer = window.setTimeout(check, RETRY_MS); };
    const wake = () => { if (document.visibilityState === "visible") check(); };
    addEventListener("online", check); addEventListener("offline", lost); document.addEventListener("visibilitychange", wake);
    check();
    return () => { alive = false; window.clearTimeout(timer); removeEventListener("online", check); removeEventListener("offline", lost); document.removeEventListener("visibilitychange", wake); };
  }, []);
  return online;
}

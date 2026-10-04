// src/pages/Landing.tsx
import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { supabase } from "../lib/supabase";

// Set VITE_MOBILE_APP_URL to the store / download link. Until then the mobile button opens the web app.
const APP_URL = (import.meta.env.VITE_MOBILE_APP_URL as string | undefined) || "/login";

const LINES = [
  "Practical AI skills, taught by people who build with AI.",
  "Understand. Design. Build. Automate.",
  "Affordable training, online and at a centre near you.",
  "Learn online, in a workshop, or one-on-one.",
  "Start from zero and leave with something you built.",
  "Join a cohort. Show up. Ship real work.",
];

// People trained before online payments existed; every paying student is added on top.
const BASE_TRAINED = 100;
type Stats = { centres: number; courses: number; paid: number };

/** 100 → "100+", 110 → "110+" (tens); from 1,000 up → "1k+", "1.2k+" (hundreds); millions → "1.2M+". */
const people = (n: number) => {
  if (n < 1000) return `${Math.floor(n / 10) * 10}+`;
  if (n < 1e6) return `${Math.floor(n / 100) / 10}k+`;
  return `${Math.floor(n / 1e5) / 10}M+`;
};

function useInView<T extends Element>() {
  const ref = useRef<T>(null);
  const [seen, setSeen] = useState(false);
  useEffect(() => {
    const el = ref.current; if (!el) return;
    const io = new IntersectionObserver(([e]) => { if (e.isIntersecting) { setSeen(true); io.disconnect(); } }, { threshold: 0.4 });
    io.observe(el);
    return () => io.disconnect();
  }, []);
  return [ref, seen] as const;
}

function useCountUp(target: number, run: boolean) {
  const [v, setV] = useState(0);
  useEffect(() => {
    if (!run) return;
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) { setV(target); return; }
    let raf = 0; const t0 = performance.now();
    const tick = (t: number) => {
      const p = Math.min(1, (t - t0) / 1600);
      setV(Math.round(target * (1 - Math.pow(1 - p, 3))));
      if (p < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [target, run]);
  return v;
}

function Typewriter({ lines }: { lines: string[] }) {
  const reduce = useMemo(() => matchMedia("(prefers-reduced-motion: reduce)").matches, []);
  const [i, setI] = useState(0);
  const [n, setN] = useState(0);
  const [out, setOut] = useState(false);
  const text = lines[i];

  useEffect(() => {
    const next = () => setI((v) => (v + 1) % lines.length);
    let id: number;
    if (reduce) id = window.setTimeout(next, 3000);
    else if (out) id = window.setTimeout(() => { setOut(false); setN(0); next(); }, 350);
    else if (n < text.length) id = window.setTimeout(() => setN(n + 1), 42);
    else id = window.setTimeout(() => setOut(true), 2000);
    return () => clearTimeout(id);
  }, [i, n, out, reduce, text, lines.length]);

  return (
    <h1 aria-label={text} className="min-h-[3.4em] text-[clamp(2.1rem,6.4vw,4.5rem)] font-semibold leading-[1.08] tracking-tight sm:min-h-[2.3em]">
      <span className={`transition-opacity duration-300 ${out ? "opacity-0" : "opacity-100"}`}>
        {reduce ? text : text.slice(0, n)}
        <span className="caret" aria-hidden />
      </span>
    </h1>
  );
}

function Stat({ value, label }: { value: string; label: string }) {
  return (
    <div>
      <p className="num text-4xl font-semibold tracking-tight sm:text-5xl">{value}</p>
      <p className="mt-2 text-sm text-muted">{label}</p>
    </div>
  );
}

function CountStat({ target, label, run, format = String }: { target: number; label: string; run: boolean; format?: (n: number) => string }) {
  return <Stat value={format(useCountUp(target, run))} label={label} />;
}

export default function Landing() {
  const nav = useNavigate();
  const [stats, setStats] = useState<Stats | null | "failed">(null);
  const [gridRef, inView] = useInView<HTMLDivElement>();

  // A failed email-confirmation link redirects to the site root with the error in the hash.
  useEffect(() => {
    if (/error_code=otp_expired|error=access_denied/.test(location.hash)) nav("/verify-email", { replace: true, state: { expired: true } });
  }, [nav]);

  useEffect(() => {
    supabase.rpc("public_landing_stats").then((r) => setStats(r.error || !r.data ? "failed" : (r.data as Stats)));
  }, []);

  const ready = stats !== null;
  const st = stats && stats !== "failed" ? stats : null;
  const run = ready && inView;

  const btn = "inline-flex h-12 items-center justify-center rounded-full px-7 text-[15px] font-medium transition active:scale-[.98]";

  return (
    <div className="relative overflow-hidden">
      <div aria-hidden className="pointer-events-none absolute inset-x-0 top-0 h-[80vh] bg-[radial-gradient(60%_60%_at_15%_0%,rgb(var(--accent)/0.14),transparent)]" />
      <div className="relative mx-auto max-w-5xl px-6">
        <section className="flex min-h-[100svh] flex-col">
          <header className="flex items-center justify-between py-6">
            <Link to="/" className="flex items-center gap-3 font-semibold tracking-tight">
              <img src="/icon-192.png" alt="" className="h-9 w-9 rounded-xl" />IQ Academy
            </Link>
            <Link to="/login" className="text-sm text-muted transition hover:text-ink">Sign in</Link>
          </header>

          <div className="flex flex-1 flex-col justify-center pb-24">
            <Typewriter lines={LINES} />
            <div className="mt-10 flex flex-col gap-3 sm:flex-row">
              <a href={APP_URL} className={`${btn} border border-line hover:bg-sunken`}>On mobile? Get the app</a>
              <Link to="/login" className={`${btn} bg-accent text-accent-ink hover:opacity-90`}>Continue on PC</Link>
            </div>
          </div>
        </section>

        <section className="border-t border-line py-24 sm:py-32">
          <p className="max-w-2xl text-2xl font-semibold leading-snug tracking-tight sm:text-3xl">
            IQ Academy is the educational wing of PromptIQ AI Agency, offering affordable training in AI skills.
          </p>
          <p className="mt-6 max-w-2xl text-muted">
            PromptIQ builds AI-powered apps, solutions, and media and entertainment. Since 2024, IQ Academy has trained people through
            online cohorts, tutorials, workshops, creator internships and one-on-one mentorship.
          </p>
          <div ref={gridRef} className={`mt-16 grid grid-cols-2 gap-10 transition-opacity duration-500 sm:grid-cols-4 ${ready ? "opacity-100" : "opacity-0"}`}>
            {st && <CountStat target={st.centres} run={run} label={st.centres === 1 ? "Physical training centre" : "Physical training centres"} />}
            {st && <CountStat target={st.courses} run={run} label={st.courses === 1 ? "AI skill taught" : "AI skills taught"} />}
            <CountStat target={BASE_TRAINED + (st?.paid ?? 0)} run={run} format={people} label="People trained" />
            <Stat value="2024" label="Building since" />
          </div>
        </section>

        <footer className="border-t border-line py-8 text-sm text-muted">© {new Date().getFullYear()} IQ Academy</footer>
      </div>
    </div>
  );
}

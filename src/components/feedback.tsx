// src/components/feedback.tsx
// One place for everything the app tells people while it works:
//   run(label, fn)  – full-screen "Saving…" overlay (pulsing app icon, spiralling ring, dark blurred backdrop)
//   confirm(...)    – a proper confirmation dialog (used before every delete or irreversible action)
//   toast(...)      – short messages ("Saved", errors)
// Nothing in the app should change data without going through run().
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Button, cx } from "./ui";
import { friendly } from "../lib/supabase";

import Icon from "./Icon";
const MIN_VISIBLE_MS = 650; // even a very fast save stays on screen long enough to be seen

type Tone = "ok" | "bad";
type ToastItem = { id: number; msg: string; tone: Tone };
export type ConfirmOpts = { title: string; message?: ReactNode; confirmLabel?: string; cancelLabel?: string; danger?: boolean };
export type RunOpts = { success?: string; quiet?: boolean };
export type RunResult<T> = { ok: true; data: T } | { ok: false; error: unknown; message: string };

type Ctx = {
  /** Shows the overlay while `fn` runs. Never throws: check `.ok`. Errors toast unless `quiet` (use quiet when you show the error inline). */
  run: <T>(label: string, fn: () => Promise<T>, opts?: RunOpts) => Promise<RunResult<T>>;
  toast: (msg: string, tone?: Tone) => void;
  confirm: (o: ConfirmOpts) => Promise<boolean>;
};
const FeedbackCtx = createContext<Ctx | null>(null);
export const useFeedback = () => {
  const c = useContext(FeedbackCtx);
  if (!c) throw new Error("useFeedback needs <FeedbackProvider>");
  return c;
};

export function BusyOverlay({ label }: { label: string }) {
  return createPortal(
    <div data-live="1" role="status" aria-live="assertive" aria-busy="true"
      className="busy-overlay anim-fade fixed inset-0 z-[100] grid place-items-center bg-black/65 backdrop-blur-md">
      <div className="flex flex-col items-center gap-7">
        <div className="relative grid h-36 w-36 place-items-center">
          <img src="/icon-192.png" alt="" className="busy-icon h-[72px] w-[72px] rounded-[20px]" />
        </div>
        <p className="text-lg font-medium tracking-tight text-white">{label}</p>
      </div>
    </div>, document.body);
}

function ConfirmDialog({ o, done }: { o: ConfirmOpts; done: (v: boolean) => void }) {
  useEffect(() => {
    // capture phase: Escape closes only this dialog, not a sheet that is open underneath it
    const k = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); done(false); } };
    addEventListener("keydown", k, true);
    const was = document.body.style.overflow; document.body.style.overflow = "hidden";
    return () => { removeEventListener("keydown", k, true); document.body.style.overflow = was; };
  }, [done]);
  return createPortal(
    <div data-live="1" className="fixed inset-0 z-[90] flex items-end justify-center sm:items-center" role="alertdialog" aria-modal="true" aria-labelledby="confirm-title">
      <div className="anim-fade absolute inset-0 bg-black/55 backdrop-blur-sm" onClick={() => done(false)} />
      <div className="anim-rise relative w-full max-w-sm rounded-t-3xl bg-surface p-5 pb-[calc(1.25rem+env(safe-area-inset-bottom))] shadow-2xl sm:rounded-3xl">
        <h2 id="confirm-title" className="text-lg">{o.title}</h2>
        {o.message && <div className="mt-1.5 text-[15px] leading-snug text-muted">{o.message}</div>}
        <div className="mt-5 grid grid-cols-2 gap-2">
          {/* a destructive action is never the default-focused button */}
          <Button variant="secondary" autoFocus={!!o.danger} onClick={() => done(false)}>{o.cancelLabel ?? "Cancel"}</Button>
          <Button variant={o.danger ? "danger" : "primary"} autoFocus={!o.danger} onClick={() => done(true)}>{o.confirmLabel ?? "Confirm"}</Button>
        </div>
      </div>
    </div>, document.body);
}

export function FeedbackProvider({ children }: { children: ReactNode }) {
  const [label, setLabel] = useState<string | null>(null);
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const [ask, setAsk] = useState<{ o: ConfirmOpts; done: (v: boolean) => void } | null>(null);
  const jobs = useRef(new Map<number, string>());
  const seq = useRef(0); const shownAt = useRef(0);
  const pending = useRef<((v: boolean) => void) | null>(null);

  const toast = useCallback((msg: string, tone: Tone = "ok") => {
    const id = ++seq.current;
    setToasts((t) => [...t.slice(-2), { id, msg, tone }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), tone === "bad" ? 6000 : 2800);
  }, []);

  const run = useCallback(async <T,>(text: string, fn: () => Promise<T>, opts: RunOpts = {}): Promise<RunResult<T>> => {
    const id = ++seq.current;
    if (jobs.current.size === 0) shownAt.current = Date.now();
    jobs.current.set(id, text); setLabel(text);
    let res: RunResult<T>;
    try { res = { ok: true, data: await fn() }; }
    catch (error) { console.error(`[${text}]`, error); res = { ok: false, error, message: friendly(error) }; }
    if (jobs.current.size === 1) {
      const wait = MIN_VISIBLE_MS - (Date.now() - shownAt.current);
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    }
    jobs.current.delete(id);
    const rest = [...jobs.current.values()];
    setLabel(rest.length ? rest[rest.length - 1] : null);
    if (res.ok && opts.success) toast(opts.success, "ok");
    if (!res.ok && !opts.quiet) toast(res.message, "bad");
    return res;
  }, [toast]);

  const confirm = useCallback((o: ConfirmOpts) => new Promise<boolean>((resolve) => {
    pending.current?.(false);
    const done = (v: boolean) => { pending.current = null; setAsk(null); resolve(v); };
    pending.current = resolve;
    setAsk({ o, done });
  }), []);

  // While something is saving, nothing underneath can be tapped, tabbed to or submitted with Enter.
  const busy = label !== null;
  useEffect(() => {
    [...document.body.children].forEach((el) => {
      if ((el as HTMLElement).dataset.live) return;
      if (busy) el.setAttribute("inert", ""); else el.removeAttribute("inert");
    });
  }, [busy]);

  const value = useMemo(() => ({ run, toast, confirm }), [run, toast, confirm]);
  return (
    <FeedbackCtx.Provider value={value}>
      {children}
      {ask && <ConfirmDialog o={ask.o} done={ask.done} />}
      {label !== null && <BusyOverlay label={label} />}
      {toasts.length > 0 && createPortal(
        <div data-live="1" aria-live="polite" className="pointer-events-none fixed inset-x-0 top-0 z-[110] flex flex-col items-center gap-2 px-4 pt-[calc(0.75rem+env(safe-area-inset-top))]">
          {toasts.map((t) => (
            <div key={t.id} role="status" className={cx("anim-drop pointer-events-auto max-w-sm rounded-2xl px-4 py-3 text-sm font-medium shadow-2xl ring-1",
              t.tone === "bad" ? "bg-bad text-white ring-bad" : "bg-surface text-ink ring-line")}>
              {t.tone === "ok" && <Icon name="check" size={16} className="mr-1.5 inline text-ok align-[-3px]" />}{t.msg}
            </div>))}
        </div>, document.body)}
    </FeedbackCtx.Provider>
  );
}

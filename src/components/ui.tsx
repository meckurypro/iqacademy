// src/components/ui.tsx
import { createPortal } from "react-dom";
import { Link } from "react-router-dom";
import Icon, { type IconName } from "./Icon";
import { useEffect, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode } from "react";

export const cx = (...a: (string | false | null | undefined)[]) => a.filter(Boolean).join(" ");

export function Button({ variant = "primary", loading, className, children, disabled, ...p }:
  ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "primary" | "secondary" | "ghost" | "danger"; loading?: boolean }) {
  const v = { primary: "bg-accent text-accent-ink hover:opacity-90", secondary: "bg-surface text-ink ring-1 ring-line hover:bg-sunken", ghost: "text-muted hover:bg-sunken hover:text-ink", danger: "bg-bad text-accent-ink hover:opacity-90" }[variant];
  return (
    <button {...p} disabled={disabled || loading}
      className={cx("relative inline-flex h-11 items-center justify-center gap-2 rounded-xl px-5 text-[15px] font-medium transition",
        "active:scale-[.98] disabled:opacity-50 disabled:active:scale-100", v, className)}>
      {loading && <span className="h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent" />}
      {children}
    </button>
  );
}

// A Card paints its own surface and ring unless the caller supplies a background or ring. Without this, "bg-accent"
// and the default "bg-surface" fight and the stylesheet order decides, which left white text on a white card.
export const Card = ({ className, children, onClick }: { className?: string; children: ReactNode; onClick?: () => void }) => (
  <div onClick={onClick} className={cx("rounded-2xl p-4 shadow-card", !/(^|\s)(bg-|glass)/.test(className ?? "") && "bg-surface", !/(^|\s)(ring-|glass)/.test(className ?? "") && "ring-1 ring-line",
    onClick && "cursor-pointer transition active:scale-[.99] lg:hover:shadow-lift", className)}>{children}</div>
);

export const Skeleton = ({ className }: { className?: string }) => <div className={cx("skeleton h-5 w-full", className)} />;

export function Avatar({ name, url, size = 40 }: { name: string; url?: string | null; size?: number }) {
  const hue = [...name].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 360, 7);
  const initials = name.split(/\s+/).filter(Boolean).slice(0, 2).map((s) => s[0]?.toUpperCase()).join("") || "?";
  if (url) return <img src={url} alt="" style={{ width: size, height: size }} className="rounded-full object-cover" />;
  return (
    <div style={{ width: size, height: size, fontSize: size * 0.38, background: `linear-gradient(135deg, hsl(${hue} 70% 62%), hsl(${(hue + 40) % 360} 70% 50%))` }}
      className="grid shrink-0 place-items-center rounded-full font-semibold text-white">{initials}</div>
  );
}

// Bottom sheet on phones, centred dialog on larger screens; dark + blurred backdrop.
export function Sheet({ open, onClose, title, children }: { open: boolean; onClose: () => void; title?: string; children: ReactNode }) {
  useEffect(() => {
    if (!open) return;
    const k = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    addEventListener("keydown", k);
    document.body.style.overflow = "hidden";
    return () => { removeEventListener("keydown", k); document.body.style.overflow = ""; };
  }, [open, onClose]);
  if (!open) return null;
  // Portalled to <body>: the sticky header's backdrop-blur would otherwise become the containing block for "fixed" and clip the overlay.
  return createPortal(
    <div className="fixed inset-0 z-50 flex items-end justify-center sm:items-center" role="dialog" aria-modal="true">
      <div className="anim-fade absolute inset-0 bg-black/50 backdrop-blur-sm" onClick={onClose} />
      <div className="anim-rise relative max-h-[92dvh] w-full max-w-md overflow-y-auto rounded-t-3xl bg-surface p-5 pb-[calc(1.25rem+env(safe-area-inset-bottom))] shadow-2xl sm:rounded-3xl">
        <div className="mx-auto mb-4 h-1 w-9 rounded-full bg-line sm:hidden" />
        {title && <h2 className="mb-4 text-xl">{title}</h2>}
        {children}
      </div>
    </div>, document.body
  );
}

export const Field = ({ label, ...p }: InputHTMLAttributes<HTMLInputElement> & { label: string }) => (
  <label className="block">
    <span className="mb-1.5 block text-sm font-medium">{label}</span>
    <input {...p} className="h-12 w-full rounded-xl bg-surface px-4 text-[15px] outline-none ring-1 ring-line transition placeholder:text-muted/60 focus:ring-2 focus:ring-accent/60" />
  </label>
);

export type Tone = "ok" | "warn" | "bad" | "info" | "accent" | "muted";
const TONE_SOFT: Record<Tone, string> = { ok: "bg-ok/10 text-ok", warn: "bg-warn/10 text-warn", bad: "bg-bad/10 text-bad", info: "bg-info/10 text-info", accent: "bg-accent/10 text-accent", muted: "bg-sunken text-muted" };
const TONE_DOT: Record<Tone, string> = { ok: "bg-ok", warn: "bg-warn", bad: "bg-bad", info: "bg-info", accent: "bg-accent", muted: "bg-muted/60" };

export const Badge = ({ tone = "muted", children }: { tone?: Tone; children: ReactNode }) => (
  <span className={cx("inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 py-1 text-xs font-medium", TONE_SOFT[tone])}>
    <span className={cx("h-1.5 w-1.5 rounded-full", TONE_DOT[tone])} />{children}
  </span>
);

// A small rounded square that holds an icon. The tone colours it softly, so colour carries meaning without shouting.
export const IconTile = ({ tone = "muted", size = 40, children }: { tone?: Tone; size?: number; children: ReactNode }) => (
  <span style={{ width: size, height: size }} className={cx("grid shrink-0 place-items-center rounded-xl", tone === "muted" ? "bg-sunken text-ink/70" : TONE_SOFT[tone])}>{children}</span>
);

// One tappable list row (icon, title, hint, optional badge, chevron). Replaces the hand-built copies on several screens.
export function NavRow({ to, icon, title, hint, tone = "muted", badge }: { to: string; icon: IconName; title: string; hint?: string; tone?: Tone; badge?: ReactNode }) {
  return (
    <Link to={to} className="group flex items-center gap-3.5 px-4 py-3.5 transition hover:bg-sunken/60 active:bg-sunken">
      <IconTile tone={tone}><Icon name={icon} size={20} /></IconTile>
      <span className="min-w-0 flex-1"><span className="block font-medium leading-snug">{title}</span>{hint && <span className="mt-0.5 block text-sm leading-snug text-muted">{hint}</span>}</span>
      {badge}
      <Icon name="chevronRight" size={16} className="shrink-0 text-muted/70 transition group-hover:translate-x-0.5" />
    </Link>
  );
}

// A group of rows inside one card, separated by hairlines. Calmer than a stack of separate cards.
export const List = ({ children, className }: { children: ReactNode; className?: string }) => (
  <div className={cx("divide-y divide-line overflow-hidden rounded-2xl bg-surface shadow-card ring-1 ring-line", className)}>{children}</div>
);

export const PageHeader = ({ title, sub, action }: { title: string; sub?: string; action?: ReactNode }) => (
  <div className="flex items-end justify-between gap-3 pt-1">
    <div className="min-w-0"><h1 className="text-[26px] leading-tight">{title}</h1>{sub && <p className="mt-1 text-[15px] text-muted">{sub}</p>}</div>
    {action}
  </div>
);

// Section heading: small, quiet, with an optional link or count on the right. Content below sits close to it.
export const Section = ({ title, aside, children, className }: { title: string; aside?: ReactNode; children: ReactNode; className?: string }) => (
  <section className={cx("space-y-3", className)}>
    <div className="flex items-baseline justify-between gap-3 px-0.5"><h2 className="text-[13px] font-semibold uppercase tracking-wider text-muted">{title}</h2>{aside && <span className="text-sm text-muted">{aside}</span>}</div>
    {children}
  </section>
);

export const Empty = ({ icon = "inbox", title, hint }: { icon?: IconName; title: string; hint?: string }) => (
  <div className="flex flex-col items-center gap-2 rounded-2xl border border-dashed border-line px-6 py-10 text-center">
    <IconTile size={44}><Icon name={icon} size={22} /></IconTile>
    <p className="font-medium">{title}</p>{hint && <p className="max-w-xs text-sm text-muted">{hint}</p>}
  </div>
);

// `compact` is for dense dashboards: tighter padding, a smaller figure that cannot push a naira amount out of a half-width tile.
export const Stat = ({ label, value, sub, tone, compact }: { label: string; value: string | number; sub?: string; tone?: Tone; compact?: boolean }) => (
  <div className={cx("min-w-0 rounded-2xl bg-surface shadow-card ring-1 ring-line", compact ? "p-3" : "p-4")}>
    <p className={cx("flex items-center gap-1.5 text-muted", compact ? "text-xs" : "text-[13px]")}>{tone && <span className={cx("h-1.5 w-1.5 shrink-0 rounded-full", TONE_DOT[tone])} />}<span className="truncate">{label}</span></p>
    <p className={cx("num whitespace-nowrap font-semibold tracking-tight", compact ? cx("mt-1", String(value).length > 12 ? "text-sm" : String(value).length > 10 ? "text-base" : String(value).length > 8 ? "text-lg" : "text-xl") : "mt-1.5 text-2xl")}>{value}</p>
    {sub && <p className={cx("text-muted", compact ? "mt-0.5 truncate text-[11px]" : "mt-0.5 text-xs")}>{sub}</p>}
  </div>
);

// Several small counts in one card, side by side (for plain numbers, not money).
export const StatStrip = ({ items }: { items: { label: string; value: string | number; tone?: Tone }[] }) => (
  <div style={{ gridTemplateColumns: `repeat(${items.length}, minmax(0, 1fr))` }} className="grid divide-x divide-line rounded-2xl bg-surface py-3 shadow-card ring-1 ring-line">
    {items.map((i) => (
      <div key={i.label} className="min-w-0 px-2 text-center">
        <p className="num truncate text-lg font-semibold leading-tight">{i.value}</p>
        <p className="mt-0.5 flex items-center justify-center gap-1 text-[11px] text-muted">{i.tone && <span className={cx("h-1.5 w-1.5 shrink-0 rounded-full", TONE_DOT[i.tone])} />}<span className="truncate">{i.label}</span></p>
      </div>))}
  </div>
);

// Filter chips: one scrolling row, small and quiet. Chip is one pill; ChipRow holds them.
export const ChipRow = ({ children }: { children: ReactNode }) => <div className="-mx-4 flex gap-1.5 overflow-x-auto px-4 pb-0.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">{children}</div>;
export const Chip = ({ on, onClick, children }: { on: boolean; onClick: () => void; children: ReactNode }) => (
  <button onClick={onClick} aria-pressed={on} className={cx("h-8 shrink-0 whitespace-nowrap rounded-full px-3.5 text-[13px] font-medium transition active:scale-95", on ? "bg-accent text-accent-ink" : "bg-sunken text-ink/80")}>{children}</button>
);

export const Err = ({ children }: { children?: ReactNode }) => children ? <p role="alert" className="rounded-xl bg-bad/10 px-3.5 py-2.5 text-sm text-bad">{children}</p> : null;

// Dashboard layout. One column on phones. On desktop: a main column and a side rail.
// Put <Rail> first in the markup so phones keep reading order; on desktop it is moved to the right.
// An empty Rail (all its children rendered nothing) disappears and Main takes the full width.
export const Split = ({ children }: { children: ReactNode }) => <div className="flex flex-col gap-6 lg:flex-row lg:items-start">{children}</div>;
export const Main = ({ children }: { children: ReactNode }) => <div className="min-w-0 space-y-6 lg:order-1 lg:flex-1">{children}</div>;
export const Rail = ({ children }: { children: ReactNode }) => <div className="space-y-6 empty:hidden lg:order-2 lg:w-[22rem] lg:shrink-0 xl:w-[24rem]">{children}</div>;

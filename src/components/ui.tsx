import { createPortal } from "react-dom";
import { useEffect, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode } from "react";

export const cx = (...a: (string | false | null | undefined)[]) => a.filter(Boolean).join(" ");

export function Button({ variant = "primary", loading, className, children, disabled, ...p }:
  ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "primary" | "secondary" | "ghost" | "danger"; loading?: boolean }) {
  const v = { primary: "bg-accent text-accent-ink shadow-card", secondary: "bg-sunken text-ink", ghost: "text-muted hover:bg-sunken", danger: "bg-bad text-white shadow-card" }[variant];
  return (
    <button {...p} disabled={disabled || loading}
      className={cx("relative inline-flex h-12 items-center justify-center gap-2 rounded-xl px-5 text-[15px] font-medium transition",
        "active:scale-[.98] disabled:opacity-50 disabled:active:scale-100", v, className)}>
      {loading && <span className="h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent" />}
      {children}
    </button>
  );
}

export const Card = ({ className, children, onClick }: { className?: string; children: ReactNode; onClick?: () => void }) => (
  <div onClick={onClick} className={cx("rounded-2xl bg-surface p-4 shadow-card ring-1 ring-line", onClick && "cursor-pointer transition active:scale-[.99]", className)}>{children}</div>
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
        <div className="mx-auto mb-3 h-1 w-10 rounded-full bg-line sm:hidden" />
        {title && <h2 className="mb-3 text-lg">{title}</h2>}
        {children}
      </div>
    </div>, document.body
  );
}

export const Field = ({ label, ...p }: InputHTMLAttributes<HTMLInputElement> & { label: string }) => (
  <label className="block">
    <span className="mb-1.5 block text-sm text-muted">{label}</span>
    <input {...p} className="h-12 w-full rounded-xl bg-sunken px-4 text-[15px] outline-none ring-accent/40 transition focus:ring-2" />
  </label>
);

export const Badge = ({ tone = "muted", children }: { tone?: "ok" | "warn" | "bad" | "muted"; children: ReactNode }) => (
  <span className={cx("rounded-full px-2.5 py-0.5 text-xs font-medium",
    tone === "ok" && "bg-ok/15 text-ok", tone === "warn" && "bg-warn/15 text-warn", tone === "bad" && "bg-bad/15 text-bad", tone === "muted" && "bg-sunken text-muted")}>{children}</span>
);

export const Err = ({ children }: { children?: ReactNode }) => children ? <p className="rounded-xl bg-bad/10 px-3 py-2 text-sm text-bad">{children}</p> : null;

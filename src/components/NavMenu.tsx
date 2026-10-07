// src/components/NavMenu.tsx
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { NavLink } from "react-router-dom";
import { cx } from "./ui";
import Icon, { type IconName } from "./Icon";
import { primaryRole, useAuth } from "../lib/auth";
import { MENU_EXTRA } from "../lib/nav";

export type NavItem = [to: string, label: string, icon: IconName];

export default function NavMenu() {
  const { roles } = useAuth();
  const role = primaryRole(roles);
  const [open, setOpen] = useState(false); const [closing, setClosing] = useState(false);
  const closeRef = useRef<HTMLButtonElement>(null);
  // The bottom bar lists the tabs and the avatar opens Profile (theme, password, sign out), so the drawer only holds what is left over.
  const items = MENU_EXTRA[role] ?? [];

  const close = useCallback(() => { setClosing(true); setTimeout(() => { setOpen(false); setClosing(false); }, 200); }, []);

  useEffect(() => {
    if (!open) return;
    const k = (e: KeyboardEvent) => e.key === "Escape" && close();
    addEventListener("keydown", k); document.body.style.overflow = "hidden"; closeRef.current?.focus();
    return () => { removeEventListener("keydown", k); document.body.style.overflow = ""; };
  }, [open, close]);

  if (items.length === 0) return null;
  return (
    <>
      <button onClick={() => setOpen(true)} aria-label="Open menu" aria-expanded={open} className="group grid h-10 w-10 place-items-center rounded-full transition hover:bg-sunken active:scale-95">
        <span className="flex w-[18px] flex-col items-end gap-[5px]" aria-hidden="true">
          <span className="h-[2px] w-full rounded-full bg-current" />
          <span className="h-[2px] w-3/4 rounded-full bg-current transition-all group-hover:w-full" />
          <span className="h-[2px] w-1/2 rounded-full bg-current transition-all group-hover:w-full" />
        </span>
      </button>
      {open && createPortal(
        <div className="fixed inset-0 z-50" role="dialog" aria-modal="true" aria-label="Menu">
          <div className={cx("absolute inset-0 bg-black/50 backdrop-blur-sm", closing ? "anim-fade-out" : "anim-fade")} onClick={close} />
          <aside className={cx("absolute inset-y-0 right-0 flex w-[85%] max-w-xs flex-col rounded-l-3xl bg-surface p-4 shadow-2xl ring-1 ring-line", closing ? "anim-slide-out" : "anim-slide")}
            style={{ paddingTop: "calc(1rem + env(safe-area-inset-top))", paddingBottom: "calc(1rem + env(safe-area-inset-bottom))" }}>
            <div className="mb-4 flex items-center justify-between">
              <span className="px-1 text-[13px] font-semibold uppercase tracking-wider text-muted">Menu</span>
              <button ref={closeRef} onClick={close} aria-label="Close menu" className="grid h-9 w-9 place-items-center rounded-full text-muted transition hover:bg-sunken active:scale-95">
                <Icon name="close" size={18} />
              </button>
            </div>
            <nav className="space-y-1 overflow-y-auto">
              {items.map(([to, label, icon]) => (
                <NavLink key={to} to={to} end onClick={close}
                  className={({ isActive }) => cx("flex items-center gap-3 rounded-xl px-3 py-3 text-[15px] transition active:scale-[.98]", isActive ? "bg-accent/10 font-medium text-accent" : "hover:bg-sunken")}>
                  {({ isActive }) => <><span className={cx("grid h-9 w-9 place-items-center rounded-lg transition", isActive ? "bg-accent/15 text-accent" : "bg-sunken text-muted")}><Icon name={icon} size={20} /></span>{label}</>}
                </NavLink>))}
            </nav>
            <div className="flex-1" />
            <p className="px-1 text-xs leading-relaxed text-muted/80">
              IQ Academy is{" "}
              <a href="https://promptiq.com.ng?utm_source=academy_app&utm_medium=menu" target="_blank" rel="noopener noreferrer" className="underline decoration-line underline-offset-2 transition hover:text-ink">PromptIQ</a>
              's school. Learn AI from the team that builds with it.
            </p>
          </aside>
        </div>, document.body)}
    </>
  );
}

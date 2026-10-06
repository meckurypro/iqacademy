// src/components/Sidebar.tsx — desktop navigation. Replaces the phone header, hamburger drawer and bottom tabs at >= 1024px.
// Collapses to an icon rail (remembered; starts collapsed on small laptops). Press "[" to toggle.
import { useCallback, useEffect, useState, type SyntheticEvent } from "react";
import { createPortal } from "react-dom";
import { Link, NavLink, useLocation } from "react-router-dom";
import Icon, { type IconName } from "./Icon";
import { Avatar, cx } from "./ui";
import { useFeedback } from "./feedback";
import { primaryRole, roleLabel, useAuth } from "../lib/auth";
import { supabase } from "../lib/supabase";
import { SIDEBAR } from "../lib/nav";
import { useNotificationCount } from "../lib/notifications";
import { useUnreadMessages } from "../lib/messages";
import { useTheme, type ThemePref } from "../lib/theme";

const KEY = "sidebar";
export const SIDEBAR_OPEN = "16rem";
export const SIDEBAR_RAIL = "4.5rem";

export function useSidebar(): [collapsed: boolean, toggle: () => void] {
  const [collapsed, setCollapsed] = useState<boolean>(() => {
    try { const v = localStorage.getItem(KEY); if (v === "collapsed") return true; if (v === "open") return false; } catch { /* storage unavailable */ }
    return innerWidth < 1280;
  });
  const toggle = useCallback(() => setCollapsed((c) => {
    const n = !c;
    try { localStorage.setItem(KEY, n ? "collapsed" : "open"); } catch { /* storage unavailable */ }
    return n;
  }), []);
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if (e.key !== "[" || e.metaKey || e.ctrlKey || e.altKey) return;
      const el = e.target as HTMLElement | null;
      if (el && (/^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) || el.isContentEditable)) return;
      toggle();
    };
    addEventListener("keydown", k); return () => removeEventListener("keydown", k);
  }, [toggle]);
  return [collapsed, toggle];
}

type Badge = { n: number; tone: "bad" | "warn" } | undefined;
type TipFn = (label: string) => { onMouseEnter: (e: SyntheticEvent<HTMLElement>) => void; onMouseLeave: () => void; onFocus: (e: SyntheticEvent<HTMLElement>) => void; onBlur: () => void };

const Pill = ({ b }: { b: NonNullable<Badge> }) => (
  <span className={cx("num grid h-5 min-w-5 place-items-center rounded-full px-1.5 text-[11px] font-semibold", b.tone === "bad" ? "bg-bad text-white" : "bg-warn/15 text-warn")}>{b.n > 99 ? "99+" : b.n}</span>
);

function Row({ to, label, icon, collapsed, badge, tip }: { to: string; label: string; icon: IconName; collapsed: boolean; badge?: Badge; tip: TipFn }) {
  return (
    <NavLink to={to} end={to === "/"} aria-label={collapsed ? (badge ? `${label}, ${badge.n}` : label) : undefined} {...tip(label)}
      className={({ isActive }) => cx("relative flex h-10 items-center rounded-xl text-[14px] transition", collapsed ? "justify-center" : "gap-3 px-3",
        isActive ? "bg-accent/10 font-medium text-accent" : "text-ink/75 hover:bg-sunken hover:text-ink")}>
      {({ isActive }) => <>
        <span className="relative grid h-6 w-6 shrink-0 place-items-center">
          <Icon name={icon} size={20} solid={isActive} />
          {collapsed && badge && badge.n > 0 && <span className={cx("absolute -right-0.5 -top-0.5 h-2.5 w-2.5 rounded-full ring-2 ring-surface", badge.tone === "bad" ? "bg-bad" : "bg-warn")} />}
        </span>
        {!collapsed && <><span className="min-w-0 flex-1 truncate">{label}</span>{badge && badge.n > 0 && <Pill b={badge} />}</>}
      </>}
    </NavLink>
  );
}

function Action({ label, icon, collapsed, onClick, tip, hint, danger }: { label: string; icon: IconName; collapsed: boolean; onClick: () => void; tip: TipFn; hint?: string; danger?: boolean }) {
  return (
    <button onClick={onClick} aria-label={collapsed ? label : undefined} {...tip(hint ? `${label}  ${hint}` : label)}
      className={cx("flex h-10 w-full items-center rounded-xl text-[14px] text-muted transition hover:bg-sunken", danger ? "hover:text-bad" : "hover:text-ink", collapsed ? "justify-center" : "gap-3 px-3")}>
      <span className="grid h-6 w-6 shrink-0 place-items-center"><Icon name={icon} size={20} /></span>
      {!collapsed && <><span className="min-w-0 flex-1 truncate text-left">{label}</span>{hint && <kbd className="rounded-md bg-sunken px-1.5 py-0.5 font-sans text-[11px] text-muted ring-1 ring-line">{hint}</kbd>}</>}
    </button>
  );
}

const THEME_NEXT: Record<ThemePref, ThemePref> = { light: "dark", dark: "system", system: "light" };
const THEME_ICON: Record<ThemePref, IconName> = { light: "sun", dark: "moon", system: "monitor" };
const THEME_LABEL: Record<ThemePref, string> = { light: "Light", dark: "Dark", system: "System" };

export default function Sidebar({ collapsed, onToggle }: { collapsed: boolean; onToggle: () => void }) {
  const { name, avatar, roles } = useAuth();
  const role = primaryRole(roles);
  const sections = SIDEBAR[role] ?? SIDEBAR.student;
  const { run } = useFeedback();
  const { pathname } = useLocation();
  const [theme, setTheme] = useTheme();
  const notes = useNotificationCount();
  const unread = useUnreadMessages();
  const admin = role === "admin" || role === "super_admin";
  const [offline, setOffline] = useState(0);
  useEffect(() => {
    if (!admin) return;
    supabase.rpc("offline_payment_counts").then((r) => setOffline((r.data as { open?: number } | null)?.open ?? 0));
  }, [admin, pathname]);

  // One shared tooltip for the icon rail, drawn in a portal so the scrolling nav can't clip it.
  const [tipState, setTipState] = useState<{ label: string; top: number; left: number } | null>(null);
  const tip: TipFn = (label) => {
    const show = (e: SyntheticEvent<HTMLElement>) => {
      if (!collapsed) return;
      const r = e.currentTarget.getBoundingClientRect();
      setTipState({ label, top: r.top + r.height / 2, left: r.right + 10 });
    };
    return { onMouseEnter: show, onFocus: show, onMouseLeave: () => setTipState(null), onBlur: () => setTipState(null) };
  };
  useEffect(() => { if (!collapsed) setTipState(null); }, [collapsed]);

  const badgeFor = (to: string): Badge =>
    to === "/messages" && role === "student" ? { n: unread, tone: "bad" } : to === "/offline-payments" ? { n: offline, tone: "warn" } : undefined;

  return (
    <aside aria-label="Sidebar" style={{ width: "var(--sbw)" }}
      className="fixed inset-y-0 left-0 z-40 flex flex-col border-r border-line bg-surface/75 backdrop-blur-xl transition-[width] duration-200 ease-out">
      <Link to="/" aria-label="IQ Academy home" className={cx("flex h-16 shrink-0 items-center gap-2.5 font-semibold tracking-tight", collapsed ? "justify-center" : "px-5")}>
        <img src="/icon-192.png" alt="" className="h-9 w-9 shrink-0 rounded-[10px]" />
        {!collapsed && <span className="text-xl leading-none">Academy</span>}
      </Link>

      <nav aria-label="Main" className="flex-1 space-y-5 overflow-y-auto overflow-x-hidden px-3 py-2">
        {sections.map((s, i) => (
          <div key={i} className="space-y-0.5">
            {s.title && (collapsed ? <div className="mx-2 mb-2 border-t border-line" /> : <p className="px-3 pb-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted">{s.title}</p>)}
            {s.items.map(([to, label, icon]) => <Row key={to} to={to} label={label} icon={icon} collapsed={collapsed} badge={badgeFor(to)} tip={tip} />)}
          </div>))}
      </nav>

      <div className="shrink-0 space-y-0.5 border-t border-line p-3">
        <Row to="/notifications" label="Notifications" icon="bell" collapsed={collapsed} badge={{ n: notes, tone: "bad" }} tip={tip} />
        <NavLink to="/profile" aria-label={collapsed ? `Profile, ${name}` : undefined} {...tip(name || "Profile")}
          className={({ isActive }) => cx("flex items-center rounded-xl transition", collapsed ? "justify-center py-2" : "gap-3 px-3 py-2", isActive ? "bg-accent/10" : "hover:bg-sunken")}>
          <Avatar name={name || "?"} url={avatar} size={collapsed ? 32 : 36} />
          {!collapsed && <span className="min-w-0 flex-1 leading-tight"><span className="block truncate text-[14px] font-medium">{name}</span><span className="block text-xs text-muted">{roleLabel[role]}</span></span>}
        </NavLink>
        <Action label={`Theme: ${THEME_LABEL[theme]}`} icon={THEME_ICON[theme]} collapsed={collapsed} onClick={() => setTheme(THEME_NEXT[theme])} tip={tip} />
        <Action label="Sign out" icon="arrowLeft" collapsed={collapsed} danger tip={tip} onClick={() => run("Signing out…", () => supabase.auth.signOut())} />
        <Action label={collapsed ? "Expand sidebar" : "Collapse"} hint="[" icon={collapsed ? "chevronRight" : "chevronLeft"} collapsed={collapsed} onClick={onToggle} tip={tip} />
      </div>

      {collapsed && tipState && createPortal(
        <div role="tooltip" style={{ top: tipState.top, left: tipState.left }}
          className="pointer-events-none fixed z-[60] -translate-y-1/2 whitespace-nowrap rounded-lg bg-ink px-2.5 py-1.5 text-xs font-medium text-bg shadow-lift">{tipState.label}</div>, document.body)}
    </aside>
  );
}

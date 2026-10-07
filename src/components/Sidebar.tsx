// src/components/Sidebar.tsx — desktop navigation. Replaces the phone header, hamburger drawer and bottom tabs at >= 1024px.
// Icon rail by default: hovering (or keyboard-focusing) it expands it over the page to show labels, leaving collapses it again.
// The hamburger (or "[") pins it open so it stays expanded; the pin is remembered and starts off on small laptops.
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
type TipFn = (label: string, always?: boolean) => { onMouseEnter: (e: SyntheticEvent<HTMLElement>) => void; onMouseLeave: () => void; onFocus: (e: SyntheticEvent<HTMLElement>) => void; onBlur: () => void };

const Pill = ({ b }: { b: NonNullable<Badge> }) => (
  <span className={cx("num grid h-5 min-w-5 place-items-center rounded-full px-1.5 text-[11px] font-semibold", b.tone === "bad" ? "bg-bad text-white" : "bg-warn/15 text-warn")}>{b.n > 99 ? "99+" : b.n}</span>
);

function Row({ to, label, icon, collapsed, badge, tip }: { to: string; label: string; icon: IconName; collapsed: boolean; badge?: Badge; tip: TipFn }) {
  return (
    <NavLink to={to} end={to === "/"} aria-label={collapsed ? (badge ? `${label}, ${badge.n}` : label) : undefined} {...tip(label)}
      className={({ isActive }) => cx("relative flex h-9 items-center rounded-xl text-[14px] transition", collapsed ? "justify-center" : "gap-3 px-3",
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

const iconBtn = "relative grid h-9 w-9 shrink-0 place-items-center rounded-xl text-muted transition hover:bg-sunken hover:text-ink";
function IconButton({ label, icon, onClick, tip, hint, danger }: { label: string; icon: IconName; onClick: () => void; tip: TipFn; hint?: string; danger?: boolean }) {
  return (
    <button onClick={onClick} aria-label={label} {...tip(hint ? `${label}  ${hint}` : label, true)} className={cx(iconBtn, danger && "hover:text-bad")}>
      <Icon name={icon} size={20} />
    </button>
  );
}

const THEME_NEXT: Record<ThemePref, ThemePref> = { light: "dark", dark: "system", system: "light" };
const THEME_ICON: Record<ThemePref, IconName> = { light: "sun", dark: "moon", system: "monitor" };
const THEME_LABEL: Record<ThemePref, string> = { light: "Light", dark: "Dark", system: "System" };

export default function Sidebar({ collapsed: pinnedCollapsed, onToggle }: { collapsed: boolean; onToggle: () => void }) {
  // `pinnedCollapsed` is the remembered state (what the page layout reserves room for). While the rail is hovered or
  // keyboard-focused it expands on top of the page without pushing the content; `collapsed` is what is actually drawn.
  const [peek, setPeek] = useState(false);
  const collapsed = pinnedCollapsed && !peek;
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
  const tip: TipFn = (label, always) => {
    const show = (e: SyntheticEvent<HTMLElement>) => {
      if (!collapsed && !always) return;
      const r = e.currentTarget.getBoundingClientRect();
      setTipState({ label, top: r.top + r.height / 2, left: r.right + 10 });
    };
    return { onMouseEnter: show, onFocus: show, onMouseLeave: () => setTipState(null), onBlur: () => setTipState(null) };
  };
  useEffect(() => { setTipState(null); }, [collapsed]);

  const badgeFor = (to: string): Badge =>
    to === "/messages" && role === "student" ? { n: unread, tone: "bad" } : to === "/offline-payments" ? { n: offline, tone: "warn" } : undefined;

  return (
    <aside aria-label="Sidebar" style={{ width: collapsed ? SIDEBAR_RAIL : SIDEBAR_OPEN }}
      onMouseEnter={() => setPeek(true)} onMouseLeave={() => setPeek(false)}
      onFocus={(e) => { if (e.target.matches(":focus-visible")) setPeek(true); }}
      onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setPeek(false); }}
      className={cx("fixed inset-y-0 left-0 z-40 flex flex-col overflow-hidden border-r border-line bg-surface/75 backdrop-blur-xl transition-[width,box-shadow] duration-200 ease-out", pinnedCollapsed && !collapsed && "shadow-lift")}>
      <div className={cx("flex h-16 shrink-0 items-center", collapsed ? "justify-center" : "gap-1 px-3")}>
        <button onClick={onToggle} aria-label={pinnedCollapsed ? "Keep sidebar open" : "Let sidebar collapse"} aria-pressed={!pinnedCollapsed} title="[" className={cx(iconBtn, !pinnedCollapsed && "text-accent")}>
          <Icon name="menu" size={22} />
        </button>
        {!collapsed && (
          <Link to="/" aria-label="IQ Academy home" className="flex min-w-0 items-center gap-2.5 pl-1 font-semibold tracking-tight">
            <img src="/icon-192.png" alt="" className="h-9 w-9 shrink-0 rounded-[10px]" />
            <span className="text-xl leading-none">Academy</span>
          </Link>)}
      </div>

      <nav aria-label="Main" className="flex-1 space-y-4 overflow-y-auto overflow-x-hidden px-3 py-2">
        {sections.map((s, i) => (
          <div key={i} className="space-y-0.5">
            {s.title && (collapsed ? <div className="mx-2 mb-2 border-t border-line" /> : <p className="px-3 pb-1 text-[11px] font-semibold uppercase tracking-wider text-muted">{s.title}</p>)}
            {s.items.map(([to, label, icon]) => <Row key={to} to={to} label={label} icon={icon} collapsed={collapsed} badge={badgeFor(to)} tip={tip} />)}
          </div>))}
      </nav>

      <div className="shrink-0 space-y-2 border-t border-line p-3">
        <NavLink to="/profile" aria-label={collapsed ? `Profile, ${name}` : undefined} {...tip(name || "Profile")}
          className={({ isActive }) => cx("flex items-center rounded-xl transition", collapsed ? "justify-center py-1.5" : "gap-3 px-2 py-1.5", isActive ? "bg-accent/10" : "hover:bg-sunken")}>
          <Avatar name={name || "?"} url={avatar} size={collapsed ? 32 : 36} />
          {!collapsed && <span className="min-w-0 flex-1 leading-tight"><span className="block truncate text-[14px] font-medium">{name}</span><span className="block text-xs text-muted">{roleLabel[role]}</span></span>}
        </NavLink>
        <div className={cx("flex gap-1", collapsed ? "flex-col items-center" : "justify-between px-1")}>
          <NavLink to="/notifications" aria-label={notes ? `Notifications, ${notes} unread` : "Notifications"} {...tip("Notifications", true)}
            className={({ isActive }) => cx(iconBtn, isActive && "bg-accent/10 text-accent")}>
            {({ isActive }) => <><Icon name="bell" size={20} solid={isActive} />
              {notes > 0 && <span className="num absolute -right-0.5 -top-0.5 grid h-4 min-w-4 place-items-center rounded-full bg-bad px-1 text-[10px] font-semibold leading-none text-white ring-2 ring-surface">{notes > 99 ? "99+" : notes}</span>}</>}
          </NavLink>
          <IconButton label={`Theme: ${THEME_LABEL[theme]}. Switch to ${THEME_LABEL[THEME_NEXT[theme]]}`} icon={THEME_ICON[theme]} onClick={() => setTheme(THEME_NEXT[theme])} tip={tip} />
          <IconButton label="Sign out" icon="arrowLeft" danger tip={tip} onClick={() => run("Signing out…", () => supabase.auth.signOut())} />
        </div>
      </div>

      {tipState && createPortal(
        <div role="tooltip" style={{ top: tipState.top, left: tipState.left }}
          className="pointer-events-none fixed z-[60] -translate-y-1/2 whitespace-nowrap rounded-lg bg-ink px-2.5 py-1.5 text-xs font-medium text-bg shadow-lift">{tipState.label}</div>, document.body)}
    </aside>
  );
}

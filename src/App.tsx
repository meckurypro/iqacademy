// src/App.tsx
import { useCallback, useEffect, useState } from "react";
import { Navigate, NavLink, Route, Routes, Link, useLocation, useNavigate } from "react-router-dom";
import { useAuth, primaryRole } from "./lib/auth";
import { getPending, clearPending } from "./lib/verify";
import { supabase } from "./lib/supabase";
import { Skeleton } from "./components/ui";
import NavMenu from "./components/NavMenu";
import ErrorBoundary from "./components/ErrorBoundary";
import ClockNotice, { useClockSync } from "./components/ClockWatch";
import VerifyEmail from "./pages/VerifyEmail";
import Login from "./pages/Login";
import Landing from "./pages/Landing";
import Enrol from "./pages/Enrol";
import StudentHome from "./pages/StudentHome";
import StaffHome from "./pages/StaffHome";
import PayCallback from "./pages/PayCallback";
import InstructorHome from "./pages/InstructorHome";
import InstructorHistory from "./pages/InstructorHistory";
import ClassScreen from "./pages/ClassScreen";
import AdminHome from "./pages/AdminHome";
import Users from "./pages/Users";
import Announce from "./pages/Announce";
import Profile from "./pages/Profile";
import ResetPassword from "./pages/ResetPassword";
import CoordinatorHome from "./pages/CoordinatorHome";
import DirectorHome from "./pages/DirectorHome";
import Manage from "./pages/Manage";
import Centres from "./pages/Centres";
import Schedule from "./pages/Schedule";
import Roster from "./pages/Roster";
import CustomClasses from "./pages/CustomClasses";
import MyClasses from "./pages/MyClasses";
import Payouts from "./pages/Payouts";
import Prices from "./pages/Prices";
import OfflinePayments from "./pages/OfflinePayments";
import OfflinePay from "./pages/OfflinePay";
import CourseBuilder from "./pages/CourseBuilder";
import Payments from "./pages/Payments";
import Team from "./pages/Team";
import Instructors from "./pages/Instructors";
import Notifications from "./pages/Notifications";
import Messages from "./pages/Messages";
import InstructorMessages from "./pages/InstructorMessages";
import ClassMessagesAdmin from "./pages/ClassMessagesAdmin";
import { useUnreadMessages } from "./lib/messages";

import Icon, { type IconName } from "./components/Icon";
// The bell only shows the unread count; the list itself lives on the /notifications page.
function Bell() {
  const { session } = useAuth();
  const [count, setCount] = useState(0);
  const load = useCallback(() => { supabase.rpc("unread_notification_count").then((c) => setCount((c.data as number) ?? 0)); }, []);

  useEffect(() => {
    if (!session) return;
    load();
    const ch = supabase.channel("my-notes")
      .on("postgres_changes", { event: "*", schema: "public", table: "notifications", filter: `user_id=eq.${session.user.id}` }, load)
      .subscribe();
    return () => { supabase.removeChannel(ch); };
  }, [session, load]);

  return (
    <NavLink to="/notifications" aria-label={count > 0 ? `Notifications, ${count} unread` : "Notifications"}
      className={({ isActive }) => `relative grid h-10 w-10 place-items-center rounded-full text-ink/80 transition hover:bg-sunken ${isActive ? "bg-sunken text-ink" : ""}`}>
      <Icon name="bell" size={21} />
      {count > 0 && <span className="anim-pop absolute right-1 top-1 grid h-4 min-w-4 place-items-center rounded-full bg-bad px-1 text-[10px] font-semibold text-white">{count > 99 ? "99+" : count}</span>}
    </NavLink>
  );
}

function UnreadDot() {
  const n = useUnreadMessages();
  return n > 0 ? <span className="anim-pop absolute right-1 top-0 grid h-4 min-w-4 place-items-center rounded-full bg-bad px-1 text-[10px] font-semibold text-white">{n > 99 ? "99+" : n}</span> : null;
}

const NAV: Record<string, [string, string, IconName][]> = {
  student: [["/", "Home", "home"], ["/messages", "Messages", "messages"]],
  instructor: [["/", "Today", "today"], ["/my-classes", "My classes", "classes"], ["/schedule", "Schedule", "schedule"], ["/history", "History", "history"], ["/messages", "Messages", "messages"]],
  admin: [["/", "Overview", "overview"], ["/users", "Users", "users"], ["/announce", "Announce", "announce"], ["/manage", "Manage", "manage"]],
};
NAV.super_admin = NAV.admin;

function TabBar({ role }: { role: string }) {
  const items = NAV[role];
  if (!items) return null;
  return (
    <nav aria-label="Main" className="fixed inset-x-0 bottom-0 z-30 border-t border-line bg-surface/90 pb-[env(safe-area-inset-bottom)] backdrop-blur-md">
      <div className="mx-auto flex max-w-2xl px-2 pt-1.5">
        {items.map(([to, label, icon]) => (
          <NavLink key={to} to={to} end className={({ isActive }) => `group flex min-w-0 flex-1 flex-col items-center gap-0.5 pb-2 text-[11px] font-medium transition ${isActive ? "text-accent" : "text-muted hover:text-ink"}`}>
            {({ isActive }) => <><span className={`relative grid h-8 w-14 place-items-center rounded-full transition ${isActive ? "bg-accent/10" : "group-active:bg-sunken"}`}><Icon name={icon} size={22} solid={isActive} />{role === "student" && to === "/messages" && <UnreadDot />}</span><span className="max-w-full truncate px-1">{label}</span></>}
          </NavLink>))}
      </div>
    </nav>
  );
}

function Shell({ children, skew }: { children: React.ReactNode; skew: number }) {
  const { roles } = useAuth();
  const { pathname } = useLocation();
  return (
    <div className="mx-auto min-h-screen max-w-2xl px-4 pb-28">
      <header className="sticky top-0 z-30 -mx-4 mb-5 flex items-center gap-1 bg-bg/85 px-4 py-2.5 backdrop-blur-md">
        <Link to="/" className="flex items-center gap-2.5 font-semibold tracking-tight"><img src="/icon-192.png" alt="" className="h-9 w-9 rounded-[10px]" /><span className="text-xl leading-none">Academy</span></Link>
        <div className="flex-1" />
        <Bell />
        <NavMenu tabs={NAV[primaryRole(roles)]} />
      </header>
      <ClockNotice skew={skew} />
      <ErrorBoundary resetKey={pathname}>{children}</ErrorBoundary>
      <TabBar role={primaryRole(roles)} />
    </div>
  );
}

// Right after a new user confirms their email (in this tab or another), show the "you're verified" screen once.
function VerifyRedirect() {
  const { session } = useAuth(); const nav = useNavigate(); const { pathname } = useLocation();
  useEffect(() => {
    const p = getPending(); if (!p || !session) return;
    if (p.email !== session.user.email?.toLowerCase()) return clearPending();
    if (pathname !== "/verify-email") nav("/verify-email", { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session]);
  return null;
}

// Signing out leaves the address bar on whatever page you were on (usually /profile), so the next sign-in would land
// there. Send signed-out visitors back to the root so a fresh sign-in always opens the dashboard.
function SignedOutReset() {
  const nav = useNavigate(); const { pathname } = useLocation();
  useEffect(() => {
    if (pathname !== "/" && pathname !== "/login" && pathname !== "/reset-password" && pathname !== "/verify-email") nav("/", { replace: true });
  }, [pathname, nav]);
  return null;
}

export default function App() {
  const { session, loading, roles } = useAuth();
  const { ready: clockReady, skew } = useClockSync(!!session);
  if (loading || (session && !clockReady)) return <div className="mx-auto max-w-3xl space-y-3 p-6"><Skeleton className="h-10" /><Skeleton className="h-40" /></div>;
  if (!session) return <><SignedOutReset /><Routes><Route path="/reset-password" element={<ResetPassword />} /><Route path="/verify-email" element={<VerifyEmail />} /><Route path="/login" element={<Login />} /><Route path="/" element={<Landing />} /><Route path="*" element={<Navigate to="/" replace />} /></Routes></>;
  const role = primaryRole(roles);
  const home = role === "student" ? <StudentHome /> : role === "instructor" ? <InstructorHome /> : role === "admin" || role === "super_admin" ? <AdminHome /> : role === "coordinator" ? <CoordinatorHome /> : role === "centre_director" ? <DirectorHome /> : <StaffHome />;
  return (
    <>
    <VerifyRedirect />
    <Routes>
      <Route path="/reset-password" element={<ResetPassword />} />
      <Route path="/verify-email" element={<VerifyEmail />} />
      <Route path="*" element={
    <Shell skew={skew}>
      <Routes>
        <Route path="/" element={home} />
        <Route path="/history" element={<InstructorHistory />} />
        <Route path="/class/:id" element={<ClassScreen />} />
        <Route path="/users" element={<Users />} />
        <Route path="/announce" element={<Announce />} />
        <Route path="/notifications" element={<Notifications />} />
        <Route path="/messages" element={role === "student" ? <Messages /> : role === "instructor" ? <InstructorMessages /> : <Navigate to="/" replace />} />
        <Route path="/class-messages" element={role === "admin" || role === "super_admin" ? <ClassMessagesAdmin /> : <Navigate to="/" replace />} />
        <Route path="/profile" element={<Profile />} />
        <Route path="/manage" element={<Manage />} />
        <Route path="/centres" element={<Centres />} />
        <Route path="/roster" element={role === "admin" || role === "super_admin" ? <Roster /> : <Navigate to="/" replace />} />
        <Route path="/custom" element={role === "admin" || role === "super_admin" || role === "instructor" ? <CustomClasses /> : <Navigate to="/" replace />} />
        <Route path="/emergency" element={<Navigate to="/custom" replace />} />
        <Route path="/my-classes" element={role === "instructor" ? <MyClasses /> : <Navigate to="/" replace />} />
        <Route path="/schedule" element={role === "student" ? <Navigate to="/" replace /> : <Schedule />} />
        <Route path="/payouts" element={<Payouts />} />
        <Route path="/prices" element={<Prices />} />
        <Route path="/courses" element={<CourseBuilder />} />
        <Route path="/courses/:id" element={<CourseBuilder />} />
        <Route path="/payments" element={<Payments />} />
        <Route path="/offline-payments" element={<OfflinePayments />} />
        <Route path="/pay/offline/:id" element={<OfflinePay />} />
        <Route path="/team" element={<Team />} />
        <Route path="/team/:centreId" element={<Team />} />
        <Route path="/instructors" element={<Instructors />} />
        <Route path="/enrol" element={<Enrol />} />
        <Route path="/pay/callback" element={<PayCallback />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </Shell>
      } />
    </Routes>
    </>
  );
}

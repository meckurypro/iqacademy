// src/App.tsx
import { useCallback, useEffect, useState } from "react";
import { Navigate, NavLink, Route, Routes, Link, useLocation, useNavigate } from "react-router-dom";
import { useAuth, primaryRole } from "./lib/auth";
import { getPending, clearPending } from "./lib/verify";
import { supabase } from "./lib/supabase";
import { Skeleton } from "./components/ui";
import NavMenu from "./components/NavMenu";
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
      className={({ isActive }) => `relative grid h-10 w-10 place-items-center rounded-full hover:bg-sunken ${isActive ? "bg-sunken" : ""}`}>
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M6 8a6 6 0 1 1 12 0c0 7 3 8 3 8H3s3-1 3-8M10 20a2 2 0 0 0 4 0" /></svg>
      {count > 0 && <span className="anim-pop absolute right-1 top-1 grid h-4 min-w-4 place-items-center rounded-full bg-bad px-1 text-[10px] font-semibold text-white">{count > 99 ? "99+" : count}</span>}
    </NavLink>
  );
}

function UnreadDot() {
  const n = useUnreadMessages();
  return n > 0 ? <span className="anim-pop absolute -right-2.5 -top-1 grid h-4 min-w-4 place-items-center rounded-full bg-bad px-1 text-[10px] font-semibold text-white">{n > 99 ? "99+" : n}</span> : null;
}

const NAV: Record<string, [string, string, string][]> = {
  student: [["/", "Home", "🏠"], ["/messages", "Messages", "💬"]],
  instructor: [["/", "Today", "📅"], ["/schedule", "Schedule", "🗓️"], ["/history", "History", "🕘"], ["/messages", "Messages", "💬"]],
  admin: [["/", "Overview", "📊"], ["/users", "Users", "👥"], ["/announce", "Announce", "📣"], ["/manage", "Manage", "⚙️"]],
};
NAV.super_admin = NAV.admin;

function TabBar({ role }: { role: string }) {
  const items = NAV[role];
  if (!items) return null;
  return (
    <nav className="fixed inset-x-0 bottom-0 z-30 border-t border-line bg-surface/90 pb-[env(safe-area-inset-bottom)] backdrop-blur-md">
      <div className="mx-auto flex max-w-3xl">
        {items.map(([to, label, icon]) => (
          <NavLink key={to} to={to} end className={({ isActive }) => `flex flex-1 flex-col items-center gap-0.5 py-2.5 text-xs transition ${isActive ? "font-semibold text-accent" : "text-muted"}`}>
            <span className="relative text-lg leading-none">{icon}{role === "student" && to === "/messages" && <UnreadDot />}</span>{label}
          </NavLink>))}
      </div>
    </nav>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  const { roles } = useAuth();
  return (
    <div className="mx-auto min-h-screen max-w-3xl px-4 pb-24">
      <header className="sticky top-0 z-30 -mx-4 mb-4 flex items-center gap-1 bg-bg/80 px-4 py-3 backdrop-blur-md">
        <Link to="/" className="flex items-center gap-2.5 font-semibold tracking-tight"><img src="/icon-192.png" alt="" className="h-11 w-11 rounded-xl" /><span className="relative top-[2px] text-[33.4px] leading-[44px]">Academy</span></Link>
        <div className="flex-1" />
        <Bell />
        <NavMenu tabs={NAV[primaryRole(roles)]} />
      </header>
      {children}
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
  if (loading) return <div className="mx-auto max-w-3xl space-y-3 p-6"><Skeleton className="h-10" /><Skeleton className="h-40" /></div>;
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
    <Shell>
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

// src/App.tsx
import { useCallback, useEffect, useState } from "react";
import { Navigate, NavLink, Route, Routes, Link, useLocation, useNavigate } from "react-router-dom";
import { useAuth, primaryRole } from "./lib/auth";
import { getPending, clearPending } from "./lib/verify";
import { supabase } from "./lib/supabase";
import { Sheet, Skeleton } from "./components/ui";
import NavMenu from "./components/NavMenu";
import VerifyEmail from "./pages/VerifyEmail";
import Login from "./pages/Login";
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
import Cohorts from "./pages/Cohorts";
import Payouts from "./pages/Payouts";
import Payments from "./pages/Payments";
import Team from "./pages/Team";
import Instructors from "./pages/Instructors";

type Note = { id: string; title: string; body: string | null; read_at: string | null; created_at: string };

function Bell() {
  const { session } = useAuth();
  const [open, setOpen] = useState(false);
  const [count, setCount] = useState(0);
  const [notes, setNotes] = useState<Note[] | null>(null);

  const load = useCallback(async () => {
    const [c, n] = await Promise.all([
      supabase.rpc("unread_notification_count"),
      supabase.from("notifications").select("id,title,body,read_at,created_at").order("created_at", { ascending: false }).limit(25),
    ]);
    setCount((c.data as number) ?? 0); setNotes((n.data as Note[]) ?? []);
  }, []);

  useEffect(() => {
    if (!session) return;
    load();
    const ch = supabase.channel("my-notes")
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "notifications", filter: `user_id=eq.${session.user.id}` }, load)
      .subscribe();
    return () => { supabase.removeChannel(ch); };
  }, [session, load]);

  const show = async () => { setOpen(true); await supabase.rpc("mark_notifications_read"); setCount(0); };
  return (
    <>
      <button onClick={show} aria-label="Notifications" className="relative grid h-10 w-10 place-items-center rounded-full hover:bg-sunken">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M6 8a6 6 0 1 1 12 0c0 7 3 8 3 8H3s3-1 3-8M10 20a2 2 0 0 0 4 0" /></svg>
        {count > 0 && <span className="anim-pop absolute right-1 top-1 grid h-4 min-w-4 place-items-center rounded-full bg-bad px-1 text-[10px] font-semibold text-white">{count}</span>}
      </button>
      <Sheet open={open} onClose={() => setOpen(false)} title="Notifications">
        <div className="max-h-[60vh] space-y-2 overflow-y-auto">
          {notes === null ? <Skeleton className="h-16" /> : notes.length === 0 ? <p className="py-8 text-center text-muted">You're all caught up.</p> :
            notes.map((n) => (
              <div key={n.id} className="rounded-xl bg-sunken p-3">
                <p className="font-medium">{n.title}</p>{n.body && <p className="mt-0.5 text-sm text-muted">{n.body}</p>}
                <p className="mt-1 text-xs text-muted">{new Date(n.created_at).toLocaleString()}</p>
              </div>))}
        </div>
      </Sheet>
    </>
  );
}

const NAV: Record<string, [string, string, string][]> = {
  instructor: [["/", "Today", "📅"], ["/history", "History", "🕘"]],
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
            <span className="text-lg leading-none">{icon}</span>{label}
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
        <Link to="/" className="flex items-center gap-2.5 font-semibold tracking-tight"><img src="/icon-192.png" alt="" className="h-11 w-11 rounded-xl" /><span className="relative -top-[2px] text-[33.4px] leading-[44px]">Academy</span></Link>
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

export default function App() {
  const { session, loading, roles } = useAuth();
  if (loading) return <div className="mx-auto max-w-3xl space-y-3 p-6"><Skeleton className="h-10" /><Skeleton className="h-40" /></div>;
  if (!session) return <Routes><Route path="/reset-password" element={<ResetPassword />} /><Route path="/verify-email" element={<VerifyEmail />} /><Route path="*" element={<Login />} /></Routes>;
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
        <Route path="/profile" element={<Profile />} />
        <Route path="/manage" element={<Manage />} />
        <Route path="/centres" element={<Centres />} />
        <Route path="/cohorts" element={<Cohorts />} />
        <Route path="/payouts" element={<Payouts />} />
        <Route path="/payments" element={<Payments />} />
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

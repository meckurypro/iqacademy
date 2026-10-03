import { createContext, useContext, useEffect, useState, useCallback, type ReactNode } from "react";
import type { Session } from "@supabase/supabase-js";
import { supabase } from "./supabase";

export type Role = "student" | "coordinator" | "centre_director" | "instructor" | "admin" | "super_admin";
type Ctx = { session: Session | null; loading: boolean; roles: { role: Role; centre_id: string | null }[]; name: string; avatar: string | null; refresh: () => void };
const AuthCtx = createContext<Ctx>({ session: null, loading: true, roles: [], name: "", avatar: null, refresh: () => {} });
export const useAuth = () => useContext(AuthCtx);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);
  const [roles, setRoles] = useState<Ctx["roles"]>([]);
  const [name, setName] = useState(""); const [avatar, setAvatar] = useState<string | null>(null);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => { setSession(data.session); setLoading(false); });
    const { data: sub } = supabase.auth.onAuthStateChange((_e, s) => setSession(s));
    return () => sub.subscription.unsubscribe();
  }, []);

  const refresh = useCallback(async () => {
    if (!session) { setRoles([]); setName(""); return; }
    const [r, p] = await Promise.all([
      supabase.rpc("my_roles"),
      supabase.from("profiles").select("full_name,avatar_url").eq("id", session.user.id).maybeSingle(),
    ]);
    setRoles((r.data as Ctx["roles"]) ?? []);
    setName(p.data?.full_name ?? session.user.email ?? ""); setAvatar(p.data?.avatar_url ?? null);
  }, [session]);

  useEffect(() => { refresh(); }, [refresh]);

  // A role change made by an admin updates this user's UI instantly.
  useEffect(() => {
    if (!session) return;
    const ch = supabase.channel("my-roles")
      .on("postgres_changes", { event: "*", schema: "public", table: "user_roles", filter: `user_id=eq.${session.user.id}` }, refresh)
      .subscribe();
    return () => { supabase.removeChannel(ch); };
  }, [session, refresh]);

  return <AuthCtx.Provider value={{ session, loading, roles, name, avatar, refresh }}>{children}</AuthCtx.Provider>;
}

export const staffRank: Role[] = ["super_admin", "admin", "centre_director", "coordinator", "instructor"];
export const primaryRole = (roles: Ctx["roles"]): Role => staffRank.find((r) => roles.some((x) => x.role === r)) ?? "student";
export const roleLabel: Record<Role, string> = {
  student: "Student", coordinator: "Coordinator", centre_director: "Centre Director",
  instructor: "Instructor", admin: "Admin", super_admin: "Super Admin",
};

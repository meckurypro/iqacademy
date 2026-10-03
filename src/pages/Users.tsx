import { useEffect, useState } from "react";
import { supabase, friendly } from "../lib/supabase";
import { roleLabel, type Role } from "../lib/auth";
import { Avatar, Badge, Button, Card, Err, Sheet, Skeleton } from "../components/ui";

export type UserRow = { id: string; full_name: string; email: string | null; avatar_url: string | null; is_active: boolean; roles: { role: Role; centre_id: string | null; centre_name: string | null }[] };
const TYPES: Role[] = ["student", "coordinator", "centre_director", "instructor", "admin"];

// WhatsApp-style search box: results update as you type.
export function useUserSearch(q: string) {
  const [rows, setRows] = useState<UserRow[]>();
  useEffect(() => {
    const h = setTimeout(async () => {
      const { data } = await supabase.rpc("search_users", { p_query: q, p_limit: 30 });
      setRows((data as UserRow[]) ?? []);
    }, 220);
    return () => clearTimeout(h);
  }, [q]);
  return rows;
}

export default function Users() {
  const [q, setQ] = useState(""); const rows = useUserSearch(q);
  const [sel, setSel] = useState<UserRow | null>(null);
  const [centres, setCentres] = useState<{ id: string; name: string }[]>([]);
  const [type, setType] = useState<Role>("student"); const [cs, setCs] = useState<string[]>([]);
  const [busy, setBusy] = useState(false); const [err, setErr] = useState("");
  useEffect(() => { supabase.from("centres").select("id,name").order("name").then((r) => setCentres(r.data ?? [])); }, []);

  const open = (u: UserRow) => {
    const staff = u.roles.find((r) => r.role !== "student");
    setSel(u); setType((staff?.role ?? "student") as Role); setCs(u.roles.filter((r) => r.role === staff?.role && r.centre_id).map((r) => r.centre_id!)); setErr("");
  };
  const needsCentre = type === "coordinator" || type === "centre_director";
  const save = async () => {
    if (!sel) return; setBusy(true); setErr("");
    const { error } = needsCentre
      ? await supabase.rpc("set_user_centres", { p_user_id: sel.id, p_role: type, p_centre_ids: cs })
      : await supabase.rpc("set_user_type", { p_user_id: sel.id, p_role: type, p_centre_id: null });
    setBusy(false); if (error) return setErr(friendly(error).replace("Something went wrong. Please try again.", error.message.replace(/^.*?: /, "")));
    setSel(null); setQ((x) => x + " "); setTimeout(() => setQ((x) => x.trimEnd()), 0);
  };

  return (
    <div className="space-y-4">
      <h1 className="text-2xl">Users</h1>
      <div className="relative"><span className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-muted">🔎</span>
        <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search by name, email or phone"
          className="h-12 w-full rounded-2xl bg-surface pl-11 pr-4 shadow-card outline-none ring-1 ring-line focus:ring-2 focus:ring-accent/50" /></div>
      {!rows ? <div className="space-y-2"><Skeleton className="h-16" /><Skeleton className="h-16" /><Skeleton className="h-16" /></div> :
        rows.length === 0 ? <Card className="text-center text-muted">No one matches “{q.trim()}”.</Card> :
        rows.map((u) => (
          <Card key={u.id} onClick={() => open(u)} className="anim-fade flex items-center gap-3 py-3">
            <Avatar name={u.full_name || "?"} url={u.avatar_url} />
            <div className="min-w-0 flex-1"><p className="truncate font-medium">{u.full_name || "(no name)"}{!u.is_active && " · inactive"}</p><p className="truncate text-sm text-muted">{u.email}</p></div>
            <div className="flex flex-wrap justify-end gap-1">{u.roles.filter((r) => r.role !== "student").map((r, i) => <Badge key={i} tone="ok">{roleLabel[r.role]}</Badge>)}</div>
          </Card>))}

      <Sheet open={!!sel} onClose={() => setSel(null)} title="Change user type">
        {sel && <div className="space-y-4">
          <div className="flex items-center gap-3"><Avatar name={sel.full_name} size={48} /><div><p className="font-medium">{sel.full_name}</p><p className="text-sm text-muted">{sel.email}</p></div></div>
          <div className="grid grid-cols-2 gap-2">{TYPES.map((r) => (
            <button key={r} onClick={() => setType(r)} className={`h-11 rounded-xl text-sm font-medium transition active:scale-[.97] ${type === r ? "bg-accent text-accent-ink" : "bg-sunken"}`}>{roleLabel[r]}</button>))}</div>
          {needsCentre && <div className="space-y-2"><p className="text-sm text-muted">Branches they look after (pick one or more)</p>
            <div className="flex flex-wrap gap-2">{centres.map((c) => (
              <button key={c.id} onClick={() => setCs(cs.includes(c.id) ? cs.filter((x) => x !== c.id) : [...cs, c.id])}
                className={`rounded-full px-3 py-1.5 text-sm transition active:scale-95 ${cs.includes(c.id) ? "bg-accent text-accent-ink" : "bg-sunken"}`}>{c.name}</button>))}</div></div>}
          <p className="text-sm text-muted">They'll be notified and their app updates straight away.</p>
          <Err>{err}</Err>
          <Button className="w-full" loading={busy} disabled={needsCentre && cs.length === 0} onClick={save}>Save</Button>
        </div>}
      </Sheet>
    </div>
  );
}

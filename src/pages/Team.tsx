import { useCallback, useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { supabase, friendly } from "../lib/supabase";
import { useAuth } from "../lib/auth";
import { Avatar, Badge, Button, Card, Err, Skeleton, cx } from "../components/ui";

/* eslint-disable @typescript-eslint/no-explicit-any */
// Centre team: directors (added by admin) and coordinators (added by the director or admin).
export default function Team() {
  const { centreId } = useParams(); const { roles } = useAuth();
  const isAdmin = roles.some((r) => r.role === "admin" || r.role === "super_admin");
  const myCentres = [...new Set(roles.filter((r) => r.role === "centre_director" && r.centre_id).map((r) => r.centre_id as string))];
  const [centres, setCentres] = useState<{ id: string; name: string }[]>([]);
  const [cid, setCid] = useState<string>(centreId ?? myCentres[0] ?? "");
  const [team, setTeam] = useState<any[]>(); const [q, setQ] = useState(""); const [hits, setHits] = useState<any[]>([]);
  const [role, setRole] = useState<"coordinator" | "centre_director">("coordinator"); const [err, setErr] = useState(""); const [busy, setBusy] = useState("");

  useEffect(() => { supabase.from("centres").select("id,name").order("name").then((r) => { const all = r.data ?? []; setCentres(isAdmin ? all : all.filter((c) => myCentres.includes(c.id))); }); /* eslint-disable-next-line */ }, [isAdmin]);
  const load = useCallback(async () => { if (!cid) return; setTeam(undefined); const { data } = await supabase.rpc("centre_team", { p_centre_id: cid }); setTeam(data ?? []); }, [cid]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    if (q.trim().length < 3) { setHits([]); return; }
    const h = setTimeout(async () => { const { data } = await supabase.rpc("lookup_user", { p_query: q }); setHits(data ?? []); }, 250);
    return () => clearTimeout(h);
  }, [q]);

  const add = async (id: string) => {
    setBusy(id); setErr("");
    const { error } = role === "coordinator" ? await supabase.rpc("add_centre_coordinator", { p_user_id: id, p_centre_id: cid }) : await supabase.rpc("assign_role", { p_user_id: id, p_role: "centre_director", p_centre_id: cid });
    setBusy(""); if (error) return setErr(friendly(error)); setQ(""); setHits([]); load();
  };
  const remove = async (m: any) => {
    if (!confirm(`Remove ${m.full_name}?`)) return; setBusy(m.user_id); setErr("");
    const { error } = m.role === "coordinator" ? await supabase.rpc("remove_centre_coordinator", { p_user_id: m.user_id, p_centre_id: cid }) : await supabase.rpc("remove_role", { p_user_id: m.user_id, p_role: "centre_director", p_centre_id: cid });
    setBusy(""); if (error) return setErr(friendly(error)); load();
  };
  const label = { centre_director: "Director", coordinator: "Coordinator" } as const;

  return (
    <div className="space-y-5">
      <h1 className="text-2xl">Centre team</h1>
      {centres.length > 1 && <select value={cid} onChange={(e) => setCid(e.target.value)} className="h-12 w-full rounded-xl bg-sunken px-4 outline-none">{!cid && <option value="">Choose a centre…</option>}{centres.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select>}
      {!cid ? <Card className="text-center text-muted">Choose a centre to see its team.</Card> : <>
        <section className="space-y-2">
          {!team ? <Skeleton className="h-16" /> : team.length === 0 ? <Card className="text-center text-muted">No team members yet.</Card> : team.map((m) => (
            <Card key={m.user_id + m.role} className="flex items-center gap-3 py-3"><Avatar name={m.full_name} url={m.avatar_url} size={40} />
              <div className="min-w-0 flex-1"><p className="truncate font-medium">{m.full_name}</p><Badge tone={m.role === "centre_director" ? "ok" : "muted"}>{label[m.role as keyof typeof label]}</Badge></div>
              {(m.role === "coordinator" || isAdmin) && <Button variant="ghost" className="h-9 px-3 text-sm text-bad" loading={busy === m.user_id} onClick={() => remove(m)}>Remove</Button>}</Card>))}
        </section>
        <Card className="space-y-3">
          <p className="font-medium">Add someone who already has an account</p>
          {isAdmin && <div className="grid grid-cols-2 gap-2">{([["coordinator", "Coordinator"], ["centre_director", "Director"]] as const).map(([r, l]) => (
            <button key={r} onClick={() => setRole(r)} className={cx("h-10 rounded-xl text-sm font-medium transition", role === r ? "bg-accent text-accent-ink" : "bg-sunken")}>{l}</button>))}</div>}
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search by name or email (3+ letters)" className="h-12 w-full rounded-xl bg-sunken px-4 outline-none" />
          {hits.map((h) => <button key={h.id} disabled={busy === h.id} onClick={() => add(h.id)} className="flex w-full items-center gap-3 rounded-xl px-2 py-2 text-left transition hover:bg-sunken active:scale-[.99]">
            <Avatar name={h.full_name} url={h.avatar_url} size={36} /><div className="min-w-0 flex-1"><p className="truncate font-medium">{h.full_name}</p><p className="truncate text-sm text-muted">{h.email_hint}</p></div><span className="text-sm text-accent">Add</span></button>)}
          {q.trim().length >= 3 && hits.length === 0 && <p className="text-sm text-muted">No one found. They need to create an account in the app first.</p>}
          <Err>{err}</Err>
        </Card>
      </>}
    </div>
  );
}

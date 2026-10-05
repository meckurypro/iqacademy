import { useCallback, useEffect, useState } from "react";
import Place from "../components/Place";
import { place, placeLabel } from "../lib/centre";
import { Link, Navigate, useParams } from "react-router-dom";
import { supabase, friendly } from "../lib/supabase";
import { useAuth } from "../lib/auth";
import { useFeedback } from "../components/feedback";
import { Avatar, Badge, Button, Card, Empty, Err, Skeleton, cx } from "../components/ui";

import Icon from "../components/Icon";
/* eslint-disable @typescript-eslint/no-explicit-any */
// Centre team: directors (added by admin) and coordinators (added by the director or admin).
// Admins reach this from a centre's card on the Centres page, so a centre is always chosen up front.
// Directors land on their own centre(s); only a director with several centres gets a switcher.
export default function Team() {
  const { centreId } = useParams(); const { roles } = useAuth();
  const isAdmin = roles.some((r) => r.role === "admin" || r.role === "super_admin");
  if (isAdmin && !centreId) return <Navigate to="/centres" replace />;
  // keyed on the route so moving between centres never keeps a stale selection
  return <TeamPage key={centreId ?? "mine"} centreId={centreId} isAdmin={isAdmin} />;
}

function TeamPage({ centreId, isAdmin }: { centreId?: string; isAdmin: boolean }) {
  const { roles } = useAuth(); const { run, confirm } = useFeedback();
  const myCentres = [...new Set(roles.filter((r) => r.role === "centre_director" && r.centre_id).map((r) => r.centre_id as string))];
  const [centres, setCentres] = useState<{ id: string; name: string; city: string | null; address: string | null }[]>();
  const [cid, setCid] = useState<string>(centreId ?? myCentres[0] ?? "");
  const [team, setTeam] = useState<any[]>(); const [loadErr, setLoadErr] = useState(""); const [q, setQ] = useState(""); const [hits, setHits] = useState<any[]>([]);
  const [role, setRole] = useState<"coordinator" | "centre_director">("coordinator"); const [err, setErr] = useState("");

  useEffect(() => { supabase.from("centres").select("id,name,city,address").order("name").then((r) => { const all = r.data ?? []; setCentres(isAdmin ? all : all.filter((c) => myCentres.includes(c.id))); }); /* eslint-disable-next-line */ }, [isAdmin]);
  const centreObj = centres?.find((c) => c.id === cid); const centreName = centreObj ? place(centreObj) : undefined;
  const load = useCallback(async () => { if (!cid) return; setTeam(undefined); setLoadErr(""); const { data, error } = await supabase.rpc("centre_team", { p_centre_id: cid }); if (error) setLoadErr(friendly(error)); setTeam(data ?? []); }, [cid]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    if (q.trim().length < 3) { setHits([]); return; }
    const h = setTimeout(async () => { const { data } = await supabase.rpc("lookup_user", { p_query: q }); setHits(data ?? []); }, 250);
    return () => clearTimeout(h);
  }, [q]);

  const add = async (h: any) => {
    setErr("");
    const r = await run(`Adding ${String(h.full_name).split(" ")[0]}…`, async () => {
      const { error } = role === "coordinator" ? await supabase.rpc("add_centre_coordinator", { p_user_id: h.id, p_centre_id: cid }) : await supabase.rpc("assign_role", { p_user_id: h.id, p_role: "centre_director", p_centre_id: cid });
      if (error) throw error;
    }, { success: `${h.full_name} added to the team`, quiet: true });
    if (!r.ok) return setErr(r.message);
    setQ(""); setHits([]); load();
  };
  const remove = async (m: any) => {
    if (!(await confirm({ title: `Remove ${m.full_name}?`, message: `They lose their ${m.role === "coordinator" ? "coordinator" : "director"} access${centreName ? ` at ${centreName}` : ""}. Their account stays.`, confirmLabel: "Remove", danger: true }))) return;
    setErr("");
    const r = await run(`Removing ${String(m.full_name).split(" ")[0]}…`, async () => {
      const { error } = m.role === "coordinator" ? await supabase.rpc("remove_centre_coordinator", { p_user_id: m.user_id, p_centre_id: cid }) : await supabase.rpc("remove_role", { p_user_id: m.user_id, p_role: "centre_director", p_centre_id: cid });
      if (error) throw error;
    }, { success: `${m.full_name} removed`, quiet: true });
    if (!r.ok) return setErr(r.message);
    load();
  };
  const label = { centre_director: "Director", coordinator: "Coordinator" } as const;

  return (
    <div className="space-y-5">
      {isAdmin && <Link to="/centres" className="inline-block text-sm text-muted transition hover:text-ink"><span className="inline-flex items-center gap-1.5"><Icon name="arrowLeft" size={16} />Centres</span></Link>}
      <div><h1 className="text-[26px] leading-tight">{isAdmin ? "Centre team" : "My team"}</h1>{centreName && (isAdmin || myCentres.length <= 1) && <p className="text-muted">{centreObj && <Place centre={centreObj} nameOnly />}</p>}</div>
      {!isAdmin && myCentres.length > 1 && <select value={cid} onChange={(e) => setCid(e.target.value)} className="h-12 w-full rounded-xl bg-surface ring-1 ring-line px-4 outline-none transition focus:ring-2 focus:ring-accent/60">{(centres ?? []).map((c) => <option key={c.id} value={c.id}>{placeLabel(c)}</option>)}</select>}
      {!cid ? <Empty title="You're not assigned to a centre yet." /> : <>
        <Err>{loadErr}</Err>
        <section className="space-y-2">
          {!team ? <Skeleton className="h-16" /> : team.length === 0 ? <Empty title="No team members yet." /> : team.map((m) => (
            <Card key={m.user_id + m.role} className="flex items-center gap-3 py-3"><Avatar name={m.full_name} url={m.avatar_url} size={40} />
              <div className="min-w-0 flex-1"><p className="truncate font-medium">{m.full_name}</p><Badge tone={m.role === "centre_director" ? "ok" : "muted"}>{label[m.role as keyof typeof label]}</Badge></div>
              {(m.role === "coordinator" || isAdmin) && <Button variant="ghost" className="h-9 px-3 text-sm text-bad" onClick={() => remove(m)}>Remove</Button>}</Card>))}
        </section>
        <Card className="space-y-3">
          <p className="font-medium">Add someone who already has an account</p>
          {isAdmin && <div className="grid grid-cols-2 gap-2">{([["coordinator", "Coordinator"], ["centre_director", "Director"]] as const).map(([r, l]) => (
            <button key={r} onClick={() => setRole(r)} className={cx("h-10 rounded-xl text-sm font-medium transition", role === r ? "bg-accent text-accent-ink" : "bg-sunken")}>{l}</button>))}</div>}
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search by name or email (3+ letters)" className="h-12 w-full rounded-xl bg-surface ring-1 ring-line px-4 outline-none transition focus:ring-2 focus:ring-accent/60" />
          {hits.map((h) => <button key={h.id} onClick={() => add(h)} className="flex w-full items-center gap-3 rounded-xl px-2 py-2 text-left transition hover:bg-sunken active:scale-[.99]">
            <Avatar name={h.full_name} url={h.avatar_url} size={36} /><div className="min-w-0 flex-1"><p className="truncate font-medium">{h.full_name}</p><p className="truncate text-sm text-muted">{h.email_hint}</p></div><span className="text-sm text-accent">Add</span></button>)}
          {q.trim().length >= 3 && hits.length === 0 && <p className="text-sm text-muted">No one found. They need to create an account in the app first.</p>}
          <Err>{err}</Err>
        </Card>
      </>}
    </div>
  );
}

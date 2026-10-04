import { useEffect, useMemo, useState } from "react";
import { supabase, friendly, rawMessage } from "../lib/supabase";
import { useFeedback } from "../components/feedback";
import { Button, Card, Err, Field, cx } from "../components/ui";
import { useUserSearch } from "./Users";

type Opt = { id: string; name: string };
type Rule = { who: string; centres: string[]; courses: string[]; users: Opt[] };
const WHO = [["students", "Students"], ["instructors", "Instructors"], ["centre_directors", "Centre directors"], ["coordinators", "Coordinators"], ["admins", "Admins"], ["users", "Specific people"], ["everyone", "Everyone"]];
const blank = (): Rule => ({ who: "students", centres: [], courses: [], users: [] });

const Chips = ({ items, on, toggle }: { items: Opt[]; on: string[]; toggle: (id: string) => void }) => (
  <div className="flex flex-wrap gap-2">{items.map((i) => (
    <button key={i.id} onClick={() => toggle(i.id)} className={cx("rounded-full px-3 py-1.5 text-sm transition active:scale-95", on.includes(i.id) ? "bg-accent text-accent-ink" : "bg-sunken")}>{i.name}</button>))}</div>
);

export default function Announce() {
  const { run, confirm } = useFeedback();
  const [rules, setRules] = useState<Rule[]>([blank()]);
  const [centres, setCentres] = useState<Opt[]>([]); const [courses, setCourses] = useState<Opt[]>([]);
  const [title, setTitle] = useState(""); const [body, setBody] = useState("");
  const [preview, setPreview] = useState<{ count: number; sample: { full_name: string }[] } | null>(null);
  const [err, setErr] = useState(""); const [sent, setSent] = useState<number | null>(null);
  const [find, setFind] = useState(""); const found = useUserSearch(find);

  useEffect(() => {
    supabase.from("centres").select("id,name").order("name").then((r) => setCentres(r.data ?? []));
    supabase.from("courses").select("id,name:title").order("sort_order").then((r) => setCourses((r.data as Opt[]) ?? []));
  }, []);

  const audience = useMemo(() => ({ rules: rules.map((r) => {
    const o: Record<string, unknown> = { who: r.who };
    if (["students", "instructors"].includes(r.who)) { if (r.courses.length) o.course_ids = r.courses }
    if (["students", "instructors", "centre_directors", "coordinators"].includes(r.who) && r.centres.length) o.centre_ids = r.centres;
    if (r.who === "users") o.user_ids = r.users.map((u) => u.id);
    return o; }) }), [rules]);
  const empty = rules.some((r) => r.who === "users" && r.users.length === 0);

  useEffect(() => {
    setPreview(null); if (empty) return;
    const h = setTimeout(async () => { const { data } = await supabase.rpc("preview_audience", { p_audience: audience }); setPreview(data as typeof preview); }, 300);
    return () => clearTimeout(h);
  }, [audience, empty]);

  const patch = (i: number, p: Partial<Rule>) => setRules((rs) => rs.map((r, k) => (k === i ? { ...r, ...p } : r)));
  const flip = (a: string[], id: string) => (a.includes(id) ? a.filter((x) => x !== id) : [...a, id]);
  const send = async () => {
    setErr("");
    const n = preview?.count ?? 0;
    if (!(await confirm({
      title: `Send to ${n} ${n === 1 ? "person" : "people"}?`,
      message: "It goes straight to their notification bell and can't be unsent.", confirmLabel: "Send now",
    }))) return;
    const r = await run("Sending announcement…", async () => {
      const { data, error } = await supabase.rpc("send_broadcast", { p_title: title, p_body: body || null, p_audience: audience });
      if (error) throw error;
      return data as { recipient_count: number };
    }, { quiet: true });
    if (!r.ok) return setErr(friendly(r.error).replace("Something went wrong. Please try again.", rawMessage(r.error) || "Something went wrong. Please try again."));
    setSent(r.data.recipient_count);
  };

  if (sent !== null) return (
    <Card className="anim-rise mx-auto mt-10 max-w-sm space-y-4 p-8 text-center"><div className="anim-pop mx-auto grid h-16 w-16 place-items-center rounded-full bg-ok/15 text-3xl text-ok">✓</div>
      <h1 className="text-xl">Sent to {sent} {sent === 1 ? "person" : "people"}</h1><p className="text-muted">It's on their notification bell now.</p>
      <Button className="w-full" onClick={() => { setSent(null); setTitle(""); setBody(""); setRules([blank()]); }}>Write another</Button></Card>);

  return (
    <div className="space-y-5 pb-32">
      <h1 className="text-2xl">New announcement</h1>
      {rules.map((r, i) => (
        <Card key={i} className="anim-fade space-y-3">
          <div className="flex items-center justify-between"><p className="text-sm font-medium text-muted">{i === 0 ? "Send to" : "Also send to"}</p>
            {rules.length > 1 && <button className="text-sm text-bad" onClick={() => setRules(rules.filter((_, k) => k !== i))}>Remove</button>}</div>
          <select value={r.who} onChange={(e) => patch(i, { ...blank(), who: e.target.value })} className="h-12 w-full rounded-xl bg-sunken px-4 outline-none">{WHO.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>
          {["students", "instructors", "centre_directors", "coordinators"].includes(r.who) && <><p className="text-sm text-muted">Only at these centres (leave empty for all)</p><Chips items={centres} on={r.centres} toggle={(id) => patch(i, { centres: flip(r.centres, id) })} /></>}
          {["students", "instructors"].includes(r.who) && <><p className="text-sm text-muted">Only in these courses</p><Chips items={courses} on={r.courses} toggle={(id) => patch(i, { courses: flip(r.courses, id) })} /></>}
          {r.who === "users" && <div className="space-y-2">
            <div className="flex flex-wrap gap-2">{r.users.map((u) => <button key={u.id} onClick={() => patch(i, { users: r.users.filter((x) => x.id !== u.id) })} className="rounded-full bg-accent px-3 py-1.5 text-sm text-accent-ink">{u.name} ✕</button>)}</div>
            <input value={find} onChange={(e) => setFind(e.target.value)} placeholder="Search people to add…" className="h-12 w-full rounded-xl bg-sunken px-4 outline-none" />
            {find.trim() && found?.slice(0, 5).map((u) => <button key={u.id} onClick={() => { patch(i, { users: [...r.users.filter((x) => x.id !== u.id), { id: u.id, name: u.full_name }] }); setFind(""); }} className="block w-full rounded-xl px-3 py-2 text-left hover:bg-sunken">{u.full_name} <span className="text-sm text-muted">{u.email}</span></button>)}</div>}
        </Card>))}
      <Button variant="secondary" className="w-full" onClick={() => setRules([...rules, blank()])}>+ Add another group</Button>

      <Card className="space-y-3">
        <Field label="Title" value={title} maxLength={120} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Classes start Monday" />
        <label className="block"><span className="mb-1.5 block text-sm text-muted">Message</span>
          <textarea value={body} onChange={(e) => setBody(e.target.value)} maxLength={2000} rows={4} className="w-full rounded-xl bg-sunken p-4 text-[15px] outline-none ring-accent/40 focus:ring-2" /></label>
      </Card>
      <Err>{err}</Err>

      <div className="fixed inset-x-0 bottom-[calc(3.6rem+env(safe-area-inset-bottom))] z-20 bg-bg/80 px-4 py-3 backdrop-blur-md">
        <div className="mx-auto flex max-w-3xl items-center gap-3">
          <p className="num flex-1 text-sm">{empty ? "Add at least one person" : preview ? <><b>{preview.count}</b> {preview.count === 1 ? "person" : "people"} will get this{preview.sample[0] ? <span className="text-muted"> · {preview.sample.slice(0, 2).map((s) => s.full_name.split(" ")[0]).join(", ")}…</span> : null}</> : "Counting…"}</p>
          <Button disabled={!title.trim() || !preview || preview.count === 0} onClick={send}>Send</Button>
        </div>
      </div>
    </div>
  );
}

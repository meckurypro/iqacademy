import { useCallback, useEffect, useMemo, useState } from "react";
import { supabase, friendly, rawMessage } from "../lib/supabase";
import { useFeedback } from "../components/feedback";
import { Button, Card, Empty, Err, Field, Sheet, Skeleton, cx } from "../components/ui";
import { useUserSearch } from "./Users";

import Icon from "../components/Icon";
import { fmtWhen } from "../lib/time";
type Opt = { id: string; name: string };
type Rule = { who: string; centres: string[]; courses: string[]; users: Opt[] };
const WHO = [["students", "Students"], ["instructors", "Instructors"], ["centre_directors", "Centre directors"], ["coordinators", "Coordinators"], ["admins", "Admins"], ["users", "Specific people"], ["everyone", "Everyone"]];
const blank = (): Rule => ({ who: "students", centres: [], courses: [], users: [] });

const Chips = ({ items, on, toggle }: { items: Opt[]; on: string[]; toggle: (id: string) => void }) => (
  <div className="flex flex-wrap gap-2">{items.map((i) => (
    <button key={i.id} onClick={() => toggle(i.id)} className={cx("rounded-full px-3 py-1.5 text-sm transition active:scale-95", on.includes(i.id) ? "bg-accent text-accent-ink" : "bg-sunken")}>{i.name}</button>))}</div>
);

function Compose({ onSeeSent }: { onSeeSent: () => void }) {
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
      message: "It goes straight to their notification bell. You can still edit or remove it afterwards from the Sent tab.", confirmLabel: "Send now",
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
    <Card className="anim-rise mx-auto mt-10 max-w-sm space-y-4 p-8 text-center"><div className="anim-pop mx-auto grid h-16 w-16 place-items-center rounded-full bg-ok/15 text-ok"><Icon name="check" size={32} strokeWidth={2.25} /></div>
      <h1 className="text-[26px] leading-tight">Sent to {sent} {sent === 1 ? "person" : "people"}</h1><p className="text-muted">It's on their notification bell now.</p>
      <Button className="w-full" onClick={() => { setSent(null); setTitle(""); setBody(""); setRules([blank()]); }}>Write another</Button>
      <Button variant="ghost" className="w-full" onClick={onSeeSent}>See sent announcements</Button></Card>);

  return (
    <div className="space-y-5 pb-32">
      {rules.map((r, i) => (
        <Card key={i} className="anim-fade space-y-3">
          <div className="flex items-center justify-between"><p className="text-sm font-medium text-muted">{i === 0 ? "Send to" : "Also send to"}</p>
            {rules.length > 1 && <button className="text-sm text-bad" onClick={() => setRules(rules.filter((_, k) => k !== i))}>Remove</button>}</div>
          <select value={r.who} onChange={(e) => patch(i, { ...blank(), who: e.target.value })} className="h-12 w-full rounded-xl bg-surface ring-1 ring-line px-4 outline-none transition focus:ring-2 focus:ring-accent/60">{WHO.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>
          {["students", "instructors", "centre_directors", "coordinators"].includes(r.who) && <><p className="text-sm text-muted">Only at these centres (leave empty for all)</p><Chips items={centres} on={r.centres} toggle={(id) => patch(i, { centres: flip(r.centres, id) })} /></>}
          {["students", "instructors"].includes(r.who) && <><p className="text-sm text-muted">Only in these courses</p><Chips items={courses} on={r.courses} toggle={(id) => patch(i, { courses: flip(r.courses, id) })} /></>}
          {r.who === "users" && <div className="space-y-2">
            <div className="flex flex-wrap gap-2">{r.users.map((u) => <button key={u.id} onClick={() => patch(i, { users: r.users.filter((x) => x.id !== u.id) })} className="inline-flex items-center gap-1.5 rounded-full bg-accent px-3 py-1.5 text-sm text-accent-ink">{u.name}<Icon name="close" size={14} /></button>)}</div>
            <input value={find} onChange={(e) => setFind(e.target.value)} placeholder="Search people to add…" className="h-12 w-full rounded-xl bg-surface ring-1 ring-line px-4 outline-none transition focus:ring-2 focus:ring-accent/60" />
            {find.trim() && found?.slice(0, 5).map((u) => <button key={u.id} onClick={() => { patch(i, { users: [...r.users.filter((x) => x.id !== u.id), { id: u.id, name: u.full_name }] }); setFind(""); }} className="block w-full rounded-xl px-3 py-2 text-left hover:bg-sunken">{u.full_name} <span className="text-sm text-muted">{u.email}</span></button>)}</div>}
        </Card>))}
      <Button variant="secondary" className="w-full" onClick={() => setRules([...rules, blank()])}>+ Add another group</Button>

      <Card className="space-y-3">
        <Field label="Title" value={title} maxLength={120} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Classes start Monday" />
        <label className="block"><span className="mb-1.5 block text-sm text-muted">Message</span>
          <textarea value={body} onChange={(e) => setBody(e.target.value)} maxLength={2000} rows={4} className="w-full rounded-xl bg-surface ring-1 ring-line p-4 text-[15px] outline-none transition focus:ring-2 focus:ring-accent/60" /></label>
      </Card>
      <Err>{err}</Err>

      <div className="fixed inset-x-0 bottom-[calc(3.6rem+env(safe-area-inset-bottom))] z-20 bg-bg/80 px-4 py-3 backdrop-blur-md lg:bottom-0 lg:left-[var(--sbw)] lg:border-t lg:border-line lg:px-8">
        <div className="mx-auto flex max-w-3xl items-center gap-3 lg:max-w-[calc(48rem-4rem)]">
          <p className="num flex-1 text-sm">{empty ? "Add at least one person" : preview ? <><b>{preview.count}</b> {preview.count === 1 ? "person" : "people"} will get this{preview.sample[0] ? <span className="text-muted"> · {preview.sample.slice(0, 2).map((s) => s.full_name.split(" ")[0]).join(", ")}…</span> : null}</> : "Counting…"}</p>
          <Button disabled={!title.trim() || !preview || preview.count === 0} onClick={send}>Send</Button>
        </div>
      </div>
    </div>
  );
}

// ───────────── sent announcements: review, correct, retract ─────────────
type SentRow = { id: string; title: string; body: string | null; recipient_count: number; created_at: string };

function SentList() {
  const { run, confirm, toast } = useFeedback();
  const [rows, setRows] = useState<SentRow[]>(); const [loadErr, setLoadErr] = useState("");
  const [ed, setEd] = useState<{ id: string; title: string; body: string; n: number } | null>(null); const [err, setErr] = useState("");

  const load = useCallback(async () => {
    const { data, error } = await supabase.from("broadcasts").select("id,title,body,recipient_count,created_at").order("created_at", { ascending: false }).limit(50);
    if (error) { setLoadErr(friendly(error)); return setRows([]); }
    setLoadErr(""); setRows((data as SentRow[]) ?? []);
  }, []);
  useEffect(() => { load(); }, [load]);

  const people = (n: number) => `${n} ${n === 1 ? "person" : "people"}`;

  const save = async () => {
    if (!ed) return; setErr("");
    const sent = ed;
    const r = await run("Saving announcement…", async () => {
      const { error } = await supabase.rpc("edit_broadcast", { p_id: sent.id, p_title: sent.title, p_body: sent.body.trim() || null });
      if (error) throw error;
      // Read it back: only call it saved if the database really holds the new wording.
      const back = await supabase.from("broadcasts").select("title,body").eq("id", sent.id).maybeSingle();
      if (back.error) throw back.error;
      if (!back.data || back.data.title !== sent.title.trim() || (back.data.body ?? "") !== sent.body.trim()) throw new Error("not_saved");
      await load();
    }, { success: "Updated for everyone who received it", quiet: true });
    if (!r.ok) return setErr(r.message);
    setEd(null);
  };

  const remove = async (b: SentRow) => {
    const yes = await confirm({
      title: "Remove this announcement?",
      message: <>“{b.title}” disappears from the notifications of the {people(b.recipient_count)} who received it, including anyone who hasn't read it yet. This can't be undone.</>,
      confirmLabel: "Remove announcement", danger: true,
    });
    if (!yes) return;
    const r = await run("Removing announcement…", async () => {
      const { data, error } = await supabase.rpc("delete_broadcast", { p_id: b.id });
      if (error) throw error;
      await load();
      return data as number;
    });
    if (r.ok) toast(`Removed from ${people(r.data)}'s notifications`);
  };

  return (
    <div className="space-y-4">
      <div><h1 className="text-[26px] leading-tight">Sent announcements</h1><p className="text-sm text-muted">Fix a typo or take one back. Changes apply to everyone who received it, and nobody is notified again.</p></div>
      {loadErr && <div className="space-y-2"><Err>{loadErr}</Err><Button variant="secondary" onClick={load}>Try again</Button></div>}
      {!rows ? <><Skeleton className="h-24" /><Skeleton className="h-24" /></> : rows.length === 0 && !loadErr ? <Empty title="Nothing sent yet." /> : rows.map((b) => (
        <Card key={b.id} className="space-y-2">
          <div><p className="font-medium">{b.title}</p><p className="text-sm text-muted">{fmtWhen(b.created_at, { dateStyle: "medium", timeStyle: "short" })} · sent to {people(b.recipient_count)}</p></div>
          {b.body && <p className="line-clamp-3 whitespace-pre-line text-[15px]">{b.body}</p>}
          <div className="grid grid-cols-2 gap-2">
            <Button variant="secondary" className="h-10" onClick={() => { setErr(""); setEd({ id: b.id, title: b.title, body: b.body ?? "", n: b.recipient_count }); }}>Edit</Button>
            <Button variant="secondary" className="h-10 text-bad" onClick={() => remove(b)}>Remove</Button></div>
        </Card>))}

      <Sheet open={!!ed} onClose={() => setEd(null)} title="Edit announcement">
        {ed && <div className="space-y-3">
          <Field label="Title" value={ed.title} maxLength={120} onChange={(e) => setEd({ ...ed, title: e.target.value })} />
          <label className="block"><span className="mb-1.5 block text-sm text-muted">Message</span>
            <textarea value={ed.body} onChange={(e) => setEd({ ...ed, body: e.target.value })} maxLength={2000} rows={5} className="w-full rounded-xl bg-surface ring-1 ring-line p-4 text-[15px] outline-none transition focus:ring-2 focus:ring-accent/60" /></label>
          <p className="text-sm text-muted">This changes the wording for all {ed.n} {ed.n === 1 ? "person" : "people"} who received it. They aren't notified again.</p>
          <Err>{err}</Err>
          <Button className="w-full" disabled={!ed.title.trim()} onClick={save}>Save changes</Button>
        </div>}
      </Sheet>
    </div>
  );
}

export default function Announce() {
  const [tab, setTab] = useState<"new" | "sent">("new");
  return (
    <div className="space-y-4">
      <div role="tablist" className="grid grid-cols-2 gap-1 rounded-2xl bg-sunken p-1">
        {([["new", "New announcement"], ["sent", "Sent"]] as const).map(([k, l]) => (
          <button key={k} role="tab" aria-selected={tab === k} onClick={() => setTab(k)}
            className={cx("h-10 rounded-xl text-sm font-medium transition", tab === k ? "bg-surface shadow-card" : "text-muted")}>{l}</button>))}
      </div>
      {tab === "new" ? <Compose onSeeSent={() => setTab("sent")} /> : <SentList />}
    </div>
  );
}

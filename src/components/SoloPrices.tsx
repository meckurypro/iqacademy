import { useEffect, useState } from "react";
import { supabase, friendly, naira } from "../lib/supabase";
import { Button, Card, Err, Skeleton } from "./ui";

// Admin: what each course costs when a student buys it on its own. A second price covers students who haven't
// completed the course's prerequisite. Leave a price empty and that course can't be bought on its own.
type Row = { course_id: string; title: string; hasPrereq: boolean; price: string; unmet: string };
const digits = (s: string) => s.replace(/\D/g, "").slice(0, 9);
const input = "num h-11 w-full rounded-xl bg-sunken px-3 text-right outline-none ring-accent/40 transition focus:ring-2";

export default function SoloPrices() {
  const [rows, setRows] = useState<Row[]>();
  const [saved, setSaved] = useState("");
  const [busy, setBusy] = useState(false); const [err, setErr] = useState(""); const [note, setNote] = useState("");

  useEffect(() => {
    Promise.all([
      supabase.from("courses").select("id,title").eq("is_active", true).order("sort_order"),
      supabase.from("course_prices").select("course_id,solo_price,solo_price_unmet"),
      supabase.from("course_prerequisites").select("course_id"),
    ]).then(([c, p, q]) => {
      const price = new Map((p.data ?? []).map((x) => [x.course_id as string, x]));
      const pre = new Set((q.data ?? []).map((x) => x.course_id as string));
      const next = (c.data ?? []).map((x) => { const r = price.get(x.id as string);
        return { course_id: x.id as string, title: x.title as string, hasPrereq: pre.has(x.id as string),
          price: r?.solo_price ? String(r.solo_price / 100) : "", unmet: r?.solo_price_unmet ? String(r.solo_price_unmet / 100) : "" }; });
      setRows(next); setSaved(JSON.stringify(next));
    });
  }, []);

  if (!rows) return <Skeleton className="h-28" />;
  const dirty = JSON.stringify(rows) !== saved;
  const set = (i: number, patch: Partial<Row>) => { setNote(""); setRows(rows.map((r, j) => (j === i ? { ...r, ...patch } : r))); };
  const kobo = (s: string) => (s ? Math.round(Number(s) * 100) : null);

  const save = async () => {
    setBusy(true); setErr(""); setNote("");
    const { error } = await supabase.rpc("save_course_prices", {
      p_prices: rows.map((r) => ({ course_id: r.course_id, solo_price: kobo(r.price), solo_price_unmet: r.hasPrereq ? kobo(r.unmet) : null })) });
    setBusy(false);
    if (error) return setErr(friendly(error));
    setSaved(JSON.stringify(rows)); setNote("Saved. Students see these prices when they buy a single course.");
  };

  return (
    <section className="space-y-3">
      <div><h2 className="text-lg">Single-course prices</h2>
        <p className="text-sm text-muted">What a student pays to buy one course on their own, after paying for a pack. This is also the price to take a course again. Leave empty to keep a course off the list.</p></div>
      {rows.map((r, i) => (
        <Card key={r.course_id} className="space-y-2">
          <p className="font-medium">{r.title}</p>
          <label className="flex items-center justify-between gap-3 text-sm"><span className="text-muted">{r.hasPrereq ? "Price, prerequisite completed (₦)" : "Price (₦)"}</span>
            <span className="w-36"><input className={input} inputMode="numeric" placeholder="Not set" value={r.price} onChange={(e) => set(i, { price: digits(e.target.value) })} /></span></label>
          {r.hasPrereq && <label className="flex items-center justify-between gap-3 text-sm"><span className="text-muted">Price, prerequisite not completed (₦)</span>
            <span className="w-36"><input className={input} inputMode="numeric" placeholder="Not set" value={r.unmet} onChange={(e) => set(i, { unmet: digits(e.target.value) })} /></span></label>}
          {r.hasPrereq && r.price && r.unmet && Number(r.unmet) < Number(r.price) && <p className="text-sm text-warn">The “not completed” price is lower than the “completed” price ({naira(Number(r.unmet) * 100)} vs {naira(Number(r.price) * 100)}).</p>}
        </Card>))}
      {note && <p className="rounded-xl bg-ok/10 px-3 py-2 text-sm text-ok">{note}</p>}
      <Err>{err}</Err>
      <Button className="w-full" loading={busy} disabled={!dirty} onClick={save}>{dirty ? "Save prices" : "Saved"}</Button>
    </section>
  );
}

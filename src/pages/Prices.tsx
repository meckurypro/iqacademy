import { useCallback, useEffect, useState } from "react";
import { Navigate } from "react-router-dom";
import { supabase, friendly, naira } from "../lib/supabase";
import { useAuth } from "../lib/auth";
import { Badge, Button, Card, Err, Field, Sheet, Skeleton, cx } from "../components/ui";
import SoloPrices from "../components/SoloPrices";

/* eslint-disable @typescript-eslint/no-explicit-any */
// Admin: package prices, how many instalments are allowed, and what each instalment costs.
// Everything is saved in one call (save_package) so a package is never left with half a plan.
type Row = { label: string; amount: string; rule: string };
type Form = { id: string; code: string; name: string; description: string; courses: string; weeks: string; price: string; active: boolean; instOn: boolean; inst: Row[] };

const sel = "h-12 w-full rounded-xl bg-sunken px-4 outline-none";
const MAX_INST = 6;
const digits = (s: string) => s.replace(/\D/g, "");
const toKobo = (n: string | number) => Math.round(Number(n || 0) * 100);
// due rules: instalment 1 is always "before_start"; later ones lock a course from that course onward, or just remind.
const ruleNo = (r: string) => (r.startsWith("before_course_") ? Number(r.slice(14)) : 0);
const ruleText = (r: string) => (r === "before_start" ? "Before classes start" : r === "custom" ? "Reminder only (doesn't lock classes)" : `Before course ${ruleNo(r)} starts`);

const blank: Form = { id: "", code: "", name: "", description: "", courses: "2", weeks: "", price: "", active: true, instOn: false, inst: [] };

// Split a whole-naira price over n instalments; the first one takes any remainder.
const split = (price: number, n: number) => {
  const base = Math.floor(price / n);
  return Array.from({ length: n }, (_, i) => String(i === 0 ? price - base * (n - 1) : base));
};
const defaultRows = (price: string, courses: number): Row[] => {
  const p = Number(price || 0);
  const a = p > 0 ? split(p, 2) : ["", ""];
  return [
    { label: "First instalment (before classes start)", amount: a[0], rule: "before_start" },
    { label: "Second instalment (before second course)", amount: a[1], rule: courses >= 2 ? "before_course_2" : "custom" },
  ];
};
const nextRule = (rows: Row[], courses: number) => {
  const next = Math.max(1, ...rows.map((r) => ruleNo(r.rule))) + 1;
  return next <= Math.min(courses, 4) ? `before_course_${next}` : "custom";
};

export default function Prices() {
  const { roles } = useAuth();
  const isAdmin = roles.some((r) => r.role === "admin" || r.role === "super_admin");
  const [rows, setRows] = useState<any[]>();
  const [courseMax, setCourseMax] = useState(10);
  const [f, setF] = useState<Form | null>(null);
  const [show, setShow] = useState(false); const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(""); const [note, setNote] = useState("");

  const load = useCallback(async () => {
    const { data } = await supabase.from("packages")
      .select("id,code,name,description,course_count,duration_weeks,price_full,is_active,sort_order,package_instalments(number,label,amount,due_rule)")
      .neq("code", "SOLO").order("sort_order");
    setRows(data ?? []);
  }, []);
  useEffect(() => {
    load();
    supabase.from("courses").select("id", { count: "exact", head: true }).eq("is_active", true).then((r) => { if (r.count) setCourseMax(r.count); });
  }, [load]);

  if (!isAdmin) return <Navigate to="/" replace />;

  const set = (patch: Partial<Form>) => setF((cur) => (cur ? { ...cur, ...patch } : cur));
  const setRow = (i: number, patch: Partial<Row>) => setF((cur) => (cur ? { ...cur, inst: cur.inst.map((r, j) => (j === i ? { ...r, ...patch } : r)) } : cur));
  const open = (next: Form) => { setErr(""); setShow(false); setNote(""); setF(next); };
  const edit = (p: any) => {
    const inst = [...(p.package_instalments ?? [])].sort((a: any, b: any) => a.number - b.number);
    open({ id: p.id, code: p.code, name: p.name, description: p.description ?? "", courses: String(p.course_count), weeks: p.duration_weeks ? String(p.duration_weeks) : "",
      price: String(p.price_full / 100), active: p.is_active, instOn: inst.length > 0, inst: inst.map((i: any) => ({ label: i.label, amount: String(i.amount / 100), rule: i.due_rule })) });
  };

  // ---- live checks (the database enforces the same rules) ----
  const courseN = f ? Number(f.courses) : 0;
  const priceN = f ? Number(f.price) : 0;
  const instTotal = f ? f.inst.reduce((s, r) => s + (Number(r.amount) || 0), 0) : 0;
  const problems: string[] = [];
  if (f) {
    if (!f.name.trim()) problems.push("Give the package a name.");
    if (!f.id && !/^[A-Za-z0-9_-]{2,20}$/.test(f.code.trim())) problems.push("Add a short code (2–20 letters or numbers).");
    if (!(priceN > 0)) problems.push("Set a full price above ₦0.");
    if (!(courseN >= 1 && courseN <= courseMax)) problems.push(`Courses must be between 1 and ${courseMax}.`);
    if (f.weeks && Number(f.weeks) < 1) problems.push("Weeks must be at least 1.");
    if (f.instOn) {
      let prev = 0;
      f.inst.forEach((r, i) => {
        const n = i + 1; const k = ruleNo(r.rule);
        if (!r.label.trim()) problems.push(`Instalment ${n} needs a name.`);
        if (!(Number(r.amount) > 0)) problems.push(`Instalment ${n} needs an amount above ₦0.`);
        if (i > 0 && k) {
          if (k > courseN) problems.push(`Instalment ${n} is due before course ${k}, but this pack has ${courseN} course${courseN === 1 ? "" : "s"}.`);
          else if (k < prev) problems.push(`Instalment ${n} is due before an earlier one. Put them in order.`);
          prev = Math.max(prev, k);
        }
      });
    }
  }

  const toggleInst = (on: boolean) => { if (f) set({ instOn: on, inst: on && f.inst.length === 0 ? defaultRows(f.price, courseN || 2) : f.inst }); };
  const addRow = () => { if (f && f.inst.length < MAX_INST) set({ inst: [...f.inst, { label: `Instalment ${f.inst.length + 1}`, amount: "", rule: nextRule(f.inst, courseN) }] }); };
  const removeRow = (i: number) => { if (f) set({ inst: f.inst.filter((_, j) => j !== i) }); };
  const splitEvenly = () => { if (f && priceN > 0 && f.inst.length) { const a = split(priceN, f.inst.length); set({ inst: f.inst.map((r, i) => ({ ...r, amount: a[i] })) }); } };

  const save = async () => {
    if (!f) return;
    setShow(true); if (problems.length) return;
    if (f.instOn && instTotal !== priceN && !confirm(`The instalments add up to ${naira(instTotal * 100)} but the full price is ${naira(priceN * 100)}. Save anyway?`)) return;
    setBusy(true); setErr("");
    const { error } = await supabase.rpc("save_package", {
      p_package_id: f.id || null, p_code: f.code.trim(), p_name: f.name.trim(), p_description: f.description.trim() || null,
      p_course_count: courseN, p_duration_weeks: f.weeks ? Number(f.weeks) : null, p_price_full: toKobo(f.price), p_is_active: f.active,
      p_instalments: f.instOn ? f.inst.map((r, i) => ({ label: r.label.trim(), amount: toKobo(r.amount), due_rule: i === 0 ? "before_start" : r.rule })) : [],
    });
    setBusy(false);
    if (error) return setErr(friendly(error));
    setF(null); setNote("Saved. New enrolments will use these prices."); load();
  };

  const diff = instTotal - priceN;
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between"><h1 className="text-2xl">Prices</h1><Button className="h-10" onClick={() => open(blank)}>+ New</Button></div>
      <Card className="text-sm text-muted">Changes apply to new enrolments only. Students who have already enrolled keep the price and instalments they signed up for.</Card>
      {note && <p className="rounded-xl bg-ok/10 px-3 py-2 text-sm text-ok">{note}</p>}

      {!rows ? <Skeleton className="h-28" /> : rows.length === 0 ? <Card className="text-center text-muted">No packages yet.</Card> : rows.map((p) => {
        const inst = [...(p.package_instalments ?? [])].sort((a: any, b: any) => a.number - b.number);
        const total = inst.reduce((s: number, i: any) => s + i.amount, 0);
        return (
          <Card key={p.id} className="space-y-3">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0"><p className="font-medium">{p.name}</p>
                <p className="text-sm text-muted">{p.course_count} course{p.course_count === 1 ? "" : "s"}{p.duration_weeks ? ` · ${p.duration_weeks} weeks` : ""}</p></div>
              <div className="shrink-0 space-y-1 text-right"><p className="num text-lg font-semibold">{naira(p.price_full)}</p><Badge tone={p.is_active ? "ok" : "muted"}>{p.is_active ? "On sale" : "Hidden"}</Badge></div>
            </div>
            {inst.length === 0 ? <p className="text-sm text-muted">Pay in full only</p> : (
              <div className="space-y-1 text-sm">
                {inst.map((i: any) => <div key={i.number} className="flex justify-between gap-3"><span className="min-w-0 truncate text-muted">{i.number}. {i.label}</span><span className="num">{naira(i.amount)}</span></div>)}
                {total !== p.price_full && <p className="text-warn">Instalments total {naira(total)}, {total > p.price_full ? "more" : "less"} than paying in full.</p>}
              </div>)}
            <Button variant="secondary" className="h-10 w-full" onClick={() => edit(p)}>Edit</Button>
          </Card>);
      })}

      <div className="pt-4"><SoloPrices /></div>

      <Sheet open={!!f} onClose={() => setF(null)} title={f?.id ? "Edit package" : "New package"}>
        {f && <div className="space-y-3">
          <Field label="Name" value={f.name} onChange={(e) => set({ name: e.target.value })} />
          {!f.id && <Field label="Short code (can't be changed later)" value={f.code} placeholder="e.g. STANDARD" onChange={(e) => set({ code: e.target.value.toUpperCase() })} />}
          <Field label="Description (shown to students)" value={f.description} onChange={(e) => set({ description: e.target.value })} />
          <div className="grid grid-cols-2 gap-3">
            <Field label="Courses in the pack" inputMode="numeric" value={f.courses} onChange={(e) => set({ courses: digits(e.target.value).slice(0, 2) })} />
            <Field label="Weeks (optional)" inputMode="numeric" value={f.weeks} onChange={(e) => set({ weeks: digits(e.target.value).slice(0, 3) })} />
          </div>
          <Field label="Full price (₦), if paid in one go" inputMode="numeric" value={f.price} onChange={(e) => set({ price: digits(e.target.value).slice(0, 9) })} />
          <label className="flex items-center gap-3 rounded-xl bg-sunken p-3 text-sm"><input type="checkbox" checked={f.active} onChange={(e) => set({ active: e.target.checked })} />On sale (students can choose this pack)</label>

          <div className="space-y-3 rounded-2xl bg-sunken/60 p-3">
            <label className="flex items-center gap-3 text-sm font-medium"><input type="checkbox" checked={f.instOn} onChange={(e) => toggleInst(e.target.checked)} />Let students pay in instalments</label>
            {!f.instOn ? <p className="text-sm text-muted">Students will only see “pay in full”{priceN > 0 ? ` (${naira(priceN * 100)})` : ""}.</p> : <>
              {f.inst.map((r, i) => {
                const base = Array.from({ length: Math.max(0, Math.min(courseN, 4) - 1) }, (_, k) => `before_course_${k + 2}`);
                const opts = [...new Set([...base, "custom", r.rule])];
                return (
                  <div key={i} className="space-y-2 rounded-xl bg-surface p-3 ring-1 ring-line">
                    <div className="flex items-center justify-between"><span className="text-sm font-medium">Instalment {i + 1}</span>
                      {i > 0 && <button type="button" onClick={() => removeRow(i)} className="text-sm text-bad">Remove</button>}</div>
                    <Field label="Name" value={r.label} onChange={(e) => setRow(i, { label: e.target.value })} />
                    <Field label="Amount (₦)" inputMode="numeric" value={r.amount} onChange={(e) => setRow(i, { amount: digits(e.target.value).slice(0, 9) })} />
                    {i === 0 ? <p className="text-sm text-muted">Due before classes start. Paying it activates the enrolment.</p>
                      : <select className={sel} value={r.rule} onChange={(e) => setRow(i, { rule: e.target.value })}>{opts.map((o) => <option key={o} value={o}>{ruleText(o)}</option>)}</select>}
                  </div>);
              })}
              <div className="flex gap-2">
                <Button type="button" variant="secondary" className="h-10 flex-1 text-sm" disabled={f.inst.length >= MAX_INST} onClick={addRow}>+ Add instalment</Button>
                <Button type="button" variant="secondary" className="h-10 flex-1 text-sm" disabled={!(priceN > 0)} onClick={splitEvenly}>Split evenly</Button>
              </div>
              {instTotal > 0 && priceN > 0 && <p className={cx("text-sm", diff === 0 ? "text-ok" : "text-warn")}>
                {diff === 0 ? "✓ The instalments add up to the full price." : `Instalments total ${naira(instTotal * 100)}, ${naira(Math.abs(diff) * 100)} ${diff > 0 ? "more" : "less"} than the full price. Students paying by instalments will pay ${naira(instTotal * 100)} in total.`}</p>}
            </>}
          </div>

          {show && problems.length > 0 && <ul className="space-y-1 rounded-xl bg-warn/10 px-3 py-2 text-sm text-warn">{problems.map((p) => <li key={p}>• {p}</li>)}</ul>}
          <Err>{err}</Err>
          <Button className="w-full" loading={busy} onClick={save}>Save</Button>
        </div>}
      </Sheet>
    </div>
  );
}

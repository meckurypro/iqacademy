import { place, placeSub } from "../lib/centre";
import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { supabase, friendly } from "../lib/supabase";
import { mapDuplicate, ok, touched } from "../lib/db";
import { useFeedback } from "../components/feedback";
import { Badge, Button, Card, Err, Field, Sheet, Skeleton } from "../components/ui";

import Icon from "../components/Icon";
/* eslint-disable @typescript-eslint/no-explicit-any */
const empty = { id: "", name: "", code: "", address: "", city: "Lagos", state: "Lagos", capacity: "", share: "0", contact: "", phone: "", lat: "", lng: "", active: true };
export default function Centres() {
  const { run, confirm } = useFeedback();
  const [rows, setRows] = useState<any[]>(); const [loadErr, setLoadErr] = useState(""); const [f, setF] = useState<typeof empty | null>(null);
  const [bank, setBank] = useState<any>(null); const [banks, setBanks] = useState<{ name: string; code: string }[]>([]);
  const [acct, setAcct] = useState({ code: "", number: "" }); const [accName, setAccName] = useState("");
  const [err, setErr] = useState("");

  const load = useCallback(async () => {
    const { data, error } = await supabase.from("centres").select("id,name,code,address,city,state,latitude,longitude,contact_name,contact_phone,default_capacity,is_active,centre_terms(revenue_share_pct),centre_payout_accounts(bank_name,account_last4,account_name)").order("name");
    if (error) { setLoadErr(friendly(error)); return setRows([]); }
    setLoadErr(""); setRows(data ?? []);
  }, []);
  useEffect(() => { load(); }, [load]);

  const save = async () => {
    if (!f) return; setErr("");
    const body = { name: f.name.trim(), code: f.code.trim().toUpperCase(), address: f.address || null, city: f.city || null, state: f.state || null, contact_name: f.contact || null, contact_phone: f.phone || null, latitude: f.lat ? Number(f.lat) : null, longitude: f.lng ? Number(f.lng) : null, default_capacity: f.capacity ? Number(f.capacity) : null, is_active: f.active };
    const share = Number(f.share || 0);
    if (!(share >= 0 && share <= 100)) return setErr("The centre's share must be between 0 and 100%.");
    const r = await run(f.id ? "Saving centre…" : "Creating centre…", async () => {
      let id = f.id;
      try {
        if (id) touched(await supabase.from("centres").update(body).eq("id", id).select("id"));
        else id = (ok(await supabase.from("centres").insert(body).select("id").single()) as { id: string }).id;
      } catch (e) { throw mapDuplicate(e, "centre_code_taken"); }
      // The revenue share lives in its own table. Update it, or create the row if the centre has none yet, and make sure it stuck.
      const up = await supabase.from("centre_terms").update({ revenue_share_pct: share }).eq("centre_id", id).select("centre_id");
      if (up.error) throw up.error;
      if (!up.data?.length) {
        const ins = await supabase.from("centre_terms").insert({ centre_id: id, revenue_share_pct: share });
        if (ins.error) throw mapDuplicate(ins.error, "not_saved");
      }
      await load();
    }, { success: f.id ? "Centre saved" : "Centre created", quiet: true });
    if (!r.ok) return setErr(r.message);
    setF(null);
  };

  const remove = async () => {
    if (!f?.id) return;
    const yes = await confirm({
      title: `Delete ${f.name || "this centre"}?`,
      message: "This permanently deletes the centre with its class days, course runs, team roles and payout account. It can't be deleted once it has students enrolled, payments or attendance on record. Hide it instead (turn off “Open for students”).",
      confirmLabel: "Delete centre", danger: true,
    });
    if (!yes) return; setErr("");
    const r = await run("Deleting centre…", async () => {
      const { error } = await supabase.rpc("delete_centre", { p_centre_id: f.id }); if (error) throw error;
      await load();
    }, { success: "Centre deleted", quiet: true });
    if (!r.ok) return setErr(r.message);
    setF(null);
  };

  const fn = async (body: object) => { const r = await supabase.functions.invoke("paystack-create-recipient", { body }); return r.data ?? { error: "failed" }; };
  const openBank = async (c: any) => { setBank(c); setErr(""); setAccName(""); setAcct({ code: "", number: "" }); if (!banks.length) setBanks((await fn({ action: "list_banks" })).banks ?? []); };
  const resolve = async () => {
    setErr("");
    const r = await run("Verifying account…", () => fn({ action: "resolve", bank_code: acct.code, account_number: acct.number }), { quiet: true });
    if (!r.ok) return setErr(r.message);
    r.data.account_name ? setAccName(r.data.account_name) : setErr("Couldn't find that account. Check the bank and number.");
  };
  const saveBank = async () => {
    setErr("");
    const r = await run("Saving payout account…", async () => {
      const out = await fn({ action: "save", centre_id: bank.id, bank_code: acct.code, account_number: acct.number });
      if (!out.ok) throw new Error("not_saved");
      await load();
    }, { success: "Payout account saved", quiet: true });
    if (!r.ok) return setErr("Couldn't save the account.");
    setBank(null);
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between"><h1 className="text-2xl">Centres</h1><Button className="h-10" onClick={() => { setErr(""); setF(empty); }}>+ New</Button></div>
      {loadErr && <div className="space-y-2"><Err>{loadErr}</Err><Button variant="secondary" onClick={load}>Try again</Button></div>}
      {!rows ? <Skeleton className="h-24" /> : rows.length === 0 && !loadErr ? <Card className="text-center text-muted">No centres yet. Tap “+ New” to add one.</Card> : rows.map((c) => { const t = c.centre_terms?.revenue_share_pct ?? c.centre_terms?.[0]?.revenue_share_pct; const a = c.centre_payout_accounts?.account_last4 ? c.centre_payout_accounts : c.centre_payout_accounts?.[0];
        return (
        <Card key={c.id} className="space-y-3"><div className="flex items-start justify-between gap-2"><div className="min-w-0"><p className="font-medium">{place(c)}</p>{placeSub(c) && <p className="text-sm text-muted">{placeSub(c)}</p>}</div>
          <div className="flex shrink-0 flex-col items-end gap-1"><Badge tone="ok">{t ?? 0}% share</Badge>{!c.is_active && <Badge>Hidden</Badge>}</div></div>
          <p className="text-sm text-muted">{a?.account_last4 ? `Payout: ${a.bank_name} ••${a.account_last4} (${a.account_name})` : "No payout account yet"}</p>
          <div className="flex gap-2"><Button variant="secondary" className="h-10 flex-1" onClick={() => { setErr(""); setF({ id: c.id, name: c.name, code: c.code, address: c.address ?? "", city: c.city ?? "", state: c.state ?? "", capacity: c.default_capacity ?? "", share: String(t ?? 0), contact: c.contact_name ?? "", phone: c.contact_phone ?? "", lat: c.latitude ?? "", lng: c.longitude ?? "", active: c.is_active !== false }); }}>Edit</Button>
            <Button variant="secondary" className="h-10 flex-1" onClick={() => openBank(c)}>Bank account</Button>
            <Link to={`/team/${c.id}`} className="flex-1"><Button variant="secondary" className="h-10 w-full">Team</Button></Link></div></Card>); })}

      <Sheet open={!!f} onClose={() => setF(null)} title={f?.id ? "Edit centre" : "New centre"}>
        {f && <div className="space-y-3"><Field label="Name" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /><Field label="Short code" value={f.code} onChange={(e) => setF({ ...f, code: e.target.value })} placeholder="e.g. YABA" />
          <Field label="Address" value={f.address} onChange={(e) => setF({ ...f, address: e.target.value })} /><div className="grid grid-cols-2 gap-3"><Field label="City" value={f.city} onChange={(e) => setF({ ...f, city: e.target.value })} /><Field label="State" value={f.state} onChange={(e) => setF({ ...f, state: e.target.value })} /></div>
          <div className="grid grid-cols-2 gap-3"><Field label="Contact person" value={f.contact} onChange={(e) => setF({ ...f, contact: e.target.value })} /><Field label="Contact phone" type="tel" value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} /></div>
          <Button variant="secondary" className="h-10 w-full text-sm" onClick={() => navigator.geolocation?.getCurrentPosition((g) => setF({ ...f, lat: g.coords.latitude.toFixed(6), lng: g.coords.longitude.toFixed(6) }))}><span className="inline-flex items-center gap-2"><Icon name="pin" size={16} />{f.lat ? `${f.lat}, ${f.lng}` : "Use my current location (when at the centre)"}</span></Button>
          <Field label="Capacity" type="number" value={f.capacity} onChange={(e) => setF({ ...f, capacity: e.target.value })} />
          <Field label="Centre's share of tuition (%)" type="number" step="0.5" min="0" max="100" value={f.share} onChange={(e) => setF({ ...f, share: e.target.value })} />
          <label className="flex items-start gap-3 rounded-xl bg-sunken p-3 text-sm"><input type="checkbox" className="mt-0.5 h-5 w-5 accent-[rgb(var(--accent))]" checked={f.active} onChange={(e) => setF({ ...f, active: e.target.checked })} />
            <span><span className="font-medium">Open for students</span><span className="block text-muted">Turn off to hide this centre from enrolment without deleting it.</span></span></label>
          <Err>{err}</Err><Button className="w-full" disabled={!f.name || !f.code} onClick={save}>Save</Button>
          {f.id && <Button variant="ghost" className="w-full text-bad" onClick={remove}>Delete this centre…</Button>}</div>}
      </Sheet>
      <Sheet open={!!bank} onClose={() => setBank(null)} title={`Bank account · ${bank?.name ?? ""}`}>
        <div className="space-y-3"><select value={acct.code} onChange={(e) => { setAcct({ ...acct, code: e.target.value }); setAccName(""); }} className="h-12 w-full rounded-xl bg-sunken px-4 outline-none"><option value="">{banks.length ? "Choose bank…" : "Loading banks…"}</option>{banks.map((b) => <option key={b.code} value={b.code}>{b.name}</option>)}</select>
          <Field label="Account number" inputMode="numeric" maxLength={10} value={acct.number} onChange={(e) => { setAcct({ ...acct, number: e.target.value.replace(/\D/g, "") }); setAccName(""); }} />
          {accName && <p className="flex items-center gap-2 rounded-xl bg-ok/10 px-3 py-2 text-sm text-ok"><Icon name="check" size={16} className="shrink-0" />{accName}</p>}<Err>{err}</Err>
          {!accName ? <Button className="w-full" disabled={!acct.code || acct.number.length !== 10} onClick={resolve}>Verify account</Button>
            : <Button className="w-full" onClick={saveBank}>Save payout account</Button>}</div>
      </Sheet>
    </div>
  );
}

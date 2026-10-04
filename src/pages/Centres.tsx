import { place, placeSub } from "../lib/centre";
import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { supabase, friendly } from "../lib/supabase";
import { Badge, Button, Card, Err, Field, Sheet, Skeleton } from "../components/ui";

/* eslint-disable @typescript-eslint/no-explicit-any */
const empty = { id: "", name: "", code: "", address: "", city: "Lagos", state: "Lagos", capacity: "", share: "0", contact: "", phone: "", lat: "", lng: "" };
export default function Centres() {
  const [rows, setRows] = useState<any[]>(); const [f, setF] = useState<typeof empty | null>(null);
  const [bank, setBank] = useState<any>(null); const [banks, setBanks] = useState<{ name: string; code: string }[]>([]);
  const [acct, setAcct] = useState({ code: "", number: "" }); const [accName, setAccName] = useState("");
  const [busy, setBusy] = useState(""); const [err, setErr] = useState("");

  const load = useCallback(async () => {
    const { data } = await supabase.from("centres").select("id,name,code,address,city,state,latitude,longitude,contact_name,contact_phone,default_capacity,is_active,centre_terms(revenue_share_pct),centre_payout_accounts(bank_name,account_last4,account_name)").order("name");
    setRows(data ?? []);
  }, []);
  useEffect(() => { load(); }, [load]);

  const save = async () => {
    if (!f) return; setBusy("save"); setErr("");
    const body = { name: f.name.trim(), code: f.code.trim().toUpperCase(), address: f.address || null, city: f.city || null, state: f.state || null, contact_name: f.contact || null, contact_phone: f.phone || null, latitude: f.lat ? Number(f.lat) : null, longitude: f.lng ? Number(f.lng) : null, default_capacity: f.capacity ? Number(f.capacity) : null };
    let id = f.id;
    if (id) { const { error } = await supabase.from("centres").update(body).eq("id", id); if (error) { setBusy(""); return setErr(friendly(error)); } }
    else { const { data, error } = await supabase.from("centres").insert(body).select("id").single(); if (error) { setBusy(""); return setErr(error.message.includes("duplicate") ? "That centre code is already used." : friendly(error)); } id = data.id; }
    await supabase.from("centre_terms").update({ revenue_share_pct: Number(f.share) }).eq("centre_id", id);
    setBusy(""); setF(null); load();
  };
  const fn = async (body: object) => { const r = await supabase.functions.invoke("paystack-create-recipient", { body }); return r.data ?? { error: "failed" }; };
  const openBank = async (c: any) => { setBank(c); setErr(""); setAccName(""); setAcct({ code: "", number: "" }); if (!banks.length) setBanks((await fn({ action: "list_banks" })).banks ?? []); };
  const resolve = async () => { setBusy("resolve"); setErr(""); const r = await fn({ action: "resolve", bank_code: acct.code, account_number: acct.number }); setBusy(""); r.account_name ? setAccName(r.account_name) : setErr("Couldn't find that account. Check the bank and number."); };
  const saveBank = async () => { setBusy("bank"); const r = await fn({ action: "save", centre_id: bank.id, bank_code: acct.code, account_number: acct.number }); setBusy(""); if (!r.ok) return setErr("Couldn't save the account."); setBank(null); load(); };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between"><h1 className="text-2xl">Centres</h1><Button className="h-10" onClick={() => { setErr(""); setF(empty); }}>+ New</Button></div>
      {!rows ? <Skeleton className="h-24" /> : rows.map((c) => { const t = c.centre_terms?.revenue_share_pct ?? c.centre_terms?.[0]?.revenue_share_pct; const a = c.centre_payout_accounts?.account_last4 ? c.centre_payout_accounts : c.centre_payout_accounts?.[0];
        return (
        <Card key={c.id} className="space-y-3"><div className="flex items-start justify-between"><div><p className="font-medium">{place(c)}</p>{placeSub(c) && <p className="text-sm text-muted">{placeSub(c)}</p>}</div><Badge tone="ok">{t ?? 0}% share</Badge></div>
          <p className="text-sm text-muted">{a?.account_last4 ? `Payout: ${a.bank_name} ••${a.account_last4} (${a.account_name})` : "No payout account yet"}</p>
          <div className="flex gap-2"><Button variant="secondary" className="h-10 flex-1" onClick={() => { setErr(""); setF({ id: c.id, name: c.name, code: c.code, address: c.address ?? "", city: c.city ?? "", state: c.state ?? "", capacity: c.default_capacity ?? "", share: String(t ?? 0), contact: c.contact_name ?? "", phone: c.contact_phone ?? "", lat: c.latitude ?? "", lng: c.longitude ?? "" }); }}>Edit</Button>
            <Button variant="secondary" className="h-10 flex-1" onClick={() => openBank(c)}>Bank account</Button>
            <Link to={`/team/${c.id}`} className="flex-1"><Button variant="secondary" className="h-10 w-full">Team</Button></Link></div></Card>); })}

      <Sheet open={!!f} onClose={() => setF(null)} title={f?.id ? "Edit centre" : "New centre"}>
        {f && <div className="space-y-3"><Field label="Name" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /><Field label="Short code" value={f.code} onChange={(e) => setF({ ...f, code: e.target.value })} placeholder="e.g. YABA" />
          <Field label="Address" value={f.address} onChange={(e) => setF({ ...f, address: e.target.value })} /><div className="grid grid-cols-2 gap-3"><Field label="City" value={f.city} onChange={(e) => setF({ ...f, city: e.target.value })} /><Field label="State" value={f.state} onChange={(e) => setF({ ...f, state: e.target.value })} /></div>
          <div className="grid grid-cols-2 gap-3"><Field label="Contact person" value={f.contact} onChange={(e) => setF({ ...f, contact: e.target.value })} /><Field label="Contact phone" type="tel" value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} /></div>
          <Button variant="secondary" className="h-10 w-full text-sm" onClick={() => navigator.geolocation?.getCurrentPosition((g) => setF({ ...f, lat: g.coords.latitude.toFixed(6), lng: g.coords.longitude.toFixed(6) }))}>{f.lat ? `📍 ${f.lat}, ${f.lng}` : "📍 Use my current location (when at the centre)"}</Button>
          <Field label="Capacity" type="number" value={f.capacity} onChange={(e) => setF({ ...f, capacity: e.target.value })} />
          <Field label="Centre's share of tuition (%)" type="number" step="0.5" min="0" max="100" value={f.share} onChange={(e) => setF({ ...f, share: e.target.value })} />
          <Err>{err}</Err><Button className="w-full" loading={busy === "save"} disabled={!f.name || !f.code} onClick={save}>Save</Button></div>}
      </Sheet>
      <Sheet open={!!bank} onClose={() => setBank(null)} title={`Bank account · ${bank?.name ?? ""}`}>
        <div className="space-y-3"><select value={acct.code} onChange={(e) => { setAcct({ ...acct, code: e.target.value }); setAccName(""); }} className="h-12 w-full rounded-xl bg-sunken px-4 outline-none"><option value="">{banks.length ? "Choose bank…" : "Loading banks…"}</option>{banks.map((b) => <option key={b.code} value={b.code}>{b.name}</option>)}</select>
          <Field label="Account number" inputMode="numeric" maxLength={10} value={acct.number} onChange={(e) => { setAcct({ ...acct, number: e.target.value.replace(/\D/g, "") }); setAccName(""); }} />
          {accName && <p className="rounded-xl bg-ok/10 px-3 py-2 text-sm text-ok">✓ {accName}</p>}<Err>{err}</Err>
          {!accName ? <Button className="w-full" loading={busy === "resolve"} disabled={!acct.code || acct.number.length !== 10} onClick={resolve}>Verify account</Button>
            : <Button className="w-full" loading={busy === "bank"} onClick={saveBank}>Save payout account</Button>}</div>
      </Sheet>
    </div>
  );
}

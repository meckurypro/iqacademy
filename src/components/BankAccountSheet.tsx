// src/components/BankAccountSheet.tsx — an instructor or centre director saves THEIR OWN payout bank account.
// Pick the bank (live list from Paystack, never hard-coded), type the 10-digit number, and the account NAME appears so they can check it is theirs.
import { useEffect, useMemo, useState } from "react";
import { supabase } from "../lib/supabase";
import { Button, Err, Field, Sheet } from "./ui";
import Icon from "./Icon";

export type BankTarget = { kind: "instructor" } | { kind: "centre"; centreId: string; label?: string };
type Bank = { name: string; code: string };
let bankCache: Bank[] | null = null; // the list rarely changes: fetch once per visit

/* eslint-disable @typescript-eslint/no-explicit-any */
async function call(body: object): Promise<any> {
  const { data, error } = await supabase.functions.invoke("paystack-create-recipient", { body });
  if (!error) return data;
  try { return await (error as any).context.json(); } catch { return { error: "failed" }; }
}
const say = (r: any) => r?.error === "payouts_not_configured" ? "Bank setup isn't switched on yet. You'll be able to add your account once payments are configured."
  : r?.error === "could_not_resolve_account" ? "Couldn't find that account. Check the bank and number."
  : r?.detail ?? "Something went wrong. Please try again.";

export default function BankAccountSheet({ open, onClose, target, onSaved }: { open: boolean; onClose: () => void; target: BankTarget; onSaved: () => void }) {
  const [banks, setBanks] = useState<Bank[]>(bankCache ?? []); const [q, setQ] = useState("");
  const [code, setCode] = useState(""); const [num, setNum] = useState("");
  const [name, setName] = useState(""); const [busy, setBusy] = useState(""); const [err, setErr] = useState(""); const [warn, setWarn] = useState("");

  useEffect(() => {
    if (!open) return; setCode(""); setNum(""); setName(""); setErr(""); setWarn(""); setQ("");
    if (bankCache) return;
    call({ action: "list_banks" }).then((r) => { if (r?.banks) { bankCache = r.banks; setBanks(r.banks); } else setErr(say(r)); });
  }, [open]);

  // The name shows up as soon as a bank is chosen and 10 digits are typed.
  useEffect(() => {
    setName(""); if (!code || num.length !== 10) return;
    let live = true; setBusy("Checking account…"); setErr("");
    call({ action: "resolve", bank_code: code, account_number: num }).then((r) => {
      if (!live) return; setBusy(""); r?.account_name ? setName(r.account_name) : setErr(say(r));
    });
    return () => { live = false; };
  }, [code, num]);

  const shown = useMemo(() => banks.filter((b) => !q.trim() || b.name.toLowerCase().includes(q.trim().toLowerCase())), [banks, q]);
  const save = async () => {
    setBusy("Saving…"); setErr("");
    const r = await call({ action: "save", bank_code: code, account_number: num, ...(target.kind === "instructor" ? { target: "instructor" } : { centre_id: target.centreId }) });
    setBusy("");
    if (!r?.ok) return setErr(say(r));
    if (r.name_match === false) { setWarn("This account name doesn't match your profile name. It's saved, but an admin will check it before paying."); setTimeout(() => { onSaved(); onClose(); }, 2600); return; }
    onSaved(); onClose();
  };

  return (
    <Sheet open={open} onClose={onClose} title={target.kind === "centre" && target.label ? `Bank account · ${target.label}` : "Payout bank account"}>
      <div className="space-y-3">
        <p className="text-sm text-muted">Payouts go to this account. Choose the bank, type the account number, and check the name that appears is yours.</p>
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search for your bank" className="h-11 w-full rounded-xl bg-sunken px-4 outline-none" />
        <select value={code} onChange={(e) => setCode(e.target.value)} size={1} className="h-12 w-full rounded-xl bg-sunken px-4 outline-none">
          <option value="">{banks.length ? "Choose bank…" : "Loading banks…"}</option>
          {shown.map((b) => <option key={b.code} value={b.code}>{b.name}</option>)}
        </select>
        <Field label="Account number" inputMode="numeric" maxLength={10} value={num} onChange={(e) => setNum(e.target.value.replace(/\D/g, ""))} />
        {busy && <p className="text-sm text-muted">{busy}</p>}
        {name && <p className="flex items-center gap-2 rounded-xl bg-ok/10 px-3 py-2 text-sm text-ok"><Icon name="check" size={16} className="shrink-0" />{name}</p>}
        {warn && <p className="rounded-xl bg-warn/10 px-3 py-2 text-sm text-warn">{warn}</p>}
        <Err>{err}</Err>
        <Button className="w-full" disabled={!name || !!busy || !!warn} onClick={save}>Save account</Button>
      </div>
    </Sheet>
  );
}

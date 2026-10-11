// src/components/CashParts.tsx
// Small pieces shared by the cash screens: the list of cash items to send, the receipt chooser and the academy bank details.
import { useRef, type ReactNode } from "react";
import { naira } from "../lib/supabase";
import type { OfflineDetails } from "../lib/offline";
import { fmtWhen } from "../lib/time";
import { useFeedback } from "./feedback";
import { Button, Card, cx } from "./ui";
import Icon from "./Icon";

export type Pickable = { id: string; title: string; sub: string; amount: number; when: string };

/** Tick the cash that goes in this transfer or hand-over. Everything is ticked to begin with. */
export function PickItems({ items, picked, onChange }: { items: Pickable[]; picked: Set<string>; onChange: (s: Set<string>) => void }) {
  const total = items.filter((i) => picked.has(i.id)).reduce((n, i) => n + i.amount, 0);
  const all = picked.size === items.length;
  const flip = (id: string) => { const s = new Set(picked); if (s.has(id)) s.delete(id); else s.add(id); onChange(s); };
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between text-sm">
        <button type="button" className="text-accent" onClick={() => onChange(all ? new Set() : new Set(items.map((i) => i.id)))}>{all ? "Untick all" : "Tick all"}</button>
        <span className="text-muted">{picked.size} of {items.length} · <span className="num font-semibold text-ink">{naira(total)}</span></span>
      </div>
      <div className="max-h-56 divide-y divide-line overflow-y-auto rounded-2xl ring-1 ring-line">
        {items.map((i) => (
          <label key={i.id} className="flex cursor-pointer items-center gap-3 px-3 py-2.5">
            <input type="checkbox" className="h-4 w-4 shrink-0" checked={picked.has(i.id)} onChange={() => flip(i.id)} />
            <span className="min-w-0 flex-1"><span className="block truncate text-sm font-medium">{i.title}</span><span className="block truncate text-xs text-muted">{i.sub} · {fmtWhen(i.when, { day: "numeric", month: "short" })}</span></span>
            <span className="num shrink-0 text-sm font-semibold">{naira(i.amount)}</span>
          </label>))}
      </div>
    </div>
  );
}

/** Photo or PDF of the bank receipt, plus an optional note. */
export function ReceiptField({ file, setFile, note, setNote }: { file: File | null; setFile: (f: File | null) => void; note: string; setNote: (s: string) => void }) {
  const pick = useRef<HTMLInputElement>(null);
  return (
    <div className="space-y-3">
      <input ref={pick} type="file" accept="image/*,application/pdf" className="hidden" onChange={(e) => { setFile(e.target.files?.[0] ?? null); e.target.value = ""; }} />
      {file ? (
        <div className="flex items-center justify-between gap-3 rounded-xl bg-sunken px-4 py-3 text-sm">
          <span className="flex min-w-0 items-center gap-2"><Icon name={file.type === "application/pdf" ? "file" : "image"} size={18} className="shrink-0 text-muted" /><span className="truncate">{file.name}</span></span>
          <button type="button" onClick={() => setFile(null)} className="text-muted">Remove</button>
        </div>
      ) : <Button type="button" variant="secondary" className="w-full" onClick={() => pick.current?.click()}>Choose receipt photo or PDF</Button>}
      <label className="block"><span className="mb-1.5 block text-sm text-muted">Note for the team (optional)</span>
        <textarea value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} placeholder="e.g. Sent from GTB at 2pm" className="min-h-[64px] w-full rounded-xl bg-surface px-4 py-3 text-[15px] outline-none ring-1 ring-line transition focus:ring-2 focus:ring-accent/60" /></label>
    </div>
  );
}

/** The academy account the money goes to (the same details students see for transfers). */
export function BankCard({ bank, title = "Send it to this account" }: { bank: OfflineDetails; title?: string }) {
  const { toast } = useFeedback();
  const copy = async (text: string, what: string) => { try { await navigator.clipboard.writeText(text); toast(`${what} copied`, "ok"); } catch { toast("Couldn't copy. Select the text and copy it.", "bad"); } };
  if (!bank.account_number && !bank.bank_name) return <Card className="text-sm text-warn">No academy bank account is set up yet. Ask an admin to add it on the Offline payments page.</Card>;
  return (
    <Card className="space-y-2 text-sm">
      <p className="font-medium">{title}</p>
      {bank.bank_name && <div className="flex justify-between gap-3"><span className="text-muted">Bank</span><span className="font-medium">{bank.bank_name}</span></div>}
      {bank.account_name && <div className="flex justify-between gap-3"><span className="text-muted">Account name</span><span className="text-right font-medium">{bank.account_name}</span></div>}
      {bank.account_number && <button type="button" onClick={() => copy(bank.account_number!, "Account number")} className="flex w-full items-center justify-between gap-3 rounded-xl bg-sunken px-4 py-3 text-left">
        <span><span className="block text-xs text-muted">Account number</span><span className="num text-lg font-semibold tracking-wide">{bank.account_number}</span></span><span className="text-accent">Copy</span></button>}
    </Card>
  );
}

export const Steps = ({ children }: { children: ReactNode }) => <div className="space-y-4">{children}</div>;
export const Pill = ({ on, children }: { on?: boolean; children: ReactNode }) => <span className={cx("rounded-full px-2.5 py-1 text-xs font-medium", on ? "bg-accent text-accent-ink" : "bg-sunken text-muted")}>{children}</span>;

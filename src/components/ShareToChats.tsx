// src/components/ShareToChats.tsx
// Instructor: pick other class chats and send the chosen messages into them. They arrive as ordinary messages from the
// instructor (sent now, no "forwarded" label), so the students there read them like anything else the instructor posts.
import { useEffect, useState } from "react";
import { supabase } from "../lib/supabase";
import { Badge, Button, cx, Sheet, Skeleton } from "./ui";
import { useFeedback } from "./feedback";
import Icon from "./Icon";
import { channelDate, type Channel } from "../lib/channels";
import { sendToChats, type ClassMessage } from "../lib/messages";

export default function ShareToChats({ open, onClose, fromSession, messages, onDone }:
  { open: boolean; onClose: () => void; fromSession: string; messages: ClassMessage[]; onDone?: () => void }) {
  const { run, toast } = useFeedback();
  const [rows, setRows] = useState<Channel[] | null>(null); const [picked, setPicked] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (!open) return;
    setPicked(new Set()); setRows(null);
    supabase.rpc("instructor_class_channels").then((r) => setRows(((r.data as Channel[]) ?? []).filter((c) => c.session_id !== fromSession)));
  }, [open, fromSession]);

  const toggle = (id: string) => setPicked((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const count = messages.length; const label = `${count} message${count === 1 ? "" : "s"}`;

  const send = async () => {
    const targets = [...picked]; if (!targets.length || !count) return;
    const r = await run("Sending…", () => sendToChats(messages, targets), { quiet: true });
    if (!r.ok) return toast(r.message, "bad");
    const { ok, failed } = r.data;
    if (ok.length) toast(`Sent ${label} to ${ok.length} chat${ok.length === 1 ? "" : "s"}`);
    if (failed.length) {
      const names = (rows ?? []).filter((c) => failed.includes(c.session_id)).map((c) => c.course_title).join(", ");
      toast(`Couldn't finish${names ? ` for ${names}` : ""}. Check your connection and try again.`, "bad");
      setPicked(new Set(failed));
      if (!ok.length) return;
    }
    onDone?.(); if (!failed.length) onClose();
  };

  return (
    <Sheet open={open} onClose={onClose} title="Send to other chats">
      <div className="space-y-3">
        <p className="text-sm text-muted">{label} will appear in each chat you pick as if you had just sent {count === 1 ? "it" : "them"} there. Students in those classes can read {count === 1 ? "it" : "them"}; they can't reply.</p>
        {rows === null ? <div className="space-y-2"><Skeleton className="h-14" /><Skeleton className="h-14" /></div>
          : rows.length === 0 ? <p className="rounded-2xl border border-dashed border-line px-4 py-6 text-center text-sm text-muted">You have no other class chats yet. A class's chat opens when its check-in opens.</p>
          : <div className="max-h-[46dvh] space-y-2 overflow-y-auto pr-0.5">
            {rows.map((c) => {
              const on = picked.has(c.session_id);
              return (
                <button key={c.session_id} onClick={() => toggle(c.session_id)} aria-pressed={on}
                  className={cx("flex w-full items-center gap-3 rounded-2xl bg-surface px-3.5 py-3 text-left ring-1 transition active:scale-[.99]", on ? "ring-2 ring-accent" : "ring-line")}>
                  <span className={cx("grid h-6 w-6 shrink-0 place-items-center rounded-full ring-1 transition", on ? "bg-accent text-accent-ink ring-accent" : "text-transparent ring-line")}><Icon name="check" size={14} /></span>
                  <span className="min-w-0 flex-1 leading-tight"><span className="block truncate font-medium">{c.course_title}</span>
                    <span className="block truncate text-sm text-muted">{[c.lesson_title, channelDate(c)].filter(Boolean).join(" · ")}</span></span>
                  {c.status === "in_progress" && <Badge tone="ok">Live</Badge>}
                </button>);
            })}
          </div>}
        <Button className="w-full" disabled={!picked.size || !count} onClick={send}>{picked.size ? `Send to ${picked.size} chat${picked.size === 1 ? "" : "s"}` : "Pick a chat"}</Button>
      </div>
    </Sheet>
  );
}

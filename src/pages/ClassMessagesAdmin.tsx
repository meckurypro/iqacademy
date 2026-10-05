// src/pages/ClassMessagesAdmin.tsx — admins see every class message and are the only people who can delete one.
import { useCallback, useEffect, useState } from "react";
import { supabase, friendly } from "../lib/supabase";
import { ok } from "../lib/db";
import { BUCKET, mergeMessages, type ClassMessage } from "../lib/messages";
import { Button, Card, Empty, Err, Skeleton } from "../components/ui";
import { useFeedback } from "../components/feedback";
import MessageBubble from "../components/MessageBubble";
import { fmtDay } from "../lib/time";

const PAGE = 30;

export default function ClassMessagesAdmin() {
  const { run, confirm, toast } = useFeedback();
  const [msgs, setMsgs] = useState<ClassMessage[] | null>(null); const [err, setErr] = useState("");
  const [more, setMore] = useState(false); const [loadingMore, setLoadingMore] = useState(false);

  const load = useCallback(async () => {
    const { data, error } = await supabase.rpc("admin_class_messages", { p_limit: PAGE });
    if (error) { setErr(friendly(error)); setMsgs([]); return; }
    const rows = (data as ClassMessage[]) ?? []; setMore(rows.length === PAGE); setMsgs(mergeMessages([], rows).reverse());
  }, []);
  useEffect(() => { load(); }, [load]);

  const older = async () => {
    if (!msgs?.length) return; setLoadingMore(true);
    const { data, error } = await supabase.rpc("admin_class_messages", { p_limit: PAGE, p_before: msgs[msgs.length - 1].created_at });
    setLoadingMore(false); if (error) return setErr(friendly(error));
    const rows = (data as ClassMessage[]) ?? []; setMore(rows.length === PAGE); setMsgs((o) => [...(o ?? []), ...mergeMessages([], rows).reverse()]);
  };

  const remove = async (m: ClassMessage) => {
    const preview = m.body ? `“${m.body.slice(0, 80)}${m.body.length > 80 ? "…" : ""}”` : m.media_name ?? "this image";
    if (!(await confirm({ title: "Delete this message?", message: <>It disappears for every student who received it, and can't be brought back. {preview}</>, confirmLabel: "Delete message", danger: true }))) return;
    const r = await run("Deleting message…", async () => {
      const path = ok(await supabase.rpc("admin_delete_class_message", { p_id: m.id })) as string | null;
      if (path) { const { error } = await supabase.storage.from(BUCKET).remove([path]); if (error) throw new Error("file_not_removed"); }
      setMsgs((o) => (o ?? []).filter((x) => x.id !== m.id));
    }, { quiet: true });
    if (!r.ok) {
      if (/file_not_removed/.test(String((r.error as Error)?.message))) { setMsgs((o) => (o ?? []).filter((x) => x.id !== m.id)); return toast("Message deleted, but its image file couldn't be removed from storage.", "bad"); }
      return toast(r.message, "bad");
    }
    toast("Message deleted");
  };

  return (
    <div className="space-y-4">
      <div><h1 className="text-[26px] leading-tight">Class messages</h1><p className="text-sm text-muted">Everything instructors have sent to their classes. Only admins can delete.</p></div>
      <Err>{err}</Err>
      {msgs === null ? <div className="space-y-3"><Skeleton className="h-28" /><Skeleton className="h-28" /></div>
        : msgs.length === 0 ? !err && <Empty icon="messages" title="No class messages yet." />
        : <div className="space-y-5">
            {msgs.map((m) => (
              <div key={m.id} className="space-y-1.5">
                <p className="px-1 text-xs text-muted">{[m.course_title, m.centre_name, m.session_date && fmtDay(m.session_date, { day: "numeric", month: "short" })].filter(Boolean).join(" · ")}</p>
                <MessageBubble m={m} footer={<div className="mt-1.5 flex justify-end"><Button variant="ghost" className="h-9 px-3 text-sm text-bad" onClick={() => remove(m)}>Delete</Button></div>} />
              </div>))}
            {more && <Button variant="secondary" className="w-full" loading={loadingMore} onClick={older}>Show older</Button>}
          </div>}
    </div>
  );
}

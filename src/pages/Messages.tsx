// src/pages/Messages.tsx — a student's class chat. Receive-only: no composer, no delete.
import { useCallback, useEffect, useRef, useState } from "react";
import { supabase } from "../lib/supabase";
import { useAuth } from "../lib/auth";
import { Button, Card, Skeleton } from "../components/ui";
import MessageBubble from "../components/MessageBubble";
import { mergeMessages, type ClassMessage } from "../lib/messages";
import { dayOf, relativeDay } from "../lib/time";

const PAGE = 40;
const dayLabel = (d: string) => relativeDay(d, { weekday: "long", day: "numeric", month: "long" });

export default function Messages() {
  const { session } = useAuth(); const uid = session?.user.id;
  const [msgs, setMsgs] = useState<ClassMessage[] | null>(null);
  const [more, setMore] = useState(false); const [loadingMore, setLoadingMore] = useState(false);
  const endRef = useRef<HTMLDivElement>(null); const stick = useRef(true);

  const markRead = useCallback(async () => { await supabase.rpc("mark_messages_read"); dispatchEvent(new Event("messages:read")); }, []);

  const latest = useCallback(async () => {
    const { data } = await supabase.rpc("class_message_feed", { p_limit: PAGE });
    const rows = ((data as ClassMessage[]) ?? []);
    setMore((m) => (msgs === null ? rows.length === PAGE : m));
    setMsgs((old) => mergeMessages(old ?? [], rows));
    markRead();
  }, [markRead, msgs]);

  useEffect(() => {
    if (!uid) return;
    latest();
    const ch = supabase.channel(`messages-${uid}`)
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "class_messages" }, latest)
      .on("postgres_changes", { event: "DELETE", schema: "public", table: "class_messages" }, () => {
        supabase.rpc("class_message_feed", { p_limit: 100 }).then((r) => { const ids = new Set(((r.data as ClassMessage[]) ?? []).map((x) => x.id)); setMsgs((o) => (o ?? []).filter((x) => ids.has(x.id))); });
      })
      .on("postgres_changes", { event: "*", schema: "public", table: "attendance", filter: `student_id=eq.${uid}` }, latest)
      .subscribe();
    return () => { supabase.removeChannel(ch); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [uid]);

  // Open at the newest message, and follow new ones only if you were already at the bottom.
  useEffect(() => { if (msgs && stick.current) endRef.current?.scrollIntoView({ block: "end" }); }, [msgs]);
  useEffect(() => {
    const onScroll = () => { stick.current = innerHeight + scrollY >= document.documentElement.scrollHeight - 160; };
    addEventListener("scroll", onScroll, { passive: true }); return () => removeEventListener("scroll", onScroll);
  }, []);

  const older = async () => {
    if (!msgs?.length) return; stick.current = false; setLoadingMore(true);
    const { data } = await supabase.rpc("class_message_feed", { p_limit: PAGE, p_before: msgs[0].created_at });
    const rows = (data as ClassMessage[]) ?? []; setMore(rows.length === PAGE); setMsgs((o) => mergeMessages(o ?? [], rows)); setLoadingMore(false);
  };

  return (
    <div className="space-y-4">
      <div><h1 className="text-2xl">Messages</h1><p className="text-sm text-muted">From your instructors. You can't reply here.</p></div>
      {msgs === null ? <div className="space-y-3"><Skeleton className="h-24" /><Skeleton className="h-32" /></div>
        : msgs.length === 0 ? <Card className="py-10 text-center text-muted">No messages yet</Card>
        : <div className="space-y-4">
            {more && <Button variant="secondary" className="w-full" loading={loadingMore} onClick={older}>Show earlier messages</Button>}
            {msgs.map((m, i) => {
              const newDay = i === 0 || dayOf(m.created_at) !== dayOf(msgs[i - 1].created_at);
              return (<div key={m.id} className="space-y-4">
                {newDay && <p className="text-center text-xs font-medium text-muted">{dayLabel(m.created_at)}</p>}
                <MessageBubble m={m} context />
              </div>);
            })}
            <div ref={endRef} />
          </div>}
    </div>
  );
}

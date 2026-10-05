// src/pages/InstructorMessages.tsx — the instructor's Messages tab: message a class that is running, and see what you've sent.
import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { supabase } from "../lib/supabase";
import { useAuth } from "../lib/auth";
import { Button, Card, Skeleton } from "../components/ui";
import ClassComposer from "../components/ClassComposer";
import MessageBubble from "../components/MessageBubble";
import { mergeMessages, type ClassMessage } from "../lib/messages";

type Active = { id: string; course_title: string; centre_name: string; start_at: string; end_at: string; joined: number };
const PAGE = 40;
const dayLabel = (d: string) => {
  const t = new Date(d), now = new Date(), y = new Date(now); y.setDate(now.getDate() - 1);
  if (t.toDateString() === now.toDateString()) return "Today";
  if (t.toDateString() === y.toDateString()) return "Yesterday";
  return t.toLocaleDateString([], { weekday: "long", day: "numeric", month: "long", year: t.getFullYear() === now.getFullYear() ? undefined : "numeric" });
};

export default function InstructorMessages() {
  const { session } = useAuth(); const uid = session?.user.id;
  const [active, setActive] = useState<Active[] | null>(null);
  const [msgs, setMsgs] = useState<ClassMessage[] | null>(null);
  const [more, setMore] = useState(false); const [loadingMore, setLoadingMore] = useState(false);

  const loadActive = useCallback(async () => { const { data } = await supabase.rpc("instructor_active_classes"); setActive((data as Active[]) ?? []); }, []);
  const loadMsgs = useCallback(async () => {
    const { data } = await supabase.rpc("instructor_message_feed", { p_limit: PAGE });
    const rows = (data as ClassMessage[]) ?? [];
    setMore((m) => (msgs === null ? rows.length === PAGE : m)); setMsgs((o) => mergeMessages(o ?? [], rows));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!uid) return;
    loadActive(); loadMsgs();
    const ch = supabase.channel(`instructor-messages-${uid}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "class_sessions", filter: `instructor_id=eq.${uid}` }, loadActive)
      .on("postgres_changes", { event: "*", schema: "public", table: "attendance" }, loadActive)
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "class_messages" }, loadMsgs)
      .on("postgres_changes", { event: "DELETE", schema: "public", table: "class_messages" }, () => {
        supabase.rpc("instructor_message_feed", { p_limit: 100 }).then((r) => { const ids = new Set(((r.data as ClassMessage[]) ?? []).map((x) => x.id)); setMsgs((o) => (o ?? []).filter((x) => ids.has(x.id))); });
      })
      .subscribe();
    return () => { supabase.removeChannel(ch); };
  }, [uid, loadActive, loadMsgs]);

  const older = async () => {
    if (!msgs?.length) return; setLoadingMore(true);
    const { data } = await supabase.rpc("instructor_message_feed", { p_limit: PAGE, p_before: msgs[0].created_at });
    const rows = (data as ClassMessage[]) ?? []; setMore(rows.length === PAGE); setMsgs((o) => mergeMessages(o ?? [], rows)); setLoadingMore(false);
  };

  return (
    <div className="space-y-5">
      <h1 className="text-2xl">Messages</h1>

      {active === null ? <Skeleton className="h-40" />
        : active.length === 0 ? <Card className="space-y-1 py-6 text-center"><p className="font-medium">No class in progress</p>
            <p className="text-sm text-muted">You can message a class once it has started. The centre opens check-in 30 minutes before. You can follow arrivals from <Link to="/" className="font-medium text-accent">Today</Link>.</p></Card>
        : active.map((c) => (
            <section key={c.id} className="space-y-2">
              <div className="flex items-baseline justify-between gap-3 px-1"><h2 className="text-lg">{c.course_title}</h2><span className="text-xs text-muted">{c.centre_name}</span></div>
              <ClassComposer sessionId={c.id} joined={c.joined} onSent={loadMsgs} />
            </section>))}

      <section className="space-y-4">
        <h2 className="px-1 text-lg">Sent</h2>
        {msgs === null ? <Skeleton className="h-24" />
          : msgs.length === 0 ? <Card className="py-8 text-center text-muted">No messages yet</Card>
          : <>
              {more && <Button variant="secondary" className="w-full" loading={loadingMore} onClick={older}>Show earlier messages</Button>}
              {msgs.map((m, i) => {
                const newDay = i === 0 || new Date(m.created_at).toDateString() !== new Date(msgs[i - 1].created_at).toDateString();
                return <div key={m.id} className="space-y-4">{newDay && <p className="text-center text-xs font-medium text-muted">{dayLabel(m.created_at)}</p>}<MessageBubble m={m} context /></div>;
              })}
            </>}
      </section>
    </div>
  );
}

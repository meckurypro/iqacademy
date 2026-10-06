// src/pages/ClassChannel.tsx
// One class's channel. Students (who joined the class) read it; the class's instructor reads and writes. Nobody replies.
import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { supabase } from "../lib/supabase";
import { useAuth } from "../lib/auth";
import { Button, Card, Empty, Skeleton } from "../components/ui";
import MessageBubble from "../components/MessageBubble";
import ClassComposer from "../components/ClassComposer";
import Icon from "../components/Icon";
import { mergeMessages, type ClassMessage } from "../lib/messages";
import { channelDate, type Channel } from "../lib/channels";
import { dayOf, relativeDay } from "../lib/time";

const PAGE = 40;
const dayLabel = (d: string) => relativeDay(d, { weekday: "long", day: "numeric", month: "long" });

export default function ClassChannel() {
  const { id } = useParams(); const nav = useNavigate();
  const { session, roles } = useAuth(); const uid = session?.user.id;
  const teaching = roles.some((r) => r.role === "instructor");
  const [info, setInfo] = useState<Channel | null | undefined>(undefined);
  const [msgs, setMsgs] = useState<ClassMessage[] | null>(null);
  const [more, setMore] = useState(false); const [loadingMore, setLoadingMore] = useState(false);
  const endRef = useRef<HTMLDivElement>(null); const stick = useRef(true);

  const loadInfo = useCallback(async () => {
    const { data } = await supabase.rpc(teaching ? "instructor_class_channels" : "my_class_channels");
    setInfo(((data as Channel[]) ?? []).find((c) => c.session_id === id) ?? null);
  }, [id, teaching]);

  const markRead = useCallback(async () => {
    if (teaching) return;
    await supabase.rpc("mark_channel_read", { p_session_id: id });
    dispatchEvent(new Event("messages:read"));
  }, [id, teaching]);

  const latest = useCallback(async () => {
    const { data } = await supabase.rpc("class_channel_messages", { p_session_id: id, p_limit: PAGE });
    const rows = (data as ClassMessage[]) ?? [];
    setMore((m) => (m || rows.length === PAGE));
    setMsgs((old) => mergeMessages(old ?? [], rows));
    markRead();
  }, [id, markRead]);

  const reload = useCallback(async () => {
    // a deleted message disappears: re-read what's there and keep only those
    const { data } = await supabase.rpc("class_channel_messages", { p_session_id: id, p_limit: 100 });
    const ids = new Set(((data as ClassMessage[]) ?? []).map((x) => x.id));
    setMsgs((o) => mergeMessages((o ?? []).filter((x) => ids.has(x.id)), (data as ClassMessage[]) ?? []));
    markRead();
  }, [id, markRead]);

  useEffect(() => {
    if (!uid || !id) return;
    loadInfo(); latest();
    const ch = supabase.channel(`channel-${id}-${uid}`)
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "class_messages", filter: `session_id=eq.${id}` }, () => { latest(); loadInfo(); })
      .on("postgres_changes", { event: "DELETE", schema: "public", table: "class_messages" }, reload)
      .on("postgres_changes", { event: "UPDATE", schema: "public", table: "class_sessions", filter: `id=eq.${id}` }, loadInfo)
      .subscribe();
    return () => { supabase.removeChannel(ch); };
  }, [uid, id, loadInfo, latest, reload]);

  useEffect(() => { if (msgs && stick.current) endRef.current?.scrollIntoView({ block: "end" }); }, [msgs]);
  useEffect(() => {
    const onScroll = () => { stick.current = innerHeight + scrollY >= document.documentElement.scrollHeight - 160; };
    addEventListener("scroll", onScroll, { passive: true }); return () => removeEventListener("scroll", onScroll);
  }, []);

  const older = async () => {
    if (!msgs?.length) return; stick.current = false; setLoadingMore(true);
    const { data } = await supabase.rpc("class_channel_messages", { p_session_id: id, p_limit: PAGE, p_before: msgs[0].created_at });
    const rows = (data as ClassMessage[]) ?? []; setMore(rows.length === PAGE); setMsgs((o) => mergeMessages(o ?? [], rows)); setLoadingMore(false);
  };

  if (info === undefined || msgs === null) return <div className="space-y-3"><Skeleton className="h-8 w-2/3" /><Skeleton className="h-24" /><Skeleton className="h-32" /></div>;
  if (info === null) return (
    <div className="space-y-4">
      <button onClick={() => nav("/messages")} className="text-sm text-muted"><span className="inline-flex items-center gap-1.5"><Icon name="arrowLeft" size={16} />Messages</span></button>
      <Empty icon="messages" title="This channel isn't available" hint="Channels are for the students who checked in to a class, and its instructor." />
    </div>);

  return (
    <div className="space-y-4">
      <button onClick={() => nav("/messages")} className="text-sm text-muted"><span className="inline-flex items-center gap-1.5"><Icon name="arrowLeft" size={16} />Messages</span></button>
      <div><h1 className="text-[26px] leading-tight">{info.course_title}</h1>
        <p className="text-muted">{[info.lesson_title, channelDate(info), info.centre_name].filter(Boolean).join(" · ")}</p>
        <p className="mt-1 text-sm text-muted">{teaching ? `Goes to the ${info.joined ?? 0} student${info.joined === 1 ? "" : "s"} who joined this class. They can't reply.` : `From your instructor${info.instructor_first_name ? `, ${info.instructor_first_name}` : ""}. You can't reply here.`}</p></div>

      {msgs.length === 0 ? <Card className="py-8 text-center text-sm text-muted">{teaching ? "Nothing sent to this class yet." : "No messages yet. New ones appear here as they're sent, during and after the class."}</Card>
        : <div className="space-y-4">
            {more && <Button variant="secondary" className="w-full" loading={loadingMore} onClick={older}>Show earlier messages</Button>}
            {msgs.map((m, i) => {
              const newDay = i === 0 || dayOf(m.created_at) !== dayOf(msgs[i - 1].created_at);
              return (<div key={m.id} className="space-y-4">
                {newDay && <p className="text-center text-xs font-medium text-muted">{dayLabel(m.created_at)}</p>}
                <MessageBubble m={m} />
              </div>);
            })}
          </div>}
      {teaching && <ClassComposer sessionId={id!} joined={info.joined} onSent={() => { stick.current = true; latest(); }} />}
      <div ref={endRef} />
    </div>
  );
}

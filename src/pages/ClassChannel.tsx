// src/pages/ClassChannel.tsx
// One class's channel. Students (who joined the class) read it; the class's instructor reads and writes. Nobody replies.
import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { supabase } from "../lib/supabase";
import { useAuth } from "../lib/auth";
import { Avatar, Badge, Button, Empty, Skeleton } from "../components/ui";
import ChatBubble from "../components/ChatBubble";
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

  const back = <button onClick={() => nav("/messages")} aria-label="Back to messages" className="grid h-9 w-9 shrink-0 lg:hidden place-items-center rounded-full text-ink transition hover:bg-sunken active:scale-95"><Icon name="arrowLeft" size={20} /></button>;
  const who = teaching ? `${info.joined ?? 0} joined` : info.instructor_first_name ?? "Your instructor";
  const outgoing = (m: ClassMessage) => teaching && m.sender_label !== "IQ Academy";

  return (
    <div className="-mt-5 flex min-h-[calc(100dvh-8.5rem)] flex-col lg:mt-0 lg:min-h-[calc(100dvh-4rem)]">
      <div className="sticky top-14 z-20 -mx-4 flex items-center gap-2.5 border-b border-line/60 bg-bg/85 px-3 py-2 backdrop-blur-md lg:top-0 lg:mx-0 lg:rounded-t-2xl lg:border lg:border-b-line/60 lg:border-line">
        {back}
        <Avatar name={info.course_title} size={40} />
        <div className="min-w-0 flex-1 leading-tight">
          <h1 className="truncate text-[16px] font-semibold">{info.course_title}</h1>
          <p className="truncate text-xs text-muted">{[who, info.lesson_title, channelDate(info)].filter(Boolean).join(" · ")}</p>
        </div>
        {info.status === "in_progress" && <Badge tone="ok">Live</Badge>}
      </div>

      <div className="chat-bg -mx-4 flex flex-1 flex-col px-3 pb-4 pt-3 lg:mx-0 lg:px-6">
        <p className="mx-auto mb-1 max-w-[18rem] rounded-full bg-surface/80 px-3 py-1 text-center text-[11px] leading-snug text-muted shadow-card">
          {teaching ? "Students can't reply to this channel" : "Only your instructor can post here"}</p>
        {more && <Button variant="ghost" className="mx-auto my-2 h-9 px-4 text-xs" loading={loadingMore} onClick={older}>Show earlier messages</Button>}
        <div className="mt-auto">
          {msgs.length === 0 && <p className="mx-auto mt-6 max-w-[16rem] rounded-2xl bg-surface/80 px-4 py-3 text-center text-sm text-muted shadow-card">
            {teaching ? "Nothing sent to this class yet." : "No messages yet. They'll appear here as they're sent, during and after class."}</p>}
          {msgs.map((m, i) => {
            const prev = i > 0 ? msgs[i - 1] : null;
            const newDay = !prev || dayOf(m.created_at) !== dayOf(prev.created_at);
            const first = newDay || !prev || prev.sender_label !== m.sender_label;
            return (<div key={m.id}>
              {newDay && <p className="mx-auto mb-1 mt-4 w-fit rounded-full bg-surface/80 px-3 py-1 text-[11px] font-medium text-muted shadow-card">{dayLabel(m.created_at)}</p>}
              <ChatBubble m={m} out={outgoing(m)} first={first} showName={first && !outgoing(m)} />
            </div>);
          })}
        </div>
        <div ref={endRef} className="scroll-mb-32" />
      </div>
      {teaching && <ClassComposer chat sessionId={id!} joined={info.joined} onSent={() => { stick.current = true; latest(); }} />}
    </div>
  );
}

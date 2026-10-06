// src/pages/ClassChannel.tsx
// One class's channel. Students (who joined the class) read it; the class's instructor reads and writes. Nobody replies.
import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { supabase } from "../lib/supabase";
import { useAuth } from "../lib/auth";
import { Avatar, Badge, Button, Empty, IconTile, Skeleton } from "../components/ui";
import ChatBubble from "../components/ChatBubble";
import ClassComposer from "../components/ClassComposer";
import ShareToChats from "../components/ShareToChats";
import ReviewSheet, { type ReviewTarget } from "../components/ReviewSheet";
import { Stars } from "../components/Stars";
import { useFeedback } from "../components/feedback";
import Icon from "../components/Icon";
import { mergeMessages, type ClassMessage } from "../lib/messages";
import { channelDate, type Channel } from "../lib/channels";
import { dayOf, relativeDay } from "../lib/time";

const PAGE = 40;
const MAX_SELECT = 20;
const dayLabel = (d: string) => relativeDay(d, { weekday: "long", day: "numeric", month: "long" });

export default function ClassChannel() {
  const { id } = useParams(); const nav = useNavigate();
  const { session, roles } = useAuth(); const uid = session?.user.id;
  const teaching = roles.some((r) => r.role === "instructor");
  const [info, setInfo] = useState<Channel | null | undefined>(undefined);
  const [msgs, setMsgs] = useState<ClassMessage[] | null>(null);
  const [more, setMore] = useState(false); const [loadingMore, setLoadingMore] = useState(false);
  const endRef = useRef<HTMLDivElement>(null); const stick = useRef(true);
  const { toast } = useFeedback();
  // instructor: choose messages and send them on to other chats
  const [picked, setPicked] = useState<Set<string> | null>(null); const [sendOpen, setSendOpen] = useState(false); const [toSend, setToSend] = useState<ClassMessage[]>([]);
  // student: review the class once it has ended
  const [review, setReview] = useState<ReviewTarget | null>(null);

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

  const toggle = (mid: string) => setPicked((cur) => {
    const n = new Set(cur ?? []);
    if (n.has(mid)) n.delete(mid);
    else if (n.size >= MAX_SELECT) { toast(`Pick up to ${MAX_SELECT} messages at a time.`, "bad"); return cur; }
    else n.add(mid);
    return n;
  });
  const sendPicked = () => { setToSend((msgs ?? []).filter((m) => picked?.has(m.id))); setSendOpen(true); };

  if (info === undefined || msgs === null) return <div className="space-y-3"><Skeleton className="h-8 w-2/3" /><Skeleton className="h-24" /><Skeleton className="h-32" /></div>;
  if (info === null) return (
    <div className="space-y-4">
      <button onClick={() => nav("/messages")} className="text-sm text-muted"><span className="inline-flex items-center gap-1.5"><Icon name="arrowLeft" size={16} />Messages</span></button>
      <Empty icon="messages" title="This channel isn't available" hint="Channels are for the students who checked in to a class, and its instructor." />
    </div>);

  const back = <button onClick={() => nav("/messages")} aria-label="Back to messages" className="grid h-9 w-9 shrink-0 lg:hidden place-items-center rounded-full text-ink transition hover:bg-sunken active:scale-95"><Icon name="arrowLeft" size={20} /></button>;
  const who = teaching ? `${info.joined ?? 0} joined` : info.instructor_first_name ?? "Your instructor";
  const outgoing = (m: ClassMessage) => teaching && m.sender_label !== "IQ Academy";
  const locked = !teaching && !!info.locked;
  const asTarget: ReviewTarget = { session_id: info.session_id, course_title: info.course_title, lesson_title: info.lesson_title, instructor_first_name: info.instructor_first_name };
  // a class that has ended can be reviewed, once, by the students who attended it
  const reviewCard = !teaching && info.status === "completed" ? (
    info.my_rating
      ? <div className="mx-auto mb-2 flex w-fit items-center gap-2 rounded-full bg-surface/80 px-3 py-1.5 text-xs text-muted shadow-card">You rated this class <Stars value={info.my_rating} size={13} /></div>
      : <div className="glass anim-fade mb-2 flex items-center gap-3 rounded-2xl p-3 shadow-card">
          <IconTile tone="accent"><Icon name="star" size={20} solid /></IconTile>
          <div className="min-w-0 flex-1 leading-snug"><p className="font-medium">How was this class?</p><p className="text-sm text-muted">Rate it and tell us honestly.</p></div>
          <Button className="h-9 px-4 text-sm" onClick={() => setReview(asTarget)}>Rate</Button>
        </div>) : null;

  return (
    <div className="-mt-5 flex min-h-[calc(100dvh-8.5rem)] flex-col lg:mt-0 lg:min-h-[calc(100dvh-4rem)]">
      <div className="sticky top-14 z-20 -mx-4 flex items-center gap-2.5 border-b border-line/60 bg-bg/85 px-3 py-2 backdrop-blur-md lg:top-0 lg:mx-0 lg:rounded-t-2xl lg:border lg:border-line">
        {picked ? <>
          <button onClick={() => setPicked(null)} aria-label="Cancel selection" className="grid h-9 w-9 shrink-0 place-items-center rounded-full text-ink transition hover:bg-sunken active:scale-95"><Icon name="close" size={20} /></button>
          <p className="min-w-0 flex-1 text-[16px] font-semibold leading-tight">{picked.size} selected</p>
          <Button className="h-9 px-4 text-sm" disabled={!picked.size} onClick={sendPicked}><span className="inline-flex items-center gap-1.5"><Icon name="forward" size={16} />Send to chats</span></Button>
        </> : <>
          {back}
          <Avatar name={info.course_title} size={40} />
          <div className="min-w-0 flex-1 leading-tight">
            <h1 className="truncate text-[16px] font-semibold">{info.course_title}</h1>
            <p className="truncate text-xs text-muted">{[who, info.lesson_title, channelDate(info)].filter(Boolean).join(" · ")}</p>
          </div>
          {info.status === "in_progress" && <Badge tone="ok">Live</Badge>}
          {locked && <Badge tone="muted">Closed</Badge>}
        </>}
      </div>

      <div className="chat-bg -mx-4 flex flex-1 flex-col px-3 pb-4 pt-3 lg:mx-0 lg:px-6">
        {reviewCard}
        {locked ? (
          <div className="mx-auto my-auto flex max-w-[18rem] flex-col items-center gap-2.5 py-12 text-center">
            <IconTile size={56}><Icon name="lock" size={26} /></IconTile>
            <h2 className="text-lg">This chat is closed</h2>
            <p className="text-sm leading-relaxed text-muted">Your cohort has ended, so the messages in this channel are no longer available to you. Your instructor can still open it.</p>
          </div>
        ) : <>
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
                <ChatBubble m={m} out={outgoing(m)} first={first} showName={first && !outgoing(m)} restricted={!teaching}
                  onSend={teaching ? () => { setToSend([m]); setSendOpen(true); } : undefined}
                  onSelect={teaching ? () => setPicked(new Set([m.id])) : undefined}
                  selecting={!!picked} selected={picked?.has(m.id)} onToggle={() => toggle(m.id)} />
              </div>);
            })}
          </div>
          <div ref={endRef} className="scroll-mb-32" />
        </>}
      </div>
      {teaching && !picked && <ClassComposer chat sessionId={id!} joined={info.joined} onSent={() => { stick.current = true; latest(); }} />}
      {teaching && <ShareToChats open={sendOpen} onClose={() => setSendOpen(false)} fromSession={id!} messages={toSend} onDone={() => setPicked(null)} />}
      <ReviewSheet target={review} onClose={() => setReview(null)} onDone={loadInfo} />
    </div>
  );
}

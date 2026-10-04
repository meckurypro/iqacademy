// src/pages/Notifications.tsx
import { useCallback, useEffect, useState } from "react";
import { supabase } from "../lib/supabase";
import { useAuth } from "../lib/auth";
import { Avatar, Button, Card, Skeleton, cx } from "../components/ui";

type Note = { id: string; title: string; body: string | null; read_at: string | null; created_at: string; sender_label: string | null };
const PAGE = 30;

const when = (d: string) => {
  const t = new Date(d), now = new Date(), mins = Math.round((+now - +t) / 60000);
  if (mins < 1) return "Just now";
  if (mins < 60) return `${mins} min ago`;
  if (t.toDateString() === now.toDateString()) return t.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  const y = new Date(now); y.setDate(now.getDate() - 1);
  if (t.toDateString() === y.toDateString()) return "Yesterday";
  return t.toLocaleDateString([], { day: "numeric", month: "short", year: t.getFullYear() === now.getFullYear() ? undefined : "numeric" });
};

function Sender({ label }: { label: string | null }) {
  const name = label || "IQ Academy";
  return (
    <div className="flex items-center gap-2">
      {name === "IQ Academy" ? <img src="/icon-192.png" alt="" className="h-6 w-6 rounded-full" /> : <Avatar name={name.replace(/^Instructor\s+/, "")} size={24} />}
      <span className="text-xs font-semibold">{name}</span>
    </div>
  );
}

export default function Notifications() {
  const { session } = useAuth();
  const [notes, setNotes] = useState<Note[] | null>(null);
  const [fresh, setFresh] = useState<Set<string>>(new Set()); // unread when this page opened, kept highlighted until you leave
  const [more, setMore] = useState(false); const [loadingMore, setLoadingMore] = useState(false);

  const fetchPage = useCallback((before?: string) => {
    let q = supabase.from("notifications").select("id,title,body,read_at,created_at,sender_label").order("created_at", { ascending: false }).limit(PAGE + 1);
    if (before) q = q.lt("created_at", before);
    return q.then((r) => (r.data as Note[]) ?? []);
  }, []);

  const top = useCallback(async () => {
    const rows = await fetchPage();
    setMore(rows.length > PAGE);
    const page = rows.slice(0, PAGE);
    setFresh((f) => { const n = new Set(f); page.forEach((x) => !x.read_at && n.add(x.id)); return n; });
    setNotes((old) => { const m = new Map((old ?? []).map((x) => [x.id, x])); page.forEach((x) => m.set(x.id, x));
      return [...m.values()].sort((a, b) => +new Date(b.created_at) - +new Date(a.created_at)); });
    if (page.some((x) => !x.read_at)) await supabase.rpc("mark_notifications_read");
  }, [fetchPage]);

  useEffect(() => {
    if (!session) return;
    top();
    const ch = supabase.channel("notifications-page")
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "notifications", filter: `user_id=eq.${session.user.id}` }, top)
      .subscribe();
    return () => { supabase.removeChannel(ch); };
  }, [session, top]);

  const older = async () => {
    if (!notes?.length) return; setLoadingMore(true);
    const rows = await fetchPage(notes[notes.length - 1].created_at);
    setMore(rows.length > PAGE); setNotes((n) => [...(n ?? []), ...rows.slice(0, PAGE)]); setLoadingMore(false);
  };

  return (
    <div className="space-y-4">
      <h1 className="text-2xl">Notifications</h1>
      {notes === null ? <div className="space-y-3"><Skeleton className="h-24" /><Skeleton className="h-24" /><Skeleton className="h-24" /></div>
        : notes.length === 0 ? <Card className="py-10 text-center text-muted">You're all caught up.</Card>
        : <div className="space-y-3">
            {notes.map((n) => (
              <Card key={n.id} className={cx("anim-fade space-y-2", fresh.has(n.id) && "ring-accent/50")}>
                <div className="flex items-center justify-between gap-3">
                  <Sender label={n.sender_label} />
                  <span className="flex items-center gap-2 text-xs text-muted">{fresh.has(n.id) && <span className="h-2 w-2 rounded-full bg-accent" aria-label="New" />}{when(n.created_at)}</span>
                </div>
                <p className="font-medium leading-snug">{n.title}</p>
                {n.body && <p className="select-text whitespace-pre-wrap break-words text-sm leading-relaxed text-muted">{n.body}</p>}
              </Card>))}
            {more && <Button variant="secondary" className="w-full" loading={loadingMore} onClick={older}>Show older</Button>}
          </div>}
    </div>
  );
}

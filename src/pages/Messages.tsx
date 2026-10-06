// src/pages/Messages.tsx — a student's class channels. One channel per class they joined; receive-only.
import { useCallback, useEffect, useState } from "react";
import { supabase } from "../lib/supabase";
import { useAuth } from "../lib/auth";
import { Empty, Skeleton } from "../components/ui";
import ChannelRow from "../components/ChannelRow";
import type { Channel } from "../lib/channels";

export default function Messages() {
  const { session } = useAuth(); const uid = session?.user.id;
  const [rows, setRows] = useState<Channel[] | null>(null);

  const load = useCallback(async () => {
    const { data } = await supabase.rpc("my_class_channels");
    setRows((data as Channel[]) ?? []);
  }, []);

  useEffect(() => {
    if (!uid) return;
    load();
    const ch = supabase.channel(`channels-${uid}`)
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "class_messages" }, load)
      .on("postgres_changes", { event: "DELETE", schema: "public", table: "class_messages" }, load)
      .on("postgres_changes", { event: "*", schema: "public", table: "attendance", filter: `student_id=eq.${uid}` }, load)
      .subscribe();
    addEventListener("messages:read", load);
    return () => { supabase.removeChannel(ch); removeEventListener("messages:read", load); };
  }, [uid, load]);

  return (
    <div className="space-y-4">
      <h1 className="text-[26px] leading-tight">Messages</h1>
      {rows === null ? <div className="space-y-3"><Skeleton className="h-20" /><Skeleton className="h-20" /></div>
        : rows.length === 0 ? <Empty icon="messages" title="No class channels yet" hint="Check in to a class and its channel appears here." />
        : <div className="space-y-3">{rows.map((c) => <ChannelRow key={c.session_id} c={c} />)}</div>}
    </div>
  );
}

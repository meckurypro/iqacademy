// src/pages/InstructorMessages.tsx — the instructor's Messages tab: one channel per class, open from the moment check-in opens.
import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { supabase } from "../lib/supabase";
import { useAuth } from "../lib/auth";
import { Card, Skeleton } from "../components/ui";
import ChannelRow from "../components/ChannelRow";
import type { Channel } from "../lib/channels";

export default function InstructorMessages() {
  const { session } = useAuth(); const uid = session?.user.id;
  const [rows, setRows] = useState<Channel[] | null>(null);
  const load = useCallback(async () => { const { data } = await supabase.rpc("instructor_class_channels"); setRows((data as Channel[]) ?? []); }, []);

  useEffect(() => {
    if (!uid) return;
    load();
    const ch = supabase.channel(`instructor-channels-${uid}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "class_sessions", filter: `instructor_id=eq.${uid}` }, load)
      .on("postgres_changes", { event: "*", schema: "public", table: "attendance" }, load)
      .on("postgres_changes", { event: "*", schema: "public", table: "class_messages" }, load)
      .subscribe();
    return () => { supabase.removeChannel(ch); };
  }, [uid, load]);

  return (
    <div className="space-y-4">
      <div><h1 className="text-[26px] leading-tight">Messages</h1><p className="text-sm text-muted">A channel opens for each class when check-in opens, and stays open after the class ends. Students can't reply.</p></div>
      {rows === null ? <Skeleton className="h-24" />
        : rows.length === 0 ? <Card className="space-y-1 py-6 text-center"><p className="font-medium">No class channels yet</p>
            <p className="text-sm text-muted">A class's channel appears when its check-in opens, 30 minutes before it starts. You can follow arrivals from <Link to="/" className="font-medium text-accent">Today</Link>.</p></Card>
        : <div className="space-y-3">{rows.map((c) => <ChannelRow key={c.session_id} c={c} instructor />)}</div>}
    </div>
  );
}

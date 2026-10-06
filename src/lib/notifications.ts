// src/lib/notifications.ts — unread notification count, kept live. Shared by the phone header bell and the desktop sidebar.
import { useCallback, useEffect, useState } from "react";
import { useAuth } from "./auth";
import { supabase } from "./supabase";

export function useNotificationCount() {
  const { session } = useAuth();
  const [count, setCount] = useState(0);
  const load = useCallback(() => { supabase.rpc("unread_notification_count").then((c) => setCount((c.data as number) ?? 0)); }, []);
  useEffect(() => {
    if (!session) return;
    load();
    const ch = supabase.channel("my-notes")
      .on("postgres_changes", { event: "*", schema: "public", table: "notifications", filter: `user_id=eq.${session.user.id}` }, load)
      .subscribe();
    return () => { supabase.removeChannel(ch); };
  }, [session, load]);
  return count;
}

// src/lib/messages.ts
// Shared plumbing for class messages: types, download / share / copy helpers, and the unread-count hook.
import { useCallback, useEffect, useState } from "react";
import { supabase } from "./supabase";
import { useAuth } from "./auth";

export const BUCKET = "class-messages";
export const MAX_MEDIA_BYTES = 25 * 1024 * 1024;
/** Any kind of file can be attached. Images get a picture icon, everything else a file icon. */
export const isImageMime = (mime: string | null | undefined) => !!mime && mime.startsWith("image/");

export type ClassMessage = {
  id: string; session_id: string; sender_label: string; body: string | null;
  media_path: string | null; media_name: string | null; media_mime: string | null; media_size: number | null;
  created_at: string; course_title?: string | null; centre_name?: string | null; session_date?: string | null;
};

export const mergeMessages = (a: ClassMessage[], b: ClassMessage[]) => {
  const m = new Map<string, ClassMessage>(); [...a, ...b].forEach((x) => m.set(x.id, x));
  return [...m.values()].sort((x, y) => +new Date(x.created_at) - +new Date(y.created_at));
};

export const fileSize = (n: number | null) => !n ? "" : n < 1024 * 1024 ? `${Math.max(1, Math.round(n / 1024))} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`;

/** Download only happens here, on a tap. A short-lived signed link is minted per tap and the browser saves the file. */
export async function downloadMedia(m: ClassMessage) {
  if (!m.media_path) return;
  const { data, error } = await supabase.storage.from(BUCKET).createSignedUrl(m.media_path, 120, { download: m.media_name ?? true });
  if (error || !data?.signedUrl) throw error ?? new Error("download_failed");
  const a = document.createElement("a"); a.href = data.signedUrl; a.rel = "noopener"; a.download = m.media_name ?? "";
  document.body.appendChild(a); a.click(); a.remove();
}

export async function copyText(text: string) {
  try { await navigator.clipboard.writeText(text); return; } catch { /* fall through to the legacy path */ }
  const t = document.createElement("textarea"); t.value = text; t.setAttribute("readonly", ""); t.style.cssText = "position:fixed;opacity:0";
  document.body.appendChild(t); t.select();
  const done = document.execCommand("copy"); t.remove();
  if (!done) throw new Error("copy_failed");
}

/** Opens the phone's share sheet. Returns "shared" | "copied" | "downloaded" | "cancelled" so the caller can say the right thing. */
export async function shareMessage(m: ClassMessage): Promise<"shared" | "copied" | "downloaded" | "cancelled"> {
  const title = m.course_title ? `${m.course_title} · IQ Academy` : "IQ Academy";
  try {
    if (m.media_path) {
      const { data, error } = await supabase.storage.from(BUCKET).download(m.media_path);
      if (error || !data) throw error ?? new Error("download_failed");
      const file = new File([data], m.media_name ?? "image", { type: m.media_mime ?? data.type });
      if (navigator.canShare?.({ files: [file] })) { await navigator.share({ files: [file], text: m.body ?? undefined, title }); return "shared"; }
      await downloadMedia(m); return "downloaded";
    }
    if (navigator.share) { await navigator.share({ text: m.body ?? "", title }); return "shared"; }
    await copyText(m.body ?? ""); return "copied";
  } catch (e) {
    if ((e as { name?: string })?.name === "AbortError") return "cancelled";
    throw e;
  }
}

/** Unread class messages for the signed-in student (drives the badge on the Messages tab). */
export function useUnreadMessages() {
  const { session } = useAuth(); const uid = session?.user.id;
  const [n, setN] = useState(0);
  const load = useCallback(() => { supabase.rpc("unread_message_count").then((r) => setN((r.data as number) ?? 0)); }, []);
  useEffect(() => {
    if (!uid) return;
    load();
    const ch = supabase.channel(`unread-messages-${uid}`)
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "class_messages" }, load)
      .on("postgres_changes", { event: "*", schema: "public", table: "attendance", filter: `student_id=eq.${uid}` }, load)
      .subscribe();
    addEventListener("messages:read", load);
    return () => { supabase.removeChannel(ch); removeEventListener("messages:read", load); };
  }, [uid, load]);
  return n;
}

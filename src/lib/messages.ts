// src/lib/messages.ts
// Shared plumbing for class messages: types, download / share / copy helpers, and the unread-count hook.
import { useCallback, useEffect, useState } from "react";
import { fmtClock, now } from "./time";
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

/** Students can copy or share a message only for this long after it arrives. After that the buttons disappear and the text can't be selected. */
export const COPY_SHARE_WINDOW_MS = 2 * 60 * 60 * 1000;
export const copyShareEndsAt = (m: Pick<ClassMessage, "created_at">) => Date.parse(m.created_at) + COPY_SHARE_WINDOW_MS;
/** True once the window has passed. Uses the server-corrected clock, so changing the phone's clock doesn't reopen it. */
export const copyShareClosed = (m: Pick<ClassMessage, "created_at">) => now() >= copyShareEndsAt(m);
export const copyShareNote = (m: Pick<ClassMessage, "created_at">) => `Copy and share close 2 hours after a message arrives (${fmtClock(copyShareEndsAt(m))}).`;

/** Re-renders when the copy/share window closes, so the buttons vanish while the message is on screen. */
export function useCopyShareClosed(m: Pick<ClassMessage, "created_at">, applies: boolean) {
  const [, tick] = useState(0);
  const closed = applies && copyShareClosed(m);
  useEffect(() => {
    if (!applies || closed) return;
    const t = setTimeout(() => tick((n) => n + 1), Math.max(250, copyShareEndsAt(m) - now() + 250));
    return () => clearTimeout(t);
  }, [applies, closed, m.created_at]); // eslint-disable-line react-hooks/exhaustive-deps
  return closed;
}

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

/** The file behind a message, as a File (used to send it on to another class's chat). */
export async function fetchMediaFile(m: ClassMessage): Promise<File> {
  if (!m.media_path) throw new Error("download_failed");
  const { data, error } = await supabase.storage.from(BUCKET).download(m.media_path);
  if (error || !data) throw error ?? new Error("download_failed");
  return new File([data], m.media_name ?? "file", { type: m.media_mime ?? data.type });
}

/** Instructor: send messages on to other classes' chats. They arrive as ordinary new messages from the instructor, stamped with
 *  the time they are sent, with no "forwarded" mark. Files are copied into the target class's folder so its students can open them.
 *  Each chat gets the messages in their original order, and stops at its first failure so a chat never gets a gap in the middle. */
export async function sendToChats(msgs: ClassMessage[], targetIds: string[]): Promise<{ ok: string[]; failed: string[] }> {
  const ordered = [...msgs].sort((a, b) => +new Date(a.created_at) - +new Date(b.created_at));
  const files = new Map<string, File>();
  const ok: string[] = []; const failed: string[] = [];
  for (const target of targetIds) {
    try {
      for (const m of ordered) {
        let media: { path: string; name: string; mime: string; size: number } | null = null;
        if (m.media_path) {
          let f = files.get(m.id); if (!f) { f = await fetchMediaFile(m); files.set(m.id, f); }
          const safe = f.name.normalize("NFKD").replace(/[^\w.-]+/g, "_").slice(-80) || "file";
          const path = `${target}/${crypto.randomUUID()}-${safe}`;
          const up = await supabase.storage.from(BUCKET).upload(path, f, { contentType: f.type || "application/octet-stream", upsert: false });
          if (up.error) throw up.error;
          media = { path, name: f.name, mime: f.type || "application/octet-stream", size: f.size };
        }
        const { error } = await supabase.rpc("send_class_message", { p_session_id: target, p_body: m.body, p_media_path: media?.path ?? null, p_media_name: media?.name ?? null, p_media_mime: media?.mime ?? null, p_media_size: media?.size ?? null });
        if (error) throw error;
      }
      ok.push(target);
    } catch { failed.push(target); }
  }
  return { ok, failed };
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

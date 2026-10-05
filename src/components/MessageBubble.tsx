// src/components/MessageBubble.tsx
// One class message. Text is plain selectable text (long-press / drag to copy part of it). Images are never loaded
// or saved until the person taps them. Recipients can copy, share, and (for media) download. Nobody but an admin deletes.
import { useState, type ReactNode } from "react";
import { Avatar, cx } from "./ui";
import { useFeedback } from "./feedback";
import { friendly } from "../lib/supabase";
import { copyText, downloadMedia, fileSize, shareMessage, type ClassMessage } from "../lib/messages";

import Icon from "./Icon";
const time = (d: string) => new Date(d).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
const Act = ({ onClick, children, busy }: { onClick: () => void; children: ReactNode; busy?: boolean }) => (
  <button onClick={onClick} disabled={busy} className="rounded-lg px-2.5 py-1.5 text-xs font-medium text-muted transition hover:bg-sunken hover:text-ink active:scale-95 disabled:opacity-50">{children}</button>
);

export default function MessageBubble({ m, context, footer }: { m: ClassMessage; context?: boolean; footer?: ReactNode }) {
  const { toast } = useFeedback(); const [busy, setBusy] = useState("");
  const official = m.sender_label === "IQ Academy";
  const attempt = async (key: string, fn: () => Promise<void>) => { setBusy(key); try { await fn(); } catch (e) { toast(friendly(e), "bad"); } finally { setBusy(""); } };

  const copy = () => attempt("copy", async () => { await copyText(m.body ?? ""); toast("Copied"); });
  const share = () => attempt("share", async () => {
    const r = await shareMessage(m);
    if (r === "copied") toast("Copied. Paste it anywhere.");
    if (r === "downloaded") toast("Saved to your device");
  });
  const save = () => attempt("save", async () => { await downloadMedia(m); toast("Download started"); });

  return (
    <article className="anim-fade flex gap-2.5">
      {official ? <img src="/icon-192.png" alt="" className="mt-0.5 h-8 w-8 shrink-0 rounded-full" /> : <div className="mt-0.5"><Avatar name={m.sender_label.replace(/^Instructor\s+/, "")} size={32} /></div>}
      <div className="min-w-0 max-w-[88%] flex-1">
        <p className="mb-1 flex flex-wrap items-baseline gap-x-2 px-1 text-xs"><b className="font-semibold">{m.sender_label}</b>
          {context && m.course_title && <span className="text-muted">{m.course_title}</span>}</p>
        <div className="rounded-2xl rounded-tl-md bg-surface p-3.5 shadow-card ring-1 ring-line">
          {m.body && <p className="select-text whitespace-pre-wrap break-words text-[15px] leading-relaxed [-webkit-user-select:text]">{m.body}</p>}
          {m.media_path && (
            <button onClick={save} disabled={busy === "save"} aria-label={`Download ${m.media_name ?? "image"}`}
              className={cx("flex w-full items-center gap-3 rounded-xl bg-sunken p-3 text-left transition active:scale-[.99] disabled:opacity-60", m.body && "mt-3")}>
              <span className="grid h-11 w-11 shrink-0 place-items-center rounded-lg bg-surface text-muted ring-1 ring-line" aria-hidden="true"><Icon name="image" size={22} /></span>
              <span className="min-w-0 flex-1 leading-tight"><span className="block truncate text-sm font-medium">{m.media_name ?? "Image"}</span>
                <span className="text-xs text-muted">{[fileSize(m.media_size), "Tap to download"].filter(Boolean).join(" · ")}</span></span>
              <Icon name="download" size={18} className="shrink-0 text-accent" />
            </button>)}
          <div className="mt-2 flex items-center gap-0.5">
            {m.body && <Act onClick={copy} busy={busy === "copy"}>Copy</Act>}
            <Act onClick={share} busy={busy === "share"}>Share</Act>
            <span className="num ml-auto pl-2 text-[11px] text-muted">{time(m.created_at)}</span>
          </div>
        </div>
        {footer}
      </div>
    </article>
  );
}

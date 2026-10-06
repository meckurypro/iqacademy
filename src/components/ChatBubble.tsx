// src/components/ChatBubble.tsx
// One message in a class channel, drawn like a chat app: compact bubble, time tucked into the corner, sender shown once
// per run. Tap a bubble for Copy / Share / Save. Text stays selectable (long-press), and images are still never loaded or
// saved until the person taps them (see lib/messages.ts).
//
// Students (`restricted`) can copy or share a message for two hours after it arrives. After that the buttons are gone, the
// text can't be selected and a copy or share that is still attempted is refused. Saving an attached file is not affected.
// Instructors can also select messages and send them on to their other classes' chats (`onSend`, `onSelect`).
import { useState } from "react";
import { cx, Button, Sheet } from "./ui";
import { useFeedback } from "./feedback";
import Icon from "./Icon";
import { friendly } from "../lib/supabase";
import { copyShareClosed, copyShareNote, copyText, downloadMedia, fileSize, isImageMime, shareMessage, useCopyShareClosed, type ClassMessage } from "../lib/messages";
import { fmtClock } from "../lib/time";

type Props = {
  m: ClassMessage; out?: boolean; first?: boolean; showName?: boolean;
  /** A student: copy and share close two hours after the message arrives. */
  restricted?: boolean;
  /** Instructor: send this message to other chats / start selecting several. */
  onSend?: () => void; onSelect?: () => void;
  /** While selecting, a tap toggles the message instead of opening the actions. */
  selecting?: boolean; selected?: boolean; onToggle?: () => void;
};

export default function ChatBubble({ m, out, first, showName, restricted, onSend, onSelect, selecting, selected, onToggle }: Props) {
  const { toast } = useFeedback(); const [open, setOpen] = useState(false); const [busy, setBusy] = useState("");
  const closed = useCopyShareClosed(m, !!restricted);
  const attempt = async (key: string, fn: () => Promise<void>) => { setBusy(key); try { await fn(); } catch (e) { toast(friendly(e), "bad"); } finally { setBusy(""); } };
  // checked again at the moment of the tap: the sheet may have been open while the window ran out
  const refused = () => { if (restricted && copyShareClosed(m)) { setOpen(false); toast("Copy and share closed 2 hours after this message arrived.", "bad"); return true; } return false; };
  const copy = () => { if (refused()) return; return attempt("copy", async () => { await copyText(m.body ?? ""); toast("Copied"); setOpen(false); }); };
  const share = () => { if (refused()) return; return attempt("share", async () => {
    const r = await shareMessage(m);
    if (r === "copied") toast("Copied. Paste it anywhere."); if (r === "downloaded") toast("Saved to your device");
    setOpen(false);
  }); };
  const save = () => attempt("save", async () => { await downloadMedia(m); toast("Download started"); setOpen(false); });
  const time = <span className="num float-right ml-3 mt-1.5 translate-y-1 text-[11px] leading-none text-muted">{fmtClock(m.created_at)}</span>;

  const nothingToDo = closed && !m.media_path && !onSend && !onSelect;
  // a tap opens the actions, unless the person was selecting text
  const tap = () => {
    if (selecting) return onToggle?.();
    if (nothingToDo) return;
    if (!window.getSelection()?.toString()) setOpen(true);
  };
  const guard = closed ? { onCopy: (e: React.ClipboardEvent) => e.preventDefault(), onCut: (e: React.ClipboardEvent) => e.preventDefault(), onContextMenu: (e: React.MouseEvent) => e.preventDefault(), onDragStart: (e: React.DragEvent) => e.preventDefault() } : {};

  return (
    <>
      <div className={cx("anim-fade flex items-center gap-2", first ? "mt-3" : "mt-0.5")}>
        {selecting && <button onClick={onToggle} aria-label={selected ? "Deselect message" : "Select message"} aria-pressed={!!selected}
          className={cx("grid h-6 w-6 shrink-0 place-items-center rounded-full ring-1 transition active:scale-90", selected ? "bg-accent text-accent-ink ring-accent" : "bg-surface/80 text-transparent ring-line")}>
          <Icon name="check" size={14} /></button>}
        <div className={cx("flex min-w-0 flex-1", out ? "justify-end" : "justify-start")}>
          <div onClick={tap} {...guard} className={cx("max-w-[84%] rounded-2xl px-3 py-2 shadow-[0_1px_1px_rgb(0_0_0/.07)] transition active:brightness-95",
            nothingToDo ? "cursor-default" : "cursor-pointer", out ? "bg-accent/15 text-ink" : "bg-surface text-ink", first && (out ? "rounded-tr-md" : "rounded-tl-md"),
            selected && "ring-2 ring-accent/70", closed && "select-none [-webkit-touch-callout:none] [-webkit-user-select:none]")}>
            {showName && <p className="mb-0.5 text-[12.5px] font-semibold text-accent">{m.sender_label}</p>}
            {m.media_path && (
              <button onClick={(e) => { e.stopPropagation(); if (selecting) return onToggle?.(); save(); }} disabled={busy === "save"} aria-label={`Download ${m.media_name ?? "file"}`}
                className={cx("mb-1.5 flex w-full min-w-[12rem] items-center gap-2.5 rounded-xl bg-sunken/80 p-2 text-left transition active:scale-[.99] disabled:opacity-60")}>
                <span className="grid h-10 w-10 shrink-0 place-items-center rounded-lg bg-surface text-muted" aria-hidden="true"><Icon name={isImageMime(m.media_mime) ? "image" : "file"} size={20} /></span>
                <span className="min-w-0 flex-1 leading-tight"><span className="block truncate text-sm font-medium">{m.media_name ?? "File"}</span>
                  <span className="text-xs text-muted">{[fileSize(m.media_size), "Tap to download"].filter(Boolean).join(" · ")}</span></span>
                <Icon name="download" size={18} className="shrink-0 text-accent" />
              </button>)}
            {m.body ? <p className={cx("whitespace-pre-wrap break-words text-[15px] leading-[1.38]", closed ? "select-none [-webkit-user-select:none]" : "select-text [-webkit-user-select:text]")}>{m.body}{time}<span className="clear-both block" /></p>
              : <p className="flex justify-end">{time}</p>}
          </div>
        </div>
      </div>
      <Sheet open={open} onClose={() => setOpen(false)}>
        <div className="space-y-2">
          {m.body && <p className="mb-3 line-clamp-3 rounded-xl bg-sunken px-3.5 py-2.5 text-sm text-muted">{m.body}</p>}
          {!closed && m.body && <Button variant="secondary" className="w-full" loading={busy === "copy"} onClick={copy}>Copy text</Button>}
          {!closed && <Button variant="secondary" className="w-full" loading={busy === "share"} onClick={share}>Share</Button>}
          {m.media_path && <Button variant="secondary" className="w-full" loading={busy === "save"} onClick={save}>Save file</Button>}
          {onSend && <Button className="w-full" onClick={() => { setOpen(false); onSend(); }}>Send to other chats</Button>}
          {onSelect && <Button variant="secondary" className="w-full" onClick={() => { setOpen(false); onSelect(); }}>Select more messages</Button>}
          {restricted && <p className="px-1 pt-1 text-center text-xs leading-snug text-muted">{closed ? "Copy and share closed 2 hours after this message arrived." : copyShareNote(m)}</p>}
        </div>
      </Sheet>
    </>
  );
}

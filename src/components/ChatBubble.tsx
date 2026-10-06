// src/components/ChatBubble.tsx
// One message in a class channel, drawn like a chat app: compact bubble, time tucked into the corner, sender shown once
// per run. Tap a bubble for Copy / Share / Save. Text stays selectable (long-press), and images are still never loaded or
// saved until the person taps them (see lib/messages.ts).
import { useState } from "react";
import { cx, Button, Sheet } from "./ui";
import { useFeedback } from "./feedback";
import Icon from "./Icon";
import { friendly } from "../lib/supabase";
import { copyText, downloadMedia, fileSize, shareMessage, type ClassMessage } from "../lib/messages";
import { fmtClock } from "../lib/time";

export default function ChatBubble({ m, out, first, showName }: { m: ClassMessage; out?: boolean; first?: boolean; showName?: boolean }) {
  const { toast } = useFeedback(); const [open, setOpen] = useState(false); const [busy, setBusy] = useState("");
  const attempt = async (key: string, fn: () => Promise<void>) => { setBusy(key); try { await fn(); } catch (e) { toast(friendly(e), "bad"); } finally { setBusy(""); } };
  const copy = () => attempt("copy", async () => { await copyText(m.body ?? ""); toast("Copied"); setOpen(false); });
  const share = () => attempt("share", async () => {
    const r = await shareMessage(m);
    if (r === "copied") toast("Copied. Paste it anywhere."); if (r === "downloaded") toast("Saved to your device");
    setOpen(false);
  });
  const save = () => attempt("save", async () => { await downloadMedia(m); toast("Download started"); setOpen(false); });
  const time = <span className="num float-right ml-3 mt-1.5 translate-y-1 text-[11px] leading-none text-muted">{fmtClock(m.created_at)}</span>;
  // a tap opens the actions, unless the person was selecting text
  const tap = () => { if (!window.getSelection()?.toString()) setOpen(true); };

  return (
    <>
      <div className={cx("anim-fade flex", out ? "justify-end" : "justify-start", first ? "mt-3" : "mt-0.5")}>
        <div onClick={tap} className={cx("max-w-[84%] cursor-pointer rounded-2xl px-3 py-2 shadow-[0_1px_1px_rgb(0_0_0/.07)] transition active:brightness-95",
          out ? "bg-accent/15 text-ink" : "bg-surface text-ink", first && (out ? "rounded-tr-md" : "rounded-tl-md"))}>
          {showName && <p className="mb-0.5 text-[12.5px] font-semibold text-accent">{m.sender_label}</p>}
          {m.media_path && (
            <button onClick={(e) => { e.stopPropagation(); save(); }} disabled={busy === "save"} aria-label={`Download ${m.media_name ?? "image"}`}
              className={cx("mb-1.5 flex w-full min-w-[12rem] items-center gap-2.5 rounded-xl bg-sunken/80 p-2 text-left transition active:scale-[.99] disabled:opacity-60")}>
              <span className="grid h-10 w-10 shrink-0 place-items-center rounded-lg bg-surface text-muted" aria-hidden="true"><Icon name="image" size={20} /></span>
              <span className="min-w-0 flex-1 leading-tight"><span className="block truncate text-sm font-medium">{m.media_name ?? "Image"}</span>
                <span className="text-xs text-muted">{[fileSize(m.media_size), "Tap to download"].filter(Boolean).join(" · ")}</span></span>
              <Icon name="download" size={18} className="shrink-0 text-accent" />
            </button>)}
          {m.body ? <p className="select-text whitespace-pre-wrap break-words text-[15px] leading-[1.38] [-webkit-user-select:text]">{m.body}{time}<span className="clear-both block" /></p>
            : <p className="flex justify-end">{time}</p>}
        </div>
      </div>
      <Sheet open={open} onClose={() => setOpen(false)}>
        <div className="space-y-2">
          {m.body && <p className="mb-3 line-clamp-3 rounded-xl bg-sunken px-3.5 py-2.5 text-sm text-muted">{m.body}</p>}
          {m.body && <Button variant="secondary" className="w-full" loading={busy === "copy"} onClick={copy}>Copy text</Button>}
          <Button variant="secondary" className="w-full" loading={busy === "share"} onClick={share}>Share</Button>
          {m.media_path && <Button variant="secondary" className="w-full" loading={busy === "save"} onClick={save}>Save image</Button>}
        </div>
      </Sheet>
    </>
  );
}

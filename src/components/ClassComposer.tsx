// src/components/ClassComposer.tsx
// Write a message (text and/or one file of any kind) to a class's channel. Open from check-in onwards, including after the class. Used on the class screen and in the channel.
import { useEffect, useState } from "react";
import { supabase, friendly } from "../lib/supabase";
import { Button, Card, Err } from "./ui";
import { useFeedback } from "./feedback";
import { BUCKET, MAX_MEDIA_BYTES, fileSize, isImageMime } from "../lib/messages";

import Icon from "./Icon";
export default function ClassComposer({ sessionId, joined, onSent, chat }: { sessionId: string; joined?: number; onSent?: () => void; chat?: boolean }) {
  const { run } = useFeedback();
  const [text, setText] = useState(""); const [file, setFile] = useState<File | null>(null); const [preview, setPreview] = useState(""); const [err, setErr] = useState("");
  useEffect(() => { if (!file) { setPreview(""); return; } if (!isImageMime(file.type)) { setPreview(""); return; } const u = URL.createObjectURL(file); setPreview(u); return () => URL.revokeObjectURL(u); }, [file]);

  const pickFile = (f: File | undefined) => {
    setErr(""); if (!f) return;
    if (f.size > MAX_MEDIA_BYTES || f.size === 0) return setErr(friendly(new Error("invalid_media")));
    setFile(f);
  };
  const send = async () => {
    const body = text.trim(); if (!body && !file) return; setErr("");
    const r = await run("Sending message…", async () => {
      let media: { path: string; name: string; mime: string; size: number } | null = null;
      if (file) {
        const safe = file.name.normalize("NFKD").replace(/[^\w.-]+/g, "_").slice(-80) || "file";
        const path = `${sessionId}/${crypto.randomUUID()}-${safe}`;
        const up = await supabase.storage.from(BUCKET).upload(path, file, { contentType: file.type || "application/octet-stream", upsert: false });
        if (up.error) throw up.error;
        media = { path, name: file.name, mime: file.type || "application/octet-stream", size: file.size };
      }
      const { error } = await supabase.rpc("send_class_message", { p_session_id: sessionId, p_body: body || null, p_media_path: media?.path ?? null, p_media_name: media?.name ?? null, p_media_mime: media?.mime ?? null, p_media_size: media?.size ?? null });
      if (error) throw error;
    }, { success: "Sent to the class", quiet: true });
    if (!r.ok) return setErr(r.message);
    setText(""); setFile(null); onSent?.();
  };

  if (chat) return (
    <div className="sticky bottom-[calc(4.1rem+env(safe-area-inset-bottom))] z-20 -mx-4 space-y-2 border-t border-line/60 bg-bg/85 px-3 py-2 backdrop-blur-md lg:bottom-0 lg:mx-0 lg:rounded-b-2xl lg:border lg:border-line lg:px-4 lg:py-3">
      {file && <div className="flex items-center gap-3 rounded-2xl bg-surface p-2 ring-1 ring-line">
        {preview ? <img src={preview} alt="" className="h-11 w-11 rounded-lg object-cover" /> : <span className="grid h-11 w-11 place-items-center rounded-lg bg-sunken text-muted"><Icon name="file" size={20} /></span>}
        <p className="min-w-0 flex-1 truncate text-sm">{file.name}<span className="block text-xs text-muted">{fileSize(file.size)}</span></p>
        <button onClick={() => setFile(null)} aria-label="Remove file" className="grid h-9 w-9 place-items-center rounded-full text-muted hover:bg-sunken"><Icon name="close" size={16} /></button></div>}
      <Err>{err}</Err>
      <div className="flex items-end gap-2">
        <label aria-label={file ? "Change file" : "Attach a file"} className="grid h-11 w-11 shrink-0 cursor-pointer place-items-center rounded-full bg-surface text-muted ring-1 ring-line transition active:scale-95">
          <Icon name="file" size={20} />
          <input type="file" className="sr-only" onChange={(e) => { pickFile(e.target.files?.[0]); e.target.value = ""; }} /></label>
        <textarea value={text} rows={1} maxLength={4000} aria-label="Message to the class" placeholder="Message the class"
          onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing && matchMedia("(hover: hover) and (pointer: fine)").matches) { e.preventDefault(); send(); } }}
          onChange={(e) => { setText(e.target.value); e.target.style.height = "auto"; e.target.style.height = `${Math.min(e.target.scrollHeight, 128)}px`; }}
          className="max-h-32 min-h-11 flex-1 resize-none rounded-3xl bg-surface px-4 py-[11px] text-[15px] leading-snug outline-none ring-1 ring-line transition placeholder:text-muted/70 focus:ring-2 focus:ring-accent/50" />
        <button onClick={send} disabled={!text.trim() && !file} aria-label="Send"
          className="grid h-11 w-11 shrink-0 place-items-center rounded-full bg-accent text-accent-ink transition active:scale-95 disabled:opacity-40"><Icon name="send" size={19} /></button>
      </div>
    </div>);

  return (
    <Card className="space-y-3">
      <textarea value={text} onChange={(e) => setText(e.target.value)} maxLength={4000} rows={4} aria-label="Message to the class" placeholder="Write a message to the class…"
        className="w-full resize-none rounded-xl bg-surface ring-1 ring-line p-3 text-[15px] leading-relaxed outline-none transition focus:ring-2 focus:ring-accent/60" />
      {file && <div className="flex items-center gap-3 rounded-xl bg-sunken p-2">
        {preview ? <img src={preview} alt="" className="h-12 w-12 rounded-lg object-cover" /> : <span className="grid h-12 w-12 place-items-center rounded-lg bg-surface text-muted"><Icon name="file" size={20} /></span>}
        <p className="min-w-0 flex-1 truncate text-sm">{file.name}<span className="block text-xs text-muted">{fileSize(file.size)}</span></p>
        <button onClick={() => setFile(null)} aria-label="Remove file" className="grid h-9 w-9 place-items-center rounded-full text-muted hover:bg-surface"><Icon name="close" size={16} /></button></div>}
      <Err>{err}</Err>
      <div className="flex items-center gap-2">
        <label className="inline-flex h-11 cursor-pointer items-center gap-2 rounded-xl bg-sunken px-4 text-sm font-medium transition active:scale-[.98]">
          <Icon name="file" size={18} />{file ? "Change file" : "Add file"}
          <input type="file" className="sr-only" onChange={(e) => { pickFile(e.target.files?.[0]); e.target.value = ""; }} /></label>
        <span className="flex-1" />
        <Button disabled={!text.trim() && !file} onClick={send}>Send</Button>
      </div>
      <p className="text-xs leading-relaxed text-muted">Goes to students who joined with the class code{joined !== undefined ? ` (${joined} so far)` : ""}. They can't reply, and only an admin can delete a message. You can keep posting after the class ends.</p>
    </Card>
  );
}

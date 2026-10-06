// src/components/ClassComposer.tsx
// Write a message (text and/or one image) to a class's channel. Open from check-in onwards, including after the class. Used on the class screen and in the channel.
import { useEffect, useState } from "react";
import { supabase, friendly } from "../lib/supabase";
import { Button, Card, Err } from "./ui";
import { useFeedback } from "./feedback";
import { BUCKET, MAX_MEDIA_BYTES, MEDIA_TYPES } from "../lib/messages";

import Icon from "./Icon";
export default function ClassComposer({ sessionId, joined, onSent }: { sessionId: string; joined?: number; onSent?: () => void }) {
  const { run } = useFeedback();
  const [text, setText] = useState(""); const [file, setFile] = useState<File | null>(null); const [preview, setPreview] = useState(""); const [err, setErr] = useState("");
  useEffect(() => { if (!file) { setPreview(""); return; } const u = URL.createObjectURL(file); setPreview(u); return () => URL.revokeObjectURL(u); }, [file]);

  const pickFile = (f: File | undefined) => {
    setErr(""); if (!f) return;
    if (!MEDIA_TYPES.includes(f.type) || f.size > MAX_MEDIA_BYTES) return setErr(friendly(new Error("invalid_media")));
    setFile(f);
  };
  const send = async () => {
    const body = text.trim(); if (!body && !file) return; setErr("");
    const r = await run("Sending message…", async () => {
      let media: { path: string; name: string; mime: string; size: number } | null = null;
      if (file) {
        const safe = file.name.normalize("NFKD").replace(/[^\w.-]+/g, "_").slice(-80) || "image";
        const path = `${sessionId}/${crypto.randomUUID()}-${safe}`;
        const up = await supabase.storage.from(BUCKET).upload(path, file, { contentType: file.type, upsert: false });
        if (up.error) throw up.error;
        media = { path, name: file.name, mime: file.type, size: file.size };
      }
      const { error } = await supabase.rpc("send_class_message", { p_session_id: sessionId, p_body: body || null, p_media_path: media?.path ?? null, p_media_name: media?.name ?? null, p_media_mime: media?.mime ?? null, p_media_size: media?.size ?? null });
      if (error) throw error;
    }, { success: "Sent to the class", quiet: true });
    if (!r.ok) return setErr(r.message);
    setText(""); setFile(null); onSent?.();
  };

  return (
    <Card className="space-y-3">
      <textarea value={text} onChange={(e) => setText(e.target.value)} maxLength={4000} rows={4} aria-label="Message to the class" placeholder="Write a message to the class…"
        className="w-full resize-none rounded-xl bg-surface ring-1 ring-line p-3 text-[15px] leading-relaxed outline-none transition focus:ring-2 focus:ring-accent/60" />
      {file && <div className="flex items-center gap-3 rounded-xl bg-sunken p-2">
        <img src={preview} alt="" className="h-12 w-12 rounded-lg object-cover" />
        <p className="min-w-0 flex-1 truncate text-sm">{file.name}</p>
        <button onClick={() => setFile(null)} aria-label="Remove image" className="grid h-9 w-9 place-items-center rounded-full text-muted hover:bg-surface"><Icon name="close" size={16} /></button></div>}
      <Err>{err}</Err>
      <div className="flex items-center gap-2">
        <label className="inline-flex h-11 cursor-pointer items-center gap-2 rounded-xl bg-sunken px-4 text-sm font-medium transition active:scale-[.98]">
          <Icon name="image" size={18} />{file ? "Change image" : "Add image"}
          <input type="file" accept={MEDIA_TYPES.join(",")} className="sr-only" onChange={(e) => { pickFile(e.target.files?.[0]); e.target.value = ""; }} /></label>
        <span className="flex-1" />
        <Button disabled={!text.trim() && !file} onClick={send}>Send</Button>
      </div>
      <p className="text-xs leading-relaxed text-muted">Goes to students who joined with the class code{joined !== undefined ? ` (${joined} so far)` : ""}. They can't reply, and only an admin can delete a message. You can keep posting after the class ends.</p>
    </Card>
  );
}

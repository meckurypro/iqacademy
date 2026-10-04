import { useCallback, useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { QRCodeSVG } from "qrcode.react";
import { supabase, friendly } from "../lib/supabase";
import { Avatar, Badge, Button, Card, Err, Sheet, Skeleton } from "../components/ui";
import { useFeedback } from "../components/feedback";
import MessageBubble from "../components/MessageBubble";
import { BUCKET, MAX_MEDIA_BYTES, MEDIA_TYPES, type ClassMessage } from "../lib/messages";

type Row = { student_id: string; full_name: string; status: "present" | "absent" | "excused" | null; method: string | null };
type Sess = { id: string; start_at: string; end_at: string; status: string; centre_name: string; course_title: string; lesson_title: string | null; lesson_summary: string | null; room: string | null };
const tone = { present: "ok", absent: "bad", excused: "warn" } as const;

export default function ClassScreen() {
  const { id } = useParams(); const nav = useNavigate(); const { run, confirm } = useFeedback();
  const [s, setS] = useState<Sess>(); const [roster, setRoster] = useState<Row[]>();
  const [code, setCode] = useState(""); const [showCode, setShowCode] = useState(false);
  const [pick, setPick] = useState<Row | null>(null); const [err, setErr] = useState("");
  const [text, setText] = useState(""); const [file, setFile] = useState<File | null>(null); const [preview, setPreview] = useState(""); const [msgErr, setMsgErr] = useState("");
  const [sent, setSent] = useState<ClassMessage[]>([]);

  const loadSent = useCallback(async () => {
    const { data } = await supabase.from("class_messages").select("id,session_id,sender_label,body,media_path,media_name,media_mime,media_size,created_at").eq("session_id", id!).order("created_at");
    setSent((data as ClassMessage[]) ?? []);
  }, [id]);
  useEffect(() => { if (!file) { setPreview(""); return; } const u = URL.createObjectURL(file); setPreview(u); return () => URL.revokeObjectURL(u); }, [file]);

  const load = useCallback(async () => {
    const [a, b] = await Promise.all([
      supabase.from("v_session_details").select("id,start_at,end_at,status,centre_name,course_title,lesson_title,lesson_summary,room").eq("id", id!).single(),
      supabase.rpc("session_attendance_roster", { p_session_id: id }),
    ]);
    setS(a.data as Sess); setRoster((b.data as Row[]) ?? []);
  }, [id]);
  useEffect(() => {
    load(); loadSent();
    const ch = supabase.channel(`class-${id}`).on("postgres_changes", { event: "*", schema: "public", table: "attendance", filter: `session_id=eq.${id}` }, load).subscribe();
    return () => { supabase.removeChannel(ch); };
  }, [id, load, loadSent]);

  const act = async (label: string, fn: () => PromiseLike<{ error: unknown }>, after?: () => void, success?: string) => {
    setErr("");
    const r = await run(label, async () => { const { error } = await fn(); if (error) throw error; await load(); }, { success, quiet: true });
    if (!r.ok) return setErr(r.message);
    after?.();
  };
  const newCode = async () => {
    setErr("");
    const r = await run("Generating class code…", async () => {
      const { data, error } = await supabase.rpc("generate_checkin_token", { p_session_id: id }); if (error) throw error;
      await load(); return data as string;
    }, { quiet: true });
    if (!r.ok) return setErr(r.message);
    setCode(r.data); setShowCode(true);
  };
  const endClass = async () => {
    if (await confirm({ title: "End this class?", message: "Students who haven't checked in are marked absent.", confirmLabel: "End class" }))
      act("Ending class…", () => supabase.rpc("complete_session", { p_session_id: id, p_mark_absentees: true }), undefined, "Class ended");
  };
  const cancelClass = async () => {
    if (await confirm({ title: "Cancel this class?", message: "Students are told it's cancelled.", confirmLabel: "Cancel class", cancelLabel: "Keep class", danger: true }))
      act("Cancelling class…", () => supabase.rpc("cancel_session", { p_session_id: id, p_reason: "Cancelled by instructor" }), undefined, "Class cancelled");
  };

  const pickFile = (f: File | undefined) => {
    setMsgErr(""); if (!f) return;
    if (!MEDIA_TYPES.includes(f.type) || f.size > MAX_MEDIA_BYTES) return setMsgErr(friendly(new Error("invalid_media")));
    setFile(f);
  };
  const sendMsg = async () => {
    const body = text.trim(); if (!body && !file) return; setMsgErr("");
    const r = await run("Sending message…", async () => {
      let media: { path: string; name: string; mime: string; size: number } | null = null;
      if (file) {
        const safe = file.name.normalize("NFKD").replace(/[^\w.-]+/g, "_").slice(-80) || "image";
        const path = `${id}/${crypto.randomUUID()}-${safe}`;
        const up = await supabase.storage.from(BUCKET).upload(path, file, { contentType: file.type, upsert: false });
        if (up.error) throw up.error;
        media = { path, name: file.name, mime: file.type, size: file.size };
      }
      const { error } = await supabase.rpc("send_class_message", { p_session_id: id, p_body: body || null, p_media_path: media?.path ?? null, p_media_name: media?.name ?? null, p_media_mime: media?.mime ?? null, p_media_size: media?.size ?? null });
      if (error) throw error;
      await loadSent();
    }, { success: "Sent to the class", quiet: true });
    if (!r.ok) return setMsgErr(r.message);
    setText(""); setFile(null);
  };

  if (!s || !roster) return <div className="space-y-3"><Skeleton className="h-8 w-2/3" /><Skeleton className="h-32" /><Skeleton className="h-48" /></div>;
  const present = roster.filter((r) => r.status === "present").length;
  const closed = s.status === "completed" || s.status === "cancelled";
  const t = (d: string) => new Date(d).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

  return (
    <div className="space-y-5">
      <button onClick={() => nav(-1)} className="text-sm text-muted">← Back</button>
      <div><h1 className="text-2xl">{s.course_title}</h1>
        <p className="text-muted">{s.lesson_title ? `${s.lesson_title} · ` : ""}{t(s.start_at)} – {t(s.end_at)} · {s.centre_name}{s.room ? ` · ${s.room}` : ""}</p></div>

      {(s.lesson_title || s.lesson_summary) && <Card className="space-y-1">
        <p className="text-sm text-muted">Today's topic</p>
        <p className="font-medium">{s.lesson_title ?? "No topic set for this class"}</p>
        {s.lesson_summary && <p className="text-sm text-muted">{s.lesson_summary}</p>}
      </Card>}

      <Card className="flex items-center gap-4">
        <div className="relative grid h-20 w-20 place-items-center rounded-full" style={{ background: `conic-gradient(rgb(var(--accent)) ${roster.length ? (present / roster.length) * 360 : 0}deg, rgb(var(--sunken)) 0)` }}>
          <div className="grid h-16 w-16 place-items-center rounded-full bg-surface"><span className="num text-xl font-semibold">{present}</span></div></div>
        <div><p className="font-medium">{present} of {roster.length} here</p><p className="text-sm text-muted">{closed ? (s.status === "cancelled" ? "Class cancelled" : "Class closed") : "Updates live as students check in"}</p></div>
      </Card>

      {!closed && <div className="grid grid-cols-2 gap-3">
        <Button onClick={newCode}>Show class code</Button>
        <Button variant="secondary" onClick={endClass}>End class</Button></div>}
      <Err>{err}</Err>

      <section className="space-y-2"><h2 className="text-lg">Students</h2>
        {roster.length === 0 && <Card className="text-center text-muted">No students are enrolled in this class yet.</Card>}
        {roster.map((r) => (
          <Card key={r.student_id} onClick={closed && s.status === "cancelled" ? undefined : () => setPick(r)} className="flex items-center gap-3 py-3">
            <Avatar name={r.full_name} size={36} /><p className="flex-1 truncate font-medium">{r.full_name}</p>
            <Badge tone={r.status ? tone[r.status] : "muted"}>{r.status ?? "Not yet"}</Badge></Card>))}
      </section>
      {s.status !== "cancelled" && <section className="space-y-3">
        <h2 className="text-lg">Message the class</h2>
        <Card className="space-y-3">
          <textarea value={text} onChange={(e) => setText(e.target.value)} maxLength={4000} rows={4} aria-label="Message to the class"
            placeholder="Share a prompt, instructions or a link for today's class…"
            className="w-full resize-none rounded-xl bg-sunken p-3 text-[15px] leading-relaxed outline-none ring-accent/40 transition focus:ring-2" />
          {file && <div className="flex items-center gap-3 rounded-xl bg-sunken p-2">
            <img src={preview} alt="" className="h-12 w-12 rounded-lg object-cover" />
            <p className="min-w-0 flex-1 truncate text-sm">{file.name}</p>
            <button onClick={() => setFile(null)} aria-label="Remove image" className="grid h-9 w-9 place-items-center rounded-full text-muted hover:bg-surface">✕</button></div>}
          <Err>{msgErr}</Err>
          <div className="flex items-center gap-2">
            <label className="inline-flex h-11 cursor-pointer items-center gap-2 rounded-xl bg-sunken px-4 text-sm font-medium transition active:scale-[.98]">
              <span aria-hidden="true">🖼️</span>{file ? "Change image" : "Add image"}
              <input type="file" accept={MEDIA_TYPES.join(",")} className="sr-only" onChange={(e) => { pickFile(e.target.files?.[0]); e.target.value = ""; }} /></label>
            <span className="flex-1" />
            <Button disabled={!text.trim() && !file} onClick={sendMsg}>Send</Button>
          </div>
          <p className="text-xs leading-relaxed text-muted">Goes to the students marked present ({present} so far). Anyone who checks in later gets it too. Students can't reply, and only an admin can delete a message.</p>
        </Card>
        {sent.length > 0 && <div className="space-y-4 pt-2"><p className="px-1 text-sm text-muted">Sent to this class</p>{sent.map((m) => <MessageBubble key={m.id} m={m} />)}</div>}
      </section>}
      {!closed && <Button variant="ghost" className="w-full text-bad" onClick={cancelClass}>Cancel this class</Button>}

      <Sheet open={showCode} onClose={() => setShowCode(false)} title="Class code">
        <div className="space-y-4 text-center">
          <div className="mx-auto w-fit rounded-2xl bg-white p-4"><QRCodeSVG value={code} size={200} /></div>
          <p className="num text-4xl font-semibold tracking-[.25em]">{code}</p>
          <p className="text-sm text-muted">Students scan the QR or type this code in their app.</p>
          <Button variant="secondary" className="w-full" onClick={newCode}>Get a new code</Button>
        </div>
      </Sheet>

      <Sheet open={!!pick} onClose={() => setPick(null)} title={pick?.full_name}>
        <div className="space-y-2"><p className="text-sm text-muted">Set attendance manually (for example if a phone died).</p>
          {(["present", "absent", "excused"] as const).map((st) => (
            <Button key={st} variant={pick?.status === st ? "primary" : "secondary"} className="w-full capitalize"
              onClick={() => act("Updating attendance…", () => supabase.rpc("mark_attendance", { p_session_id: id, p_student_id: pick!.student_id, p_status: st }), () => setPick(null), "Attendance updated")}>{st}</Button>))}
        </div>
      </Sheet>
    </div>
  );
}

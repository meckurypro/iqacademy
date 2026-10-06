// src/components/ReviewSheet.tsx
// A student's review of a class that has ended: stars, an honest comment, and (only if something went wrong) a report about the
// instructor. One review per student per class. Admins read it; the instructor does not see it.
import { useEffect, useState } from "react";
import { supabase } from "../lib/supabase";
import { Button, cx, Err, Sheet } from "./ui";
import { useFeedback } from "./feedback";
import { StarPicker } from "./Stars";

export type ReviewTarget = { session_id: string; course_title: string; lesson_title?: string | null; instructor_first_name?: string | null };

export default function ReviewSheet({ target, onClose, onDone }: { target: ReviewTarget | null; onClose: () => void; onDone?: () => void }) {
  const { run } = useFeedback();
  const [rating, setRating] = useState(0); const [comment, setComment] = useState("");
  const [report, setReport] = useState(false); const [why, setWhy] = useState(""); const [err, setErr] = useState("");
  useEffect(() => { if (target) { setRating(0); setComment(""); setReport(false); setWhy(""); setErr(""); } }, [target?.session_id]); // eslint-disable-line react-hooks/exhaustive-deps

  const submit = async () => {
    if (!target) return;
    if (!rating) return setErr("Choose a rating from 1 to 5 stars.");
    if (report && why.trim().length < 10) return setErr("Tell us what happened (at least 10 characters) so an admin can look into it.");
    setErr("");
    const r = await run("Sending your review…", async () => {
      const { error } = await supabase.rpc("submit_class_review", { p_session_id: target.session_id, p_rating: rating, p_comment: comment.trim() || null, p_report: report, p_report_reason: report ? why.trim() : null });
      if (error) throw error;
    }, { success: "Thank you for your review", quiet: true });
    if (!r.ok) return setErr(r.message);
    onDone?.(); onClose();
  };

  const who = target?.instructor_first_name ? `Instructor ${target.instructor_first_name}` : "your instructor";
  return (
    <Sheet open={!!target} onClose={onClose} title="How was this class?">
      {target && <div className="space-y-5">
        <p className="-mt-2 text-sm text-muted">{[target.course_title, target.lesson_title].filter(Boolean).join(" · ")}</p>
        <StarPicker value={rating} onChange={(n) => { setRating(n); setErr(""); }} />

        <label className="block">
          <span className="mb-1.5 flex items-baseline justify-between text-sm font-medium">Your honest review <span className="text-xs font-normal text-muted">{comment.length}/2000</span></span>
          <textarea value={comment} onChange={(e) => setComment(e.target.value)} maxLength={2000} rows={4}
            placeholder="What worked, what didn't, how the class went. Good or bad, we want to hear it."
            className="w-full resize-none rounded-xl bg-surface p-3 text-[15px] leading-relaxed outline-none ring-1 ring-line transition placeholder:text-muted/60 focus:ring-2 focus:ring-accent/60" />
        </label>

        <div className={cx("rounded-2xl p-3.5 ring-1 transition", report ? "bg-bad/5 ring-bad/30" : "bg-sunken/60 ring-transparent")}>
          <button type="button" role="switch" aria-checked={report} onClick={() => setReport((v) => !v)} className="flex w-full items-center gap-3 text-left">
            <span className="min-w-0 flex-1 leading-snug"><span className="block text-[15px] font-medium">Report {who}</span>
              <span className="block text-xs text-muted">Only if something was wrong, like rudeness, no-shows or unfair treatment.</span></span>
            <span className={cx("relative h-7 w-12 shrink-0 rounded-full transition-colors", report ? "bg-bad" : "bg-line")}>
              <span className={cx("absolute top-0.5 h-6 w-6 rounded-full bg-white shadow transition-all", report ? "left-[22px]" : "left-0.5")} /></span>
          </button>
          {report && <label className="anim-fade mt-3 block">
            <span className="mb-1.5 block text-sm font-medium">What happened?</span>
            <textarea value={why} onChange={(e) => setWhy(e.target.value)} maxLength={1000} rows={3} placeholder="Describe it in your own words."
              className="w-full resize-none rounded-xl bg-surface p-3 text-[15px] leading-relaxed outline-none ring-1 ring-line transition placeholder:text-muted/60 focus:ring-2 focus:ring-bad/50" />
            <span className="mt-1.5 block text-xs text-muted">Only the admins read this. It is never shown on the website.</span>
          </label>}
        </div>

        <Err>{err}</Err>
        <Button className="w-full" onClick={submit} disabled={!rating}>Send review</Button>
        <p className="text-center text-xs leading-snug text-muted">Your instructor doesn't see your review. If an admin picks it for our website, your name, photo and review will be shown there.</p>
      </div>}
    </Sheet>
  );
}

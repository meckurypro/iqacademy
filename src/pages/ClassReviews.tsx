// src/pages/ClassReviews.tsx — admin: what students said about their classes.
// Read every review, see who reported an instructor, and choose up to ten reviews to show on the landing page.
import { useCallback, useEffect, useMemo, useState } from "react";
import { supabase } from "../lib/supabase";
import { Avatar, Badge, Card, cx, Empty, PageHeader, Skeleton } from "../components/ui";
import { useFeedback } from "../components/feedback";
import { Stars } from "../components/Stars";
import Icon from "../components/Icon";
import { fmtWhen } from "../lib/time";

export const FEATURE_LIMIT = 10;
export type AdminReview = {
  id: string; session_id: string; rating: number; comment: string | null; report_instructor: boolean; report_reason: string | null; featured: boolean; created_at: string;
  student_name: string; student_avatar: string | null; instructor_name: string | null; course_title: string | null; centre_name: string | null; session_date: string | null;
};
type Filter = "all" | "reported" | "featured" | "low";
const FILTERS: [Filter, string][] = [["all", "All"], ["reported", "Reported"], ["featured", "On landing page"], ["low", "1–2 stars"]];
const when = (d: string) => fmtWhen(d, { day: "numeric", month: "short", year: "numeric" });

export default function ClassReviews() {
  const { run } = useFeedback();
  const [rows, setRows] = useState<AdminReview[] | null>(null); const [filter, setFilter] = useState<Filter>("all"); const [failed, setFailed] = useState(false);
  const load = useCallback(async () => {
    const { data, error } = await supabase.rpc("admin_class_reviews");
    if (error) setFailed(true); else setRows((data as AdminReview[]) ?? []);
  }, []);
  useEffect(() => { load(); }, [load]);

  const featured = rows?.filter((r) => r.featured).length ?? 0;
  const reported = rows?.filter((r) => r.report_instructor).length ?? 0;
  const avg = useMemo(() => (rows?.length ? rows.reduce((n, r) => n + r.rating, 0) / rows.length : 0), [rows]);
  const shown = useMemo(() => (rows ?? []).filter((r) => filter === "all" ? true : filter === "reported" ? r.report_instructor : filter === "featured" ? r.featured : r.rating <= 2), [rows, filter]);

  const toggle = async (r: AdminReview) => {
    const res = await run(r.featured ? "Hiding review…" : "Showing review…", async () => {
      const { error } = await supabase.rpc("set_review_featured", { p_id: r.id, p_featured: !r.featured }); if (error) throw error;
      await load();
    });
    return res.ok;
  };

  if (failed) return <Empty icon="alert" title="Couldn't load reviews" hint="Check your connection and try again." />;
  return (
    <div className="space-y-5">
      <PageHeader title="Class reviews" sub={rows ? (rows.length ? `${rows.length} review${rows.length === 1 ? "" : "s"} · ${avg.toFixed(1)} average` : "Students review a class after it ends") : undefined} />

      <Card className="glass flex items-center gap-3.5">
        <span className="grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-accent/10 text-accent"><Icon name="star" size={22} solid /></span>
        <div className="min-w-0 flex-1 leading-snug"><p className="font-medium">On the landing page</p><p className="text-sm text-muted">Visitors swipe through these. Choose up to {FEATURE_LIMIT}.</p></div>
        <p className="num text-2xl font-semibold tracking-tight">{featured}<span className="text-base font-medium text-muted">/{FEATURE_LIMIT}</span></p>
      </Card>

      <div className="-mx-4 flex gap-2 overflow-x-auto px-4 pb-0.5 [scrollbar-width:none]" role="tablist" aria-label="Filter reviews">
        {FILTERS.map(([k, label]) => (
          <button key={k} role="tab" aria-selected={filter === k} onClick={() => setFilter(k)}
            className={cx("shrink-0 rounded-full px-3.5 py-2 text-sm font-medium ring-1 transition active:scale-95", filter === k ? "bg-accent/10 text-accent ring-accent/40" : "bg-surface text-muted ring-line")}>
            {label}{k === "reported" && reported > 0 && <span className="num ml-1.5 rounded-full bg-bad/10 px-1.5 text-xs text-bad">{reported}</span>}
          </button>))}
      </div>

      {rows === null ? <div className="space-y-3"><Skeleton className="h-36" /><Skeleton className="h-36" /></div>
        : shown.length === 0 ? <Empty icon="star" title={rows.length ? "Nothing here" : "No reviews yet"} hint={rows.length ? "No review matches this filter." : "Reviews appear here when students rate a class that has ended."} />
        : <div className="space-y-3">{shown.map((r) => {
          const noText = (r.comment ?? "").trim().length < 10;
          const blocked = r.report_instructor ? "A review that reports an instructor is never shown publicly." : noText ? "Only a review with a written comment can be shown." : !r.featured && featured >= FEATURE_LIMIT ? `Already ${FEATURE_LIMIT} on the landing page. Hide one to add this.` : "";
          return (
            <Card key={r.id} className={cx("space-y-3", r.report_instructor && "ring-bad/30")}>
              <div className="flex items-center gap-3">
                <Avatar name={r.student_name} url={r.student_avatar} size={40} />
                <div className="min-w-0 flex-1 leading-tight"><p className="truncate font-semibold">{r.student_name}</p><p className="text-xs text-muted">{when(r.created_at)}</p></div>
                <Stars value={r.rating} size={16} />
              </div>
              <p className="text-sm text-muted">{[r.course_title, r.instructor_name && `Instructor ${r.instructor_name}`, r.centre_name].filter(Boolean).join(" · ")}</p>
              {r.comment ? <p className="whitespace-pre-wrap break-words text-[15px] leading-relaxed">{r.comment}</p> : <p className="text-sm italic text-muted">No written comment.</p>}
              {r.report_instructor && <div className="rounded-xl bg-bad/10 p-3 text-sm">
                <p className="mb-1 flex items-center gap-1.5 font-medium text-bad"><Icon name="flag" size={15} />Reported {r.instructor_name ? r.instructor_name : "the instructor"}</p>
                <p className="whitespace-pre-wrap break-words leading-snug">{r.report_reason}</p></div>}
              <div className="flex items-center gap-3 border-t border-line pt-3">
                <p className="min-w-0 flex-1 text-sm leading-snug"><span className="font-medium">Show on landing page</span>{blocked && <span className="mt-0.5 block text-xs text-muted">{blocked}</span>}</p>
                {r.featured && <Badge tone="ok">Showing</Badge>}
                <button role="switch" aria-checked={r.featured} aria-label="Show on landing page" disabled={!r.featured && !!blocked} onClick={() => toggle(r)}
                  className={cx("relative h-7 w-12 shrink-0 rounded-full transition-colors disabled:opacity-40", r.featured ? "bg-accent" : "bg-line")}>
                  <span className={cx("absolute top-0.5 h-6 w-6 rounded-full bg-white shadow transition-all", r.featured ? "left-[22px]" : "left-0.5")} /></button>
              </div>
            </Card>);
        })}</div>}
    </div>
  );
}

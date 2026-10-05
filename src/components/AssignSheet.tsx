// src/components/AssignSheet.tsx
// Bottom sheet for giving an instructor one class, "this and later", or a whole course (at one centre or everywhere).
// Previews the outcome and flags double-bookings before anything is saved.
import { useMemo, useState } from "react";
import { supabase } from "../lib/supabase";
import { useFeedback } from "./feedback";
import { Avatar, Button, Err, Sheet, cx } from "./ui";
import { classes, clock, first, label, pick, plan, short, where, type P, type S, type Scope } from "../lib/roster";

/* eslint-disable @typescript-eslint/no-explicit-any */

export default function AssignSheet({ anchor, scope0, ses, people, onClose, onSaved }:
  { anchor: S; scope0: Scope; ses: S[]; people: P[]; onClose: () => void; onSaved: () => Promise<void> }) {
  const { run, toast } = useFeedback();
  const [scope, setScope] = useState<Scope>(scope0);
  const [who, setWho] = useState(anchor.instructor_id ?? "");
  const [err, setErr] = useState("");

  const counts = useMemo<Record<Scope, number>>(() => ({
    class: pick(ses, anchor, "class").length, later: pick(ses, anchor, "later").length,
    centre: pick(ses, anchor, "centre").length, all: pick(ses, anchor, "all").length }), [ses, anchor]);
  // Hide choices that would do exactly what a neighbouring one does
  const show: Record<Scope, boolean> = {
    class: true,
    later: !!anchor.run_id && counts.later > counts.class && counts.later < counts.centre,
    centre: counts.centre > counts.class,
    all: counts.all > counts.centre };
  const sc: Scope = show[scope] ? scope : show.centre ? "centre" : "class";
  const opts: { k: Scope; text: string }[] = [
    { k: "class", text: "This class" }, { k: "later", text: "This and later" },
    { k: "centre", text: `Whole course · ${where(anchor)}` }, { k: "all", text: "Whole course · every centre" }];

  const targets = useMemo(() => pick(ses, anchor, sc), [ses, anchor, sc]);
  const fit = useMemo(() => new Map(people.map((p) => [p.id, plan(ses, p.id, targets)])), [people, ses, targets]);
  const pl = who ? fit.get(who) : undefined;
  const chosen = people.find((p) => p.id === who);
  const staffed = targets.filter((t) => t.instructor_id).length;
  const replaced = pl ? pl.ok.filter((t) => t.instructor_id).length : 0;

  const save = async (instr: string | null) => {
    setErr("");
    const body = sc === "class" || sc === "later"
      ? { p_scope: "sessions", p_instructor_id: instr, p_session_ids: targets.map((t) => t.id), p_course_id: null, p_centre_id: null }
      : { p_scope: sc === "centre" ? "course_centre" : "course_all", p_instructor_id: instr, p_session_ids: null, p_course_id: anchor.course_id, p_centre_id: sc === "centre" ? anchor.centre_id : null };
    const r = await run(instr ? "Assigning…" : "Clearing…", async () => {
      const { data, error } = await supabase.rpc("roster_assign", body); if (error) throw error;
      await onSaved(); return data as any;
    }, { quiet: true });
    if (!r.ok) return setErr(r.message);
    const skipped = r.data?.clashes?.length ?? 0, done = r.data?.assigned ?? 0;
    toast(skipped ? `${done} done, ${skipped} skipped because of a clash` : done === 0 ? "Nothing needed changing" : instr ? `${classes(done)} assigned` : "Instructor cleared", skipped ? "bad" : "ok");
    onClose();
  };

  return (
    <Sheet open onClose={onClose} title={anchor.course_title}>
      <div className="space-y-4">
        <div className="space-y-0.5 text-sm text-muted">
          <p>Class {anchor.session_no}{anchor.lesson_title ? ` · ${anchor.lesson_title}` : ""}</p>
          <p><span className="num">{label(anchor.session_date)} · {clock(anchor.start_at)} – {clock(anchor.end_at)}</span> · {where(anchor)}</p>
        </div>

        <div className="space-y-1.5">
          <p className="text-sm text-muted">Apply to</p>
          <div className="flex flex-wrap gap-2">
            {opts.filter((o) => show[o.k]).map((o) => (
              <button key={o.k} onClick={() => setScope(o.k)}
                className={cx("rounded-full px-3.5 py-2 text-sm ring-1 transition active:scale-[.98]", sc === o.k ? "bg-accent/10 font-medium ring-2 ring-accent" : "bg-surface ring-line")}>
                {o.text} <span className="num text-muted">{counts[o.k]}</span>
              </button>))}
          </div>
        </div>

        <div className="space-y-1.5">
          <p className="text-sm text-muted">Instructor</p>
          {people.length === 0 ? <p className="rounded-xl bg-sunken p-3 text-sm text-muted">No instructors yet. Promote someone to instructor on the Users page.</p>
            : <div className="max-h-[36dvh] space-y-2 overflow-y-auto pr-1">
              {people.map((p) => {
                const f = fit.get(p.id)!; const n = targets.length;
                const dead = f.ok.length === 0 && f.same === 0;
                const hint = f.same === n && n > 0 ? "Already teaching these" : f.clash.length === n && n > 0 ? "Busy at these times"
                  : f.clash.length > 0 ? `Free for ${f.ok.length + f.same}, busy for ${f.clash.length}` : "Free";
                return (
                  <button key={p.id} disabled={dead} onClick={() => setWho(p.id)}
                    className={cx("flex w-full items-center gap-3 rounded-2xl p-3 text-left ring-1 transition active:scale-[.99] disabled:opacity-50", who === p.id ? "bg-accent/10 ring-2 ring-accent" : "bg-surface ring-line")}>
                    <Avatar name={p.name} url={p.avatar} size={36} />
                    <div className="min-w-0 flex-1"><p className="truncate font-medium">{p.name}</p><p className={cx("text-xs", f.clash.length ? "text-warn" : "text-muted")}>{hint}</p></div>
                    <span className={cx("grid h-5 w-5 place-items-center rounded-full text-[11px]", who === p.id ? "bg-accent text-accent-ink" : "ring-1 ring-line")}>{who === p.id && "✓"}</span>
                  </button>);
              })}
            </div>}
        </div>

        {pl && chosen && (
          <p className="text-sm text-muted">
            {pl.ok.length > 0
              ? <><span className="font-medium text-ink">{first(chosen.name)}</span> will teach {classes(pl.ok.length)}{pl.ok.length > 1 ? ` (${short(pl.ok[0].session_date)} to ${short(pl.ok[pl.ok.length - 1].session_date)})` : ""}.</>
              : "Nothing to change."}
            {pl.same > 0 && pl.ok.length > 0 && ` ${pl.same} already theirs.`}
            {replaced > 0 && ` This replaces ${replaced === 1 ? "the current instructor" : `${replaced} current assignments`}, who will be told.`}
            {pl.clash.length > 0 && ` ${pl.clash.length} skipped: they teach something else at ${pl.clash.length === 1 ? "that time" : "those times"}.`}
          </p>)}

        <Err>{err}</Err>
        <Button className="w-full" disabled={!pl || pl.ok.length === 0} onClick={() => save(who)}>
          {!who || !pl ? "Choose an instructor" : pl.ok.length === 0 ? (pl.same > 0 ? "Already assigned" : "Can't assign") : `Assign ${first(chosen?.name ?? "")}${pl.ok.length > 1 ? ` to ${pl.ok.length} classes` : ""}`}
        </Button>
        {staffed > 0 && <Button variant="ghost" className="w-full text-bad" onClick={() => save(null)}>Clear instructor{staffed > 1 ? ` on ${staffed} classes` : ""}</Button>}
      </div>
    </Sheet>
  );
}

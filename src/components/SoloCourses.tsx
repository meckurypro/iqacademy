import { useCallback, useEffect, useState } from "react";
import { supabase, naira } from "../lib/supabase";
import { sleep } from "../lib/db";
import { startPayment } from "../lib/payment";
import { place } from "../lib/centre";
import { useFeedback } from "./feedback";
import Place from "./Place";
import { Button, Card, Err, Sheet, Skeleton, cx } from "./ui";

import Icon from "./Icon";
import { fmtDay, today } from "../lib/time";
// Any student can buy a course on its own. The price is set by admin per course (a second price applies when the
// prerequisite isn't completed) and is worked out by the database, never here.
export type Offer = { course_id: string; title: string; summary: string | null; price: number | null; prereq_met: boolean; has_prereq: boolean; taken: boolean; needs: string | null; blocked: string | null };
type Centre = { id: string; name: string; city: string | null; address: string | null };
type Start = { centre_id: string; starts_on: string };

const startsLabel = (iso: string) => (iso <= today() ? "Starts today" : `Starts ${fmtDay(iso, { day: "numeric", month: "long", year: "numeric" })}`);

/** Courses a student can buy on their own. Courses without a price are left out; undefined while loading. */
export function useSoloOffers() {
  const [offers, setOffers] = useState<Offer[]>();
  const load = useCallback(async () => {
    const r = await supabase.rpc("solo_course_offers");
    setOffers(((r.data as Offer[]) ?? []).filter((o) => o.blocked !== "price_not_set"));
  }, []);
  useEffect(() => { load(); }, [load]);
  return { offers, reload: load };
}

export function SoloSheet({ open, onClose, offers }: { open: boolean; onClose: () => void; offers?: Offer[] }) {
  const { run } = useFeedback();
  const [pick, setPick] = useState<Offer | null>(null);
  const [centres, setCentres] = useState<Centre[]>();
  const [starts, setStarts] = useState<Map<string, string>>(new Map());
  const [centre, setCentre] = useState("");
  const [err, setErr] = useState("");

  useEffect(() => { if (!open) { setPick(null); setCentre(""); setErr(""); } }, [open]);

  const choose = async (o: Offer) => {
    setPick(o); setCentre(""); setErr(""); setCentres(undefined);
    const [c, s] = await Promise.all([
      supabase.from("centres").select("id,name,city,address").eq("is_active", true),
      supabase.rpc("centre_course_starts", { p_course_id: o.course_id }),
    ]);
    const map = new Map(((s.data as Start[]) ?? []).map((x) => [x.centre_id, x.starts_on]));
    setStarts(map);
    setCentres(((c.data as Centre[]) ?? []).sort((a, b) => (map.get(a.id) ?? "9").localeCompare(map.get(b.id) ?? "9") || place(a).localeCompare(place(b))));
  };

  const pay = async () => {
    if (!pick || !centre) return;
    setErr("");
    // startPayment sends the browser to Paystack; the overlay stays up until the page actually leaves.
    const r = await run("Setting up your payment…", async () => {
      const { data: id, error } = await supabase.rpc("create_solo_enrolment", { p_centre_id: centre, p_course_id: pick.course_id });
      if (error) throw error;
      const { data: inst } = await supabase.from("enrolment_instalments").select("id").eq("enrolment_id", id).eq("number", 1).single();
      await startPayment(inst!.id);
      await sleep(10000);
    }, { quiet: true });
    if (!r.ok) setErr(r.message);
  };

  return (
    <Sheet open={open} onClose={onClose} title={pick ? undefined : "Single courses"}>
      {!pick ? (
        <div className="space-y-2.5">
          {!offers ? <><Skeleton className="h-20" /><Skeleton className="h-20" /></> : offers.map((o) => {
            const busy = o.blocked === "in_progress";
            return (
              <button key={o.course_id} disabled={busy} onClick={() => choose(o)}
                className="flex w-full items-start gap-4 rounded-2xl bg-surface p-4 text-left ring-1 ring-line transition active:scale-[.99] disabled:opacity-60">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                    <p className="font-medium leading-snug">{o.title}</p>
                    {o.taken && !busy && <span className="rounded-full bg-accent/10 px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide text-accent">Retake</span>}
                    {busy && <span className="rounded-full bg-sunken px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide text-muted">In progress</span>}
                  </div>
                  {o.summary && <p className="mt-1 line-clamp-2 text-sm text-muted">{o.summary}</p>}
                  {o.needs && !busy && <p className="mt-1 text-[13px] text-muted">Builds on <span className="font-medium text-ink">{o.needs}</span></p>}
                </div>
                {o.price != null && !busy && <span className="num pt-0.5 text-[17px] font-semibold">{naira(o.price)}</span>}
              </button>);
          })}
          {offers && !offers.length && <p className="py-6 text-center text-muted">No single courses are open yet.</p>}
        </div>
      ) : (
        <div className="space-y-4">
          <div>
            <button onClick={() => setPick(null)} className="mb-2 text-sm text-muted"><span className="inline-flex items-center gap-1.5"><Icon name="arrowLeft" size={16} />Courses</span></button>
            <div className="flex items-start justify-between gap-4">
              <div className="min-w-0"><h2 className="text-lg leading-snug">{pick.title}</h2>
                {pick.taken && <span className="mt-1 inline-block rounded-full bg-accent/10 px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide text-accent">Retake</span>}</div>
              {pick.price != null && <span className="num text-lg font-semibold">{naira(pick.price)}</span>}
            </div>
          </div>
          <p className="text-sm font-medium text-muted">Where will you learn?</p>
          <div className="space-y-2.5">
            {!centres ? <Skeleton className="h-20" /> : centres.map((c) => {
              const d = starts.get(c.id);
              return (
                <button key={c.id} disabled={!d} onClick={() => setCentre(c.id)}
                  className={cx("flex w-full items-center gap-3 rounded-2xl p-4 text-left ring-1 transition active:scale-[.99] disabled:opacity-50", centre === c.id ? "bg-accent/10 ring-2 ring-accent" : "bg-surface ring-line")}>
                  <div className="min-w-0 flex-1"><p className="text-[17px] leading-snug"><Place centre={c} /></p>
                    <p className={cx("mt-0.5 text-sm", d ? "font-medium text-accent" : "text-muted")}>{d ? startsLabel(d) : "No classes scheduled yet"}</p></div>
                  <span className={cx("grid h-5 w-5 shrink-0 place-items-center rounded-full text-[11px]", centre === c.id ? "bg-accent text-accent-ink" : "ring-1 ring-line")}>{centre === c.id && <Icon name="check" size={12} strokeWidth={3} />}</span>
                </button>);
            })}
          </div>
          <Err>{err}</Err>
          <Button className="w-full" disabled={!centre} onClick={pay}>Pay {pick.price != null ? naira(pick.price) : ""}</Button>
        </div>)}
    </Sheet>
  );
}

// Student home: a quiet card for students who already have an enrolment.
export default function SoloCourses() {
  const { offers } = useSoloOffers();
  const [open, setOpen] = useState(false);
  if (!offers?.length) return null;
  return (
    <>
      <Card className="flex items-center justify-between gap-3">
        <div className="min-w-0"><p className="font-medium">Want more?</p><p className="text-sm text-muted">Buy a single course, or take one again.</p></div>
        <Button variant="secondary" className="h-10 shrink-0" onClick={() => setOpen(true)}>Buy a course</Button>
      </Card>
      <SoloSheet open={open} onClose={() => setOpen(false)} offers={offers} />
    </>
  );
}

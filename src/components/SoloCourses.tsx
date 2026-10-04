import { useEffect, useState } from "react";
import { supabase, friendly, naira } from "../lib/supabase";
import { startPayment } from "../pages/Enrol";
import Place from "./Place";
import { Button, Card, Err, Sheet, Skeleton, cx } from "./ui";

// Students who have fully paid for a pack can buy any single course on its own. The price is set by admin per course
// (a second price applies when the prerequisite isn't completed) and is worked out by the database, never here.
type Offer = { course_id: string; title: string; summary: string | null; price: number | null; prereq_met: boolean; has_prereq: boolean; blocked: string | null };
type Centre = { id: string; name: string; city: string | null; address: string | null };
type Start = { centre_id: string; starts_on: string };

const startsLabel = (iso: string) => {
  const d = new Date(`${iso}T00:00:00`); const t = new Date(); t.setHours(0, 0, 0, 0);
  return d <= t ? "Starts today" : `Starts ${d.toLocaleDateString(undefined, { day: "numeric", month: "long", year: "numeric" })}`;
};

export default function SoloCourses() {
  const [open, setOpen] = useState(false);
  const [offers, setOffers] = useState<Offer[]>();
  const [pick, setPick] = useState<Offer | null>(null);
  const [centres, setCentres] = useState<Centre[]>();
  const [starts, setStarts] = useState<Map<string, string>>(new Map());
  const [centre, setCentre] = useState("");
  const [busy, setBusy] = useState(false); const [err, setErr] = useState("");

  const show = async () => {
    setOpen(true); setPick(null); setErr("");
    const r = await supabase.rpc("solo_course_offers");
    setOffers((r.data as Offer[]) ?? []);
  };
  const choose = async (o: Offer) => {
    setPick(o); setCentre(""); setErr(""); setCentres(undefined);
    const [c, s] = await Promise.all([
      supabase.from("centres").select("id,name,city,address").eq("is_active", true),
      supabase.rpc("centre_course_starts", { p_course_id: o.course_id }),
    ]);
    setStarts(new Map(((s.data as Start[]) ?? []).map((x) => [x.centre_id, x.starts_on])));
    setCentres((c.data as Centre[]) ?? []);
  };
  const close = () => { if (!busy) { setOpen(false); setPick(null); } };

  const pay = async () => {
    if (!pick || !centre) return;
    setBusy(true); setErr("");
    try {
      const { data: id, error } = await supabase.rpc("create_solo_enrolment", { p_centre_id: centre, p_course_id: pick.course_id });
      if (error) throw error;
      const { data: inst } = await supabase.from("enrolment_instalments").select("id").eq("enrolment_id", id).eq("number", 1).single();
      await startPayment(inst!.id);
    } catch (e) { setErr(friendly(e)); setBusy(false); }
  };

  // The button only appears for students who can actually buy (the database returns nothing otherwise).
  const [eligible, setEligible] = useState(false);
  useEffect(() => { supabase.rpc("solo_course_offers").then((r) => setEligible(((r.data as Offer[]) ?? []).length > 0)); }, []);
  if (!eligible) return null;

  return (
    <>
      <Card className="flex items-center justify-between gap-3">
        <div className="min-w-0"><p className="font-medium">Want more?</p><p className="text-sm text-muted">Buy a single course, or take one again.</p></div>
        <Button variant="secondary" className="h-10 shrink-0" onClick={show}>Buy a course</Button>
      </Card>

      <Sheet open={open} onClose={close} title={pick ? "Where will you learn?" : "Buy a single course"}>
        {!pick ? (
          <div className="space-y-3">
            {!offers ? <Skeleton className="h-20" /> : offers.map((o) => {
              const locked = o.blocked === "in_progress" ? "You're already taking this" : o.blocked === "price_not_set" ? "Not available on its own yet" : undefined;
              return (
                <button key={o.course_id} disabled={!!locked} onClick={() => choose(o)}
                  className="flex w-full items-center gap-3 rounded-2xl bg-surface p-4 text-left ring-1 ring-line transition active:scale-[.99] disabled:opacity-50">
                  <div className="min-w-0 flex-1"><p className="font-medium">{o.title}</p>
                    <p className="mt-0.5 text-sm text-muted">{locked ?? (o.has_prereq && !o.prereq_met ? "Recommended after the courses that come before it" : o.summary)}</p></div>
                  {o.price != null && !locked && <span className="num font-medium">{naira(o.price)}</span>}
                </button>);
            })}
          </div>
        ) : (
          <div className="space-y-3">
            <button onClick={() => setPick(null)} className="text-sm text-muted">← Courses</button>
            <p className="text-sm text-muted"><span className="font-medium text-ink">{pick.title}</span> · {pick.price != null ? naira(pick.price) : ""}</p>
            {!centres ? <Skeleton className="h-20" /> : centres.map((c) => {
              const d = starts.get(c.id);
              return (
                <button key={c.id} disabled={!d} onClick={() => setCentre(c.id)}
                  className={cx("flex w-full items-center gap-3 rounded-2xl p-4 text-left ring-1 transition active:scale-[.99] disabled:opacity-50", centre === c.id ? "bg-accent/10 ring-2 ring-accent" : "bg-surface ring-line")}>
                  <div className="min-w-0 flex-1"><p className="text-[17px] leading-snug"><Place centre={c} /></p>
                    <p className={cx("mt-0.5 text-sm", d ? "font-medium text-accent" : "text-muted")}>{d ? startsLabel(d) : "No classes scheduled yet"}</p></div>
                </button>);
            })}
            <Err>{err}</Err>
            <Button className="w-full" disabled={!centre} loading={busy} onClick={pay}>Pay {pick.price != null ? naira(pick.price) : ""}</Button>
          </div>)}
      </Sheet>
    </>
  );
}

import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { supabase } from "../lib/supabase";
import { Card } from "./ui";
import { fmtDay } from "../lib/time";

type R = { id: string; course_title: string; centre_city: string | null; centre_name: string; last_session_date: string | null };

// Admins and instructors are nudged when a course is about to hold its last class with nothing scheduled after it.
export default function RunReminder() {
  const [rows, setRows] = useState<R[]>([]);
  useEffect(() => { supabase.from("v_course_runs").select("id,course_title,centre_city,centre_name,last_session_date").eq("ending_soon", true).then((r) => setRows((r.data as R[]) ?? [])); }, []);
  if (!rows.length) return null;
  const d = (iso: string | null) => (iso ? fmtDay(iso, { day: "numeric", month: "short" }) : "");
  return (
    <Link to="/schedule"><Card onClick={() => {}} className="anim-rise space-y-1 bg-warn/10 ring-warn/30">
      <p className="font-medium">Set the next course dates</p>
      <p className="text-sm text-muted">{rows.map((r) => `${r.course_title} at ${r.centre_city || r.centre_name} ends ${d(r.last_session_date)}`).join(" · ")}</p>
    </Card></Link>
  );
}

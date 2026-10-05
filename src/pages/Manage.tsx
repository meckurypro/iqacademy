// src/pages/Manage.tsx
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { supabase } from "../lib/supabase";
import { Badge, Card } from "../components/ui";

import Icon, { type IconName } from "../components/Icon";
const ITEMS: [string, string, IconName, string][] = [["/centres", "Centres", "centres", "Locations, teams, revenue share and bank accounts"], ["/schedule", "Schedule", "schedule", "Class days at each centre and when each course begins and ends"],
  ["/roster", "Roster", "roster", "Who teaches which class: by class, course or centre"],
  ["/emergency", "Emergency classes", "alert", "Start an extra class at a centre and choose who teaches it"],
  ["/courses", "Course builder", "courses", "Classes in each course and what every class covers"],
  ["/prices", "Prices & instalments", "prices", "Package prices and what each instalment costs"], ["/offline-payments", "Offline payments", "cash", "Cash and transfer payments waiting for you to confirm"], ["/payments", "Payments & refunds", "receipt", "Student payments, refund a student"], ["/payouts", "Payouts", "payout", "Monthly payments to centres"], ["/instructors", "Instructors", "instructor", "Classes taught and students taught"],
  ["/class-messages", "Class messages", "messages", "What instructors sent to classes. Admins can delete"]];
export default function Manage() {
  const [open, setOpen] = useState(0);
  useEffect(() => { supabase.rpc("offline_payment_counts").then((r) => setOpen((r.data as { open?: number } | null)?.open ?? 0)); }, []);
  return (
    <div className="space-y-4"><h1 className="text-2xl">Manage</h1>
      {ITEMS.map(([to, t, i, s]) => <Link key={to} to={to}><Card onClick={() => {}} className="mb-3 flex items-center gap-4"><span className="grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-sunken text-accent"><Icon name={i} size={22} /></span><div className="min-w-0 flex-1"><p className="font-medium">{t}</p><p className="text-sm text-muted">{s}</p></div>{to === "/offline-payments" && open > 0 && <Badge tone="warn">{open} waiting</Badge>}<Icon name="chevronRight" size={18} className="shrink-0 text-muted" /></Card></Link>)}
    </div>
  );
}

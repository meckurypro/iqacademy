import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { supabase } from "../lib/supabase";
import { Badge, Card } from "../components/ui";

const ITEMS = [["/centres", "Centres", "🏫", "Locations, teams, revenue share and bank accounts"], ["/schedule", "Schedule", "🗓️", "Class days at each centre and when each course begins and ends"],
  ["/courses", "Course builder", "📚", "Classes in each course and what every class covers"],
  ["/prices", "Prices & instalments", "🏷️", "Package prices and what each instalment costs"], ["/offline-payments", "Offline payments", "💵", "Cash and transfer payments waiting for you to confirm"], ["/payments", "Payments & refunds", "🧾", "Student payments, refund a student"], ["/payouts", "Payouts", "💸", "Monthly payments to centres"], ["/instructors", "Instructors", "🎓", "Classes taught and students taught"],
  ["/class-messages", "Class messages", "💬", "What instructors sent to classes. Admins can delete"]];
export default function Manage() {
  const [open, setOpen] = useState(0);
  useEffect(() => { supabase.rpc("offline_payment_counts").then((r) => setOpen((r.data as { open?: number } | null)?.open ?? 0)); }, []);
  return (
    <div className="space-y-4"><h1 className="text-2xl">Manage</h1>
      {ITEMS.map(([to, t, i, s]) => <Link key={to} to={to}><Card onClick={() => {}} className="mb-3 flex items-center gap-4"><span className="text-2xl">{i}</span><div className="min-w-0 flex-1"><p className="font-medium">{t}</p><p className="text-sm text-muted">{s}</p></div>{to === "/offline-payments" && open > 0 && <Badge tone="warn">{open} waiting</Badge>}</Card></Link>)}
    </div>
  );
}

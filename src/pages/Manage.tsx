import { Link } from "react-router-dom";
import { Card } from "../components/ui";

const ITEMS = [["/centres", "Centres", "🏫", "Locations, teams, revenue share and bank accounts"], ["/cohorts", "Cohorts & timetable", "🗓️", "Open cohorts, weekly classes, instructors"],
  ["/prices", "Prices & instalments", "🏷️", "Package prices and what each instalment costs"], ["/payments", "Payments & refunds", "🧾", "Student payments, refund a student"], ["/payouts", "Payouts", "💸", "Monthly payments to centres"], ["/instructors", "Instructors", "🎓", "Classes taught and students taught"]];
export default function Manage() {
  return (
    <div className="space-y-4"><h1 className="text-2xl">Manage</h1>
      {ITEMS.map(([to, t, i, s]) => <Link key={to} to={to}><Card onClick={() => {}} className="mb-3 flex items-center gap-4"><span className="text-2xl">{i}</span><div><p className="font-medium">{t}</p><p className="text-sm text-muted">{s}</p></div></Card></Link>)}
    </div>
  );
}

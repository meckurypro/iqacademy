// src/pages/Manage.tsx
import { useEffect, useState } from "react";
import { supabase } from "../lib/supabase";
import { Badge, List, NavRow, PageHeader, Section, type Tone } from "../components/ui";
import type { IconName } from "../components/Icon";

type Item = [to: string, title: string, icon: IconName, hint: string, tone?: Tone];
// Grouped by what an admin is trying to do, so eleven rows read as three short lists.
const GROUPS: [title: string, items: Item[]][] = [
  ["Classes", [
    ["/schedule", "Schedule", "schedule", "Class days and course start and end dates", "info"],
    ["/roster", "Roster", "roster", "Who teaches which class", "info"],
    ["/custom", "Custom classes", "calendarPlus", "Create a class and choose who is invited", "info"],
    ["/courses", "Course builder", "courses", "Classes in each course and what they cover", "info"],
  ]],
  ["Money", [
    ["/prices", "Prices & instalments", "prices", "Package prices and instalment amounts", "ok"],
    ["/offline-payments", "Offline payments", "cash", "Cash and transfers waiting to be confirmed", "ok"],
    ["/payments", "Payments & refunds", "receipt", "Student payments and refunds", "ok"],
    ["/payouts", "Payouts", "payout", "Monthly payments to centres", "ok"],
  ]],
  ["People & places", [
    ["/centres", "Centres", "centres", "Locations, teams, revenue share, bank accounts"],
    ["/instructors", "Instructors", "instructor", "Classes and students taught"],
    ["/class-messages", "Class messages", "messages", "What instructors sent to classes"],
  ]],
];

export default function Manage() {
  const [open, setOpen] = useState(0);
  useEffect(() => { supabase.rpc("offline_payment_counts").then((r) => setOpen((r.data as { open?: number } | null)?.open ?? 0)); }, []);
  return (
    <div className="space-y-7">
      <PageHeader title="Manage" />
      <div className="space-y-7 lg:grid lg:grid-cols-2 lg:items-start lg:gap-x-6 lg:gap-y-7 lg:space-y-0">{GROUPS.map(([title, items]) => (
        <Section key={title} title={title}>
          <List>{items.map(([to, t, icon, hint, tone]) => (
            <NavRow key={to} to={to} icon={icon} title={t} hint={hint} tone={tone}
              badge={to === "/offline-payments" && open > 0 ? <Badge tone="warn">{open} waiting</Badge> : undefined} />))}
          </List>
        </Section>))}</div>
    </div>
  );
}

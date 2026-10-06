// src/lib/nav.ts — where each role can go. Phones show TABS (bottom bar) plus the hamburger drawer; desktops show SIDEBAR.
import type { IconName } from "../components/Icon";

export type NavItem = [to: string, label: string, icon: IconName];
export type NavSection = { title?: string; items: NavItem[] };

// Bottom tab bar on phones. Keep to five or fewer.
export const TABS: Record<string, NavItem[]> = {
  student: [["/", "Home", "home"], ["/messages", "Messages", "messages"]],
  instructor: [["/", "Today", "today"], ["/my-classes", "My classes", "classes"], ["/schedule", "Schedule", "schedule"], ["/history", "History", "history"], ["/messages", "Messages", "messages"]],
  admin: [["/", "Overview", "overview"], ["/users", "Users", "users"], ["/announce", "Announce", "announce"], ["/manage", "Manage", "manage"]],
};
TABS.super_admin = TABS.admin;

// Desktop sidebar. There is room to show everything at once, so the admin's "Manage" hub is spread out into its groups
// and the drawer-only shortcuts (Enrol, Custom class, My team) sit with the rest.
const ADMIN: NavSection[] = [
  { items: [["/", "Overview", "overview"], ["/users", "Users", "users"], ["/announce", "Announce", "announce"]] },
  { title: "Classes", items: [["/schedule", "Schedule", "schedule"], ["/roster", "Roster", "roster"], ["/custom", "Custom classes", "calendarPlus"], ["/courses", "Course builder", "courses"]] },
  { title: "Money", items: [["/prices", "Prices & instalments", "prices"], ["/offline-payments", "Offline payments", "cash"], ["/payments", "Payments & refunds", "receipt"], ["/payouts", "Payouts", "payout"]] },
  { title: "People & places", items: [["/centres", "Centres", "centres"], ["/instructors", "Instructors", "instructor"], ["/class-messages", "Class messages", "messages"]] },
];

export const SIDEBAR: Record<string, NavSection[]> = {
  student: [{ items: [["/", "Home", "home"], ["/messages", "Messages", "messages"], ["/enrol", "Enrol in a course", "enrol"]] }],
  instructor: [{ items: [["/", "Today", "today"], ["/my-classes", "My classes", "classes"], ["/schedule", "Schedule", "schedule"], ["/history", "History", "history"], ["/messages", "Messages", "messages"], ["/custom", "Custom class", "calendarPlus"]] }],
  coordinator: [{ items: [["/", "Home", "home"]] }],
  centre_director: [{ items: [["/", "Home", "home"], ["/team", "My team", "userPlus"]] }],
  admin: ADMIN,
  super_admin: ADMIN,
};

// Pages that read better as one narrow column (forms, wizards, settings) than stretched across a wide screen.
const NARROW = [/^\/announce/, /^\/enrol/, /^\/profile/, /^\/notifications/, /^\/pay\//, /^\/courses\/.+/];
// Pages that lay themselves out edge to edge (the two-pane inbox).
const FULL = [/^\/messages/];
export type PageWidth = "narrow" | "wide" | "full";
export const pageWidth = (pathname: string): PageWidth => NARROW.some((r) => r.test(pathname)) ? "narrow" : FULL.some((r) => r.test(pathname)) ? "full" : "wide";

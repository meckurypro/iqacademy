// src/lib/nav.ts — where each role can go. Phones show TABS (bottom bar), the avatar (opens Profile) and, only for a role that has links
// the tabs and its own pages don't reach, the hamburger drawer (MENU_EXTRA). Desktops show SIDEBAR.
import type { IconName } from "../components/Icon";

export type NavItem = [to: string, label: string, icon: IconName];
export type NavSection = { title?: string; items: NavItem[] };

// Bottom tab bar on phones. Keep to five or fewer.
export const TABS: Record<string, NavItem[]> = {
  student: [["/", "Home", "home"], ["/messages", "Messages", "messages"], ["/enrol", "Enrol", "enrol"]],
  instructor: [["/", "Today", "today"], ["/my-classes", "My classes", "classes"], ["/schedule", "Schedule", "schedule"], ["/history", "History", "history"], ["/messages", "Messages", "messages"]],
  coordinator: [["/", "Home", "home"], ["/students", "Students", "users"], ["/centre-classes", "Classes", "classes"]],
  centre_director: [["/", "Home", "home"], ["/students", "Students", "users"], ["/centre-classes", "Classes", "classes"], ["/statement", "Statement", "receipt"], ["/team", "Team", "userPlus"]],
  admin: [["/", "Overview", "overview"], ["/users", "Users", "users"], ["/announce", "Announce", "announce"], ["/manage", "Manage", "manage"]],
};
TABS.super_admin = TABS.admin;

// The hamburger drawer. It lists only what the bottom bar and the role's own pages don't reach; a role with nothing here has no hamburger.
// Instructors: a custom class is deliberately not on their Today page, and their five tabs are full.
export const MENU_EXTRA: Record<string, NavItem[]> = {
  instructor: [["/custom", "Custom class", "calendarPlus"]],
};

// Desktop sidebar. There is room to show everything at once, so the admin's "Manage" hub is spread out into its groups
// and the drawer-only shortcuts (Enrol, Custom class, My team) sit with the rest.
const ADMIN: NavSection[] = [
  { items: [["/", "Overview", "overview"], ["/users", "Users", "users"], ["/announce", "Announce", "announce"]] },
  { title: "Classes", items: [["/schedule", "Schedule", "schedule"], ["/roster", "Roster", "roster"], ["/custom", "Custom classes", "calendarPlus"], ["/courses", "Course builder", "courses"]] },
  { title: "Money", items: [["/prices", "Prices & instalments", "prices"], ["/offline-payments", "Offline payments", "cash"], ["/payments", "Payments & refunds", "receipt"], ["/payouts", "Payouts", "payout"]] },
  { title: "People & places", items: [["/centres", "Centres", "centres"], ["/instructors", "Instructors", "instructor"], ["/class-messages", "Class messages", "messages"], ["/reviews", "Class reviews", "star"], ["/check-ins", "Hand check-ins", "lock"]] },
];

export const SIDEBAR: Record<string, NavSection[]> = {
  student: [{ items: [["/", "Home", "home"], ["/messages", "Messages", "messages"], ["/enrol", "Enrol in a course", "enrol"]] }],
  instructor: [{ items: [["/", "Today", "today"], ["/my-classes", "My classes", "classes"], ["/schedule", "Schedule", "schedule"], ["/history", "History", "history"], ["/messages", "Messages", "messages"], ["/custom", "Custom class", "calendarPlus"]] }],
  coordinator: [{ items: [["/", "Home", "home"], ["/students", "Students", "users"], ["/centre-classes", "Classes & staff", "classes"]] }],
  centre_director: [{ items: [["/", "Home", "home"], ["/students", "Students", "users"], ["/centre-classes", "Classes & staff", "classes"], ["/statement", "Statements", "receipt"], ["/team", "My team", "userPlus"]] }],
  admin: ADMIN,
  super_admin: ADMIN,
};

// Pages that read better as one narrow column (forms, wizards, settings) than stretched across a wide screen.
const NARROW = [/^\/announce/, /^\/enrol/, /^\/profile/, /^\/notifications/, /^\/pay\//, /^\/courses\/.+/];
// Pages that lay themselves out edge to edge (the two-pane inbox).
const FULL = [/^\/messages/];
export type PageWidth = "narrow" | "wide" | "full";
export const pageWidth = (pathname: string): PageWidth => NARROW.some((r) => r.test(pathname)) ? "narrow" : FULL.some((r) => r.test(pathname)) ? "full" : "wide";

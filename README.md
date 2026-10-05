# IQ Academy

**Understand. Design. Build. Automate.**

IQ Academy is a mobile-first web app for running an AI-skills training business across several physical centres. Students enrol and pay, check in to classes with a code or QR, and follow a course class by class. Instructors run live classes. Coordinators and centre directors look after their branches. Admins run everything else: courses, prices, schedules, staffing, payments, refunds and payouts.

It is a single-page React app that talks directly to a Supabase backend (Postgres, Auth, Realtime, Storage and Edge Functions). Payments go through Paystack, with an offline cash/transfer option confirmed by an admin.

> IQ Academy is the education arm of [PromptIQ](https://promptiq.com.ng), an AI creative agency.

---

## Contents

1. [Tech stack](#tech-stack)
2. [Roles and what each can do](#roles-and-what-each-can-do)
3. [How the main flows work](#how-the-main-flows-work)
4. [Accounts, passwords and email verification](#accounts-passwords-and-email-verification)
5. [Routes](#routes)
6. [How the code is organised](#how-the-code-is-organised)
7. [Backend: database, functions and storage](#backend-database-functions-and-storage)
8. [Getting started](#getting-started)
9. [Deploying](#deploying)
10. [Supabase configuration checklist](#supabase-configuration-checklist)
11. [Branding](#branding)
12. [Known limits](#known-limits)

---

## Tech stack

| Layer | Choice |
| --- | --- |
| UI | React 18, TypeScript, React Router 6 |
| Build | Vite 5 |
| Styling | Tailwind CSS 3, Geist variable font, light/dark/system theme |
| Backend | Supabase: `@supabase/supabase-js` 2 (Auth, Postgres with RLS and RPC functions, Realtime, Storage, Edge Functions) |
| Payments | Paystack (card/transfer checkout, refunds, bank-recipient verification, centre payouts) |
| QR | `qrcode.react` for generating codes; the camera scanner is built into the app |
| Hosting | Vercel (`vercel.json` handles SPA routing and long-lived asset caching) |

There is no separate server: the business rules live in the database as Postgres functions (RPCs) and row-level security policies. The front end calls them and shows the result.

---

## Roles and what each can do

A person can hold more than one role. The highest one decides their home screen and navigation:

`super_admin` > `admin` > `centre_director` > `coordinator` > `instructor` > `student`

### Student
- **Enrol in four steps:** pack, courses, centre, payment. Courses are locked until their prerequisites are done.
- **Pay** in full or by instalment, online with Paystack or offline by cash/transfer with a receipt upload.
- **Home screen:** next class, the next instalment to pay, progress per course, the full class-by-class outline with a tick for each class attended, refunds, and any offline payment waiting on confirmation.
- **Check in** to a class by scanning the QR shown at the centre or typing the code. The whole screen turns green ("You're in!") or red (not registered, payment due, make-up rules) so door staff can see the answer at a glance.
- **Make-up classes:** a free catch-up window for classes missed.
- **Buy a single course** from the registration page or the home screen. Courses taken before are marked Retake.
- **Messages tab:** receive-only class messages from instructors, with an unread badge.
- Can cancel an unpaid registration from the home screen.

### Instructor
- **Today:** the day's classes plus stats (classes taught, students taught, average per class, all time).
- **Live class screen:** a real-time attendance roster, manual attendance marking and end class. The instructor no longer creates the code; the centre does (see Check-in). It also shows today's topic from the course outline.
- **My classes:** the classes an admin assigned to them, grouped by course and centre. It updates live when the roster changes.
- **Schedule:** schedule the next run of a course they teach.
- **History** of classes taught.
- **Messages:** send text and/or an image to the students in a class that is running.

### Coordinator
- Their centre's classes today, each opening a check-in screen where they show the class code and QR, see who was turned away, mark attendance by hand and end the class. The student list shows Active/Unpaid status.
- An "Invite students" QR that opens the app so students can sign up and enrol themselves.

### Centre director
- One account can cover several branches. Switch between them or see all together.
- Dashboard: students by weekday and by course, plus income by month (earned, refunds deducted, adjustments).
- **Income and withdrawals:** a director sees the current and previous month, and older months only while money is still unwithdrawn. Future months are never shown. Each month has an optional withdrawal that opens on its last day. Directors request, and admins approve.
- **Team page:** add and remove coordinators for their centres.

### Admin and super admin
- **Overview:** revenue this month, outstanding balances, student counts (active and unpaid), money owed to centres, classes today, and a prompt when offline payments need review.
- **Users:** instant search, change a user's type, assign one or more branches.
- **Announcements:** build an audience from rules (students, instructors, directors, coordinators, admins or specific people, optionally narrowed by centre and course) with a live recipient count. Sent announcements can be edited or retracted.
- **Manage hub:**
  - **Centres:** locations, teams, revenue share and payout bank accounts. A centre can't be deleted once it has students or payments.
  - **Schedule:** each centre's weekly class days and times, and course runs (start and end dates, up to four months ahead). Cancelling a run notifies the people on it.
  - **Roster:** assign instructors to a single class, to "this and every later class", to a course at one centre, or to a course everywhere. Double-bookings are caught before saving, and instructors are told when they are assigned or replaced.
  - **Course builder:** create and edit courses, set how many classes a course has and the topic and description of each class, and set prerequisites. Courses with history are hidden rather than deleted.
  - **Prices and instalments:** package prices, instalment plans (up to six, each due before the start or before a given course), and per-course single-course prices.
  - **Offline payments:** review cash/transfer claims, view receipts, approve, decline with a reason (optionally removing the registration) or ignore. Admins also edit the bank details students see.
  - **Payments and refunds:** refund a student through Paystack or record a manual refund, optionally cancelling their enrolment.
  - **Payouts:** monthly payments to centres, including withdrawal requests from directors.
  - **Instructors:** classes and students taught per instructor.
  - **Class messages:** read what instructors sent and delete any message.

### Everyone
- Notification bell with a live unread count, and a notifications page showing who each message is from ("IQ Academy" or "Instructor <first name>").
- Profile with photo upload, theme (Light/Dark/System), change password and sign out.
- A public landing page for visitors (see below).

---

## How the main flows work

### Enrolment and payment
1. The student picks a **pack** (a package with a set number of courses), then the **courses**, then a **centre**. The centre step shows when that centre's course starts.
2. They choose **full payment or instalments**, and **online or offline**.
3. **Online:** the app calls the `paystack-init-payment` Edge Function and sends the student to Paystack. They return to `/pay/callback`, where `paystack-verify-payment` confirms the payment.
4. **Offline:** a pending payment with a reference (`OFF-XXXXXXXX`) is saved and the student pays outside the app. They upload a receipt (photos are shrunk to a readable size; PDFs are accepted; maximum 5 MB). An admin approves, which activates the enrolment and sends the usual "Payment received" notification. While an offline registration is open, the student can't register again unless they cancel it. They can also switch to paying online instead.
5. **Instalments lock classes.** A pending instalment locks every course from the one it is due before onward. The first instalment activates the enrolment.

### Dates and times
- **Real time comes from the server.** The app measures the gap between the phone's clock and the server's once at sign-in (`server_now()`), then every ten minutes, and uses the corrected time for "today", check-in windows and "5 min ago". A phone more than two minutes off shows a dismissible notice. Code: `src/lib/time.ts`, `src/components/ClockWatch.tsx`.
- **Everything is shown in centre time (Africa/Lagos), whatever timezone the phone is set to.** The database stores moments as UTC (`timestamptz`) and calendar dates as plain dates, and cuts days and months at Lagos midnight. A class at 9:00 reads 9:00 for everyone. Don't use `new Date()`, `Date.now()` or `toLocale*String` for anything a person sees; use the helpers in `src/lib/time.ts`.
- **Entering a time** (for example an emergency class) is read as the centre's wall-clock time, not the phone's.

### The student clock
A student's clock starts on the day of the first class of their first course, not when they pay. That date drives access, visibility, absences, progress and reminders.

### Check-in
The centre's **coordinator or director** (or an admin) opens check-in on the class screen. That is possible from 30 minutes before the class starts until it ends (`checkin_opens_minutes_before`), and opening it starts the class. They show a short code and QR. The code stops working when the class ends.

Students scan or type it. The server decides if they are entitled to that class: an active registration at the centre for the course, payment up to date, or an allowed make-up class. The student's phone shows a full-screen **green** "You're in" or **red** reason. Every red is logged and shown to door staff under "Turned away", which catches people who aren't entitled and gives them somewhere to be sent. Every green marks the student present. Attendance appears on the class screen in real time, and door staff or the instructor can mark anyone by hand. Ending a class can mark absentees.

### Make-up classes and single-course purchases
- When a student's last class ends, a **make-up window** opens for two months. They may attend up to six make-up classes, and only for classes they missed. Both numbers are stored in `app_settings` (`makeup_window_months`, `makeup_max_classes`).
- Any student can buy one course on its own. Admin sets each course's price, plus a second price for students who haven't completed its prerequisite. The database works out the price, never the browser.

### Emergency classes
An emergency class is a one-off class at a centre that isn't part of any course run. **Instructors** start one for themselves and **admins** start one and choose the instructor (Manage → Emergency classes, or the Emergency class card on an instructor's home). The centre, course, topic (one of the course's classes) and start time all come from dropdowns. Students with an active registration at that centre are notified and can check in whatever course they are on; their attendance counts toward progress only if they are on that course. Centre staff at the centre are notified too, because check-in follows the door rules (centre staff or an admin issue the class code). Nobody is marked absent when it ends, and Roster bulk assignment by course or centre never moves it. The rules live in `create_emergency_class`, `check_in` and `emergency_classes_for_me` (migration 43).

### Class messages
Instructors can message a class only **while it is in progress**, and only students who **checked in with the code or QR** receive it (students marked by hand don't). Students can't reply, edit or delete. Only admins can delete. Images (JPG, PNG, WebP, GIF, up to 10 MB) live in a private bucket and are downloaded through short-lived signed links minted when the student taps. Students can also copy or share a message.

### Money going out
- Each payment books the centre's revenue share.
- A director's available balance per month is earned minus refunds plus adjustments.
- A withdrawal request creates a payout for admin approval. Admins process payouts through the `process-payouts` Edge Function, and bank accounts are verified with `paystack-create-recipient`.

### Reminders
When a course is about to hold its last class with nothing scheduled after it, admins and the instructors who teach it get a reminder to schedule the next run.

### Public landing page
Visitors who aren't signed in see a landing page with rotating headlines, count-up numbers (centres, courses, people trained, calculated from live data on top of a base figure) and Sign in / Get the app buttons. Set `VITE_MOBILE_APP_URL` to point "Get the app" at a store link; until then it opens the web app.

---

## Accounts, passwords and email verification

- **Password fields** everywhere have a show/hide eye.
- **Creating a password** (sign-up, reset, change) shows a live checklist, a strength meter and a **"Suggest a strong password"** button. Requirements: at least 8 characters, a lowercase letter, an uppercase letter, a number, a symbol, and not an easy-to-guess password. Suggestions are 16 characters from the Web Crypto API, with look-alike characters removed.
- **Change password** is a button on the Profile page that opens a modal.
- **Email verification** has its own page, `/verify-email`. After sign-up, or signing in with an unconfirmed email, the user lands there. It shows a three-step guide, a shortcut to their inbox (Gmail, Outlook, Yahoo, iCloud, Proton), resend with a 60-second cooldown, an expired-link state, and a "You're verified" screen once the link is clicked, in this tab or another. The pending email is remembered for 24 hours.
- **Forgot password** emails a link to `/reset-password`. The same page serves the one-time setup link for new staff accounts.
- Signing out returns visitors to the root, so the next sign-in always opens the dashboard.
- **Header:** logo, notification bell and a hamburger menu. The menu is a slide-in drawer with the profile card (tap it to open Profile), role navigation and shortcuts. Theme, photo and sign out live on the Profile page.

---

## Routes

**Signed out:** `/` (landing), `/login`, `/reset-password`, `/verify-email`. Anything else redirects to `/`.

**Signed in:**

| Route | Purpose |
| --- | --- |
| `/` | Home for the user's top role |
| `/enrol`, `/pay/callback`, `/pay/offline/:id` | Enrolment, Paystack return, offline payment details and receipt |
| `/messages` | Student class chat or instructor composer (other roles are redirected) |
| `/notifications` | Notification list |
| `/profile` | Profile, theme, password, sign out |
| `/class/:id` | Live class screen |
| `/my-classes`, `/history` | Instructor: assigned classes, past classes |
| `/schedule` | Class days and course runs (everyone except students) |
| `/team`, `/team/:centreId` | Centre team |
| `/users`, `/announce` | Admin: users, announcements |
| `/manage` | Admin hub |
| `/centres`, `/roster`, `/courses`, `/courses/:id`, `/prices`, `/payments`, `/offline-payments`, `/payouts`, `/instructors`, `/class-messages` | Admin pages |

A few routes are also guarded in the browser (`/roster` and `/class-messages` for admins, `/my-classes` for instructors, `/messages` and `/schedule` by role). Everywhere else, the **database is the gatekeeper**: row-level security and the RPCs refuse anything the user shouldn't do, and the app shows a readable "you don't have permission" message.

---

## How the code is organised

```
src/
  main.tsx              App entry: Router, FeedbackProvider, AuthProvider
  App.tsx               Routes, header, tab bar, role-based navigation
  pages/                One file per screen (Landing, Login, Enrol, StudentHome,
                        InstructorHome, ClassScreen, DirectorHome, AdminHome, Roster, ...)
  components/
    ui.tsx              Button, Card, Field, Sheet (portalled), Badge, Avatar, Skeleton
    feedback.tsx        run() saving overlay, confirm() dialog, toast()
    NavMenu.tsx         Hamburger drawer
    PasswordFields.tsx  PasswordField, PasswordCreator, checklist, strength meter
    QrScanner.tsx, CourseOutline.tsx, MakeupCard.tsx, SoloCourses.tsx,
    SoloPrices.tsx, ClassComposer.tsx, MessageBubble.tsx, RunReminder.tsx, Place.tsx
  lib/
    supabase.ts         Client, naira(), friendly() error messages, UserMessage
    auth.tsx            AuthProvider, roles, primaryRole, live role updates
    db.ts               ok(), touched(), mapDuplicate(), sleep()
    messages.ts         Class-message helpers, download/share/copy, unread hook
    offline.ts          Receipt preparation and upload
    password.ts         Rules, strength and secure generator
    verify.ts           Pending-verification memory and inbox links
    theme.ts            Light/Dark/System preference
    centre.ts           Location-first labels ("Okota" before "Brainstorm Academy")
supabase/migrations/    SQL for the schema changes from migration 19 onward
```

### Conventions worth keeping
- **Every change goes through `run()`.** It shows the full-screen "Saving…" overlay with the pulsing app icon, holds it long enough to be seen, and turns any failure into a toast (or inline message). Deletes and other irreversible actions go through `confirm()` first.
- **Friendly errors.** Database functions raise short error keys (`cohort_full`, `payment_required`, `withdraw_not_open`, ...). `friendly()` in `lib/supabase.ts` maps each one to plain English. Add a line there whenever you add a key in SQL.
- **Silent no-ops are errors.** Supabase reports success when row-level security blocks an update. `touched()` in `lib/db.ts` turns a zero-row update or delete into a `not_saved` error, so a save the database ignored is never shown as saved.
- **Rules live in the database.** Prices, eligibility, access locks, make-up limits and withdrawal windows are computed by Postgres functions, not by the browser.
- **Location first.** Students think in places, so `lib/centre.ts` leads with the city or address and puts the facility name second.
- **Realtime** is used for the notification bell and page, role changes, the live attendance roster, an instructor's assigned classes, and class messages with their unread badge.

---

## Backend: database, functions and storage

### Migrations
`supabase/migrations/` holds the SQL for changes from **19 onward** (pricing admin, centre class days and course runs, course builder, first-class clock, make-up and single-course purchases, sender labels and class messages, offline payments, admin create/edit/delete, editable announcements, director income months and withdrawals, roster). Files are numbered in the order they were written. Some were recorded in the live database under a different number, which is noted at the top of each file (for example `34_offline_payments.sql` is recorded as `31_offline_payments`), and there is no file 31 in this repo.

The base schema (migrations before 19) and the Edge Function source are not in this repository. According to the earlier README they live in the `iq-academy-db` project. Apply migrations to a project that already has that base schema.

### Edge Functions the app calls
`paystack-init-payment`, `paystack-verify-payment`, `paystack-create-recipient`, `process-payouts`, `process-refund`. New-staff setup links come from a `create-staff-user` function mentioned in the earlier README; it is not called from this front end.

### Storage buckets
| Bucket | Used for |
| --- | --- |
| `avatars` | Profile photos |
| `payment-receipts` | Offline payment receipts (private, signed links for viewing) |
| `class-messages` | Images sent to classes (private, signed links minted on tap) |

### Main data areas
Centres and their class days, courses with outlines and prerequisites, packages with instalment plans, course runs and class sessions, enrolments and instalments, attendance, payments and refunds, payouts, notifications and broadcasts, class messages, and `app_settings` for tunable numbers. Reports such as session details and student/lesson progress are exposed as views.

---

## Getting started

Requirements: Node.js 18 or newer, and a Supabase project with the base schema, migrations and Edge Functions in place.

```bash
npm install
cp .env.example .env     # then fill in your Supabase values
npm run dev              # http://localhost:5173
```

| Variable | Required | Purpose |
| --- | --- | --- |
| `VITE_SUPABASE_URL` | yes | Your project URL |
| `VITE_SUPABASE_ANON_KEY` | yes | The public anon key |
| `VITE_MOBILE_APP_URL` | no | Store/download link for the landing page "Get the app" button |

If the two required variables are missing, the app shows a setup message instead of a blank page.

| Script | What it does |
| --- | --- |
| `npm run dev` | Start the dev server |
| `npm run build` | Type-check (`tsc --noEmit`) and build to `dist/` |
| `npm run preview` | Serve the production build locally |

---

## Deploying

1. Push the repo to GitHub, then in Vercel choose **Add New Project** and import it. Vite is detected automatically.
2. Add `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` (and optionally `VITE_MOBILE_APP_URL`) as environment variables.
3. Deploy. `vercel.json` rewrites app routes to `index.html` and caches built assets for a year.
4. Use the same site URL in Supabase Auth settings and as `SITE_URL` in the Edge Function secrets.

---

## Supabase configuration checklist

- **Auth → URL Configuration:** set **Site URL** to your Vercel URL. Under **Redirect URLs** add the site root, `/reset-password`, and `http://localhost:5173/**` for local work. Email confirmation links redirect to the site root.
- **Auth → Providers → Email:** turn on email confirmation and set the **minimum password length to 8 or more**, so the server is never looser than the app's checklist. Supabase won't enforce the uppercase/lowercase/number/symbol rules unless you configure them there too.
- **Auth → SMTP:** add your own mail provider for real volume. The built-in sender is heavily rate limited, which also limits resend emails.
- **Edge Function secrets:** `SITE_URL`, plus your Paystack keys as the functions expect.
- **Realtime:** enable it for `notifications`, `user_roles`, `class_sessions`, `attendance` and `class_messages`.
- **Storage:** the three buckets above, with the policies from the migrations.

---

## Branding

- The app icon source is `public/favicon.png`. `icon-192.png`, `icon-512.png`, `icon-maskable-512.png`, `apple-touch-icon.png` and `favicon-32.png` are resized from it, so regenerate them if you change it.
- The header shows the icon with the word "Academy" sized to match the "IQ" mark inside the icon.
- The accent colour lives in `src/index.css` (`--accent`, light and dark). Surfaces, text and status colours are CSS variables there too.
- `public/manifest.webmanifest` makes the app installable to a phone's home screen. There is no service worker, so it does not work offline.

---

## Known limits

- **Staff accounts for new people:** coordinators can't yet register a student on their behalf; students create their own account (the invite QR makes that quick).
- **Backend lives elsewhere:** the base schema and Edge Function source are outside this repo, so a fresh Supabase project can't be fully set up from this repository alone.
- **No automated tests** are included; `npm run build` type-checks the code.
- **Bundle size:** the production build is a single large chunk (Vite warns about this). Code-splitting by route is a straightforward next step.

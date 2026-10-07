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
- **Class channels:** every class a student was checked in to (by scan or by hand) has a channel with the instructor's messages, open during and after the class. It closes for the student when their cohort ends: the channel stays in the list, marked Closed, but its messages can't be opened. Copy and share on a message stop working two hours after it arrives.
- **Review a class** once it has ended: stars, an honest comment, and an optional report about the instructor (admins only). Prompted on the home screen and in the class channel.
- **Check-in PIN:** four digits, chosen on a numeric keypad and typed twice before it is saved. It is **required after a student's first successful payment**: the app blocks until it is set. It is used when someone has to check the student in by hand. Changing it on the Profile page needs the account password typed twice. The PIN is stored only as a hash, so nobody (staff or admin) can read it. The registration number is also shown on the Profile page. Only students have one: it is not shown to staff or admins.
- **"That wasn't me":** every hand check-in sends the student a notification saying who did it. The button undoes the check-in and alerts the admins.
- Can cancel an unpaid registration from the home screen.

### Instructor
- **Today:** the day's classes plus stats (classes taught, students taught, average per class, all time).
- **Live class screen:** a real-time attendance roster, manual attendance marking and end class. The instructor no longer creates the code; the centre does (see Check-in). It also shows today's topic from the course outline.
- **My classes:** the classes an admin assigned to them, grouped by course and centre. It updates live when the roster changes.
- **Schedule:** schedule the next run of a course they teach.
- **History** of classes taught.
- **Class channel:** send text and files to the students of a class from check-in onward. The channel stays open after the class ends, for as long as the instructor wants it. Messages can be selected and sent on to other class chats; they arrive as ordinary new messages from the instructor.
- **Ending a running class early** needs a reason. The class is kept (completed, with its chat), not cancelled.
- **Door PIN:** to check a student in by hand (on a class they teach), or to show the class code of a custom class they run, the instructor first types their own 4-digit door PIN (see Check-in).

### Coordinator
- Their centre's classes today, each opening a check-in screen where they show the class code and QR, see who was turned away and mark attendance by hand. The student list shows Active/Unpaid status. The "next class" countdown and the class-start reminders are theirs. **Door work (the class code, checking students in) belongs to the coordinator, not the centre director.**
- A student list (name, photo, bundle, Active/Unpaid, no amounts) and a read-only Classes & staff page.
- An "Invite students" QR that opens the app so students can sign up and enrol themselves.
- **Door PIN:** before showing the class code / QR or checking a student in by hand, the coordinator types their own 4-digit door PIN (see Check-in). They choose it the first time they open check-in, or on their Profile page.

### Centre director
- One account can cover several branches. Switch between them or see all together.
- **Home:** income by month (earned, refunds deducted, adjustments), active students, students by course, average attendance by weekday (last 8 weeks, from classes actually held), recent refund deductions and payouts.
- **Income and withdrawals:** a director sees the current and previous month, and older months only while money is still unwithdrawn. Future months are never shown. Each month has an optional withdrawal that opens on its last day. Directors request, and admins approve.
- **Students:** name, registration number, photo, bundle (6 or 10 weeks), courses, Active/Unpaid/Completed, classes attended out of total, and amount paid against the bundle price. Search and filter by bundle and status.
- **Classes & staff:** who teaches which class at the centre (past two weeks and next three), plus the instructors, coordinators and directors on site. Read-only.
- **Statements:** every ledger line behind a month's balance (payment reference, share % and base amount, never student names). Each closed month is frozen automatically on the 1st with a checksum.
- **Alerts:** a notification for every payment, every refund that affects the share, and every new enrolment (name and bundle).
- **Team page:** add and remove coordinators for their centres.
- **Navigation:** a bottom bar with Home, Students, Classes, Statement and Team. The dashboard no longer repeats those links; the director pages (Students, Classes & staff, Statements, My team) use compact list rows and keep every figure fully visible on a small phone.
- **No contact details.** Directors never receive email, phone, birth date, address, emergency contact or notes. The database enforces this: centre staff have no direct read access to `profiles`, `students` or `enrolments`; they get students only through the `centre_students` function, which returns the fields above. Money columns are returned to directors and admins, not coordinators.
- Door work (the class code, checking students in) belongs to the coordinator, not the director. The database enforces this too (a director cannot mark attendance).

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
  - **Hand check-ins:** every check-in done by hand, who did it, PIN or admin override, per-person totals, and the ones students disputed.
  - **Class reviews:** read every review, see who reported an instructor, and pick up to ten reviews (never a reported one) to show on the landing page.

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
- **Entering a time** (for example a custom class) is read as the centre's wall-clock time, not the phone's.

### The student clock
A student's clock starts on the day of the first class of their first course, not when they pay. That date drives access, visibility, absences, progress and reminders.

### The class clock
Classes run themselves. Nobody presses Start or End. A scheduler function, `private.class_clock_tick()`, runs every minute from `pg_cron` (job `iqa-class-clock`, migration 45) and does four things from each class's own start and end times:

| When | What happens |
| --- | --- |
| 60 minutes before the start (`class_reminder_minutes_before`) | Students on the class, its instructor and the centre's coordinators each get one notification. Sent once (`class_sessions.reminder_sent_at`). |
| 30 minutes before the start (`checkin_opens_minutes_before`) | The check-in code is created automatically. It expires at the class's end time. |
| At the start | The class becomes `in_progress`. |
| At the end | The class becomes `completed`, the code is deleted, absentees are logged and the head count is refreshed. |

It works from timestamps rather than exact minutes, so a late or missed run catches up on the next one, and every step is safe to repeat. It only auto-completes classes that ended within `class_clock_catchup_hours` (default 12), so it never rewrites old attendance. A failure on one class is logged as a warning and doesn't stop the others. `check_in()` still checks the time window itself, so a late run can never let someone in outside it.

**Countdown.** Students, instructors and coordinators see a countdown card on their home screen (`ClassCountdown`, `lib/classClock.ts`). It shows days and hours when the class is more than a day away, then hours, minutes and seconds. While check-in is open the door shows as open. During a class it counts down to the end, and the moment the class ends it starts counting to the next one. It reads the server-corrected clock and the class's timestamps (never a decrementing counter), so a phone that sleeps is right the moment it wakes, and the card flips on time even if the scheduler is a few seconds late. `my_class_clock()` decides which classes belong to the caller, using the same roster rule as absentee logging.

### Check-in
The class code and QR appear on the class screen for the centre's **coordinator** (or an admin) when check-in opens, with a full-screen view for showing at the door. There is nothing to press, and no manual Start or End button. The code stops working when the class ends. "New code" is still there if a code needs replacing.

Students scan or type it. The server decides if they are entitled to that class: an active registration at the centre for the course, payment up to date, or an allowed make-up class. The student's phone shows a full-screen **green** "You're in" or **red** reason. Every red is logged and shown to door staff under "Turned away", which catches people who aren't entitled and gives them somewhere to be sent. Every green marks the student present. Attendance appears on the class screen in real time, and door staff or the instructor can mark anyone by hand. **Before the class code is shown, and before anyone is checked in by hand, a coordinator (or the instructor of a custom class or a class they teach) types their own door PIN.** Admins are not asked. The door PIN is separate from a student's check-in PIN; it is stored only as a hash, changing it needs the account password typed twice, and five wrong tries pause it for 15 minutes. Unlocking lasts five minutes (`DOOR_UNLOCK_MS` in `lib/doorLock.ts`) and ends sooner if the app goes to the background, the page reloads or the user signs out. **Marking someone present by hand then needs the student's own PIN**, typed by the student on the staff member's phone (shown as dots), and **only works while check-in is open**: from 30 minutes before the class starts (when the class code unlocks) until it ends. It is checked on the server, for admins too. Someone who is already present is never re-checked in: the server answers "already checked in" and no PIN is accepted or needed. Five wrong PINs pause hand check-in for that student for 15 minutes. An **admin** can instead check a student in with a written reason (the only way for a student who has no PIN); it is logged as an admin override. Every hand check-in is recorded, the student is notified at once and can dispute it, and admins review them under Manage → Hand check-ins. Absent and excused need no PIN.

### Make-up classes and single-course purchases
- When a student's last class ends, a **make-up window** opens for two months. They may attend up to six make-up classes, and only for classes they missed. Both numbers are stored in `app_settings` (`makeup_window_months`, `makeup_max_classes`).
- Any student can buy one course on its own. Admin sets each course's price, plus a second price for students who haven't completed its prerequisite. The database works out the price, never the browser.

### Custom classes
A custom class is a one-off class that isn't part of any course run (a make-up, revision, practical or weekend class, and so on). **Instructors** create one for themselves from the menu (Custom class) and **admins** create one and choose the instructor (Manage → Custom classes). It is deliberately not on the instructor's dashboard. The centre (where it is held), course, topic (one of the course's classes) and start time come from dropdowns.

**Who can attend is decided by invitation. This is deliberate: do not make it depend on the centre and do not make it automatic.** Custom classes cut across centres, courses and course runs, and only the instructor knows who belongs. The instructor invites students by searching for a name, or adds a group: a centre, a course or a course run, in any mix. A student needs an active registration somewhere to be invited (attendance needs one), but it can be at any centre; attendance is recorded against their registration that includes the course, otherwise their newest active one. The centre on the class is only where it is held.

- Invited students are notified, and told again if they are removed or the time, place, course or topic changes. Cancelling tells the invited students only.
- The instructor can edit the class and add or remove students until 30 minutes before it starts (`app_settings.custom_class_edit_lock_minutes`, default 30). Admins can change it until it ends. The database enforces this, not just the screen.
- Check-in is the normal door check-in, with the class clock's code from 30 minutes before the start. Centre staff, admins and the instructor teaching the class can read it; invited students scan or type it from their home screen. A student who wasn't invited sees "Not invited"; one whose registration is unpaid sees "Payment due". Attendance counts toward progress only if the student is on that course. Nobody is marked absent when it ends, and Roster bulk assignment never moves it.
- Reminders, the instructor's "students expected" count and the dashboard countdown all follow the invitations, through `private.session_students()`. Anything new that needs "who is in this class" should use it.
- Naming: it is a "custom class" everywhere users see it, but the database still calls the flag `is_emergency` (the name is historic and views depend on it). The rules live in `create_custom_class`, `edit_custom_class`, `custom_classes_for_me`, `search_students_for_custom_class` and `check_in` (migration 47; it replaced migrations 43 and 46's emergency classes).

Students also see where they are registered: the centre's town, name and address under their greeting on the home screen and on their profile.

### Class channels
Each class has a channel. It exists for every student who was **checked in, however they were checked in** (scan, centre staff, instructor or admin), and for the class's instructor. Instructors and admins post; students can't reply, edit or delete, and only admins can delete. Files of any type (up to 25 MB) live in a private bucket and are downloaded through short-lived signed links minted when someone taps.

- **Open after class.** A channel stays open when the class ends, including when the instructor ended it early.
- **Cohort lock.** When the class's course run ends (for a custom class, the student's registration end date), students keep seeing the channel but can no longer read its messages or open its files. This is enforced by row-level security and in the RPCs. Instructors and admins are never locked out.
- **Copy and share** are offered to students only for two hours after a message arrives. This is a rule in the app, not in the database.
- **Ending a running class early** (`end_class_early`) needs a reason, 5 to 300 characters, kept on the class and shown on its screen.

### Class reviews
After a class ends, a student who attended can review it once: 1 to 5 stars, an optional comment, and an optional report about the instructor (with a reason). Reviews can't be edited. Admins see all of them under Manage → Class reviews; instructors don't. Admins choose up to **10** to show on the landing page as swipeable cards (name, photo, stars, words, date). A review that reports an instructor, or has no written comment, can't be featured. The review form tells students their name and photo may be shown.

### Money going out
- The centre's share is calculated on the full payment (Paystack fees are not deducted) at the rate in force when the payment was made, and that rate is stored on the ledger line. Changing a centre's percentage affects only future payments; refunds reverse at the original rate.
- The ledger is append-only (updates and deletes are blocked by trigger). `private.close_month_statements()` runs from `pg_cron` (job `iqa-close-month-statements`, 00:10 UTC on the 1st) and stores one frozen row per centre per month in `centre_statements`.
- Each payment books the centre's revenue share.
- A director's available balance per month is earned minus refunds plus adjustments.
- A withdrawal request creates a payout for admin approval. Admins process payouts through the `process-payouts` Edge Function, and bank accounts are verified with `paystack-create-recipient`.

### Reminders
One hour before each class, the class clock (above) reminds the class's students, its instructor and the centre's staff. Notifications appear in the bell and the notifications page. Other reminders run daily from `iqa-class-reminders` and `iqa-run-reminders`.

When a course is about to hold its last class with nothing scheduled after it, admins and the instructors who teach it get a reminder to schedule the next run.

### Public landing page
Visitors who aren't signed in see a landing page with rotating headlines, count-up numbers (centres, courses, people trained, calculated from live data on top of a base figure) and Sign in / Get the app buttons. Below the numbers, the reviews an admin picked appear as cards visitors can swipe through (hidden when none are picked). Set `VITE_MOBILE_APP_URL` to point "Get the app" at a store link; until then it opens the web app.

---

## Accounts, passwords and email verification

- **Password fields** everywhere have a show/hide eye.
- **Creating a password** (sign-up, reset, change) shows a live checklist, a strength meter and a **"Suggest a strong password"** button. Requirements: at least 8 characters, a lowercase letter, an uppercase letter, a number, a symbol, and not an easy-to-guess password. Suggestions are 16 characters from the Web Crypto API, with look-alike characters removed.
- **Change password** is a button on the Profile page that opens a modal.
- **Email verification** has its own page, `/verify-email`. After sign-up, or signing in with an unconfirmed email, the user lands there. It shows a three-step guide, a shortcut to their inbox (Gmail, Outlook, Yahoo, iCloud, Proton), resend with a 60-second cooldown, an expired-link state, and a "You're verified" screen once the link is clicked, in this tab or another. The pending email is remembered for 24 hours.
- **Forgot password** emails a link to `/reset-password`. The same page serves the one-time setup link for new staff accounts.
- Signing out returns visitors to the root, so the next sign-in always opens the dashboard.
- **Phones (under 1024px):** logo, notification bell and the user's **avatar** (opens Profile) at the top, role tabs at the bottom. Tabs: student Home / Messages / Enrol; instructor Today / My classes / Schedule / History / Messages; coordinator Home / Students / Classes; centre director Home / Students / Classes / Statement / Team; admin Overview / Users / Announce / Manage. The **hamburger** appears only for a role that has links neither the tabs nor its own pages reach: today that is the instructor's "Custom class" (`MENU_EXTRA` in `lib/nav.ts`). Theme, photo, password and sign out live on the Profile page. Add a link to a tab or a page rather than duplicating it in the drawer.
- **Desktop (1024px and up):** a persistent left sidebar replaces the header, hamburger and tab bar. It is built from `lib/nav.ts` (`SIDEBAR`), so each role sees all of its destinations at once; for admins the Manage hub is spread into Classes, Money and People & places groups, with live badges (unread messages, offline payments, notifications). It collapses to an icon rail with tooltips (button or the `[` key), remembers the choice, and starts collapsed below 1280px. Only one shell is mounted at a time (`useDesktop()`), so realtime subscriptions are never doubled. Content is centred and width-limited per route (`pageWidth()` in `lib/nav.ts`: forms stay narrow, dashboards and lists go wide). Dashboards use `Split`/`Main`/`Rail` from `ui.tsx`, which is one column on phones and a main column plus side rail on desktop. Messages is a two-pane inbox (channel list, chat). Anything `fixed` to the bottom of a page uses `lg:left-[var(--sbw)]` to stay clear of the sidebar.
- **System bars (status bar, gesture/navigation area).** The page paints behind them (`viewport-fit=cover`), so they must be the theme colour. What each platform reads: Android Chrome and Safari up to 18 read `<meta name="theme-color">` (kept in step by `lib/theme.ts`, with the right value on first paint from the script in `index.html`); **Safari 26 ignores that tag** and tints its bars from a full-width, opaque `position: fixed` element at the top and bottom edge (the sticky header and the tab bar are solid `bg-bg` for this reason), else from `<body>`; the strips in `BarCaps` (App.tsx) cover the status bar and gesture area exactly, so scrolling content never shows through them. Rules to keep: safe-area insets belong on the bars themselves (never only on `<body>`, which scrolls away and leaves a sticky header under the clock); keep the header and tab bar opaque; do not leave empty full-width `fixed` layers on the top or bottom edge (the toast layer only exists while a toast is showing); and sticky offsets under the header use `calc(3.5rem + env(safe-area-inset-top))`. iOS home-screen apps draw their own status bar and cannot follow the in-app theme.

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
| `/centres`, `/roster`, `/courses`, `/courses/:id`, `/prices`, `/payments`, `/offline-payments`, `/payouts`, `/instructors`, `/class-messages`, `/reviews`, `/check-ins` | Admin pages |

A few routes are also guarded in the browser (`/roster`, `/class-messages`, `/reviews` and `/check-ins` for admins, `/my-classes` for instructors, `/messages` and `/schedule` by role). Everywhere else, the **database is the gatekeeper**: row-level security and the RPCs refuse anything the user shouldn't do, and the app shows a readable "you don't have permission" message.

---

## How the code is organised

```
src/
  main.tsx              App entry: Router, FeedbackProvider, AuthProvider
  App.tsx               Routes, header, tab bar, role-based navigation
  pages/                One file per screen (Landing, Login, Enrol, StudentHome,
                        InstructorHome, ClassScreen, DirectorHome, AdminHome, Roster, ...)
  components/
    ui.tsx              Button, Card, Field, Sheet (portalled), Badge, Avatar, Skeleton, plus the layout pieces
                        every screen shares: PageHeader, Section, List + NavRow, IconTile, Stat, Empty
    feedback.tsx        run() saving overlay, confirm() dialog, toast()
    NavMenu.tsx         Hamburger drawer (only for links that are in no tab; see MENU_EXTRA)
    DoorPinSheet.tsx    Asks staff for their door PIN (or sets it the first time)
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
    theme.ts            Light/Dark/System preference and system-bar colour
    nav.ts              Phone tabs, hamburger extras, desktop sidebar sections, per-route page width
    doorLock.ts         Door-PIN unlock state (in memory, five minutes) and who has to enter one
    useMedia.ts         Media-query hook; useDesktop() is the 1024px switch
    notifications.ts    Live unread-notification count (bell and sidebar)
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
`supabase/migrations/` holds the SQL for changes from **19 onward** (pricing admin, centre class days and course runs, course builder, first-class clock, make-up and single-course purchases, sender labels and class messages, offline payments, admin create/edit/delete, editable announcements, director income months and withdrawals, roster, door check-in, time calibration, the class clock, class channels, end-class reasons and the cohort lock, class reviews, hand check-in by student PIN with a dispute button and an admin audit, the hand check-in window, with door work moved from directors to coordinators, centre visibility, and the staff door PIN, migration 55). Files are numbered in the order they were written. Some were recorded in the live database under a different number, which is noted at the top of each file (for example `34_offline_payments.sql` is recorded as `31_offline_payments`), and there is no file 31 in this repo.

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
- The accent colour lives in `src/index.css` (`--accent`, light and dark). Surfaces, text and status colours are CSS variables there too: green (`ok`), blue (`info`), amber (`warn`) and red (`bad`). Use them sparingly, as a soft tint on a badge, icon tile or stat dot, so the amber/cream brand stays the main colour.
- `public/manifest.webmanifest` makes the app installable to a phone's home screen. There is no service worker, so it does not work offline.

---

## Known limits

- **Screenshots can't be blocked from a web app.** A browser gives a page no way to stop screenshots or screen recording. Blocking them needs a native wrapper (for example Capacitor, with Android's secure-window flag and the matching iOS handling). The copy/share limit on class messages stops the app's own buttons, not a photo of the screen.
- **The door PIN gate is enforced in the app.** The PIN itself is checked on the server (`verify_staff_pin`, with a lockout), but whether the code or the hand check-in is hidden until it is typed is decided by the app. A person calling the database functions directly could skip the prompt. Making `mark_attendance` and `generate_checkin_token` require a recent successful `verify_staff_pin` would close that.
- **A PIN can be watched.** A staff member who sees a student type their PIN could reuse it. The defences are that the student is notified of every hand check-in, can undo it with one tap, and that admins can see who does many or disputed check-ins. A student with no PIN can only be checked in by an admin, with a reason. The PIN gate is enforced in the app; hand check-in itself is enforced in the database.
- **Reminders are in-app only.** They appear in the notification bell and page, so someone who never opens the app won't see them. Phone push (Web Push) needs a service worker and a send function and isn't built yet. The reminders are ordinary rows in `notifications`, so a push sender can be added without changing how they are created.
- **The class clock needs `pg_cron`.** If the extension is off, migration 45 prints a notice instead of scheduling the job. Check `select * from cron.job where jobname = 'iqa-class-clock'`.
- **Staff accounts for new people:** coordinators can't yet register a student on their behalf; students create their own account (the invite QR makes that quick).
- **Backend lives elsewhere:** the base schema and Edge Function source are outside this repo, so a fresh Supabase project can't be fully set up from this repository alone.
- **No automated tests** are included; `npm run build` type-checks the code.
- **Bundle size:** the production build is a single large chunk (Vite warns about this). Code-splitting by route is a straightforward next step.

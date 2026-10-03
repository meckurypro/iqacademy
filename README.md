# IQ Academy — Web App (phase 1)

React + Vite + TypeScript + Tailwind, talking to the Supabase backend in `iq-academy-db`.

## Run locally
```
npm install
cp .env.example .env      # add your Supabase URL + anon key
npm run dev
```

## Deploy on Vercel
1. Push this folder to GitHub → Vercel → *Add New Project* → import it (framework: Vite is auto-detected).
2. Add environment variables: `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`.
3. Deploy. `vercel.json` already handles single-page routing.
4. Set the same site URL as `SITE_URL` in the Supabase Edge Function secrets, and under Supabase → Auth → URL Configuration.

## Your icon
The app icon is `public/favicon.png`; `icon-192.png`, `icon-512.png`, `icon-maskable-512.png`, `apple-touch-icon.png` and `favicon-32.png` are resized from it.
The accent colour lives in `src/index.css` (`--accent`, light and dark): set it to a colour from your icon.

## What's in phase 1
Sign in / sign up, light/dark theme, notification bell (live), role-based home, **student enrolment** (centre → cohort → pack → courses with
prerequisite locking → full/instalment → Paystack), payment confirmation page, student home (next class, pay next instalment,
check in with the class code, progress).

## Screens (all phases)
- **Student:** sign in/up, step-by-step enrolment with Paystack, home (next class, pay next instalment, progress), check-in by camera QR or typed code.
- **Instructor:** today + stats, live class screen (code + QR, real-time roster, manual attendance, end/cancel), teaching history.
- **Coordinator:** centre roster, today's classes, invite-students QR.
- **Centre director:** team page (add/remove your coordinators), one account for several branches (switch branch or see all together), monthly earnings, refunds deducted, balance owed, students by day and course, payouts.
- **Admin:** overview, Users (instant search, change user type, assign one or more branches), announcements (audience builder + preview), centres (revenue share, bank account),
  cohorts and weekly timetable (assign instructors, create classes), payments and refunds (Paystack transfer or manual, with enrolment cancel option), payouts, centre teams (directors), instructors summary.
- **Students:** also see their refunds and status.
- **Everyone:** profile + avatar upload, light/dark theme, live notification bell.

## Password reset
"Forgot password?" on the sign-in screen emails a link to `/reset-password`, where the user picks a new one (also used by the one-time setup link
the `create-staff-user` function returns for new staff). Signed-in users can change it from Profile.
**Required:** in Supabase → Auth → URL Configuration, set Site URL to your Vercel URL and add `https://YOUR-APP.vercel.app/reset-password`
and `https://YOUR-APP.vercel.app` under Redirect URLs (also add `http://localhost:5173/**` for local testing).
For real emails at volume, add your own SMTP provider in Supabase → Auth → SMTP (the built-in sender is heavily rate limited).

## Sign-up, passwords and email verification
- Every password field has a show/hide toggle. New passwords (sign-up, reset, profile) show a live checklist and strength meter, plus a "Suggest a strong password" button (16 characters, generated with the Web Crypto API).
- After sign-up (or signing in with an unconfirmed email) users land on `/verify-email`: inbox shortcut, resend with a 60s cooldown, expired-link handling, and a "you're verified" screen once confirmed.
- Supabase → Auth → Providers → Email: set the minimum password length to 8 (or higher) so the server is never looser than the checklist.
- The confirmation link redirects to the site root, which is already in your Redirect URLs.
- Header: notification bell + hamburger menu. Theme (light/dark/system), photo and sign out live on the Profile page.

## Before going live
- Regenerate the resized icons in `public/` if you change `favicon.png`.
- Enable email confirmation settings and add your Vercel URL in Supabase Auth → URL Configuration.
- "Register a student on their behalf" (coordinator) needs a backend lookup function and is not included.

# Instructor wallet, earnings ledger and withdrawals

Status legend used below: **built** (in the repo and live in Supabase), **tested** (actually executed), **needs config** (waits for a secret).

## What it does
Student pays → the course gets a slice of the base tuition → a class is finished and attendance is final → each attended student earns the instructor 20% of that class's slice → the amount lands in the instructor's ledger → after the month ends the instructor withdraws → an admin approves → Paystack pays → the webhook confirms.

## Rules (and where they came from)
| Rule | Source |
|---|---|
| Instructor share 20% (`app_settings.instructor_share_bp = 2000`), copied onto every earning so later changes never rewrite history | stated |
| Centre share is per centre and untouched | stated |
| Pack courses are equal-priced: base ÷ number of courses, spare kobo to the earliest courses | stated |
| Instalment premium (plan total − `packages.price_full`) belongs to IQ Academy: instructors are paid from the base only | stated |
| Cash recorded by a coordinator lets the student attend, so it counts as paid for instructors | stated |
| One-off/custom classes (`is_emergency`) never earn | stated |
| Attended classes are not refundable | stated (**not yet enforced in the refund screens**, see Limitations) |
| Instructors and directors save their own bank account (bank list and account name come live from Paystack) | stated |
| A class's tuition share = course slice ÷ `courses.total_sessions`. The count comes from the course, not from rows in `class_sessions`, because sessions are generated about 4 weeks ahead | inferred |
| Earn only when the class is `completed` **and** its check-in grace (`checkin_grace_minutes_after_end`, 30 min) has passed, because students can still scan in after the instructor ends the class | inferred |
| Funding guard: net earnings of an enrolment can never exceed 20% × min(base, net collected). The premium counts as the last money paid. Anything above waits in `instructor_pending_earnings` and moves into the ledger when more is collected | inferred |
| A lesson is paid once per enrolment even if attended in a make-up run | inferred |
| Withdrawals open on the last day of the month (existing `withdraw_opens_days_before_month_end`, Africa/Lagos). One wallet: the whole eligible balance (all closed months) is withdrawn at once; older months stay withdrawable | inferred |
| Classes completed before the feature went live never earn (`instructor_earnings_since`) | requirement |

## Worked example
STANDARD pack, paid in full ₦50,000, 2 courses → each course slice ₦25,000. AI Foundations has 6 classes → ₦4,166.67 per class → 20% = ₦833.33 per attending student. Shares are cumulative floors so the 6 add up to exactly ₦5,000 (83,333 · 83,333 · 83,334 · 83,333 · 83,333 · 83,334 kobo). 12 students present at class 3 → 12 earnings rows.
Instalments, 30,000 + 25,000 = 55,000 for the same pack: base is still 50,000 (premium 5,000 is IQ's). After only the first instalment 30,000 is collected, so the cap is 6,000; course 1 can earn at most 5,000, which fits.

## Data model (migrations 61–63)
- `instructor_ledger_entries` — append-only (update/delete/truncate blocked). Types: `earning`, `earning_reversal`, `earning_restore`, `adjustment`, `withdrawal` (reserve, negative), `withdrawal_release` (positive). Unique: one earning per (session, enrolment); each entry can be reversed once; one reserve and one release per withdrawal.
- `instructor_pending_earnings` — earned but not yet funded.
- `instructor_session_posts` — one row per finished class once posted (exactly-once marker).
- `instructor_earning_errors` — anything that failed, visible to admins, retried by the sweep.
- `instructor_withdrawals` — `draft → processing → paid`, or `rejected / cancelled / failed`. One open request per instructor (partial unique index).
- `instructor_payout_accounts` — Paystack recipient code, bank, account name, last 4 digits, `name_match`.

Definitions: **balance** = sum of all ledger entries. **Available** = sum of entries whose `period_month` ≤ the latest open month. **Reserved** = amount of withdrawals in `draft`/`processing`. **Paid out** = withdrawals in `paid`. **Lifetime** = earnings + reversals + restores + adjustments. **Unfunded** = pending earnings.

## Flow in the database
- `private.post_due_session_earnings()` runs every 10 minutes (cron `iqa-post-instructor-earnings`) and posts every finished class past its grace. It covers all three completion paths (`complete_session`, `end_class_early`, `auto_close_overdue_sessions`) because they all end in `status = 'completed'`. It does not change those functions.
- Trigger `trg_attendance_earnings`: attendance changed after posting (dispute, correction, delete) → a reversal or restore entry, never an edit.
- Trigger `trg_payments_instructor_release`: a payment or refund changes → pending earnings are released as far as the collected money allows.
- Both triggers log failures to `instructor_earning_errors` instead of blocking attendance or payments.
- `request_instructor_withdrawal()` locks the instructor, reserves the money in the same transaction and notifies admins. `reject/cancel/fail` release it exactly once. `handle_transfer_event` (the webhook's router) now also settles instructor references; a repeated event does nothing, and `transfer.reversed` after `paid` returns the money.

## Paystack
Edge Functions (source in `supabase/functions/`): `paystack-create-recipient` (v2) and `process-payouts` (v2). Both read the secret **`PAYSTACK_SECRET_KEY`** (the same name `paystack-webhook` and `paystack-init-payment` already use).
Until it exists: `process-payouts` answers `payouts_not_configured` **before** approving or reserving anything, the admin Instructors tab shows a banner and disables Send, and the bank sheet explains that setup is not on yet. Nothing is ever marked sent without Paystack's confirmation.
Set it with: Supabase dashboard → Edge Functions → Secrets → add `PAYSTACK_SECRET_KEY` (or `supabase secrets set PAYSTACK_SECRET_KEY=…` from your own terminal). Never put it in code or chat. Then, in order: set the webhook URL in Paystack to the `paystack-webhook` function, turn transfer OTP off, fund the Paystack balance, send one small instructor withdrawal and watch it go `processing → paid`.

## Security
Clients can only read their own rows (RLS) and call RPCs; there is no insert/update on any of these tables from the app. Amounts, rates and instructors are always derived in the database. Admin RPCs check `private.is_admin()`; an admin cannot approve or reject their own withdrawal; centre directors have no access to instructor wallets. Private helper functions are not executable by app roles. A bank account cannot be changed while a withdrawal is open; every change notifies the owner and the admins and is audited.

## Admin operations
Payouts → Instructors: review requests (Send / Reject with reason), "Check with Paystack" (reconcile by reference) and "Retry send" (only if Paystack has no record), search wallets, filter earnings by date and instructor, record an adjustment (reason ≥ 5 characters, signed with the admin's name), and a "Needs attention" list: finished classes not posted (with a Post now button), classes with no instructor, unfunded earnings, posting errors, withdrawals stuck in processing over 2 hours, negative balances, and bank names that differ from the profile.

## Tested
Run inside rolled-back transactions on the live database with real rows (nothing persisted): exact 6-class rounding; idempotent posting; unfunded earning after a refund then released by the payments trigger; reversal / restore / re-reversal through the attendance trigger; withdrawal request, second request refused, self-approval refused, approve, success event twice, reversal after paid (money returned once), reject, cancel; a student, a non-admin and a direct table insert are all refused. `npm run build` (tsc + vite) passes. **Not tested:** anything that calls Paystack (no secret), the new screens in a browser, and a real concurrent double-submit.

## Known limitations / decisions for the owner
1. Refund screens do not yet block refunding money for classes already attended (`record_manual_refund`, `process-refund`). Rule is stated; enforcement is the next backend change.
2. Instalment funding uses the money-collected cap above, not "first payment unlocks half the classes": access to classes is still gated per course by the existing instalment rules, which this feature does not change.
3. `fail_payout` (centres) ignores a `reversed` event after `paid`; instructors handle it. Worth fixing for centres.
4. Deleting an instructor account who has ledger entries is blocked by design (financial records).

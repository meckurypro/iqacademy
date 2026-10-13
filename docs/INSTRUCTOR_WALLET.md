# Instructor wallet, earnings ledger and withdrawals

## The rules, in plain words
1. **Class price** = the pack's full price ÷ **all the classes of all the courses in the pack**. (STANDARD: ₦50,000 ÷ 16 classes = ₦3,125 per class.) The instalment premium is IQ Academy's and is never part of the price.
2. **The instructor earns 20%** of that class price for every student who attended the class (₦625 per student per class in the example). The 20% is `app_settings.instructor_share_bp = 2000` and is copied onto each earning, so changing it later never rewrites old earnings. Rounding is exact: over the whole pack the shares add up to exactly 20% of the price.
3. **A class pays when the student was allowed into it.** Course 1 is open after instalment 1, later courses after the instalment that unlocks them (the existing instalment gates). Cash recorded by a coordinator counts as paid. If somehow a student attended a course whose instalment is unpaid, the earning waits and is paid automatically the moment the instalment is paid. Nothing is lost and nothing is paid twice.
4. **Custom (one-off) classes never earn.**
5. **Withdrawals are identical for instructors and centre directors**: one record per month; the month's Withdraw button turns on on the month's last day (`withdraw_opens_days_before_month_end`, Africa/Lagos); older months stay withdrawable; one open request per month; "Requested" → "On its way" → "Paid"; cancel allowed until it is approved. For instructors the money is set aside the moment they ask.
6. **Attended classes can't be refunded.** Refund ≤ amount paid − (class price × classes attended). Enforced in the database for both Paystack and manual refunds; the refund screen shows the maximum.
7. **Bank accounts**: instructors and directors enter their own (bank list and account name come live from Paystack).

## Worked example (STANDARD, 2 courses: AI Foundations 6 classes + Accounting 10 classes)
Price ₦50,000, 16 classes → ₦3,125 per class → instructor ₦625 per attending student. A student paid ₦30,000 + ₦25,000 (instalment premium ₦5,000 is IQ's): course 1 is open after the first instalment, course 2 after the second. If the student attended 2 classes and asks for a refund, the most that can be refunded is what they paid minus ₦6,250.

## Data model (migrations 61–64)
`instructor_ledger_entries` (append-only: `earning`, `earning_reversal`, `earning_restore`, `adjustment`, `withdrawal`, `withdrawal_release`), `instructor_pending_earnings` (waiting for an instalment), `instructor_session_posts` (a class is posted exactly once), `instructor_earning_errors`, `instructor_withdrawals`, `instructor_payout_accounts`.
Month of an entry: an earning belongs to the month of its class; a reversal, restore or adjustment belongs to the month it happens in (so a withdrawn month never changes), exactly like centre refunds.

## Flow
- `private.post_due_session_earnings()` runs every 10 minutes (cron `iqa-post-instructor-earnings`) and posts classes that are `completed` **and** past their check-in grace (30 min). It covers all three completion paths without touching them.
- Triggers: attendance changed after posting → reversal/restore entry; a payment or instalment changes → waiting earnings are released. Failures are logged to `instructor_earning_errors` and never block attendance or payments.
- `request_instructor_withdrawal(month)` → admin approves/rejects in Payouts → Instructors → `process-payouts` sends via Paystack → the webhook (`handle_transfer_event`) marks it paid; failed/rejected/cancelled/reversed all give the money back exactly once.
- A `transfer.reversed` that arrives after a payout was marked paid now returns the money to the balance, for **instructors and centres** (`private.reverse_paid_payout`). Repeated events do nothing.

## Paystack
Edge Functions in `supabase/functions/`: `paystack-create-recipient` (v2), `process-payouts` (v2), `process-refund` (v2). Secret name: **`PAYSTACK_SECRET_KEY`**. Until it exists: sending is blocked before anything is approved or reserved, the admin Instructors tab shows a banner, and the bank sheet says setup is not on yet. Set it in Supabase dashboard → Edge Functions → Secrets (never in code or chat). Then: point the Paystack webhook at `paystack-webhook`, turn transfer OTP off, fund the balance, send one small withdrawal and watch it go to Paid.

## Security
Clients read only their own rows (RLS) and call RPCs; no direct writes. Admin RPCs check `private.is_admin()`; admins cannot approve their own withdrawal; directors cannot see instructor wallets; private helpers are not executable by app roles; a bank account cannot change while a withdrawal is open; every change is audited and notifies the owner and admins.

## Admin
Payouts → Instructors: requests (Send / Reject with reason / Check with Paystack / Retry only if Paystack has no record), wallets with search, earnings list, signed adjustments (reason ≥ 5 characters), and "Needs attention" (finished classes not posted, classes with no instructor, earnings waiting for an instalment, posting errors, withdrawals stuck over 2 hours, negative balances, bank names that differ from the profile).

## Tested (executed on the live database inside rolled-back transactions)
Pack-wide class price and exact rounding (16 classes add up to ₦10,000 = 20% of ₦50,000); earning waits while its instalment is unpaid and pays when it is; per-month request rules (future month, empty month, same month twice refused); reserve, approve, paid, reversed-after-paid returns money once; reject and cancel release once; refund ceiling (attended 2 of 16 → max ₦43,750 of ₦50,000; a bigger refund is refused; the maximum is accepted); centre payout reversed after paid returns the money once with repeated events; non-admin, student and direct-insert access refused. `npm run build` (web) and `npm run verify` (native) pass.
**Not tested:** any real Paystack call (no secret yet), the screens in a browser or on a device, and a true concurrent double-submit.

## Known limitations
- A month that goes negative (deductions larger than earnings) is not offset automatically against another month; this matches centres.
- Refunds of money returned by the bank *after* a refund was marked paid are not reversed (centres and instructors are).
- Deleting an instructor account that has ledger entries is blocked (financial records).

-- 64_instructor_wallet_simple_rules.sql — one simple rule set for instructors, directors and refunds.
--
-- 1. Class price = the pack's full price / ALL classes of ALL courses in the pack. The instructor earns 20% of that per attended class.
--    (The instalment premium is IQ Academy's and is never in the price: the base is packages.price_full.)
-- 2. A class pays the instructor when the student was allowed into it, i.e. paid up for that course under the existing instalment gates
--    (course 1 after instalment 1, later courses after the instalment that unlocks them). No separate "cap" any more.
-- 3. Instructor withdrawals work exactly like centre withdrawals: one record per month, a Withdraw button per month once the month's
--    last day arrives, old months stay withdrawable, one open request per month. Money is still reserved the moment it is requested.
-- 4. A student cannot be refunded for classes they attended: refund <= paid - (price of the classes attended). Enforced in the database.
-- 5. A transfer.reversed that arrives AFTER a centre payout was marked paid now returns the money to the centre's balance.
-- Nothing in the instructor ledger exists yet (the feature has not posted a real earning), so changing the formula rewrites no history.

-- ------------------------------------------------------------------ 1 + 2: earnings
create or replace function private.paid_up(p_enrolment uuid, p_course uuid) returns boolean
language sql stable security definer set search_path = '' as $f$
  select exists (
    select 1 from public.enrolments e join public.enrolment_courses ec on ec.enrolment_id = e.id
     where e.id = p_enrolment and ec.course_id = p_course and e.activated_at is not null
       and (ec.sequence_no = 1 or not exists (
             select 1 from public.enrolment_instalments i
              where i.enrolment_id = e.id and i.status = 'pending'
                and case i.due_rule when 'before_start' then true when 'before_course_2' then ec.sequence_no >= 2
                                    when 'before_course_3' then ec.sequence_no >= 3 when 'before_course_4' then ec.sequence_no >= 4 else false end))) $f$;

create or replace function private.accrue_earning(p_session uuid, p_student uuid) returns text
language plpgsql security definer set search_path = '' as $f$
declare
  s public.class_sessions%rowtype; a public.attendance%rowtype;
  v_course_total integer; v_lesson integer; v_k integer; v_seq integer; v_before integer; v_n integer; v_g integer;
  v_base bigint; v_rate integer; v_amt bigint; v_month date;
begin
  select * into s from public.class_sessions where id = p_session;
  if not found or s.status <> 'completed' or s.is_emergency or s.instructor_id is null then return 'skip'; end if;
  select * into a from public.attendance where session_id = p_session and student_id = p_student;
  if not found or a.status <> 'present' or a.enrolment_id is null then return 'skip'; end if;
  perform pg_advisory_xact_lock(hashtextextended(a.enrolment_id::text, 0));
  select ec.sequence_no into v_seq from public.enrolment_courses ec where ec.enrolment_id = a.enrolment_id and ec.course_id = s.course_id;
  if v_seq is null then return 'skip_not_enrolled'; end if;
  if exists (select 1 from public.instructor_ledger_entries l where l.session_id = p_session and l.enrolment_id = a.enrolment_id and l.entry_type = 'earning')
     or exists (select 1 from public.instructor_pending_earnings q where q.session_id = p_session and q.enrolment_id = a.enrolment_id) then return 'exists'; end if;

  select c.total_sessions into v_course_total from public.courses c where c.id = s.course_id;
  if coalesce(v_course_total, 0) <= 0 then return 'skip_no_allocation'; end if;
  select l.lesson_no into v_lesson from public.course_lessons l where l.id = s.lesson_id;
  v_k := least(greatest(coalesce(v_lesson, s.session_no, 1), 1), v_course_total);

  -- N = every class of every course in the pack; g = this class's place in the whole pack (course 1 first, then course 2 ...)
  select coalesce(sum(c.total_sessions), 0) into v_n from public.enrolment_courses ec join public.courses c on c.id = ec.course_id where ec.enrolment_id = a.enrolment_id;
  select coalesce(sum(c.total_sessions), 0) into v_before from public.enrolment_courses ec join public.courses c on c.id = ec.course_id
   where ec.enrolment_id = a.enrolment_id and ec.sequence_no < v_seq;
  v_g := v_before + v_k;

  -- a class is paid once per enrolment, whichever run (own or make-up) it was attended in
  if exists (select 1 from public.instructor_ledger_entries l where l.enrolment_id = a.enrolment_id and l.lesson_no = v_g and l.entry_type = 'earning' and l.session_id <> p_session)
     or exists (select 1 from public.instructor_pending_earnings q where q.enrolment_id = a.enrolment_id and q.lesson_no = v_g and q.session_id <> p_session and q.voided_at is null)
  then return 'duplicate_lesson'; end if;

  v_base := private.enrolment_base(a.enrolment_id);
  v_rate := private.setting_int('instructor_share_bp', 2000);
  if v_base is null or v_n <= 0 then return 'skip_no_allocation'; end if;
  v_amt := private.earning_amount(v_base, v_rate, v_n, v_g);     -- 20% of (pack price / all classes), exact over the whole pack
  if v_amt <= 0 then return 'zero'; end if;
  v_month := date_trunc('month', s.session_date)::date;

  if private.paid_up(a.enrolment_id, s.course_id) then
    insert into public.instructor_ledger_entries (instructor_id, entry_type, amount, period_month, session_id, enrolment_id, student_id, course_id, centre_id,
           lesson_no, allocated_tuition, total_sessions, rate_bp, description)
    values (s.instructor_id, 'earning', v_amt, v_month, p_session, a.enrolment_id, p_student, s.course_id, s.centre_id, v_g, v_base, v_n, v_rate, 'Class ' || v_g || ' of ' || v_n);
    return 'posted';
  end if;
  insert into public.instructor_pending_earnings (instructor_id, session_id, enrolment_id, student_id, course_id, centre_id, lesson_no, allocated_tuition, total_sessions, rate_bp, amount, period_month)
  values (s.instructor_id, p_session, a.enrolment_id, p_student, s.course_id, s.centre_id, v_g, v_base, v_n, v_rate, v_amt, v_month);
  return 'pending';
end $f$;

create or replace function private.release_pending(p_enrolment uuid) returns integer
language plpgsql security definer set search_path = '' as $f$
declare q public.instructor_pending_earnings%rowtype; v_n integer := 0;
begin
  perform pg_advisory_xact_lock(hashtextextended(p_enrolment::text, 0));
  for q in select * from public.instructor_pending_earnings where enrolment_id = p_enrolment and released_at is null and voided_at is null order by created_at, id loop
    continue when not private.paid_up(q.enrolment_id, q.course_id);
    insert into public.instructor_ledger_entries (instructor_id, entry_type, amount, period_month, session_id, enrolment_id, student_id, course_id, centre_id,
           lesson_no, allocated_tuition, total_sessions, rate_bp, description)
    values (q.instructor_id, 'earning', q.amount, q.period_month, q.session_id, q.enrolment_id, q.student_id, q.course_id, q.centre_id, q.lesson_no,
            q.allocated_tuition, q.total_sessions, q.rate_bp, 'Class ' || q.lesson_no || ' of ' || q.total_sessions || ' (paid up later)');
    update public.instructor_pending_earnings set released_at = now() where id = q.id;
    v_n := v_n + 1;
  end loop;
  return v_n;
end $f$;

-- Reversals and restores land in the month they happen (like centre refund reversals), so a month that was already withdrawn never changes.
create or replace function private.sync_attendance_earning(p_session uuid, p_student uuid, p_enrolment uuid, p_present boolean) returns void
language plpgsql security definer set search_path = '' as $f$
declare e public.instructor_ledger_entries%rowtype; v_last public.instructor_ledger_entries%rowtype; q public.instructor_pending_earnings%rowtype;
begin
  if p_enrolment is null or not exists (select 1 from public.instructor_session_posts where session_id = p_session) then return; end if;
  perform pg_advisory_xact_lock(hashtextextended(p_enrolment::text, 0));
  select * into e from public.instructor_ledger_entries where session_id = p_session and enrolment_id = p_enrolment and entry_type = 'earning';
  if not found then
    select * into q from public.instructor_pending_earnings where session_id = p_session and enrolment_id = p_enrolment;
    if found then
      if p_present and q.voided_at is not null then update public.instructor_pending_earnings set voided_at = null where id = q.id;
      elsif not p_present and q.voided_at is null and q.released_at is null then update public.instructor_pending_earnings set voided_at = now() where id = q.id; end if;
    elsif p_present then perform private.accrue_earning(p_session, p_student); end if;
    return;
  end if;
  select * into v_last from public.instructor_ledger_entries
   where session_id = p_session and enrolment_id = p_enrolment and entry_type in ('earning','earning_reversal','earning_restore') order by seq desc limit 1;
  if not p_present and v_last.entry_type in ('earning','earning_restore') then
    insert into public.instructor_ledger_entries (instructor_id, entry_type, amount, period_month, session_id, enrolment_id, student_id, course_id, centre_id,
           lesson_no, allocated_tuition, total_sessions, rate_bp, reverses_id, description)
    values (e.instructor_id, 'earning_reversal', -e.amount, private.lagos_month(), e.session_id, e.enrolment_id, e.student_id, e.course_id, e.centre_id,
            e.lesson_no, e.allocated_tuition, e.total_sessions, e.rate_bp, v_last.id, 'Attendance changed after posting');
  elsif p_present and v_last.entry_type = 'earning_reversal' then
    insert into public.instructor_ledger_entries (instructor_id, entry_type, amount, period_month, session_id, enrolment_id, student_id, course_id, centre_id,
           lesson_no, allocated_tuition, total_sessions, rate_bp, reverses_id, description)
    values (e.instructor_id, 'earning_restore', e.amount, private.lagos_month(), e.session_id, e.enrolment_id, e.student_id, e.course_id, e.centre_id,
            e.lesson_no, e.allocated_tuition, e.total_sessions, e.rate_bp, v_last.id, 'Attendance restored');
  end if;
end $f$;

drop function if exists private.course_allocation(uuid, uuid);
drop function if exists private.enrolment_collected(uuid);

-- ------------------------------------------------------------------ 3: per-month withdrawals, same as centres
drop index if exists public.instructor_withdrawals_one_open;
create unique index instructor_withdrawals_one_open_per_month on public.instructor_withdrawals (instructor_id, eligible_through) where status in ('draft','processing');
drop function if exists public.request_instructor_withdrawal();

create or replace function public.request_instructor_withdrawal(p_month date) returns uuid
language plpgsql security definer set search_path = '' as $f$
declare
  v_uid uuid := (select auth.uid()); v_today date := private.lagos_today(); v_cur date := private.lagos_month();
  v_month date := date_trunc('month', p_month)::date; v_days integer := private.setting_int('withdraw_opens_days_before_month_end', 0);
  v_acc public.instructor_payout_accounts%rowtype; v_amt bigint; v_id uuid; v_name text;
begin
  if v_uid is null then raise exception 'not_authenticated' using errcode = '28000'; end if;
  if not private.is_instructor() then raise exception 'forbidden' using errcode = '42501'; end if;
  if p_month is null or v_month > v_cur then raise exception 'month_not_available'; end if;
  if v_today < ((v_month + interval '1 month')::date - 1 - v_days) then raise exception 'withdraw_not_open'; end if;
  select * into v_acc from public.instructor_payout_accounts where instructor_id = v_uid;
  if v_acc.provider_recipient_code is null then raise exception 'no_payout_account'; end if;

  perform 1 from public.profiles where id = v_uid for update;            -- one request at a time per instructor
  if exists (select 1 from public.instructor_withdrawals where instructor_id = v_uid and eligible_through = v_month and status in ('draft','processing')) then raise exception 'withdrawal_pending'; end if;
  select coalesce(sum(amount), 0) into v_amt from public.instructor_ledger_entries where instructor_id = v_uid and period_month = v_month;
  if v_amt <= 0 then raise exception 'nothing_to_withdraw'; end if;
  if v_amt < private.setting_int('min_payout_kobo', 0) then raise exception 'below_minimum'; end if;

  insert into public.instructor_withdrawals (instructor_id, amount, eligible_through, recipient_code, bank_name, account_name, account_last4, name_match, created_by)
  values (v_uid, v_amt, v_month, v_acc.provider_recipient_code, v_acc.bank_name, v_acc.account_name, v_acc.account_last4, v_acc.name_match, v_uid) returning id into v_id;
  insert into public.instructor_ledger_entries (instructor_id, entry_type, amount, period_month, withdrawal_id, description, created_by)
  values (v_uid, 'withdrawal', -v_amt, v_month, v_id, 'Withdrawal requested', v_uid);

  select coalesce(nullif(trim(full_name), ''), 'An instructor') into v_name from public.profiles where id = v_uid;
  perform private.notify(private.admin_ids(), 'instructor_withdrawal_requested', 'Instructor withdrawal requested',
    v_name || ' asked to withdraw ' || private.fmt_naira(v_amt) || ' for ' || to_char(v_month, 'FMMonth YYYY') || '. Review it in Payouts.', jsonb_build_object('withdrawal_id', v_id));
  perform private.notify(array[v_uid], 'withdrawal_submitted', 'Withdrawal requested',
    private.fmt_naira(v_amt) || ' for ' || to_char(v_month, 'FMMonth YYYY') || ' is set aside while we review your request.', jsonb_build_object('withdrawal_id', v_id));
  return v_id;
end $f$;

create or replace function public.instructor_wallet() returns jsonb
language plpgsql stable security definer set search_path = '' as $f$
declare
  v_uid uuid := (select auth.uid()); v_today date := private.lagos_today(); v_cur date := private.lagos_month();
  v_days integer := private.setting_int('withdraw_opens_days_before_month_end', 0); v_min integer := private.setting_int('min_payout_kobo', 0);
  v_acc public.instructor_payout_accounts%rowtype; v_bal bigint; v_life bigint; v_this bigint; v_reserved bigint; v_paid bigint; v_unfunded bigint; v_months jsonb;
begin
  if v_uid is null then raise exception 'not_authenticated' using errcode = '28000'; end if;
  if not private.is_instructor() then raise exception 'forbidden' using errcode = '42501'; end if;
  select coalesce(sum(amount), 0),
         coalesce(sum(amount) filter (where entry_type in ('earning','earning_reversal','earning_restore','adjustment')), 0),
         coalesce(sum(amount) filter (where entry_type in ('earning','earning_reversal','earning_restore','adjustment') and period_month = v_cur), 0)
    into v_bal, v_life, v_this from public.instructor_ledger_entries where instructor_id = v_uid;
  select coalesce(sum(amount) filter (where status in ('draft','processing')), 0), coalesce(sum(amount) filter (where status = 'paid'), 0)
    into v_reserved, v_paid from public.instructor_withdrawals where instructor_id = v_uid;
  select coalesce(sum(amount), 0) into v_unfunded from public.instructor_pending_earnings where instructor_id = v_uid and released_at is null and voided_at is null;
  select * into v_acc from public.instructor_payout_accounts where instructor_id = v_uid;

  with m as (select period_month as month from public.instructor_ledger_entries where instructor_id = v_uid union select v_cur),
  agg as (
    select m.month,
      coalesce(sum(l.amount) filter (where l.entry_type in ('earning','earning_restore')), 0)   as earned,
      coalesce(-sum(l.amount) filter (where l.entry_type = 'earning_reversal'), 0)              as reversals,
      coalesce(sum(l.amount) filter (where l.entry_type = 'adjustment'), 0)                     as adjustments,
      coalesce(-sum(l.amount) filter (where l.entry_type in ('withdrawal','withdrawal_release')), 0) as withdrawn,
      coalesce(sum(l.amount), 0)                                                                as available
      from m left join public.instructor_ledger_entries l on l.instructor_id = v_uid and l.period_month = m.month
     where m.month <= v_cur
       and (m.month >= (v_cur - interval '1 month')::date
            or coalesce((select sum(x.amount) from public.instructor_ledger_entries x where x.instructor_id = v_uid and x.period_month = m.month), 0) > 0)
     group by m.month)
  select coalesce(jsonb_agg(jsonb_build_object(
      'month', a.month, 'is_current', a.month = v_cur, 'earned', a.earned, 'reversals', a.reversals, 'adjustments', a.adjustments,
      'withdrawn', a.withdrawn, 'available', a.available, 'opens_on', o.opens_on,
      'can_withdraw', (v_today >= o.opens_on and a.available > 0 and a.available >= v_min and v_acc.provider_recipient_code is not null
                       and not exists (select 1 from public.instructor_withdrawals w where w.instructor_id = v_uid and w.eligible_through = a.month and w.status in ('draft','processing'))),
      'withdrawal', case when wd.id is null then null else jsonb_build_object('id', wd.id, 'status', wd.status, 'amount', wd.amount, 'paid_at', wd.paid_at) end
    ) order by a.month desc), '[]'::jsonb)
    into v_months
    from agg a
    cross join lateral (select ((a.month + interval '1 month')::date - 1 - v_days) as opens_on) o
    left join lateral (select w.id, w.status, w.amount, w.paid_at from public.instructor_withdrawals w
                        where w.instructor_id = v_uid and w.eligible_through = a.month
                        order by (w.status in ('draft','processing')) desc, w.created_at desc limit 1) wd on true;

  return jsonb_build_object('balance', v_bal, 'lifetime', v_life, 'this_month', v_this, 'reserved', v_reserved, 'paid_out', v_paid, 'unfunded', v_unfunded,
    'min_payout', v_min, 'today', v_today,
    'account', jsonb_build_object('ready', v_acc.provider_recipient_code is not null, 'bank_name', v_acc.bank_name, 'account_name', v_acc.account_name, 'account_last4', v_acc.account_last4),
    'months', v_months);
end $f$;

-- ------------------------------------------------------------------ 4: no refund for classes already attended
create or replace function private.enrolment_refund_info(p_enrolment uuid) returns jsonb
language sql stable security definer set search_path = '' as $f$
  with n as (select coalesce(sum(c.total_sessions), 0)::bigint total from public.enrolment_courses ec join public.courses c on c.id = ec.course_id where ec.enrolment_id = p_enrolment),
  a as (select count(*)::bigint attended from public.attendance t join public.class_sessions s on s.id = t.session_id
         where t.enrolment_id = p_enrolment and t.status = 'present' and not s.is_emergency
           and exists (select 1 from public.enrolment_courses ec where ec.enrolment_id = p_enrolment and ec.course_id = s.course_id)),
  pd as (select coalesce(sum(p.amount - p.refunded_amount), 0)::bigint paid from public.payments p where p.enrolment_id = p_enrolment and p.status in ('succeeded','partially_refunded')),
  b as (select coalesce(private.enrolment_base(p_enrolment), 0)::bigint base),
  c as (select case when n.total > 0 then (b.base * least(a.attended, n.total)) / n.total else 0 end consumed, a.attended, n.total, pd.paid from n, a, pd, b)
  select jsonb_build_object('paid', c.paid, 'attended', c.attended, 'total_classes', c.total, 'consumed', c.consumed, 'refundable', greatest(0, c.paid - c.consumed)) from c $f$;

create or replace function public.payment_refund_info(p_payment_id uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $f$
declare v_p public.payments%rowtype; v_i jsonb;
begin
  if not (private.is_privileged() or private.is_admin()) then raise exception 'forbidden' using errcode = '42501'; end if;
  select * into v_p from public.payments where id = p_payment_id;
  if not found then raise exception 'payment_not_found'; end if;
  v_i := private.enrolment_refund_info(v_p.enrolment_id);
  return v_i || jsonb_build_object('payment_left', v_p.amount - v_p.refunded_amount,
                                   'max_refund', least(v_p.amount - v_p.refunded_amount, (v_i ->> 'refundable')::bigint));
end $f$;

create or replace function private.apply_refund(p_payment_id uuid, p_amount bigint, p_reason text, p_method text, p_cancel boolean, p_status public.refund_status, p_note text, p_recipient text, p_bank_name text, p_account_name text, p_last4 text)
 returns public.refunds language plpgsql security definer set search_path to '' as $function$
declare
  v_p public.payments%rowtype;
  v_r public.refunds%rowtype;
  v_n integer;
begin
  select * into v_p from public.payments where id = p_payment_id for update;
  if not found then raise exception 'payment_not_found'; end if;
  if v_p.status not in ('succeeded','partially_refunded') then raise exception 'payment_not_refundable'; end if;
  if p_amount is null or p_amount <= 0 or p_amount > v_p.amount - v_p.refunded_amount then raise exception 'invalid_refund_amount'; end if;
  -- Classes a student already attended are not refundable (the instructor is paid for them).
  if p_amount > coalesce((private.enrolment_refund_info(v_p.enrolment_id) ->> 'refundable')::bigint, 0) then raise exception 'refund_exceeds_unused_classes'; end if;

  insert into public.refunds (reference, payment_id, enrolment_id, student_id, centre_id, amount, currency, method, status, reason,
                              recipient_code, bank_name, account_name, account_last4, note, requested_by, paid_at)
  values (case when p_method = 'paystack' then 'rf-' || to_char(now(), 'YYMM') || '-' || lower(substr(replace(gen_random_uuid()::text, '-', ''), 1, 10)) end,
          v_p.id, v_p.enrolment_id, v_p.student_id, v_p.centre_id, p_amount, v_p.currency, p_method, p_status, p_reason,
          p_recipient, p_bank_name, p_account_name, p_last4, p_note, (select auth.uid()),
          case when p_status = 'paid' then now() end)
  returning * into v_r;

  -- Marks the payment refunded; the payment trigger reverses the centre's share (tagged with this refund) and tells the director.
  perform set_config('app.refund_id', v_r.id::text, true);
  update public.payments
     set refunded_amount = refunded_amount + p_amount,
         status = case when refunded_amount + p_amount >= amount then 'refunded'::public.payment_status
                       else 'partially_refunded'::public.payment_status end,
         metadata = metadata || jsonb_build_object('last_refund_reason', p_reason)
   where id = p_payment_id;
  perform set_config('app.refund_id', '', true);

  if p_cancel then
    update public.enrolments set status = 'cancelled', cancelled_at = now(), cancel_reason = 'Refunded'
     where id = v_p.enrolment_id and status in ('pending_payment','active');
    get diagnostics v_n = row_count;
    if v_n > 0 then
      update public.enrolment_instalments set status = 'cancelled' where enrolment_id = v_p.enrolment_id and status = 'pending';
      update public.refunds set cancelled_enrolment = true where id = v_r.id returning * into v_r;
    end if;
  end if;

  perform private.notify(array[v_p.student_id],
          'refund_update', case p_status when 'paid' then 'Refund sent' else 'Your refund is on its way' end,
          private.fmt_naira(p_amount) || case p_status when 'paid' then ' has been refunded to you.' else ' is being sent to your bank account.' end ||
          case when v_r.cancelled_enrolment then ' Your enrolment has been cancelled.' else '' end,
          jsonb_build_object('refund_id', v_r.id, 'enrolment_id', v_p.enrolment_id));
  return v_r;
end $function$;

-- ------------------------------------------------------------------ 5: reversed after paid (centres)
create or replace function private.reverse_paid_payout(p_id uuid, p_reason text) returns void
language plpgsql security definer set search_path = '' as $f$
declare v_p public.payouts%rowtype; v_directors uuid[];
begin
  select * into v_p from public.payouts where id = p_id for update;
  if not found or v_p.status <> 'paid' then return; end if;
  update public.payouts set status = 'failed', failure_reason = p_reason where id = p_id;
  if not exists (select 1 from public.centre_ledger_entries where payout_id = p_id and entry_type = 'payout_reversal') then
    insert into public.centre_ledger_entries (centre_id, entry_type, amount, currency, payout_id, description, period_month)
    values (v_p.centre_id, 'payout_reversal', v_p.amount, v_p.currency, v_p.id,
            'Payout ' || coalesce(v_p.reference, '') || ' was reversed after it was marked paid', coalesce(v_p.period_month, private.lagos_month()));
  end if;
  select array_agg(r.user_id) into v_directors from public.user_roles r where r.centre_id = v_p.centre_id and r.role = 'centre_director' and r.is_active;
  perform private.notify(private.admin_ids(), 'payout_failed', 'Payout reversed',
         'Payout ' || coalesce(v_p.reference, '') || ' came back after it was marked paid. The money is back in the centre''s balance.', jsonb_build_object('payout_id', p_id));
  perform private.notify(v_directors, 'payout_failed', 'Payout returned',
         'The ' || private.fmt_naira(v_p.amount) || ' payout was returned by the bank and is back in your balance. You can withdraw it again.', jsonb_build_object('payout_id', p_id));
end $f$;

create or replace function public.handle_transfer_event(p_reference text, p_status text, p_transfer_code text default null::text, p_raw jsonb default null::jsonb)
 returns jsonb language plpgsql security definer set search_path to '' as $f$
declare v_p public.payouts%rowtype; v_rf public.refunds%rowtype; v_directors uuid[];
begin
  if not private.is_privileged() then raise exception 'forbidden' using errcode = '42501'; end if;
  select * into v_p from public.payouts where reference = p_reference for update;
  if not found then
    select * into v_rf from public.refunds where reference = p_reference for update;
    if not found then return private.handle_instructor_transfer(p_reference, p_status, p_transfer_code, p_raw); end if;
    if p_status = 'success' then
      if v_rf.status = 'processing' then
        update public.refunds set status = 'paid', paid_at = now(), raw = p_raw,
               provider_transfer_code = coalesce(p_transfer_code, provider_transfer_code) where id = v_rf.id;
        perform private.notify(array[v_rf.student_id], 'refund_update', 'Refund sent',
                private.fmt_naira(v_rf.amount) || ' has been sent to your bank account.', jsonb_build_object('refund_id', v_rf.id));
      end if;
    elsif p_status in ('failed','reversed') then
      perform public.fail_refund(v_rf.id, 'Transfer ' || p_status);
    end if;
    return jsonb_build_object('ok', true, 'refund_id', v_rf.id);
  end if;

  if p_status = 'success' then
    if v_p.status = 'processing' then
      update public.payouts
         set status = 'paid', paid_at = now(), provider_transfer_code = coalesce(p_transfer_code, provider_transfer_code), raw = p_raw
       where id = v_p.id;
      select array_agg(r.user_id) into v_directors from public.user_roles r
       where r.centre_id = v_p.centre_id and r.role = 'centre_director' and r.is_active;
      perform private.notify(v_directors, 'payout_paid', 'Payout sent',
              'We sent ' || private.fmt_naira(v_p.amount) || ' to your bank account.',
              jsonb_build_object('payout_id', v_p.id));
    end if;
  elsif p_status = 'reversed' and v_p.status = 'paid' then
    perform private.reverse_paid_payout(v_p.id, 'Transfer reversed after it was marked paid');
  elsif p_status in ('failed','reversed') then
    perform public.fail_payout(v_p.id, 'Transfer ' || p_status);
  end if;
  return jsonb_build_object('ok', true, 'payout_id', v_p.id);
end $f$;

-- ------------------------------------------------------------------ grants
revoke all on function private.paid_up(uuid, uuid), private.enrolment_refund_info(uuid), private.reverse_paid_payout(uuid, text) from public, anon, authenticated;
revoke all on function public.request_instructor_withdrawal(date), public.payment_refund_info(uuid) from public, anon;
grant execute on function public.request_instructor_withdrawal(date), public.payment_refund_info(uuid) to authenticated, service_role;

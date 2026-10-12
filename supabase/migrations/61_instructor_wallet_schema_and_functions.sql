-- 61_instructor_wallet_schema_and_functions.sql — instructor earnings ledger, wallet and month-end withdrawals.
-- Part 1 of 2: tables, RLS, helper and RPC functions. Triggers and cron are in 62 so this part can be tested first.
-- Design (see docs/INSTRUCTOR_WALLET.md):
--   * Money is integer kobo. One append-only ledger per instructor (instructor_ledger_entries); balance = SUM(amount).
--   * An earning is one row per attended student per class: floor-cumulative share of the course's base tuition.
--   * Base tuition = packages.price_full for instalment plans (the instalment premium is IQ Academy's), else enrolments.total_amount.
--     The base is split equally across the pack's courses (remainder kobo to the earliest courses).
--   * Funding guard: net earnings of an enrolment can never exceed rate x min(base, net collected). Anything above waits in
--     instructor_pending_earnings and is released when more money is collected.
--   * Withdrawals reserve funds at request time (a 'withdrawal' debit); reject/cancel/fail/reverse release them exactly once.

insert into public.app_settings (key, value, description) values
  ('instructor_share_bp', '2000'::jsonb, 'Instructor share of base tuition per attended class, in basis points (2000 = 20%). Copied onto every earning.'),
  ('instructor_earnings_since', to_jsonb(now()::text), 'Classes completed before this moment never earn (no invented history).')
on conflict (key) do nothing;

-- ---------------------------------------------------------------- tables
create table public.instructor_payout_accounts (
  instructor_id uuid primary key references public.profiles(id),
  provider_recipient_code text, bank_code text, bank_name text, account_name text, account_last4 text,
  name_match boolean,
  updated_at timestamptz not null default now()
);

create table public.instructor_withdrawals (
  id uuid primary key default gen_random_uuid(),
  reference text unique,
  instructor_id uuid not null references public.profiles(id),
  amount bigint not null check (amount > 0),
  currency char(3) not null default 'NGN',
  eligible_through date not null,
  status text not null default 'draft' check (status in ('draft','processing','paid','failed','cancelled','rejected')),
  recipient_code text, bank_name text, account_name text, account_last4 text, name_match boolean,
  provider_transfer_code text, raw jsonb,
  reviewed_by uuid references public.profiles(id), reviewed_at timestamptz, reject_reason text,
  failure_reason text, attempts integer not null default 0,
  paid_at timestamptz,
  created_by uuid references public.profiles(id),
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create unique index instructor_withdrawals_one_open on public.instructor_withdrawals (instructor_id) where status in ('draft','processing');

create table public.instructor_ledger_entries (
  id uuid primary key default gen_random_uuid(),
  seq bigint generated always as identity,
  instructor_id uuid not null references public.profiles(id),
  entry_type text not null check (entry_type in ('earning','earning_reversal','earning_restore','adjustment','withdrawal','withdrawal_release')),
  amount bigint not null,
  currency char(3) not null default 'NGN',
  period_month date not null,
  session_id uuid references public.class_sessions(id),
  enrolment_id uuid references public.enrolments(id),
  student_id uuid references public.students(id),
  course_id uuid references public.courses(id),
  centre_id uuid references public.centres(id),
  lesson_no integer, allocated_tuition bigint, total_sessions integer, rate_bp integer,
  reverses_id uuid references public.instructor_ledger_entries(id),
  withdrawal_id uuid references public.instructor_withdrawals(id),
  description text,
  created_by uuid references public.profiles(id),
  created_at timestamptz not null default now(),
  constraint ile_sign check (
    (entry_type in ('earning','earning_restore','withdrawal_release') and amount > 0)
    or (entry_type in ('earning_reversal','withdrawal') and amount < 0)
    or (entry_type = 'adjustment' and amount <> 0)),
  constraint ile_earning_cols check (entry_type <> 'earning' or (session_id is not null and enrolment_id is not null
    and allocated_tuition is not null and coalesce(total_sessions, 0) > 0 and rate_bp is not null)),
  constraint ile_withdrawal_cols check (entry_type not in ('withdrawal','withdrawal_release') or withdrawal_id is not null)
);
create unique index ile_one_earning on public.instructor_ledger_entries (session_id, enrolment_id) where entry_type = 'earning';
create unique index ile_one_reversal on public.instructor_ledger_entries (reverses_id) where reverses_id is not null;
create unique index ile_one_withdrawal_entry on public.instructor_ledger_entries (withdrawal_id, entry_type) where entry_type in ('withdrawal','withdrawal_release');
create index ile_by_instructor on public.instructor_ledger_entries (instructor_id, period_month);
create index ile_by_enrolment on public.instructor_ledger_entries (enrolment_id) where enrolment_id is not null;
create trigger trg_ile_no_update before update or delete on public.instructor_ledger_entries for each row execute function private.block_mutation();
create trigger trg_ile_no_truncate before truncate on public.instructor_ledger_entries for each statement execute function private.block_mutation();

create table public.instructor_pending_earnings (
  id uuid primary key default gen_random_uuid(),
  instructor_id uuid not null references public.profiles(id),
  session_id uuid not null references public.class_sessions(id),
  enrolment_id uuid not null references public.enrolments(id),
  student_id uuid references public.students(id), course_id uuid references public.courses(id), centre_id uuid references public.centres(id),
  lesson_no integer, allocated_tuition bigint not null, total_sessions integer not null, rate_bp integer not null,
  amount bigint not null check (amount > 0),
  period_month date not null,
  created_at timestamptz not null default now(),
  released_at timestamptz, voided_at timestamptz,
  unique (session_id, enrolment_id)
);

create table public.instructor_session_posts (
  session_id uuid primary key references public.class_sessions(id),
  instructor_id uuid not null references public.profiles(id),
  posted_at timestamptz not null default now(),
  earning_count integer not null default 0,
  total bigint not null default 0
);

create table public.instructor_earning_errors (
  id bigint generated always as identity primary key,
  occurred_at timestamptz not null default now(),
  session_id uuid, enrolment_id uuid, error text not null, resolved_at timestamptz
);
create unique index instructor_earning_errors_open on public.instructor_earning_errors (session_id) where resolved_at is null and session_id is not null;

-- ---------------------------------------------------------------- RLS
alter table public.instructor_payout_accounts enable row level security;
alter table public.instructor_withdrawals enable row level security;
alter table public.instructor_ledger_entries enable row level security;
alter table public.instructor_pending_earnings enable row level security;
alter table public.instructor_session_posts enable row level security;
alter table public.instructor_earning_errors enable row level security;

create policy ipa_select on public.instructor_payout_accounts for select to authenticated using (instructor_id = (select auth.uid()) or private.is_admin());
create policy iw_select on public.instructor_withdrawals for select to authenticated using (instructor_id = (select auth.uid()) or private.is_admin());
create policy ile_select on public.instructor_ledger_entries for select to authenticated using (instructor_id = (select auth.uid()) or private.is_admin());
create policy ipe_select on public.instructor_pending_earnings for select to authenticated using (instructor_id = (select auth.uid()) or private.is_admin());
create policy isp_select on public.instructor_session_posts for select to authenticated using (private.is_admin());
create policy iee_select on public.instructor_earning_errors for select to authenticated using (private.is_admin());

revoke all on public.instructor_payout_accounts, public.instructor_withdrawals, public.instructor_ledger_entries,
  public.instructor_pending_earnings, public.instructor_session_posts, public.instructor_earning_errors from anon, authenticated;
grant select on public.instructor_payout_accounts, public.instructor_withdrawals, public.instructor_ledger_entries,
  public.instructor_pending_earnings, public.instructor_session_posts, public.instructor_earning_errors to authenticated;

create trigger trg_iw_updated_at before update on public.instructor_withdrawals for each row execute function private.set_updated_at();
create trigger trg_ipa_updated_at before update on public.instructor_payout_accounts for each row execute function private.set_updated_at();
create trigger audit_instructor_withdrawals after insert or delete or update on public.instructor_withdrawals for each row execute function private.audit_row('id');
create trigger audit_instructor_payout_accounts after insert or delete or update on public.instructor_payout_accounts for each row execute function private.audit_row('instructor_id');

-- ---------------------------------------------------------------- helpers
create or replace function private.lagos_today() returns date language sql stable set search_path = '' as $f$
  select (now() at time zone 'Africa/Lagos')::date $f$;
create or replace function private.lagos_month() returns date language sql stable set search_path = '' as $f$
  select date_trunc('month', now() at time zone 'Africa/Lagos')::date $f$;

create or replace function private.is_instructor() returns boolean language sql stable security definer set search_path = '' as $f$
  select exists (select 1 from public.user_roles r where r.user_id = (select auth.uid()) and r.is_active and r.role = 'instructor') $f$;

-- Latest month (first-of-month date) whose income may be withdrawn today. Same rule as centre directors: opens on the last day of the month.
create or replace function private.eligible_through() returns date language sql stable security definer set search_path = '' as $f$
  select case when private.lagos_today() >= ((private.lagos_month() + interval '1 month')::date - 1 - private.setting_int('withdraw_opens_days_before_month_end', 0))
              then private.lagos_month() else (private.lagos_month() - interval '1 month')::date end $f$;

create or replace function private.earnings_since() returns timestamptz language sql stable security definer set search_path = '' as $f$
  select coalesce((select (value #>> '{}')::timestamptz from public.app_settings where key = 'instructor_earnings_since'), 'infinity'::timestamptz) $f$;

create or replace function private.enrolment_base(p_enrolment uuid) returns bigint language sql stable security definer set search_path = '' as $f$
  select case when e.plan = 'instalment' and coalesce(pk.price_full, 0) > 0 then least(pk.price_full, e.total_amount) else e.total_amount end
    from public.enrolments e join public.packages pk on pk.id = e.package_id where e.id = p_enrolment $f$;

create or replace function private.course_allocation(p_enrolment uuid, p_course uuid) returns bigint language sql stable security definer set search_path = '' as $f$
  with c as (select course_id, row_number() over (order by sequence_no, course_id) rn, count(*) over () n
               from public.enrolment_courses where enrolment_id = p_enrolment),
       b as (select private.enrolment_base(p_enrolment) base)
  select (b.base / c.n) + case when c.rn <= (b.base % c.n) then 1 else 0 end from c, b where c.course_id = p_course $f$;

create or replace function private.enrolment_collected(p_enrolment uuid) returns bigint language sql stable security definer set search_path = '' as $f$
  select greatest(0, least(private.enrolment_base(p_enrolment), coalesce((select sum(p.amount - p.refunded_amount) from public.payments p
          where p.enrolment_id = p_enrolment and p.status in ('succeeded','partially_refunded','refunded')), 0))) $f$;

-- Share for the k-th of N classes: cumulative floors, so the N shares add up to exactly floor(A * rate / 10000).
create or replace function private.earning_amount(p_alloc bigint, p_rate_bp integer, p_total integer, p_k integer) returns bigint language sql immutable set search_path = '' as $f$
  select ((p_alloc * p_rate_bp * p_k) / (10000::bigint * p_total)) - ((p_alloc * p_rate_bp * (p_k - 1)) / (10000::bigint * p_total)) $f$;

create or replace function private.accrue_earning(p_session uuid, p_student uuid) returns text
language plpgsql security definer set search_path = '' as $f$
declare
  s public.class_sessions%rowtype; a public.attendance%rowtype;
  v_total integer; v_lesson integer; v_k integer; v_rate integer; v_alloc bigint; v_amt bigint; v_cap bigint; v_net bigint; v_month date; v_blocked boolean;
begin
  select * into s from public.class_sessions where id = p_session;
  if not found or s.status <> 'completed' or s.is_emergency or s.instructor_id is null then return 'skip'; end if;
  select * into a from public.attendance where session_id = p_session and student_id = p_student;
  if not found or a.status <> 'present' or a.enrolment_id is null then return 'skip'; end if;
  perform pg_advisory_xact_lock(hashtextextended(a.enrolment_id::text, 0));
  if not exists (select 1 from public.enrolment_courses ec where ec.enrolment_id = a.enrolment_id and ec.course_id = s.course_id) then return 'skip_not_enrolled'; end if;
  if exists (select 1 from public.instructor_ledger_entries l where l.session_id = p_session and l.enrolment_id = a.enrolment_id and l.entry_type = 'earning')
     or exists (select 1 from public.instructor_pending_earnings q where q.session_id = p_session and q.enrolment_id = a.enrolment_id) then return 'exists'; end if;

  select c.total_sessions into v_total from public.courses c where c.id = s.course_id;
  select l.lesson_no into v_lesson from public.course_lessons l where l.id = s.lesson_id;
  if coalesce(v_total, 0) <= 0 then return 'skip_no_allocation'; end if;
  v_k := least(greatest(coalesce(v_lesson, s.session_no, 1), 1), v_total);

  -- a lesson is paid once per enrolment, whichever run (own or make-up) it was attended in
  if exists (select 1 from public.instructor_ledger_entries l where l.enrolment_id = a.enrolment_id and l.course_id = s.course_id
               and l.lesson_no = v_k and l.entry_type = 'earning' and l.session_id <> p_session)
     or exists (select 1 from public.instructor_pending_earnings q where q.enrolment_id = a.enrolment_id and q.course_id = s.course_id
               and q.lesson_no = v_k and q.session_id <> p_session and q.voided_at is null) then return 'duplicate_lesson'; end if;

  v_rate := private.setting_int('instructor_share_bp', 2000);
  v_alloc := private.course_allocation(a.enrolment_id, s.course_id);
  if v_alloc is null then return 'skip_no_allocation'; end if;
  v_amt := private.earning_amount(v_alloc, v_rate, v_total, v_k);
  if v_amt <= 0 then return 'zero'; end if;
  v_month := date_trunc('month', s.session_date)::date;

  v_cap := (private.enrolment_collected(a.enrolment_id) * v_rate) / 10000;
  select coalesce(sum(l.amount), 0) into v_net from public.instructor_ledger_entries l
   where l.enrolment_id = a.enrolment_id and l.entry_type in ('earning','earning_reversal','earning_restore');
  v_blocked := exists (select 1 from public.instructor_pending_earnings q where q.enrolment_id = a.enrolment_id and q.released_at is null and q.voided_at is null);

  if not v_blocked and v_net + v_amt <= v_cap then
    insert into public.instructor_ledger_entries (instructor_id, entry_type, amount, period_month, session_id, enrolment_id, student_id, course_id, centre_id,
           lesson_no, allocated_tuition, total_sessions, rate_bp, description)
    values (s.instructor_id, 'earning', v_amt, v_month, p_session, a.enrolment_id, p_student, s.course_id, s.centre_id, v_k, v_alloc, v_total, v_rate,
            'Class ' || v_k || ' of ' || v_total);
    return 'posted';
  end if;
  insert into public.instructor_pending_earnings (instructor_id, session_id, enrolment_id, student_id, course_id, centre_id, lesson_no,
         allocated_tuition, total_sessions, rate_bp, amount, period_month)
  values (s.instructor_id, p_session, a.enrolment_id, p_student, s.course_id, s.centre_id, v_k, v_alloc, v_total, v_rate, v_amt, v_month);
  return 'pending';
end $f$;

-- Move waiting (unfunded) earnings into the ledger as far as collected tuition now allows, oldest first.
create or replace function private.release_pending(p_enrolment uuid) returns integer
language plpgsql security definer set search_path = '' as $f$
declare q public.instructor_pending_earnings%rowtype; v_cap bigint; v_net bigint; v_n integer := 0;
begin
  perform pg_advisory_xact_lock(hashtextextended(p_enrolment::text, 0));
  for q in select * from public.instructor_pending_earnings where enrolment_id = p_enrolment and released_at is null and voided_at is null order by created_at, id loop
    v_cap := (private.enrolment_collected(p_enrolment) * q.rate_bp) / 10000;
    select coalesce(sum(l.amount), 0) into v_net from public.instructor_ledger_entries l
     where l.enrolment_id = p_enrolment and l.entry_type in ('earning','earning_reversal','earning_restore');
    exit when v_net + q.amount > v_cap;
    insert into public.instructor_ledger_entries (instructor_id, entry_type, amount, period_month, session_id, enrolment_id, student_id, course_id, centre_id,
           lesson_no, allocated_tuition, total_sessions, rate_bp, description)
    values (q.instructor_id, 'earning', q.amount, q.period_month, q.session_id, q.enrolment_id, q.student_id, q.course_id, q.centre_id, q.lesson_no,
            q.allocated_tuition, q.total_sessions, q.rate_bp, 'Class ' || q.lesson_no || ' of ' || q.total_sessions || ' (funded later)');
    update public.instructor_pending_earnings set released_at = now() where id = q.id;
    v_n := v_n + 1;
  end loop;
  return v_n;
end $f$;

-- A finalised attendance row changed: reverse, restore or post the matching earning (never edit history).
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
    values (e.instructor_id, 'earning_reversal', -e.amount, e.period_month, e.session_id, e.enrolment_id, e.student_id, e.course_id, e.centre_id,
            e.lesson_no, e.allocated_tuition, e.total_sessions, e.rate_bp, v_last.id, 'Attendance changed after posting');
  elsif p_present and v_last.entry_type = 'earning_reversal' then
    insert into public.instructor_ledger_entries (instructor_id, entry_type, amount, period_month, session_id, enrolment_id, student_id, course_id, centre_id,
           lesson_no, allocated_tuition, total_sessions, rate_bp, reverses_id, description)
    values (e.instructor_id, 'earning_restore', e.amount, e.period_month, e.session_id, e.enrolment_id, e.student_id, e.course_id, e.centre_id,
            e.lesson_no, e.allocated_tuition, e.total_sessions, e.rate_bp, v_last.id, 'Attendance restored');
  end if;
end $f$;

-- Post every present student of one finished class, exactly once. Runs when the class is completed AND its check-in grace has passed.
create or replace function private.post_session_earnings(p_session uuid, p_force boolean default false) returns integer
language plpgsql security definer set search_path = '' as $f$
declare s public.class_sessions%rowtype; r record; v_n integer := 0; v_total bigint; v_title text;
begin
  select * into s from public.class_sessions where id = p_session for update;
  if not found or s.status <> 'completed' or s.is_emergency or s.instructor_id is null then return 0; end if;
  if s.completed_at is null or s.completed_at < private.earnings_since() then return 0; end if;
  if exists (select 1 from public.instructor_session_posts where session_id = p_session) then return 0; end if;
  if not p_force and now() < s.end_at + make_interval(mins => private.setting_int('checkin_grace_minutes_after_end', 30)) then return 0; end if;
  insert into public.instructor_session_posts (session_id, instructor_id) values (p_session, s.instructor_id);
  for r in select student_id from public.attendance where session_id = p_session and status = 'present' order by student_id loop
    if private.accrue_earning(p_session, r.student_id) = 'posted' then v_n := v_n + 1; end if;
  end loop;
  select coalesce(sum(amount), 0) into v_total from public.instructor_ledger_entries where session_id = p_session and entry_type = 'earning';
  update public.instructor_session_posts set earning_count = v_n, total = v_total where session_id = p_session;
  if v_total > 0 then
    select title into v_title from public.courses where id = s.course_id;
    perform private.notify(array[s.instructor_id], 'earning_posted', 'Class earnings posted',
      private.fmt_naira(v_total) || ' from ' || coalesce(v_title, 'your class') || ' on ' || to_char(s.session_date, 'Dy DD Mon') || '.',
      jsonb_build_object('session_id', p_session, 'amount', v_total));
  end if;
  return v_n;
end $f$;

create or replace function private.post_due_session_earnings() returns integer
language plpgsql security definer set search_path = '' as $f$
declare r record; v_n integer := 0;
begin
  for r in select s.id from public.class_sessions s
            where s.status = 'completed' and not s.is_emergency and s.instructor_id is not null and s.completed_at >= private.earnings_since()
              and s.end_at + make_interval(mins => private.setting_int('checkin_grace_minutes_after_end', 30)) <= now()
              and not exists (select 1 from public.instructor_session_posts p where p.session_id = s.id)
            order by s.end_at limit 200 loop
    begin
      v_n := v_n + private.post_session_earnings(r.id);
      update public.instructor_earning_errors set resolved_at = now() where session_id = r.id and resolved_at is null;
    exception when others then
      insert into public.instructor_earning_errors (session_id, error) values (r.id, sqlerrm)
      on conflict (session_id) where resolved_at is null and session_id is not null do update set error = excluded.error, occurred_at = now();
    end;
  end loop;
  return v_n;
end $f$;

-- ---------------------------------------------------------------- withdrawals
create or replace function private.release_withdrawal(p_id uuid) returns void language plpgsql security definer set search_path = '' as $f$
declare w public.instructor_withdrawals%rowtype; v_month date;
begin
  select * into w from public.instructor_withdrawals where id = p_id;
  select period_month into v_month from public.instructor_ledger_entries where withdrawal_id = p_id and entry_type = 'withdrawal';
  if v_month is null then return; end if;
  insert into public.instructor_ledger_entries (instructor_id, entry_type, amount, period_month, withdrawal_id, description)
  values (w.instructor_id, 'withdrawal_release', w.amount, v_month, p_id, 'Withdrawal ' || coalesce(w.reference, '') || ' returned to balance')
  on conflict (withdrawal_id, entry_type) where entry_type in ('withdrawal','withdrawal_release') do nothing;
end $f$;

create or replace function private.fail_instructor_withdrawal(p_id uuid, p_reason text, p_allow_paid boolean default false) returns void
language plpgsql security definer set search_path = '' as $f$
declare w public.instructor_withdrawals%rowtype;
begin
  select * into w from public.instructor_withdrawals where id = p_id for update;
  if not found then return; end if;
  if w.status = 'processing' or (p_allow_paid and w.status = 'paid') then
    update public.instructor_withdrawals set status = 'failed', failure_reason = p_reason where id = p_id;
    perform private.release_withdrawal(p_id);
    perform private.notify(array[w.instructor_id], 'withdrawal_failed', 'Withdrawal did not go through',
      private.fmt_naira(w.amount) || ' is back in your balance. ' || coalesce(p_reason, ''), jsonb_build_object('withdrawal_id', p_id));
    perform private.notify(private.admin_ids(), 'payout_failed', 'Instructor payout failed',
      'Withdrawal ' || coalesce(w.reference, '') || ' failed: ' || coalesce(p_reason, 'unknown reason'), jsonb_build_object('withdrawal_id', p_id));
  end if;
end $f$;

create or replace function private.handle_instructor_transfer(p_reference text, p_status text, p_transfer_code text, p_raw jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $f$
declare w public.instructor_withdrawals%rowtype;
begin
  select * into w from public.instructor_withdrawals where reference = p_reference for update;
  if not found then return jsonb_build_object('ok', false, 'reason', 'transfer_not_found'); end if;
  if p_status = 'success' then
    if w.status = 'processing' then
      update public.instructor_withdrawals set status = 'paid', paid_at = now(), raw = p_raw,
             provider_transfer_code = coalesce(p_transfer_code, provider_transfer_code) where id = w.id;
      perform private.notify(array[w.instructor_id], 'withdrawal_paid', 'Withdrawal sent',
        private.fmt_naira(w.amount) || ' has been sent to your bank account.', jsonb_build_object('withdrawal_id', w.id));
    end if;
  elsif p_status in ('failed','reversed') then
    perform private.fail_instructor_withdrawal(w.id, 'Transfer ' || p_status, p_status = 'reversed');
  end if;
  return jsonb_build_object('ok', true, 'withdrawal_id', w.id);
end $f$;

create or replace function public.request_instructor_withdrawal() returns uuid
language plpgsql security definer set search_path = '' as $f$
declare
  v_uid uuid := (select auth.uid()); v_elig date := private.eligible_through(); v_acc public.instructor_payout_accounts%rowtype;
  v_avail bigint; v_id uuid; v_name text;
begin
  if v_uid is null then raise exception 'not_authenticated' using errcode = '28000'; end if;
  if not private.is_instructor() then raise exception 'forbidden' using errcode = '42501'; end if;
  perform 1 from public.profiles where id = v_uid for update;            -- one request at a time per instructor
  if exists (select 1 from public.instructor_withdrawals where instructor_id = v_uid and status in ('draft','processing')) then raise exception 'withdrawal_pending'; end if;
  select * into v_acc from public.instructor_payout_accounts where instructor_id = v_uid;
  if v_acc.provider_recipient_code is null then raise exception 'no_payout_account'; end if;
  select coalesce(sum(amount), 0) into v_avail from public.instructor_ledger_entries where instructor_id = v_uid and period_month <= v_elig;
  if v_avail <= 0 then raise exception 'nothing_to_withdraw'; end if;
  if v_avail < private.setting_int('min_payout_kobo', 0) then raise exception 'below_minimum'; end if;

  insert into public.instructor_withdrawals (instructor_id, amount, eligible_through, recipient_code, bank_name, account_name, account_last4, name_match, created_by)
  values (v_uid, v_avail, v_elig, v_acc.provider_recipient_code, v_acc.bank_name, v_acc.account_name, v_acc.account_last4, v_acc.name_match, v_uid)
  returning id into v_id;
  insert into public.instructor_ledger_entries (instructor_id, entry_type, amount, period_month, withdrawal_id, description, created_by)
  values (v_uid, 'withdrawal', -v_avail, v_elig, v_id, 'Withdrawal requested', v_uid);

  select coalesce(full_name, 'An instructor') into v_name from public.profiles where id = v_uid;
  perform private.notify(private.admin_ids(), 'instructor_withdrawal_requested', 'Instructor withdrawal requested',
    v_name || ' asked to withdraw ' || private.fmt_naira(v_avail) || '. Review it in Payouts.', jsonb_build_object('withdrawal_id', v_id));
  perform private.notify(array[v_uid], 'withdrawal_submitted', 'Withdrawal requested',
    private.fmt_naira(v_avail) || ' is reserved while we review your request.', jsonb_build_object('withdrawal_id', v_id));
  return v_id;
end $f$;

create or replace function public.cancel_instructor_withdrawal(p_id uuid) returns void
language plpgsql security definer set search_path = '' as $f$
declare w public.instructor_withdrawals%rowtype;
begin
  select * into w from public.instructor_withdrawals where id = p_id for update;
  if not found then raise exception 'withdrawal_not_found'; end if;
  if not (private.is_admin() or w.instructor_id = (select auth.uid())) then raise exception 'forbidden' using errcode = '42501'; end if;
  if w.status <> 'draft' then raise exception 'withdrawal_not_draft'; end if;
  update public.instructor_withdrawals set status = 'cancelled' where id = p_id;
  perform private.release_withdrawal(p_id);
end $f$;

create or replace function public.approve_instructor_withdrawal(p_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $f$
declare w public.instructor_withdrawals%rowtype; acc public.instructor_payout_accounts%rowtype; v_ref text;
begin
  if not (private.is_privileged() or private.is_admin()) then raise exception 'forbidden' using errcode = '42501'; end if;
  select * into w from public.instructor_withdrawals where id = p_id for update;
  if not found then raise exception 'withdrawal_not_found'; end if;
  if w.status <> 'draft' then raise exception 'withdrawal_not_draft'; end if;
  if coalesce(w.instructor_id = (select auth.uid()), false) then raise exception 'cannot_approve_own' using errcode = '42501'; end if;
  select * into acc from public.instructor_payout_accounts where instructor_id = w.instructor_id;
  if acc.provider_recipient_code is null then raise exception 'no_payout_account'; end if;
  v_ref := 'ipo-' || to_char(now(), 'YYMM') || '-' || lower(substr(replace(gen_random_uuid()::text, '-', ''), 1, 10));
  update public.instructor_withdrawals
     set status = 'processing', reference = v_ref, recipient_code = acc.provider_recipient_code, bank_name = acc.bank_name,
         account_name = acc.account_name, account_last4 = acc.account_last4, name_match = acc.name_match,
         reviewed_by = (select auth.uid()), reviewed_at = now(), attempts = attempts + 1
   where id = p_id;
  perform private.notify(array[w.instructor_id], 'withdrawal_processing', 'Withdrawal approved',
    private.fmt_naira(w.amount) || ' is on its way to your bank account.', jsonb_build_object('withdrawal_id', p_id));
  return jsonb_build_object('withdrawal_id', p_id, 'reference', v_ref, 'amount', w.amount, 'currency', w.currency, 'recipient_code', acc.provider_recipient_code);
end $f$;

create or replace function public.reject_instructor_withdrawal(p_id uuid, p_reason text) returns void
language plpgsql security definer set search_path = '' as $f$
declare w public.instructor_withdrawals%rowtype; v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
begin
  if not private.is_admin() then raise exception 'forbidden' using errcode = '42501'; end if;
  if v_reason is null or char_length(v_reason) < 3 then raise exception 'reason_required'; end if;
  select * into w from public.instructor_withdrawals where id = p_id for update;
  if not found then raise exception 'withdrawal_not_found'; end if;
  if w.status <> 'draft' then raise exception 'withdrawal_not_draft'; end if;
  if w.instructor_id = (select auth.uid()) then raise exception 'cannot_approve_own' using errcode = '42501'; end if;
  update public.instructor_withdrawals set status = 'rejected', reject_reason = v_reason, reviewed_by = (select auth.uid()), reviewed_at = now() where id = p_id;
  perform private.release_withdrawal(p_id);
  perform private.notify(array[w.instructor_id], 'withdrawal_rejected', 'Withdrawal not approved',
    private.fmt_naira(w.amount) || ' is back in your balance. Reason: ' || v_reason, jsonb_build_object('withdrawal_id', p_id));
end $f$;

create or replace function public.fail_instructor_withdrawal(p_id uuid, p_reason text default null) returns void
language plpgsql security definer set search_path = '' as $f$
begin
  if not (private.is_privileged() or private.is_admin()) then raise exception 'forbidden' using errcode = '42501'; end if;
  perform private.fail_instructor_withdrawal(p_id, p_reason, false);
end $f$;

-- ---------------------------------------------------------------- instructor reads
create or replace function public.instructor_wallet() returns jsonb
language plpgsql stable security definer set search_path = '' as $f$
declare
  v_uid uuid := (select auth.uid()); v_elig date := private.eligible_through(); v_cur date := private.lagos_month();
  v_bal bigint; v_avail bigint; v_life bigint; v_month bigint; v_reserved bigint; v_paid bigint; v_unfunded bigint;
  v_acc public.instructor_payout_accounts%rowtype; v_open public.instructor_withdrawals%rowtype; v_min integer := private.setting_int('min_payout_kobo', 0);
  v_opens date := (v_cur + interval '1 month')::date - 1 - private.setting_int('withdraw_opens_days_before_month_end', 0);
begin
  if v_uid is null then raise exception 'not_authenticated' using errcode = '28000'; end if;
  if not private.is_instructor() then raise exception 'forbidden' using errcode = '42501'; end if;
  select coalesce(sum(amount), 0),
         coalesce(sum(amount) filter (where period_month <= v_elig), 0),
         coalesce(sum(amount) filter (where entry_type in ('earning','earning_reversal','earning_restore','adjustment')), 0),
         coalesce(sum(amount) filter (where entry_type in ('earning','earning_reversal','earning_restore','adjustment') and period_month = v_cur), 0)
    into v_bal, v_avail, v_life, v_month from public.instructor_ledger_entries where instructor_id = v_uid;
  select coalesce(sum(amount) filter (where status in ('draft','processing')), 0), coalesce(sum(amount) filter (where status = 'paid'), 0)
    into v_reserved, v_paid from public.instructor_withdrawals where instructor_id = v_uid;
  select coalesce(sum(amount), 0) into v_unfunded from public.instructor_pending_earnings where instructor_id = v_uid and released_at is null and voided_at is null;
  select * into v_acc from public.instructor_payout_accounts where instructor_id = v_uid;
  select * into v_open from public.instructor_withdrawals where instructor_id = v_uid and status in ('draft','processing');
  return jsonb_build_object(
    'balance', v_bal, 'available', v_avail, 'lifetime', v_life, 'this_month', v_month, 'reserved', v_reserved, 'paid_out', v_paid, 'unfunded', v_unfunded,
    'eligible_through', v_elig, 'opens_on', v_opens, 'min_payout', v_min,
    'can_withdraw', v_avail > 0 and v_avail >= v_min and v_acc.provider_recipient_code is not null and v_open.id is null,
    'account', case when v_acc.provider_recipient_code is null then null else jsonb_build_object('bank_name', v_acc.bank_name, 'account_name', v_acc.account_name, 'account_last4', v_acc.account_last4) end,
    'open_withdrawal', case when v_open.id is null then null else jsonb_build_object('id', v_open.id, 'amount', v_open.amount, 'status', v_open.status, 'created_at', v_open.created_at) end,
    'months', coalesce((select jsonb_agg(m order by m.month desc) from (
        select l.period_month as month,
               coalesce(sum(l.amount) filter (where l.entry_type in ('earning','earning_reversal','earning_restore','adjustment')), 0) as earned,
               coalesce(-sum(l.amount) filter (where l.entry_type in ('withdrawal','withdrawal_release')), 0) as withdrawn,
               l.period_month <= v_elig as open
          from public.instructor_ledger_entries l where l.instructor_id = v_uid group by l.period_month order by l.period_month desc limit 12) m), '[]'::jsonb));
end $f$;

-- Earnings history: one line per class (students counted net of reversals), plus adjustments.
create or replace function public.instructor_earnings(p_limit integer default 50, p_offset integer default 0) returns jsonb
language sql stable security definer set search_path = '' as $f$
  select coalesce(jsonb_agg(x order by x.at desc), '[]'::jsonb) from (
    select * from (
      select 'class'::text as kind, s.id::text as id, max(l.created_at) as at, s.session_date as day, c.title as course, ce.name as centre, ce.city as city,
             (count(*) filter (where l.entry_type in ('earning','earning_restore')) - count(*) filter (where l.entry_type = 'earning_reversal'))::int as students,
             sum(l.amount)::bigint as amount, null::text as note
        from public.instructor_ledger_entries l
        join public.class_sessions s on s.id = l.session_id join public.courses c on c.id = s.course_id join public.centres ce on ce.id = s.centre_id
       where l.instructor_id = (select auth.uid()) and l.entry_type in ('earning','earning_reversal','earning_restore')
       group by s.id, c.title, ce.name, ce.city
      union all
      select 'adjustment', l.id::text, l.created_at, l.created_at::date, null, null, null, null, l.amount, l.description
        from public.instructor_ledger_entries l where l.instructor_id = (select auth.uid()) and l.entry_type = 'adjustment'
    ) u where private.is_instructor() order by at desc limit greatest(1, least(p_limit, 200)) offset greatest(0, p_offset)
  ) x $f$;

-- Per-student breakdown of one class the caller taught. Names only: the instructor already sees this roster.
create or replace function public.instructor_earning_breakdown(p_session_id uuid) returns jsonb
language sql stable security definer set search_path = '' as $f$
  select coalesce(jsonb_agg(x order by x.name), '[]'::jsonb) from (
    select coalesce(nullif(trim(p.full_name), ''), 'Student') as name, max(l.allocated_tuition)::bigint as course_tuition, max(l.total_sessions) as classes,
           max(l.lesson_no) as lesson_no, max(l.rate_bp) as rate_bp, sum(l.amount)::bigint as amount
      from public.instructor_ledger_entries l join public.profiles p on p.id = l.student_id
     where l.session_id = p_session_id and l.instructor_id = (select auth.uid()) and l.entry_type in ('earning','earning_reversal','earning_restore')
       and private.is_instructor()
     group by l.enrolment_id, p.full_name
  ) x $f$;

create or replace function public.my_payout_scope() returns jsonb language sql stable security definer set search_path = '' as $f$
  select jsonb_build_object('admin', private.is_admin(), 'instructor', private.is_instructor(),
    'centre_ids', coalesce((select jsonb_agg(distinct r.centre_id) from public.user_roles r
        where r.user_id = (select auth.uid()) and r.is_active and r.role = 'centre_director' and r.centre_id is not null), '[]'::jsonb)) $f$;

-- ---------------------------------------------------------------- admin
create or replace function public.admin_instructor_wallets(p_search text default null) returns jsonb
language plpgsql stable security definer set search_path = '' as $f$
begin
  if not private.is_admin() then raise exception 'forbidden' using errcode = '42501'; end if;
  return (select coalesce(jsonb_agg(x order by x.name), '[]'::jsonb) from (
    select p.id, coalesce(nullif(trim(p.full_name), ''), p.email) as name, p.email,
           coalesce((select sum(l.amount) from public.instructor_ledger_entries l where l.instructor_id = p.id), 0)::bigint as balance,
           coalesce((select sum(l.amount) from public.instructor_ledger_entries l where l.instructor_id = p.id and l.entry_type in ('earning','earning_reversal','earning_restore','adjustment')), 0)::bigint as lifetime,
           coalesce((select sum(w.amount) from public.instructor_withdrawals w where w.instructor_id = p.id and w.status in ('draft','processing')), 0)::bigint as reserved,
           coalesce((select sum(w.amount) from public.instructor_withdrawals w where w.instructor_id = p.id and w.status = 'paid'), 0)::bigint as paid_out,
           coalesce((select sum(q.amount) from public.instructor_pending_earnings q where q.instructor_id = p.id and q.released_at is null and q.voided_at is null), 0)::bigint as unfunded,
           exists (select 1 from public.instructor_payout_accounts a where a.instructor_id = p.id and a.provider_recipient_code is not null) as has_account
      from public.profiles p
     where exists (select 1 from public.user_roles r where r.user_id = p.id and r.role = 'instructor' and r.is_active)
       and (p_search is null or p.full_name ilike '%' || p_search || '%' or p.email ilike '%' || p_search || '%')) x);
end $f$;

create or replace function public.admin_instructor_withdrawals(p_limit integer default 100) returns jsonb
language plpgsql stable security definer set search_path = '' as $f$
begin
  if not private.is_admin() then raise exception 'forbidden' using errcode = '42501'; end if;
  return (select coalesce(jsonb_agg(x order by x.created_at desc), '[]'::jsonb) from (
    select w.id, w.reference, w.amount, w.status, w.created_at, w.paid_at, w.reject_reason, w.failure_reason, w.attempts, w.eligible_through,
           w.bank_name, w.account_name, w.account_last4, w.name_match, coalesce(nullif(trim(p.full_name), ''), p.email) as instructor, w.instructor_id
      from public.instructor_withdrawals w join public.profiles p on p.id = w.instructor_id
     order by w.created_at desc limit greatest(1, least(p_limit, 500))) x);
end $f$;

create or replace function public.admin_instructor_earnings(p_instructor uuid default null, p_centre uuid default null, p_course uuid default null,
  p_from date default null, p_to date default null, p_limit integer default 100, p_offset integer default 0) returns jsonb
language plpgsql stable security definer set search_path = '' as $f$
begin
  if not private.is_admin() then raise exception 'forbidden' using errcode = '42501'; end if;
  return (select coalesce(jsonb_agg(x order by x.day desc, x.instructor), '[]'::jsonb) from (
    select s.id as session_id, s.session_date as day, coalesce(nullif(trim(p.full_name), ''), p.email) as instructor, l.instructor_id, c.title as course, ce.name as centre,
           s.run_id, (count(*) filter (where l.entry_type in ('earning','earning_restore')) - count(*) filter (where l.entry_type = 'earning_reversal'))::int as students,
           sum(l.amount)::bigint as amount, max(l.rate_bp) as rate_bp
      from public.instructor_ledger_entries l
      join public.class_sessions s on s.id = l.session_id join public.courses c on c.id = s.course_id
      join public.centres ce on ce.id = s.centre_id join public.profiles p on p.id = l.instructor_id
     where l.entry_type in ('earning','earning_reversal','earning_restore')
       and (p_instructor is null or l.instructor_id = p_instructor) and (p_centre is null or s.centre_id = p_centre) and (p_course is null or s.course_id = p_course)
       and (p_from is null or s.session_date >= p_from) and (p_to is null or s.session_date <= p_to)
     group by s.id, p.full_name, p.email, l.instructor_id, c.title, ce.name
     order by s.session_date desc limit greatest(1, least(p_limit, 500)) offset greatest(0, p_offset)) x);
end $f$;

create or replace function public.admin_instructor_exceptions() returns jsonb
language plpgsql stable security definer set search_path = '' as $f$
declare v_grace integer := private.setting_int('checkin_grace_minutes_after_end', 30);
begin
  if not private.is_admin() then raise exception 'forbidden' using errcode = '42501'; end if;
  return jsonb_build_object(
    'missing_posts', coalesce((select jsonb_agg(jsonb_build_object('session_id', s.id, 'day', s.session_date, 'course', c.title, 'instructor_id', s.instructor_id))
        from public.class_sessions s join public.courses c on c.id = s.course_id
       where s.status = 'completed' and not s.is_emergency and s.instructor_id is not null and s.completed_at >= private.earnings_since()
         and s.end_at + make_interval(mins => v_grace) + interval '30 minutes' <= now()
         and not exists (select 1 from public.instructor_session_posts p where p.session_id = s.id)), '[]'::jsonb),
    'no_instructor', coalesce((select jsonb_agg(jsonb_build_object('session_id', s.id, 'day', s.session_date, 'course', c.title))
        from public.class_sessions s join public.courses c on c.id = s.course_id
       where s.status = 'completed' and not s.is_emergency and s.instructor_id is null and s.completed_at >= private.earnings_since()
         and exists (select 1 from public.attendance a where a.session_id = s.id and a.status = 'present')), '[]'::jsonb),
    'unfunded', coalesce((select jsonb_agg(jsonb_build_object('session_id', q.session_id, 'enrolment_id', q.enrolment_id, 'instructor_id', q.instructor_id, 'amount', q.amount, 'since', q.created_at))
        from public.instructor_pending_earnings q where q.released_at is null and q.voided_at is null), '[]'::jsonb),
    'errors', coalesce((select jsonb_agg(jsonb_build_object('session_id', e.session_id, 'error', e.error, 'at', e.occurred_at))
        from public.instructor_earning_errors e where e.resolved_at is null), '[]'::jsonb),
    'stuck_withdrawals', coalesce((select jsonb_agg(jsonb_build_object('id', w.id, 'reference', w.reference, 'amount', w.amount, 'status', w.status, 'since', w.updated_at))
        from public.instructor_withdrawals w where w.status = 'processing' and w.updated_at < now() - interval '2 hours'), '[]'::jsonb),
    'negative_balances', coalesce((select jsonb_agg(jsonb_build_object('instructor_id', t.instructor_id, 'balance', t.bal))
        from (select instructor_id, sum(amount) bal from public.instructor_ledger_entries group by instructor_id having sum(amount) < 0) t), '[]'::jsonb),
    'name_mismatch', coalesce((select jsonb_agg(jsonb_build_object('id', w.id, 'amount', w.amount, 'account_name', w.account_name))
        from public.instructor_withdrawals w where w.status = 'draft' and w.name_match is false), '[]'::jsonb));
end $f$;

create or replace function public.admin_post_session_earnings(p_session_id uuid) returns integer
language plpgsql security definer set search_path = '' as $f$
begin
  if not (private.is_privileged() or private.is_admin()) then raise exception 'forbidden' using errcode = '42501'; end if;
  return private.post_session_earnings(p_session_id, false);
end $f$;

-- The only way a balance changes by hand: a signed, reasoned, attributed entry.
create or replace function public.admin_adjust_instructor(p_instructor uuid, p_amount bigint, p_reason text) returns uuid
language plpgsql security definer set search_path = '' as $f$
declare v_reason text := nullif(btrim(coalesce(p_reason, '')), ''); v_id uuid;
begin
  if not private.is_admin() then raise exception 'forbidden' using errcode = '42501'; end if;
  if p_amount is null or p_amount = 0 then raise exception 'amount_required'; end if;
  if v_reason is null or char_length(v_reason) < 5 then raise exception 'reason_required'; end if;
  if not exists (select 1 from public.user_roles r where r.user_id = p_instructor and r.role = 'instructor' and r.is_active) then raise exception 'not_an_instructor'; end if;
  insert into public.instructor_ledger_entries (instructor_id, entry_type, amount, period_month, description, created_by)
  values (p_instructor, 'adjustment', p_amount, private.lagos_month(), v_reason, (select auth.uid())) returning id into v_id;
  perform private.notify(array[p_instructor], 'wallet_adjustment', 'Wallet adjusted',
    case when p_amount > 0 then private.fmt_naira(p_amount) || ' was added. ' else private.fmt_naira(-p_amount) || ' was deducted. ' end || v_reason,
    jsonb_build_object('entry_id', v_id));
  return v_id;
end $f$;

-- ---------------------------------------------------------------- grants (only the new RPCs; existing functions are left exactly as they were)
do $g$
declare r record;
begin
  for r in select p.oid::regprocedure as sig from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'public' and p.proname in ('request_instructor_withdrawal','cancel_instructor_withdrawal','approve_instructor_withdrawal',
              'reject_instructor_withdrawal','fail_instructor_withdrawal','instructor_wallet','instructor_earnings','instructor_earning_breakdown',
              'my_payout_scope','admin_instructor_wallets','admin_instructor_withdrawals','admin_instructor_earnings','admin_instructor_exceptions',
              'admin_post_session_earnings','admin_adjust_instructor') loop
    execute format('revoke all on function %s from public, anon', r.sig);
    execute format('grant execute on function %s to authenticated, service_role', r.sig);
  end loop;
end $g$;

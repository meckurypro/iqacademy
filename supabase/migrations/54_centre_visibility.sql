-- supabase/migrations/54_centre_visibility.sql
-- Centre directors and coordinators see their students through one narrow roster function, not through the raw tables.
-- Also: enrolment alerts for directors, a truthful "attendance by day" chart, and frozen monthly statements.
-- (Recorded in the live database as `centre_visibility`.)

-- 1. Raw student data is no longer readable by centre staff. Students still read their own rows and admins read all;
--    instructors keep the enrolment rows for the courses they teach (the app reads people through RPCs, not these tables).
create or replace function private.can_view_enrolment(p_enrolment_id uuid)
returns boolean language sql stable security definer set search_path to '' as $$
  select private.is_admin()
      or exists (select 1 from public.enrolments e
                 where e.id = p_enrolment_id
                   and (e.student_id = (select auth.uid()) or private.instructs_enrolment(e.id)))
$$;

alter policy enrolments_select on public.enrolments
  using (student_id = (select auth.uid()) or private.is_admin() or private.instructs_enrolment(id));
alter policy profiles_select on public.profiles
  using (id = (select auth.uid()) or private.is_admin());
alter policy students_select on public.students
  using (id = (select auth.uid()) or private.is_admin());

-- 2. The roster: name, reg number, photo, pack, courses, status, attendance. Never email, phone, birth date, address,
--    emergency contact or notes. Money columns are for directors and admins only (not door staff).
create or replace function public.centre_students(p_centre_id uuid)
returns jsonb language plpgsql stable security definer set search_path to '' as $$
declare v_money boolean;
begin
  if not (private.is_admin() or private.is_centre_staff(p_centre_id)) then raise exception 'forbidden' using errcode = '42501'; end if;
  v_money := private.is_admin() or private.has_role_at('centre_director', p_centre_id);
  return coalesce((select jsonb_agg(x order by x.full_name) from (
    select e.id as enrolment_id, s.student_number, p.full_name, p.avatar_url,
           pk.name as pack, pk.duration_weeks, e.plan, e.status, e.starts_on, e.ends_on, e.created_at,
           case when v_money then e.total_amount end as total_amount,
           case when v_money then e.amount_paid end as amount_paid,
           case when v_money then e.balance end as balance,
           (select coalesce(jsonb_agg(c.title order by ec.sequence_no), '[]'::jsonb)
              from public.enrolment_courses ec join public.courses c on c.id = ec.course_id where ec.enrolment_id = e.id) as courses,
           (select coalesce(sum(ec.sessions_attended), 0) from public.enrolment_courses ec where ec.enrolment_id = e.id) as attended,
           (select coalesce(sum(c.total_sessions), 0)
              from public.enrolment_courses ec join public.courses c on c.id = ec.course_id where ec.enrolment_id = e.id) as total_sessions
      from public.enrolments e
      join public.students s on s.id = e.student_id
      join public.profiles p on p.id = e.student_id
      left join public.packages pk on pk.id = e.package_id
     where e.centre_id = p_centre_id and e.status in ('active', 'pending_payment', 'completed')
  ) x), '[]'::jsonb);
end $$;

-- 3. Directors are told when a student's place is secured (their first payment lands).
create or replace function private.on_enrolment_activated()
returns trigger language plpgsql security definer set search_path to '' as $$
declare v_title text; v_date date; v_dirs uuid[]; v_name text; v_pack text; v_weeks integer;
begin
  if new.status = 'active' and old.status = 'pending_payment' then
    if new.starts_on is null or new.starts_on < (now() at time zone 'Africa/Lagos')::date then
      perform private.set_enrolment_clock(new.id, false);
    end if;
    select starts_on into v_date from public.enrolments where id = new.id;
    select c.title into v_title from public.enrolment_courses ec join public.courses c on c.id = ec.course_id
     where ec.enrolment_id = new.id and ec.sequence_no = 1;
    perform private.notify(array[new.student_id], 'enrolment_active', 'You''re in',
      case when v_date is null then 'Your place is secured. We will tell you your first class date as soon as it is set.'
           else 'Your first class is ' || coalesce(v_title, 'on') || ' at ' || private.centre_place(new.centre_id) || ', ' || to_char(v_date, 'Dy DD Mon') || '.' end,
      jsonb_build_object('enrolment_id', new.id, 'starts_on', v_date));

    select array_agg(r.user_id) into v_dirs from public.user_roles r
     where r.centre_id = new.centre_id and r.role = 'centre_director' and r.is_active;
    select p.full_name into v_name from public.profiles p where p.id = new.student_id;
    select pk.name, pk.duration_weeks into v_pack, v_weeks from public.packages pk where pk.id = new.package_id;
    perform private.notify(v_dirs, 'centre_enrolment', 'New student enrolled',
      coalesce(v_name, 'A student') || ' joined' || coalesce(' the ' || v_pack, '') || coalesce(' (' || v_weeks || ' weeks)', '') || '.',
      jsonb_build_object('enrolment_id', new.id, 'centre_id', new.centre_id));
  end if;
  return null;
end $$;

-- 4. Dashboard: "by weekday" now shows real attendance (average students present per class held in the last 8 weeks).
create or replace function public.centre_dashboard(p_centre_id uuid, p_month date default null)
returns jsonb language plpgsql stable security definer set search_path to '' as $$
declare
  v_admin boolean := private.is_admin();
  v_cur   date := date_trunc('month', (now() at time zone 'Africa/Lagos'))::date;
  v_month date := date_trunc('month', coalesce(p_month, v_cur))::date;
begin
  if not (v_admin or private.has_role_at('centre_director', p_centre_id)) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if not v_admin and (v_month > v_cur or not private.director_sees_month(p_centre_id, v_month)) then v_month := v_cur; end if;
  return jsonb_build_object(
    'centre',  (select jsonb_build_object('id', c.id, 'name', c.name, 'city', c.city, 'address', c.address) from public.centres c where c.id = p_centre_id),
    'month',   v_month,
    'share_pct', (select t.revenue_share_pct from public.centre_terms t where t.centre_id = p_centre_id),
    'students_active', (select count(distinct e.student_id) from public.enrolments e
                         where e.centre_id = p_centre_id and e.status = 'active'),
    'students_total',  (select count(distinct e.student_id) from public.enrolments e
                         where e.centre_id = p_centre_id and e.status in ('active','completed')),
    'earned_month',    coalesce((select sum(l.amount) from public.centre_ledger_entries l
                                  where l.centre_id = p_centre_id and l.period_month = v_month and l.entry_type = 'earning'), 0),
    'refunds_month',   coalesce((select -sum(l.amount) from public.centre_ledger_entries l
                                  where l.centre_id = p_centre_id and l.period_month = v_month and l.entry_type = 'refund_reversal'), 0),
    'earnings_month',  coalesce((select sum(l.amount) from public.centre_ledger_entries l
                                  where l.centre_id = p_centre_id and l.period_month = v_month
                                    and l.entry_type in ('earning','refund_reversal','adjustment')), 0),
    'balance_owed',    coalesce((select sum(l.amount) from public.centre_ledger_entries l
                                  where l.centre_id = p_centre_id and (v_admin or private.director_sees_month(p_centre_id, l.period_month))), 0),
    'paid_out_total',  coalesce((select -sum(l.amount) from public.centre_ledger_entries l
                                  where l.centre_id = p_centre_id and l.entry_type in ('payout','payout_reversal')
                                    and (v_admin or private.director_sees_month(p_centre_id, l.period_month))), 0),
    'by_course', coalesce((select jsonb_agg(x order by x.students desc) from (
        select c.id as course_id, c.title, count(distinct e.student_id) as students
          from public.enrolments e
          join public.enrolment_courses ec on ec.enrolment_id = e.id
          join public.courses c on c.id = ec.course_id
         where e.centre_id = p_centre_id and e.status = 'active'
         group by c.id, c.title) x), '[]'::jsonb),
    'by_weekday', coalesce((select jsonb_agg(x order by x.day_of_week) from (
        select extract(isodow from s.session_date)::int as day_of_week,
               round(avg(s.students_present))::int as students,
               count(*)::int as classes
          from public.class_sessions s
         where s.centre_id = p_centre_id and s.status = 'completed' and not s.is_emergency
           and s.session_date >= (now() at time zone 'Africa/Lagos')::date - 56
         group by 1) x), '[]'::jsonb),
    'recent_refunds', coalesce((select jsonb_agg(x) from (
        select l.created_at, -l.amount as share_deducted, l.description
          from public.centre_ledger_entries l
         where l.centre_id = p_centre_id and l.entry_type = 'refund_reversal'
           and (v_admin or private.director_sees_month(p_centre_id, l.period_month))
         order by l.created_at desc limit 5) x), '[]'::jsonb),
    'recent_payouts', coalesce((select jsonb_agg(x) from (
        select po.id, po.amount, po.status, po.period_start, po.period_end, po.period_month, po.paid_at
          from public.payouts po
         where po.centre_id = p_centre_id
           and (v_admin or private.director_sees_month(p_centre_id, coalesce(po.period_month, date_trunc('month', po.created_at at time zone 'Africa/Lagos')::date)))
         order by po.created_at desc limit 6) x), '[]'::jsonb)
  );
end $$;

-- 5. Frozen monthly statements. The ledger is already append-only; this adds a snapshot of each closed month with a
--    checksum, so a month's figures can be proved later even if the app is down or a dispute comes up.
create table if not exists public.centre_statements (
  id              uuid primary key default gen_random_uuid(),
  centre_id       uuid not null references public.centres(id) on delete restrict,
  period_month    date not null,
  earned          bigint not null,
  refunds         bigint not null,
  adjustments     bigint not null,
  payouts         bigint not null,
  closing_balance bigint not null,
  entry_count     integer not null,
  checksum        text not null,
  created_at      timestamptz not null default now(),
  unique (centre_id, period_month)
);
alter table public.centre_statements enable row level security;
create policy statements_select on public.centre_statements for select to authenticated
  using (private.is_admin() or private.has_role_at('centre_director', centre_id));
grant select on public.centre_statements to authenticated;
create trigger trg_statements_immutable before update or delete on public.centre_statements
  for each row execute function private.block_mutation();

create or replace function private.close_month_statements(p_month date default null)
returns integer language plpgsql security definer set search_path to '' as $$
declare v_month date := coalesce(date_trunc('month', p_month)::date,
                                 (date_trunc('month', (now() at time zone 'Africa/Lagos')) - interval '1 month')::date);
        v_n integer;
begin
  insert into public.centre_statements (centre_id, period_month, earned, refunds, adjustments, payouts, closing_balance, entry_count, checksum)
  select l.centre_id, v_month,
         coalesce(sum(l.amount) filter (where l.entry_type = 'earning'), 0),
         coalesce(-sum(l.amount) filter (where l.entry_type = 'refund_reversal'), 0),
         coalesce(sum(l.amount) filter (where l.entry_type = 'adjustment'), 0),
         coalesce(-sum(l.amount) filter (where l.entry_type in ('payout', 'payout_reversal')), 0),
         coalesce(sum(l.amount), 0), count(*)::int,
         md5(string_agg(l.id::text || ':' || l.amount::text, ',' order by l.created_at, l.id))
    from public.centre_ledger_entries l
   where l.period_month = v_month
   group by l.centre_id
  on conflict (centre_id, period_month) do nothing;
  get diagnostics v_n = row_count;
  return v_n;
end $$;
revoke all on function private.close_month_statements(date) from public, anon, authenticated;

-- Line items for a month: what the centre checks when it questions a figure. Payment references only, no student names.
create or replace function public.centre_statement(p_centre_id uuid, p_month date)
returns jsonb language plpgsql stable security definer set search_path to '' as $$
declare v_admin boolean := private.is_admin(); v_month date := date_trunc('month', p_month)::date;
begin
  if not (v_admin or private.has_role_at('centre_director', p_centre_id)) then raise exception 'forbidden' using errcode = '42501'; end if;
  if not v_admin and not private.director_sees_month(p_centre_id, v_month) then raise exception 'month_not_available'; end if;
  return jsonb_build_object(
    'month', v_month,
    'closed', (select to_jsonb(s) - 'id' - 'centre_id' from public.centre_statements s where s.centre_id = p_centre_id and s.period_month = v_month),
    'lines', coalesce((select jsonb_agg(x order by x.created_at) from (
        select l.created_at, l.entry_type, l.description, l.base_amount, l.share_pct, l.amount
          from public.centre_ledger_entries l
         where l.centre_id = p_centre_id and l.period_month = v_month) x), '[]'::jsonb));
end $$;

revoke all on function public.centre_students(uuid), public.centre_statement(uuid, date) from public, anon;
grant execute on function public.centre_students(uuid), public.centre_statement(uuid, date) to authenticated;

-- Close each month automatically at 01:10 Lagos time on the 1st (00:10 UTC).
select cron.schedule('iqa-close-month-statements', '10 0 1 * *', $$select private.close_month_statements()$$);

-- 21: cohorts retired. Centres own weekly class days; course runs own start/end dates.
-- (Applied to the live project as "21_centre_class_days_and_course_runs".)

-- 0) Cohort links become optional
alter table public.enrolments       alter column cohort_id drop not null;
alter table public.class_sessions   alter column cohort_id drop not null;
alter table public.class_sessions   alter column slot_id   drop not null;
alter table public.attendance       alter column cohort_id drop not null;
alter table public.timetable_slots  alter column cohort_id drop not null;

-- 1) Tables
create table public.centre_class_days (
  id          uuid primary key default gen_random_uuid(),
  centre_id   uuid not null references public.centres(id) on delete cascade,
  day_of_week smallint not null check (day_of_week between 1 and 7),
  start_time  time not null,
  end_time    time not null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  constraint centre_class_days_time_check check (end_time > start_time),
  constraint centre_class_days_uniq unique (centre_id, day_of_week)
);
comment on table public.centre_class_days is 'Weekdays and times a centre holds classes (1 = Monday .. 7 = Sunday). Set by admin.';

create table public.course_runs (
  id              uuid primary key default gen_random_uuid(),
  centre_id       uuid not null references public.centres(id) on delete cascade,
  course_id       uuid not null references public.courses(id),
  instructor_id   uuid references public.profiles(id),
  start_date      date not null,
  end_date        date not null,
  status          text not null default 'scheduled' check (status in ('scheduled','cancelled')),
  cancel_reason   text,
  end_reminded_at timestamptz,
  created_by      uuid default auth.uid(),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  constraint course_runs_dates_check check (end_date >= start_date)
);
comment on table public.course_runs is 'One teaching run of a course at a centre: begins and ends on these dates, held on the centre class days.';
create index course_runs_centre_course_idx on public.course_runs (centre_id, course_id);

alter table public.class_sessions add column run_id uuid references public.course_runs(id);
create unique index class_sessions_run_date_uniq on public.class_sessions (run_id, session_date) where run_id is not null;

create trigger trg_centre_class_days_updated_at before update on public.centre_class_days for each row execute function private.set_updated_at();
create trigger trg_course_runs_updated_at before update on public.course_runs for each row execute function private.set_updated_at();

alter table public.centre_class_days enable row level security;
alter table public.course_runs enable row level security;
revoke all on public.centre_class_days, public.course_runs from anon;
create policy class_days_select on public.centre_class_days for select to authenticated using (true);
create policy class_days_admin  on public.centre_class_days for all to authenticated using (private.is_admin()) with check (private.is_admin());
create policy runs_select on public.course_runs for select to authenticated
  using (private.is_admin() or instructor_id = (select auth.uid()) or private.is_centre_staff(centre_id));
create policy runs_admin  on public.course_runs for all to authenticated using (private.is_admin()) with check (private.is_admin());

-- 2) Helpers
create or replace function private.centre_place(p_centre_id uuid) returns text
language sql stable security definer set search_path = '' as $$
  select coalesce(nullif(trim(city), ''), nullif(trim(address), ''), name) from public.centres where id = p_centre_id
$$;

-- The classes a run would hold: every centre class day between the dates, capped at the course's session count.
create or replace function private.session_plan(p_centre_id uuid, p_course_id uuid, p_start date, p_end date)
returns table (session_no integer, session_date date, start_time time, end_time time)
language sql stable security definer set search_path = '' as $$
  with raw as (
    select g::date as d, cd.start_time as st, cd.end_time as et
      from public.centre_class_days cd
     cross join lateral generate_series(p_start::timestamp, p_end::timestamp, interval '1 day') g
     where cd.centre_id = p_centre_id and extract(isodow from g)::int = cd.day_of_week
  ), numbered as (
    select (row_number() over (order by d, st))::int as n, d, st, et from raw
  )
  select n, d, st, et from numbered
   where n <= coalesce((select total_sessions from public.courses where id = p_course_id), 9)
   order by n
$$;

create or replace function private.has_next_run(p_centre_id uuid, p_course_id uuid, p_start date) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.course_runs n
                  where n.centre_id = p_centre_id and n.course_id = p_course_id
                    and n.status = 'scheduled' and n.start_date > p_start)
$$;

create or replace function private.instructs_enrolment(p_enrolment_id uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.enrolments e join public.enrolment_courses ec on ec.enrolment_id = e.id
     where e.id = p_enrolment_id
       and (exists (select 1 from public.class_sessions cs
                     where cs.centre_id = e.centre_id and cs.course_id = ec.course_id and cs.instructor_id = (select auth.uid()))
         or exists (select 1 from public.course_runs r
                     where r.centre_id = e.centre_id and r.course_id = ec.course_id
                       and r.instructor_id = (select auth.uid()) and r.status = 'scheduled')))
$$;
grant execute on function private.instructs_enrolment(uuid) to authenticated;

-- Build (or rebuild) the class sessions of a run. Past classes and classes with attendance are left alone.
-- (Redefined in 28 to also refresh student clocks.)
create or replace function private.build_run_sessions(p_run_id uuid) returns integer
language plpgsql security definer set search_path = '' as $$
declare v_run public.course_runs%rowtype; v_tz text; v_n integer;
begin
  select * into v_run from public.course_runs where id = p_run_id;
  if not found or v_run.status <> 'scheduled' then return 0; end if;
  select timezone into v_tz from public.centres where id = v_run.centre_id;

  delete from public.session_checkin_tokens where session_id in (
    select cs.id from public.class_sessions cs where cs.run_id = p_run_id and cs.status = 'scheduled' and cs.start_at > now()
       and not exists (select 1 from public.attendance a where a.session_id = cs.id));
  delete from public.class_sessions cs
   where cs.run_id = p_run_id and cs.status = 'scheduled' and cs.start_at > now()
     and not exists (select 1 from public.attendance a where a.session_id = cs.id);

  insert into public.class_sessions (run_id, centre_id, course_id, instructor_id, lesson_id, session_no, session_date, start_at, end_at)
  select p_run_id, v_run.centre_id, v_run.course_id, v_run.instructor_id,
         (select l.id from public.course_lessons l where l.course_id = v_run.course_id and l.lesson_no = p.session_no),
         p.session_no, p.session_date,
         (p.session_date + p.start_time) at time zone v_tz,
         (p.session_date + p.end_time)   at time zone v_tz
    from private.session_plan(v_run.centre_id, v_run.course_id, v_run.start_date, v_run.end_date) p
   where (p.session_date + p.start_time) at time zone v_tz > now()
  on conflict do nothing;
  get diagnostics v_n = row_count;
  return v_n;
end $$;

-- Sessions fill centre/course/instructor from their run (or legacy slot)
create or replace function private.fill_session_from_slot() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_slot public.timetable_slots%rowtype; v_run public.course_runs%rowtype;
begin
  if new.run_id is not null then
    select * into v_run from public.course_runs where id = new.run_id;
    if not found then raise exception 'run_not_found'; end if;
    new.centre_id := v_run.centre_id;
    new.course_id := v_run.course_id;
    if tg_op = 'INSERT' and new.instructor_id is null then new.instructor_id := v_run.instructor_id; end if;
    return new;
  end if;
  select * into v_slot from public.timetable_slots where id = new.slot_id;
  if not found then raise exception 'slot_not_found'; end if;
  new.cohort_id := v_slot.cohort_id;
  new.centre_id := v_slot.centre_id;
  new.course_id := v_slot.course_id;
  if tg_op = 'INSERT' and new.instructor_id is null then new.instructor_id := v_slot.instructor_id; end if;
  return new;
end $$;

-- 3) Admin: weekly class days per centre
create or replace function public.save_centre_class_days(p_centre_id uuid, p_days jsonb) returns integer
language plpgsql security definer set search_path = '' as $$
declare v_cnt integer; v_distinct integer; r record; v_n integer := 0;
begin
  if not (private.is_admin() or private.is_privileged()) then raise exception 'forbidden' using errcode = '42501'; end if;
  if not exists (select 1 from public.centres where id = p_centre_id) then raise exception 'centre_not_found'; end if;
  if jsonb_typeof(p_days) is distinct from 'array' or jsonb_array_length(p_days) = 0 then raise exception 'no_days'; end if;
  select count(*), count(distinct (e ->> 'day')) into v_cnt, v_distinct from jsonb_array_elements(p_days) e;
  if v_cnt <> v_distinct then raise exception 'duplicate_day'; end if;
  if exists (select 1 from jsonb_array_elements(p_days) e
              where (e ->> 'day')::int not between 1 and 7 or (e ->> 'end')::time <= (e ->> 'start')::time) then
    raise exception 'bad_times';
  end if;

  delete from public.centre_class_days where centre_id = p_centre_id;
  insert into public.centre_class_days (centre_id, day_of_week, start_time, end_time)
  select p_centre_id, (e ->> 'day')::smallint, (e ->> 'start')::time, (e ->> 'end')::time from jsonb_array_elements(p_days) e;

  for r in select id from public.course_runs
            where centre_id = p_centre_id and status = 'scheduled' and end_date >= (now() at time zone 'Africa/Lagos')::date loop
    v_n := v_n + private.build_run_sessions(r.id);
  end loop;
  return v_n;
end $$;

-- 4) Admin or instructor: create / change a course run
create or replace function public.save_course_run(
  p_run_id uuid, p_centre_id uuid, p_course_id uuid, p_instructor_id uuid, p_start date, p_end date) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_uid   uuid := (select auth.uid());
  v_super boolean := private.is_admin() or private.is_privileged();
  v_today date := (now() at time zone 'Africa/Lagos')::date;
  v_run   public.course_runs%rowtype;
  v_instr uuid := p_instructor_id;
  v_id uuid; v_n integer; v_planned integer; v_expected integer; v_last date; v_title text;
begin
  if v_uid is null and not private.is_privileged() then raise exception 'not_authenticated' using errcode = '28000'; end if;
  if not (v_super or exists (select 1 from public.user_roles r where r.user_id = v_uid and r.is_active and r.role = 'instructor')) then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  if p_run_id is not null then
    select * into v_run from public.course_runs where id = p_run_id for update;
    if not found then raise exception 'run_not_found'; end if;
    if not v_super and v_run.instructor_id is distinct from v_uid then raise exception 'forbidden' using errcode = '42501'; end if;
    if v_run.status = 'cancelled' then raise exception 'run_cancelled'; end if;
    p_centre_id := v_run.centre_id;
    p_course_id := v_run.course_id;
  end if;
  if not v_super then v_instr := v_uid; end if;
  if v_instr is not null and not exists (select 1 from public.user_roles r where r.user_id = v_instr and r.is_active and r.role = 'instructor') then
    raise exception 'not_an_instructor';
  end if;

  if not exists (select 1 from public.centres where id = p_centre_id and is_active) then raise exception 'centre_not_available'; end if;
  select title, total_sessions into v_title, v_expected from public.courses where id = p_course_id and is_active;
  if not found then raise exception 'invalid_course'; end if;
  if not exists (select 1 from public.centre_class_days where centre_id = p_centre_id) then raise exception 'no_class_days'; end if;

  if p_start is null or p_end is null or p_end < p_start then raise exception 'bad_dates'; end if;
  if (p_run_id is null or p_start <> v_run.start_date) and p_start < v_today then raise exception 'start_in_past'; end if;
  if p_start > (v_today + interval '4 months')::date then raise exception 'too_far_ahead'; end if;
  if p_end > (p_start + interval '4 months')::date then raise exception 'run_too_long'; end if;

  if exists (select 1 from public.course_runs r
              where r.centre_id = p_centre_id and r.course_id = p_course_id and r.status = 'scheduled'
                and r.id is distinct from p_run_id
                and daterange(r.start_date, r.end_date, '[]') && daterange(p_start, p_end, '[]')) then
    raise exception 'run_overlap';
  end if;

  select count(*), max(session_date) into v_planned, v_last from private.session_plan(p_centre_id, p_course_id, p_start, p_end);
  if v_planned = 0 then raise exception 'no_class_in_range'; end if;

  if v_instr is not null and exists (
       select 1 from private.session_plan(p_centre_id, p_course_id, p_start, p_end) p
         join public.centres c on c.id = p_centre_id
         join public.class_sessions cs on cs.instructor_id = v_instr and cs.status <> 'cancelled'
                                      and (p_run_id is null or cs.run_id is distinct from p_run_id)
        where tstzrange((p.session_date + p.start_time) at time zone c.timezone, (p.session_date + p.end_time) at time zone c.timezone)
              && tstzrange(cs.start_at, cs.end_at)) then
    raise exception 'instructor_clash';
  end if;

  if p_run_id is null then
    insert into public.course_runs (centre_id, course_id, instructor_id, start_date, end_date)
    values (p_centre_id, p_course_id, v_instr, p_start, p_end) returning id into v_id;
  else
    update public.course_runs
       set instructor_id = v_instr, start_date = p_start, end_date = p_end,
           end_reminded_at = case when p_end is distinct from v_run.end_date then null else end_reminded_at end
     where id = p_run_id;
    v_id := p_run_id;
  end if;

  v_n := private.build_run_sessions(v_id);

  if v_instr is not null and v_instr is distinct from v_uid and (p_run_id is null or v_instr is distinct from v_run.instructor_id) then
    perform private.notify(array[v_instr], 'run_assigned', 'New teaching assignment',
      v_title || ' at ' || private.centre_place(p_centre_id) || ' from ' || to_char(p_start, 'DD Mon') || ' to ' || to_char(p_end, 'DD Mon') || '.',
      jsonb_build_object('run_id', v_id));
  end if;

  return jsonb_build_object('run_id', v_id, 'sessions', v_n, 'planned', v_planned, 'expected', v_expected,
                            'last_session_date', v_last, 'short_by', greatest(v_expected - v_planned, 0));
end $$;

-- Date of the last class if the run starts on p_start (prefills the end date)
create or replace function public.suggest_run_end(p_centre_id uuid, p_course_id uuid, p_start date) returns date
language sql stable security definer set search_path = '' as $$
  select max(p.session_date) from private.session_plan(p_centre_id, p_course_id, p_start, (p_start + interval '4 months')::date) p
$$;

-- (cancel_course_run is defined in 28, where it also refreshes student clocks.)

-- 5) What students see: when each centre starts a course
create or replace function public.centre_course_starts(p_course_id uuid)
returns table (centre_id uuid, starts_on date)
language sql stable security definer set search_path = '' as $$
  select r.centre_id, min(p.session_date)
    from public.course_runs r
    join public.centres c on c.id = r.centre_id and c.is_active
   cross join lateral private.session_plan(r.centre_id, r.course_id, r.start_date, r.end_date) p
   where r.course_id = p_course_id and r.status = 'scheduled'
     and (p.session_date + p.end_time) > (now() at time zone c.timezone)
   group by r.centre_id
$$;

-- 6) Enrolment without cohorts: centre must have classes scheduled for the first course
drop function if exists public.create_enrolment(uuid, uuid, uuid, public.plan_type, uuid[], uuid);
create function public.create_enrolment(
  p_centre_id uuid, p_package_id uuid, p_plan public.plan_type, p_course_ids uuid[],
  p_student_id uuid default null, p_cohort_id uuid default null) returns uuid
language plpgsql security definer set search_path = '' as $function$
declare
  v_uid     uuid := (select auth.uid());
  v_student uuid;
  v_pkg     public.packages%rowtype;
  v_ids     uuid[];
  v_missing text;
  v_total   bigint;
  v_id      uuid;
  v_first   uuid;
begin
  if v_uid is null then raise exception 'not_authenticated' using errcode = '28000'; end if;
  v_student := coalesce(p_student_id, v_uid);
  if v_student <> v_uid and not (private.is_admin() or private.is_centre_staff(p_centre_id)) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if not exists (select 1 from public.students where id = v_student) then raise exception 'student_not_found'; end if;
  if not exists (select 1 from public.centres where id = p_centre_id and is_active) then raise exception 'centre_not_available'; end if;

  select * into v_pkg from public.packages where id = p_package_id and is_active;
  if not found then raise exception 'package_not_available'; end if;

  select array_agg(distinct x) into v_ids from unnest(p_course_ids) as x;
  if coalesce(array_length(v_ids, 1), 0) <> v_pkg.course_count then
    raise exception 'course_count_mismatch' using hint = 'This package needs exactly ' || v_pkg.course_count || ' course(s).';
  end if;
  if exists (select 1 from unnest(v_ids) x left join public.courses c on c.id = x where c.id is null or not c.is_active) then
    raise exception 'invalid_course';
  end if;

  if exists (select 1 from public.enrolment_courses ec join public.enrolments e on e.id = ec.enrolment_id
             where e.student_id = v_student and e.status in ('pending_payment','active') and ec.course_id = any (v_ids)) then
    raise exception 'already_enrolled_in_course';
  end if;

  select string_agg(c.title, ', ') into v_missing
  from public.courses c
  where c.id = any (v_ids)
    and exists (
      select 1 from (select distinct group_no from public.course_prerequisites where course_id = c.id) g
      where not exists (
        select 1 from public.course_prerequisites p
        where p.course_id = c.id and p.group_no = g.group_no
          and (p.prerequisite_id = any (v_ids)
               or exists (select 1 from public.enrolment_courses ec join public.enrolments e on e.id = ec.enrolment_id
                          where e.student_id = v_student and ec.course_id = p.prerequisite_id and ec.status = 'completed'))));
  if v_missing is not null then
    raise exception 'prerequisites_not_met' using hint = 'Missing prerequisites for: ' || v_missing;
  end if;

  -- The first course of the bundle must have classes coming up at this centre
  select c.id into v_first from public.courses c where c.id = any (v_ids) order by c.sort_order, c.code limit 1;
  if not exists (select 1 from public.centre_course_starts(v_first) s where s.centre_id = p_centre_id) then
    raise exception 'no_classes_scheduled';
  end if;

  if p_plan = 'full' then
    v_total := v_pkg.price_full;
  else
    select sum(amount) into v_total from public.package_instalments where package_id = p_package_id;
    if v_total is null then raise exception 'instalment_plan_unavailable'; end if;
  end if;

  insert into public.enrolments (student_id, centre_id, package_id, plan, currency, total_amount, registered_by)
  values (v_student, p_centre_id, p_package_id, p_plan, v_pkg.currency, v_total, case when v_student <> v_uid then v_uid end)
  returning id into v_id;

  insert into public.enrolment_courses (enrolment_id, course_id, sequence_no)
  select v_id, c.id, row_number() over (order by c.sort_order, c.code) from public.courses c where c.id = any (v_ids);

  if p_plan = 'full' then
    insert into public.enrolment_instalments (enrolment_id, number, label, amount, due_rule) values (v_id, 1, 'Full payment', v_total, 'before_start');
  else
    insert into public.enrolment_instalments (enrolment_id, number, label, amount, due_rule)
    select v_id, number, label, amount, due_rule from public.package_instalments where package_id = p_package_id;
  end if;
  return v_id;
end $function$;

-- 7) Delete a centre (only when it has no money, enrolment or attendance history)
create or replace function public.delete_centre(p_centre_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if not private.is_admin() then raise exception 'forbidden' using errcode = '42501'; end if;
  if not exists (select 1 from public.centres where id = p_centre_id) then raise exception 'centre_not_found'; end if;
  if exists (select 1 from public.enrolments where centre_id = p_centre_id)
     or exists (select 1 from public.payments where centre_id = p_centre_id)
     or exists (select 1 from public.refunds where centre_id = p_centre_id)
     or exists (select 1 from public.payouts where centre_id = p_centre_id)
     or exists (select 1 from public.centre_ledger_entries where centre_id = p_centre_id)
     or exists (select 1 from public.expenses where centre_id = p_centre_id)
     or exists (select 1 from public.attendance where centre_id = p_centre_id) then
    raise exception 'centre_has_history' using hint = 'Deactivate it instead.';
  end if;
  delete from public.session_checkin_tokens where session_id in (select id from public.class_sessions where centre_id = p_centre_id);
  delete from public.class_sessions where centre_id = p_centre_id;
  delete from public.course_runs where centre_id = p_centre_id;
  delete from public.timetable_slots where centre_id = p_centre_id;
  delete from public.cohorts where centre_id = p_centre_id;
  delete from public.user_roles where centre_id = p_centre_id;
  update public.students set home_centre_id = null where home_centre_id = p_centre_id;
  update public.leads set centre_id = null where centre_id = p_centre_id;
  delete from public.centre_share_history where centre_id = p_centre_id;
  delete from public.centre_payout_accounts where centre_id = p_centre_id;
  delete from public.centre_terms where centre_id = p_centre_id;
  delete from public.centres where id = p_centre_id;
end $$;

-- 8) Reminder: a run is nearly over and nothing follows it
create or replace function public.remind_run_endings() returns integer
language plpgsql security definer set search_path = '' as $$
declare r record; v_n integer := 0; v_today date := (now() at time zone 'Africa/Lagos')::date;
begin
  if not (private.is_privileged() or private.is_admin()) then raise exception 'forbidden' using errcode = '42501'; end if;
  for r in
    select x.id, x.centre_id, x.course_id, x.instructor_id, x.start_date, x.last_date, co.title
      from (select ru.*,
                   (select max(cs.session_date) from public.class_sessions cs where cs.run_id = ru.id and cs.status <> 'cancelled') as last_date,
                   (select count(*) from public.class_sessions cs where cs.run_id = ru.id and cs.status = 'scheduled' and cs.start_at > now()) as left_n
              from public.course_runs ru where ru.status = 'scheduled' and ru.end_reminded_at is null) x
      join public.courses co on co.id = x.course_id
     where x.last_date is not null and x.last_date >= v_today and x.left_n <= 2
  loop
    if not private.has_next_run(r.centre_id, r.course_id, r.start_date) then
      perform private.notify(
        (select array_agg(distinct u) from unnest(private.admin_ids() || coalesce(array[r.instructor_id], '{}')) u where u is not null),
        'run_ending', 'Set the next run',
        r.title || ' at ' || private.centre_place(r.centre_id) || ' holds its last class on ' || to_char(r.last_date, 'Dy DD Mon') || '. Set the next start date.',
        jsonb_build_object('run_id', r.id, 'centre_id', r.centre_id, 'course_id', r.course_id));
      v_n := v_n + 1;
    end if;
    update public.course_runs set end_reminded_at = now() where id = r.id;
  end loop;
  return v_n;
end $$;

-- 9) Views (security_invoker, see 27)
create or replace view public.v_course_runs with (security_invoker = true) as
select r.id, r.centre_id, c.name as centre_name, c.city as centre_city, r.course_id, co.title as course_title, co.total_sessions,
       r.instructor_id, d.full_name as instructor_name, r.start_date, r.end_date, r.status,
       s.planned as sessions_planned, s.left_n as sessions_left, s.last_date as last_session_date,
       private.has_next_run(r.centre_id, r.course_id, r.start_date) as has_next_run,
       (r.status = 'scheduled' and s.last_date >= (now() at time zone 'Africa/Lagos')::date and s.left_n <= 2
        and not private.has_next_run(r.centre_id, r.course_id, r.start_date)) as ending_soon
  from public.course_runs r
  join public.centres c on c.id = r.centre_id
  join public.courses co on co.id = r.course_id
  left join public.v_staff_directory d on d.id = r.instructor_id
  cross join lateral (
    select count(*) filter (where cs.status <> 'cancelled') as planned,
           count(*) filter (where cs.status = 'scheduled' and cs.start_at > now()) as left_n,
           max(cs.session_date) filter (where cs.status <> 'cancelled') as last_date
      from public.class_sessions cs where cs.run_id = r.id) s;
grant select on public.v_course_runs to authenticated;
revoke all on public.v_course_runs from anon;

create or replace view public.v_session_details with (security_invoker = true) as
 SELECT s.id, s.session_date, s.start_at, s.end_at, s.status, s.session_no, s.cohort_id, s.centre_id,
    c.name AS centre_name, c.address AS centre_address, s.course_id, co.title AS course_title,
    s.instructor_id, d.full_name AS instructor_name, s.lesson_id, l.title AS lesson_title,
    s.students_enrolled, s.students_present, s.students_absent, s.students_excused,
    s.completed_at, s.auto_closed, ts.room, c.city AS centre_city, s.run_id
   FROM class_sessions s
     JOIN centres c ON c.id = s.centre_id
     JOIN courses co ON co.id = s.course_id
     LEFT JOIN timetable_slots ts ON ts.id = s.slot_id
     LEFT JOIN course_lessons l ON l.id = s.lesson_id
     LEFT JOIN v_staff_directory d ON d.id = s.instructor_id;

create or replace view public.v_enrolment_counts with (security_invoker = true) as
 SELECT e.centre_id, ce.name AS centre_name, ec.course_id, co.title AS course_title, cd.day_of_week,
    count(DISTINCT e.student_id) AS students
   FROM enrolments e
     JOIN centres ce ON ce.id = e.centre_id
     JOIN enrolment_courses ec ON ec.enrolment_id = e.id
     JOIN courses co ON co.id = ec.course_id
     LEFT JOIN centre_class_days cd ON cd.centre_id = e.centre_id
  WHERE e.status = 'active'::enrolment_status
  GROUP BY e.centre_id, ce.name, ec.course_id, co.title, cd.day_of_week;

-- 10) Who can see what: match on centre + course instead of cohort
alter policy enrolments_select on public.enrolments
  using ((student_id = (select auth.uid())) or private.is_admin() or private.is_centre_staff(centre_id) or private.instructs_enrolment(id));
alter policy sessions_select on public.class_sessions
  using (private.is_admin() or (instructor_id = (select auth.uid())) or private.is_centre_staff(centre_id)
         or exists (select 1 from public.enrolments e join public.enrolment_courses ec on ec.enrolment_id = e.id
                     where e.student_id = (select auth.uid()) and e.centre_id = class_sessions.centre_id
                       and ec.course_id = class_sessions.course_id and e.status in ('active','completed')));

do $patch$
declare p record; d text;
begin
  for p in select * from (values
    ('private.can_view_enrolment(uuid)', 'private.instructs_cohort(e.cohort_id)', 'private.instructs_enrolment(e.id)'),
    ('private.can_view_student(uuid)', 'private.instructs_cohort(e.cohort_id)', 'private.instructs_enrolment(e.id)'),
    ('private.log_absentees(uuid)', 'e.cohort_id = v_s.cohort_id', 'e.centre_id = v_s.centre_id and coalesce(e.activated_at, e.created_at) <= v_s.end_at'),
    ('private.refresh_session_counts(uuid)', 'e.cohort_id = v_s.cohort_id', 'e.centre_id = v_s.centre_id and coalesce(e.activated_at, e.created_at) <= v_s.end_at'),
    ('private.prepare_attendance()', 'e.cohort_id = v_s.cohort_id', 'e.centre_id = v_s.centre_id'),
    ('public.cancel_session(uuid,text)', 'e.cohort_id = v_s.cohort_id', 'e.centre_id = v_s.centre_id'),
    ('public.check_in(text)', 'e.cohort_id = v_s.cohort_id', 'e.centre_id = v_s.centre_id'),
    ('public.mark_attendance(uuid,uuid,attendance_status,text)', 'e.cohort_id = v_s.cohort_id', 'e.centre_id = v_s.centre_id'),
    ('public.session_attendance_roster(uuid)', 'e.cohort_id = v_s.cohort_id', 'e.centre_id = v_s.centre_id and coalesce(e.activated_at, e.created_at) <= v_s.end_at'),
    ('public.review_project(uuid,project_status,text,numeric)', 'select cohort_id into v_cohort from public.enrolments where id = v_p.enrolment_id;', 'v_cohort := null;'),
    ('public.review_project(uuid,project_status,text,numeric)', 'private.instructs_cohort(v_cohort)', 'private.instructs_enrolment(v_p.enrolment_id)'),
    ('public.centre_dashboard(uuid,date)', 'join public.timetable_slots ts on ts.cohort_id = e.cohort_id and ts.course_id = ec.course_id and ts.is_active', 'join public.centre_class_days ts on ts.centre_id = e.centre_id'),
    ('private.resolve_audience(jsonb)', 'and (v_cohorts is null or s.cohort_id = any (v_cohorts))', 'and true'),
    ('private.resolve_audience(jsonb)', 'and (v_cohorts is null or e.cohort_id = any (v_cohorts))', 'and true'),
    ('private.resolve_audience(jsonb)', 'from public.timetable_slots s', 'from public.course_runs s'),
    ('private.resolve_audience(jsonb)', 'where s.instructor_id is not null and s.is_active', 'where s.instructor_id is not null and s.status = ''scheduled''')
  ) as t(fn, old, new) loop
    select pg_get_functiondef(p.fn::regprocedure) into d;
    if position(p.old in d) = 0 then raise exception 'patch target missing in %: %', p.fn, p.old; end if;
    execute replace(d, p.old, p.new);
  end loop;
end $patch$;

-- 11) Grants
revoke all on function public.save_centre_class_days(uuid, jsonb), public.save_course_run(uuid, uuid, uuid, uuid, date, date),
  public.suggest_run_end(uuid, uuid, date), public.centre_course_starts(uuid),
  public.create_enrolment(uuid, uuid, public.plan_type, uuid[], uuid, uuid), public.delete_centre(uuid), public.remind_run_endings()
  from public, anon;
grant execute on function public.save_centre_class_days(uuid, jsonb), public.save_course_run(uuid, uuid, uuid, uuid, date, date),
  public.suggest_run_end(uuid, uuid, date), public.centre_course_starts(uuid),
  public.create_enrolment(uuid, uuid, public.plan_type, uuid[], uuid, uuid), public.delete_centre(uuid), public.remind_run_endings()
  to authenticated;

select cron.schedule('iqa-run-reminders', '0 6 * * *', 'select public.remind_run_endings()');

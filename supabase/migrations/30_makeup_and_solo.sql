-- 30_makeup_and_solo.sql   (builds on 28_enrolment_clock_starts_at_first_class: enrolments.starts_on / ends_on / private.clock_open)
-- (1) Make-up window: free, automatic. Opens when a student's last class ends and lasts 2 months.
--     They may attend up to 6 make-up classes (all of them if they missed 6 or fewer). Only classes they missed.
-- (2) Single-course purchases: a student who has fully paid for a course pack can buy one course on its own.
--     Admin sets each course's price, plus a second price for students who haven't completed its prerequisite.
--     This is also how extra training works after the make-up window: course specific, no separate make-up/retake fee.

insert into public.app_settings (key, value, description) values
  ('makeup_window_months', '2'::jsonb, 'Months after a student''s last class during which they may attend make-up classes'),
  ('makeup_max_classes',   '6'::jsonb, 'Most make-up classes a student can attend per course pack')
on conflict (key) do nothing;

-- ---------------------------------------------------------------------------
-- Admin-set prices for buying one course on its own (kobo)
-- ---------------------------------------------------------------------------
create table if not exists public.course_prices (
  course_id         uuid primary key references public.courses(id) on delete cascade,
  solo_price        bigint check (solo_price > 0),         -- price when the student has the prerequisite(s) or the course has none
  solo_price_unmet  bigint check (solo_price_unmet > 0),   -- price when the student hasn't completed the prerequisite(s)
  updated_at        timestamptz not null default now()
);
alter table public.course_prices enable row level security;
create policy course_prices_select on public.course_prices for select to authenticated using (true);
create policy course_prices_admin  on public.course_prices for all to authenticated using (private.is_admin()) with check (private.is_admin());
grant select on public.course_prices to authenticated;

-- hidden package that single-course enrolments hang off (enrolments need a package)
insert into public.packages (code, name, description, course_count, duration_weeks, price_full, is_active, sort_order)
values ('SOLO', 'Single course', 'One course bought on its own', 1, null, 0, false, 9999)
on conflict (code) do nothing;

create or replace function public.save_course_prices(p_prices jsonb) returns integer
language plpgsql security definer set search_path = '' as $$
declare v_item jsonb; v_c uuid; v_p bigint; v_u bigint; v_n integer := 0;
begin
  if not private.is_admin() then raise exception 'forbidden' using errcode = '42501'; end if;
  if p_prices is null or jsonb_typeof(p_prices) <> 'array' then raise exception 'prices_invalid'; end if;
  for v_item in select * from jsonb_array_elements(p_prices) loop
    begin
      v_c := (v_item ->> 'course_id')::uuid;
      v_p := nullif(v_item ->> 'solo_price', '')::bigint;
      v_u := nullif(v_item ->> 'solo_price_unmet', '')::bigint;
    exception when others then raise exception 'prices_invalid'; end;
    if not exists (select 1 from public.courses where id = v_c) then raise exception 'course_not_found'; end if;
    if (v_p is not null and v_p <= 0) or (v_u is not null and v_u <= 0) then raise exception 'price_must_be_positive'; end if;
    if not exists (select 1 from public.course_prerequisites where course_id = v_c) then v_u := null; end if;
    insert into public.course_prices (course_id, solo_price, solo_price_unmet) values (v_c, v_p, v_u)
    on conflict (course_id) do update set solo_price = excluded.solo_price, solo_price_unmet = excluded.solo_price_unmet, updated_at = now();
    v_n := v_n + 1;
  end loop;
  return v_n;
end $$;
revoke all on function public.save_course_prices(jsonb) from public, anon;
grant execute on function public.save_course_prices(jsonb) to authenticated;

-- ---------------------------------------------------------------------------
-- Which teaching run a student follows for a course: the earliest scheduled run at their centre
-- that hasn't ended before their course clock started (enrolments.starts_on).
-- ---------------------------------------------------------------------------
create or replace function private.own_run(p_enrolment_id uuid, p_course_id uuid) returns uuid
language sql stable security definer set search_path = '' as $$
  select r.id
    from public.enrolments e
    join public.centres c on c.id = e.centre_id
    join public.course_runs r on r.centre_id = e.centre_id and r.course_id = p_course_id and r.status = 'scheduled'
   where e.id = p_enrolment_id
     and r.end_date >= coalesce(e.starts_on, (coalesce(e.activated_at, e.created_at) at time zone c.timezone)::date)
   order by r.start_date
   limit 1
$$;

-- When the student's time ends: the end of the package period (enrolments.ends_on) or their last class, whichever is later.
-- Single-course purchases have no package period, so theirs is the last class of their run.
create or replace function private.pack_end(p_enrolment_id uuid) returns timestamptz
language sql stable security definer set search_path = '' as $$
  select greatest(
    (select (e.ends_on + 1)::timestamp at time zone c.timezone
       from public.enrolments e join public.centres c on c.id = e.centre_id
      where e.id = p_enrolment_id and e.ends_on is not null),
    (select max(s.end_at)
       from public.enrolment_courses ec
       join public.class_sessions s on s.run_id = private.own_run(p_enrolment_id, ec.course_id) and s.status <> 'cancelled'
      where ec.enrolment_id = p_enrolment_id))
$$;

create or replace function private.pack_ended(p_enrolment_id uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce(now() > private.pack_end(p_enrolment_id), false)
$$;

-- Classes held in the student's own run that they have no "present" mark for
create or replace function private.missed_lessons(p_enrolment_id uuid)
returns table (course_id uuid, lesson_id uuid, lesson_no integer, title text)
language sql stable security definer set search_path = '' as $$
  select ec.course_id, l.id, l.lesson_no, l.title
    from public.enrolment_courses ec
    join public.course_lessons l on l.course_id = ec.course_id
   where ec.enrolment_id = p_enrolment_id
     and exists (select 1 from public.class_sessions s
                  where s.run_id = private.own_run(p_enrolment_id, ec.course_id) and s.lesson_id = l.id
                    and s.status = 'completed' and private.clock_open(p_enrolment_id, s.session_date))
     and not exists (select 1 from public.attendance a join public.class_sessions s2 on s2.id = a.session_id
                      where a.enrolment_id = p_enrolment_id and a.status = 'present' and s2.lesson_id = l.id)
$$;

create or replace function private.makeup_info(p_enrolment_id uuid)
returns table (pack_end_at timestamptz, closes_at timestamptz, state text, missed_count integer, used_count integer, allowance integer, slots_left integer)
language plpgsql stable security definer set search_path = '' as $$
declare
  v_end timestamptz := private.pack_end(p_enrolment_id);
  v_max integer := private.setting_int('makeup_max_classes', 6);
  v_months integer := private.setting_int('makeup_window_months', 2);
  v_missed integer; v_used integer; v_close timestamptz; v_state text;
begin
  select count(*) into v_missed from private.missed_lessons(p_enrolment_id);
  -- make-up classes already attended: present marks in sessions that belong to another run than the student's own
  select count(*) into v_used
    from public.attendance a join public.class_sessions s on s.id = a.session_id
   where a.enrolment_id = p_enrolment_id and a.status = 'present' and s.run_id is not null
     and private.own_run(p_enrolment_id, a.course_id) is not null
     and s.run_id is distinct from private.own_run(p_enrolment_id, a.course_id);
  v_close := case when v_end is null then null else v_end + make_interval(months => v_months) end;
  v_state := case when v_end is null then 'pending' when now() < v_end then 'before' when now() > v_close then 'closed' else 'open' end;
  return query select v_end, v_close, v_state, v_missed, v_used, least(v_max, v_missed + v_used),
                      case when v_state = 'open' then greatest(0, least(v_max - v_used, v_missed)) else 0 end;
end $$;

create or replace function private.in_own_run(p_enrolment_id uuid, p_course_id uuid, p_run_id uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select p_run_id is null or private.own_run(p_enrolment_id, p_course_id) is not distinct from p_run_id
$$;

grant execute on function private.in_own_run(uuid, uuid, uuid), private.own_run(uuid, uuid), private.pack_end(uuid), private.pack_ended(uuid),
  private.missed_lessons(uuid), private.makeup_info(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- check_in: own-run classes work as before; a class from another run is a make-up class
-- ---------------------------------------------------------------------------
create or replace function public.check_in(p_token text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_uid    uuid := (select auth.uid());
  v_tok    public.session_checkin_tokens%rowtype;
  v_s      public.class_sessions%rowtype;
  v_enrol  uuid;
  v_status public.enrolment_status;
  v_own    uuid;
  v_makeup boolean;
  v_info   record;
  v_row    public.attendance%rowtype;
begin
  if v_uid is null then raise exception 'not_authenticated' using errcode = '28000'; end if;
  select * into v_tok from public.session_checkin_tokens where token = upper(trim(p_token));
  if not found then raise exception 'invalid_code'; end if;
  if v_tok.expires_at is not null and v_tok.expires_at < now() then raise exception 'code_expired'; end if;

  select * into v_s from public.class_sessions where id = v_tok.session_id;
  if v_s.status = 'cancelled' then raise exception 'session_cancelled'; end if;
  if now() < v_s.start_at - make_interval(mins => private.setting_int('checkin_opens_minutes_before', 30))
     or now() > v_s.end_at + make_interval(mins => private.setting_int('checkin_grace_minutes_after_end', 30)) then
    raise exception 'outside_checkin_window';
  end if;

  select e.id, e.status into v_enrol, v_status
    from public.enrolments e join public.enrolment_courses ec on ec.enrolment_id = e.id
   where e.student_id = v_uid and e.centre_id = v_s.centre_id and ec.course_id = v_s.course_id
     and e.status in ('active', 'completed') and private.clock_open(e.id, v_s.session_date)
   order by (e.status = 'active') desc, e.created_at desc
   limit 1;
  if v_enrol is null then raise exception 'not_enrolled'; end if;

  v_own := private.own_run(v_enrol, v_s.course_id);
  v_makeup := v_s.run_id is not null and v_own is not null and v_s.run_id <> v_own;

  if v_makeup then
    select * into v_info from private.makeup_info(v_enrol);
    if v_info.state <> 'open' then raise exception 'makeup_not_open'; end if;
    if not exists (select 1 from private.missed_lessons(v_enrol) m where m.lesson_id = v_s.lesson_id) then
      raise exception 'not_a_missed_class';
    end if;
    if v_info.slots_left <= 0 then raise exception 'makeup_limit_reached'; end if;
    if v_status = 'active' and not private.enrolment_course_access(v_enrol, v_s.course_id) then raise exception 'payment_required'; end if;
  else
    if v_status <> 'active' then raise exception 'not_enrolled'; end if;
    if not private.enrolment_course_access(v_enrol, v_s.course_id) then raise exception 'payment_required'; end if;
  end if;

  insert into public.attendance (session_id, student_id, enrolment_id, status, method)
  values (v_s.id, v_uid, v_enrol, 'present', 'qr_scan')
  on conflict (session_id, student_id) do update
    set status = 'present', method = 'qr_scan', checked_in_at = now()
    where public.attendance.status <> 'present'
  returning * into v_row;

  return jsonb_build_object(
    'ok', true,
    'already_checked_in', v_row.id is null,
    'makeup', v_makeup,
    'session_id', v_s.id, 'course_id', v_s.course_id, 'lesson_id', v_s.lesson_id);
end $$;

-- Patch the live functions in place (they were changed by migrations 28/29, so we don't re-create them from an old copy):
-- absences, class counts and the instructor roster only cover a student's own run; the roster also lists make-up attendees.
do $patch$
declare p record; d text;
begin
  for p in select * from (values
    ('private.log_absentees(uuid)', 'private.clock_open(e.id, v_s.session_date)',
     'private.clock_open(e.id, v_s.session_date) and private.in_own_run(e.id, v_s.course_id, v_s.run_id)'),
    ('private.refresh_session_counts(uuid)', 'private.clock_open(e.id, v_s.session_date)',
     'private.clock_open(e.id, v_s.session_date) and private.in_own_run(e.id, v_s.course_id, v_s.run_id)'),
    ('public.session_attendance_roster(uuid)', 'private.clock_open(e.id, v_s.session_date)',
     'private.clock_open(e.id, v_s.session_date) and (private.in_own_run(e.id, v_s.course_id, v_s.run_id) or exists (select 1 from public.attendance a2 where a2.session_id = p_session_id and a2.student_id = e.student_id))'),
    ('public.create_enrolment(uuid,uuid,plan_type,uuid[],uuid,uuid)', 'e.status in (''pending_payment'',''active'')',
     '(e.status = ''pending_payment'' or (e.status = ''active'' and not private.pack_ended(e.id)))')
  ) as t(fn, old, new) loop
    select pg_get_functiondef(p.fn::regprocedure) into d;
    if position('in_own_run' in d) > 0 or position('pack_ended' in d) > 0 then continue; end if;   -- already patched
    if position(p.old in d) = 0 then raise exception 'patch target missing in %', p.fn; end if;
    execute replace(d, p.old, p.new);
  end loop;
end $patch$;

-- Student's class checklist (same as migration 28, but "missed" is judged against the student's own run)
create or replace view public.v_lesson_progress with (security_invoker = true) as
select e.id as enrolment_id, e.student_id, e.status as enrolment_status,
       ec.course_id, ec.sequence_no, l.id as lesson_id, l.lesson_no, l.title, l.summary,
       case
         when exists (select 1 from public.attendance a join public.class_sessions s on s.id = a.session_id
                       where a.enrolment_id = e.id and a.status = 'present' and s.lesson_id = l.id) then 'attended'
         when exists (select 1 from public.class_sessions s
                       where s.run_id = private.own_run(e.id, l.course_id) and s.lesson_id = l.id
                         and s.status = 'completed' and private.clock_open(e.id, s.session_date)) then 'missed'
         else 'upcoming'
       end as state
  from public.enrolments e
  join public.enrolment_courses ec on ec.enrolment_id = e.id
  join public.course_lessons l on l.course_id = ec.course_id;
grant select on public.v_lesson_progress to authenticated;

-- ---------------------------------------------------------------------------
-- What the student sees about make-up classes
-- ---------------------------------------------------------------------------
create or replace function public.my_makeup_status() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_uid uuid := (select auth.uid()); v_out jsonb := '[]'::jsonb; v_e record; v_i record; v_l jsonb;
begin
  if v_uid is null then return v_out; end if;
  for v_e in select e.id from public.enrolments e
              where e.student_id = v_uid and e.status in ('active', 'completed') and e.activated_at is not null
              order by e.created_at loop
    select * into v_i from private.makeup_info(v_e.id);
    continue when v_i.missed_count = 0 and v_i.used_count = 0;
    select coalesce(jsonb_agg(jsonb_build_object('course', c.title, 'lesson_no', m.lesson_no, 'title', m.title) order by c.sort_order, m.lesson_no), '[]'::jsonb)
      into v_l from private.missed_lessons(v_e.id) m join public.courses c on c.id = m.course_id;
    v_out := v_out || jsonb_build_object('enrolment_id', v_e.id, 'state', v_i.state, 'pack_end', v_i.pack_end_at, 'closes_at', v_i.closes_at,
      'missed', v_i.missed_count, 'used', v_i.used_count, 'allowance', v_i.allowance, 'slots_left', v_i.slots_left, 'lessons', v_l);
  end loop;
  return v_out;
end $$;
revoke all on function public.my_makeup_status() from public, anon;
grant execute on function public.my_makeup_status() to authenticated;

-- ---------------------------------------------------------------------------
-- Single-course purchases
-- ---------------------------------------------------------------------------
create or replace function private.has_paid_pack(p_student uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.enrolments e join public.packages p on p.id = e.package_id
                  where e.student_id = p_student and p.code <> 'SOLO' and e.activated_at is not null
                    and e.total_amount > 0 and e.amount_paid >= e.total_amount and e.status in ('active', 'completed', 'expired'))
$$;

create or replace function private.solo_quote(p_student uuid, p_course uuid)
returns table (price bigint, prereq_met boolean, has_prereq boolean)
language sql stable security definer set search_path = '' as $$
  select case when pm.met then cp.solo_price else cp.solo_price_unmet end, pm.met, pm.has
    from (select not exists (
                   select 1 from (select distinct group_no from public.course_prerequisites where course_id = p_course) g
                    where not exists (select 1 from public.course_prerequisites p
                                       where p.course_id = p_course and p.group_no = g.group_no
                                         and exists (select 1 from public.enrolment_courses ec join public.enrolments e on e.id = ec.enrolment_id
                                                      where e.student_id = p_student and ec.course_id = p.prerequisite_id and ec.status = 'completed'))) as met,
                 exists (select 1 from public.course_prerequisites where course_id = p_course) as has) pm
    left join public.course_prices cp on cp.course_id = p_course
$$;

create or replace function private.course_in_progress(p_student uuid, p_course uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.enrolments e join public.enrolment_courses ec on ec.enrolment_id = e.id
                  where e.student_id = p_student and ec.course_id = p_course
                    and (e.status = 'pending_payment' or (e.status = 'active' and not private.pack_ended(e.id))))
$$;
grant execute on function private.has_paid_pack(uuid), private.solo_quote(uuid, uuid), private.course_in_progress(uuid, uuid) to authenticated;

create or replace function public.solo_course_offers()
returns table (course_id uuid, title text, summary text, price bigint, prereq_met boolean, has_prereq boolean, blocked text)
language plpgsql stable security definer set search_path = '' as $$
#variable_conflict use_column
declare v_uid uuid := (select auth.uid());
begin
  if v_uid is null or not private.has_paid_pack(v_uid) then return; end if;
  return query
  select c.id, c.title, c.summary, q.price, q.prereq_met, q.has_prereq,
         case when private.course_in_progress(v_uid, c.id) then 'in_progress' when q.price is null then 'price_not_set' end
    from public.courses c cross join lateral private.solo_quote(v_uid, c.id) q
   where c.is_active
   order by c.sort_order;
end $$;
revoke all on function public.solo_course_offers() from public, anon;
grant execute on function public.solo_course_offers() to authenticated;

create or replace function public.create_solo_enrolment(p_centre_id uuid, p_course_id uuid) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := (select auth.uid());
  v_pkg public.packages%rowtype;
  v_q   record;
  v_id  uuid;
begin
  if v_uid is null then raise exception 'not_authenticated' using errcode = '28000'; end if;
  if not exists (select 1 from public.students where id = v_uid) then raise exception 'student_not_found'; end if;
  if not private.has_paid_pack(v_uid) then raise exception 'not_eligible_for_solo'; end if;
  if not exists (select 1 from public.courses where id = p_course_id and is_active) then raise exception 'course_not_available'; end if;
  if not exists (select 1 from public.centres where id = p_centre_id and is_active) then raise exception 'centre_not_available'; end if;
  if private.course_in_progress(v_uid, p_course_id) then raise exception 'already_enrolled_in_course'; end if;

  select * into v_q from private.solo_quote(v_uid, p_course_id);
  if v_q.price is null then raise exception 'solo_price_not_set'; end if;

  if not exists (select 1 from public.centre_course_starts(p_course_id) s where s.centre_id = p_centre_id) then
    raise exception 'no_classes_scheduled';
  end if;

  select * into v_pkg from public.packages where code = 'SOLO';
  insert into public.enrolments (student_id, centre_id, package_id, plan, currency, total_amount)
  values (v_uid, p_centre_id, v_pkg.id, 'full', v_pkg.currency, v_q.price)
  returning id into v_id;
  insert into public.enrolment_courses (enrolment_id, course_id, sequence_no) values (v_id, p_course_id, 1);
  insert into public.enrolment_instalments (enrolment_id, number, label, amount, due_rule) values (v_id, 1, 'Full payment', v_q.price, 'before_start');
  return v_id;
end $$;
revoke all on function public.create_solo_enrolment(uuid, uuid) from public, anon;
grant execute on function public.create_solo_enrolment(uuid, uuid) to authenticated;

-- (create_enrolment is patched in the block above: a course whose pack has finished no longer blocks buying it again.)

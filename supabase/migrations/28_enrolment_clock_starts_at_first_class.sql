-- 28: a student's course clock starts the day their first class of their first course is held,
-- never when they pay. enrolments.starts_on drives access, visibility, absences, progress and reminders.
-- (Applied to the live project as "28_enrolment_clock_starts_at_first_class".)

alter table public.enrolments add column if not exists starts_on date;
alter table public.enrolments add column if not exists ends_on date;
comment on column public.enrolments.starts_on is 'Date of the first class of the first course at the centre. The course clock starts here, not at payment.';
comment on column public.enrolments.ends_on is 'starts_on + the package duration in weeks (null when the package has no duration).';

-- Date of the first class of the first course in an enrolment (null when the centre has nothing scheduled)
create or replace function private.enrolment_first_class(p_enrolment_id uuid) returns date
language sql stable security definer set search_path = '' as $$
  select (select s.starts_on from public.centre_course_starts(ec.course_id) s where s.centre_id = e.centre_id)
    from public.enrolments e
    join public.enrolment_courses ec on ec.enrolment_id = e.id and ec.sequence_no = 1
   where e.id = p_enrolment_id
$$;

-- Set / refresh the clock, and keep instalment due dates in step with it
create or replace function private.set_enrolment_clock(p_enrolment_id uuid, p_notify boolean default false) returns void
language plpgsql security definer set search_path = '' as $$
declare e public.enrolments%rowtype; v_new date; v_weeks integer; v_title text; v_when text;
begin
  select * into e from public.enrolments where id = p_enrolment_id;
  if not found or e.status not in ('pending_payment','active') then return; end if;
  -- once classes have started for this student the clock is fixed
  if e.starts_on is not null and e.starts_on <= (now() at time zone 'Africa/Lagos')::date
     and exists (select 1 from public.attendance a where a.enrolment_id = e.id) then return; end if;

  v_new := private.enrolment_first_class(p_enrolment_id);
  select p.duration_weeks into v_weeks from public.packages p where p.id = e.package_id;

  if v_new is distinct from e.starts_on then
    update public.enrolments set starts_on = v_new,
           ends_on = case when v_new is not null and v_weeks is not null then v_new + v_weeks * 7 end
     where id = p_enrolment_id;
    if p_notify and e.status = 'active' then
      select c.title into v_title from public.enrolment_courses ec join public.courses c on c.id = ec.course_id
       where ec.enrolment_id = e.id and ec.sequence_no = 1;
      v_when := case when v_new is null then 'We will tell you the new date as soon as it is set.' else 'It is now ' || to_char(v_new, 'Dy DD Mon') || '.' end;
      perform private.notify(array[e.student_id], 'start_changed', 'Your first class has moved',
        coalesce(v_title, 'Your first class') || ' at ' || private.centre_place(e.centre_id) || '. ' || v_when,
        jsonb_build_object('enrolment_id', e.id, 'starts_on', v_new));
    end if;
  elsif e.ends_on is null and v_new is not null and v_weeks is not null then
    update public.enrolments set ends_on = v_new + v_weeks * 7 where id = p_enrolment_id;
  end if;

  -- instalment due dates follow the classes, not the payment date
  update public.enrolment_instalments i
     set due_date = case i.due_rule
           when 'before_start' then v_new
           when 'before_course_2' then (select s.starts_on from public.enrolment_courses ec, lateral public.centre_course_starts(ec.course_id) s where ec.enrolment_id = e.id and ec.sequence_no = 2 and s.centre_id = e.centre_id)
           when 'before_course_3' then (select s.starts_on from public.enrolment_courses ec, lateral public.centre_course_starts(ec.course_id) s where ec.enrolment_id = e.id and ec.sequence_no = 3 and s.centre_id = e.centre_id)
           when 'before_course_4' then (select s.starts_on from public.enrolment_courses ec, lateral public.centre_course_starts(ec.course_id) s where ec.enrolment_id = e.id and ec.sequence_no = 4 and s.centre_id = e.centre_id)
           else i.due_date end
   where i.enrolment_id = e.id and i.status = 'pending';
end $$;

-- Re-derive the clock of everyone studying this course at this centre
create or replace function private.refresh_clocks(p_centre_id uuid, p_course_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare r record;
begin
  for r in select e.id from public.enrolments e join public.enrolment_courses ec on ec.enrolment_id = e.id
            where e.centre_id = p_centre_id and e.status in ('pending_payment','active')
              and (ec.course_id = p_course_id) loop
    perform private.set_enrolment_clock(r.id, true);
  end loop;
end $$;

create or replace function private.trg_enrolment_clock() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  perform private.set_enrolment_clock(new.id, false);
  return null;
end $$;
-- enrolment_courses rows are inserted after the enrolment, so hang the stamp on the sequence-1 course row
create or replace function private.trg_enrolment_course_clock() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.sequence_no = 1 then perform private.set_enrolment_clock(new.enrolment_id, false); end if;
  return null;
end $$;
drop trigger if exists trg_enrolment_course_clock on public.enrolment_courses;
create trigger trg_enrolment_course_clock after insert on public.enrolment_courses
  for each row execute function private.trg_enrolment_course_clock();
-- instalments are inserted after the course rows; stamp due dates once they exist
create or replace function private.trg_instalment_clock() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  perform private.set_enrolment_clock(new.enrolment_id, false);
  return null;
end $$;
drop trigger if exists trg_instalment_clock on public.enrolment_instalments;
create trigger trg_instalment_clock after insert on public.enrolment_instalments
  for each row execute function private.trg_instalment_clock();

-- Paying must not move the clock, except when the first class has already been held:
-- then the clock moves to the next class (the student cannot attend a class that is over).
create or replace function private.on_enrolment_activated() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_title text; v_date date;
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
  end if;
  return null;
end $$;
drop trigger if exists trg_enrolment_activated on public.enrolments;
create trigger trg_enrolment_activated after update of status on public.enrolments
  for each row execute function private.on_enrolment_activated();

-- Anything that moves a run or the centre's class days re-derives the clocks
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
  perform private.refresh_clocks(v_run.centre_id, v_run.course_id);
  return v_n;
end $$;

create or replace function public.cancel_course_run(p_run_id uuid, p_reason text default null) returns void
language plpgsql security definer set search_path = '' as $$
declare v_run public.course_runs%rowtype; v_students uuid[]; v_title text;
begin
  select * into v_run from public.course_runs where id = p_run_id for update;
  if not found then raise exception 'run_not_found'; end if;
  if not (private.is_admin() or private.is_privileged() or v_run.instructor_id = (select auth.uid())) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if v_run.status = 'cancelled' then return; end if;

  update public.course_runs set status = 'cancelled', cancel_reason = p_reason where id = p_run_id;
  delete from public.session_checkin_tokens where session_id in (
    select id from public.class_sessions where run_id = p_run_id and status = 'scheduled' and start_at > now());
  update public.class_sessions set status = 'cancelled', cancelled_at = now(), cancel_reason = coalesce(p_reason, 'Run cancelled')
   where run_id = p_run_id and status = 'scheduled' and start_at > now();

  select title into v_title from public.courses where id = v_run.course_id;
  select array_agg(distinct e.student_id) into v_students
    from public.enrolments e join public.enrolment_courses ec on ec.enrolment_id = e.id
   where e.centre_id = v_run.centre_id and ec.course_id = v_run.course_id and e.status = 'active';
  perform private.notify(v_students, 'run_cancelled', 'Classes cancelled',
    v_title || ' at ' || private.centre_place(v_run.centre_id) || ' has been cancelled.' || coalesce(' Reason: ' || p_reason, ''),
    jsonb_build_object('run_id', p_run_id));
  perform private.refresh_clocks(v_run.centre_id, v_run.course_id);
end $$;
revoke all on function public.cancel_course_run(uuid, text) from public, anon;
grant execute on function public.cancel_course_run(uuid, text) to authenticated;

-- Backfill
update public.enrolments e set starts_on = coalesce(
        (select s.starts_on from public.enrolment_courses ec, lateral public.centre_course_starts(ec.course_id) s
          where ec.enrolment_id = e.id and ec.sequence_no = 1 and s.centre_id = e.centre_id),
        (e.activated_at at time zone 'Africa/Lagos')::date)
 where e.starts_on is null and e.status in ('pending_payment','active','completed');
update public.enrolments e set ends_on = e.starts_on + p.duration_weeks * 7
  from public.packages p where p.id = e.package_id and e.starts_on is not null and p.duration_weeks is not null and e.ends_on is null;

-- Eligibility for a class: it was held on/after the student's start date
create or replace function private.clock_open(p_enrolment_id uuid, p_session_date date) returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce((select coalesce(e.starts_on, (e.activated_at at time zone 'Africa/Lagos')::date, p_session_date) <= p_session_date
                     from public.enrolments e where e.id = p_enrolment_id), false)
$$;

do $patch$
declare p record; d text;
begin
  for p in select * from (values
    ('private.log_absentees(uuid)', 'coalesce(e.activated_at, e.created_at) <= v_s.end_at', 'private.clock_open(e.id, v_s.session_date)'),
    ('private.refresh_session_counts(uuid)', 'coalesce(e.activated_at, e.created_at) <= v_s.end_at', 'private.clock_open(e.id, v_s.session_date)'),
    ('public.session_attendance_roster(uuid)', 'coalesce(e.activated_at, e.created_at) <= v_s.end_at', 'private.clock_open(e.id, v_s.session_date)'),
    ('public.check_in(text)', 'and e.status = ''active''
   limit 1;
  if v_enrol is null then raise exception ''not_enrolled''; end if;', 'and e.status = ''active'' and private.clock_open(e.id, v_s.session_date)
   limit 1;
  if v_enrol is null then raise exception ''not_enrolled''; end if;')
  ) as t(fn, old, new) loop
    select pg_get_functiondef(p.fn::regprocedure) into d;
    if position(p.old in d) = 0 then raise exception 'patch target missing in %', p.fn; end if;
    execute replace(d, p.old, p.new);
  end loop;
end $patch$;

-- Students only see classes from their start date onward
alter policy sessions_select on public.class_sessions
  using (private.is_admin() or (instructor_id = (select auth.uid())) or private.is_centre_staff(centre_id)
         or exists (select 1 from public.enrolments e join public.enrolment_courses ec on ec.enrolment_id = e.id
                     where e.student_id = (select auth.uid()) and e.centre_id = class_sessions.centre_id
                       and ec.course_id = class_sessions.course_id and e.status in ('active','completed')
                       and private.clock_open(e.id, class_sessions.session_date)));

-- Class checklist: "missed" counts only classes held since the student's start date
create or replace view public.v_lesson_progress with (security_invoker = true) as
select e.id as enrolment_id, e.student_id, e.status as enrolment_status,
       ec.course_id, ec.sequence_no, l.id as lesson_id, l.lesson_no, l.title, l.summary,
       case
         when exists (select 1 from public.attendance a join public.class_sessions s on s.id = a.session_id
                       where a.enrolment_id = e.id and a.status = 'present' and s.lesson_id = l.id) then 'attended'
         when exists (select 1 from public.class_sessions s
                       where s.centre_id = e.centre_id and s.course_id = l.course_id and s.lesson_id = l.id
                         and s.status = 'completed'
                         and private.clock_open(e.id, s.session_date)) then 'missed'
         else 'upcoming'
       end as state
  from public.enrolments e
  join public.enrolment_courses ec on ec.enrolment_id = e.id
  join public.course_lessons l on l.course_id = ec.course_id;
grant select on public.v_lesson_progress to authenticated;

-- Daily reminders, all keyed to class dates
create or replace function public.remind_upcoming_classes() returns integer
language plpgsql security definer set search_path = '' as $$
declare r record; v_n integer := 0; v_today date := (now() at time zone 'Africa/Lagos')::date;
begin
  if not (private.is_privileged() or private.is_admin()) then raise exception 'forbidden' using errcode = '42501'; end if;

  -- paid students: classes start tomorrow
  for r in
    select e.id, e.student_id, e.centre_id, e.starts_on, c.title,
           (select to_char(cd.start_time, 'HH12:MI AM') from public.centre_class_days cd
             where cd.centre_id = e.centre_id and cd.day_of_week = extract(isodow from e.starts_on)::int) as at_time
      from public.enrolments e
      join public.enrolment_courses ec on ec.enrolment_id = e.id and ec.sequence_no = 1
      join public.courses c on c.id = ec.course_id
     where e.status = 'active' and e.starts_on = v_today + 1
       and not exists (select 1 from public.notifications n where n.user_id = e.student_id and n.type = 'class_tomorrow'
                          and n.data ->> 'enrolment_id' = e.id::text)
  loop
    perform private.notify(array[r.student_id], 'class_tomorrow', 'Classes start tomorrow',
      r.title || ' at ' || private.centre_place(r.centre_id) || coalesce(', ' || r.at_time, '') || '.',
      jsonb_build_object('enrolment_id', r.id));
    v_n := v_n + 1;
  end loop;

  -- unpaid: first payment is due before the first class
  for r in
    select e.id, e.student_id, e.centre_id, e.starts_on, i.id as inst_id, i.amount
      from public.enrolments e
      join public.enrolment_instalments i on i.enrolment_id = e.id and i.number = 1 and i.status = 'pending'
     where e.status = 'pending_payment' and e.starts_on between v_today and v_today + 3
       and not exists (select 1 from public.notifications n where n.user_id = e.student_id and n.type = 'pay_before_start'
                          and n.data ->> 'enrolment_id' = e.id::text)
  loop
    perform private.notify(array[r.student_id], 'pay_before_start', 'Secure your place',
      'Classes at ' || private.centre_place(r.centre_id) || ' start ' || to_char(r.starts_on, 'Dy DD Mon') || '. Pay ' || private.fmt_naira(r.amount) || ' before then.',
      jsonb_build_object('enrolment_id', r.id, 'instalment_id', r.inst_id));
    v_n := v_n + 1;
  end loop;

  -- later instalments: due before the course they unlock begins
  for r in
    select e.student_id, e.id as enrolment_id, i.id as inst_id, i.amount, i.due_date, c.title, e.centre_id
      from public.enrolment_instalments i
      join public.enrolments e on e.id = i.enrolment_id and e.status = 'active'
      join public.enrolment_courses ec on ec.enrolment_id = e.id
           and ec.sequence_no = (substring(i.due_rule::text from 'before_course_(\d)'))::int
      join public.courses c on c.id = ec.course_id
     where i.status = 'pending' and i.due_rule::text like 'before_course_%'
       and i.due_date between v_today and v_today + 7
       and not exists (select 1 from public.notifications n where n.user_id = e.student_id and n.type = 'instalment_due'
                          and n.data ->> 'instalment_id' = i.id::text)
  loop
    perform private.notify(array[r.student_id], 'instalment_due', 'Instalment due soon',
      private.fmt_naira(r.amount) || ' is due before ' || r.title || ' starts on ' || to_char(r.due_date, 'Dy DD Mon') || '.',
      jsonb_build_object('enrolment_id', r.enrolment_id, 'instalment_id', r.inst_id));
    v_n := v_n + 1;
  end loop;
  return v_n;
end $$;

revoke all on function public.remind_upcoming_classes() from public, anon, authenticated;
select cron.schedule('iqa-class-reminders', '0 7 * * *', 'select public.remind_upcoming_classes()');

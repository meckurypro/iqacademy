-- 43_emergency_classes.sql   (applied to the live DB as "emergency_classes", then "emergency_classes_error_keys" for the error names in section 11)
-- An emergency class is a one-off class that is not part of any course run or timetable.
--   * An instructor can start one for themselves (pick centre, course, topic, time); an admin can start one and
--     assign the instructor. Course and topic are required: the topic is one of the course's classes (course_lessons).
--   * Students with an active registration at that centre can check in, whatever course they are on. Attendance is
--     recorded against their own registration. It counts toward progress only when they are on that course.
--   * Check-in follows the door rules from "door_check_in": centre staff or an admin issue the code and open the door.
--     Centre staff at the centre are told so they know to do it. Denied check-ins are logged like any other.
--   * Nobody is marked absent when an emergency class ends (it is optional), and Roster bulk assignment by course
--     or centre never moves an emergency class.
-- Builds on the live versions of check_in, mark_attendance, session_attendance_roster, cancel_session, roster_assign,
-- my_classes, instructor_dashboard and v_session_details (which include the door check-in changes).

-- ---------- 1. Columns ----------
alter table public.class_sessions
  add column if not exists is_emergency boolean not null default false,
  add column if not exists created_by uuid references public.profiles (id);
create index if not exists class_sessions_emergency_idx on public.class_sessions (centre_id, start_at) where is_emergency;

-- ---------- 2. An emergency class has no slot or run to copy from ----------
create or replace function private.fill_session_from_slot()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_slot public.timetable_slots%rowtype; v_run public.course_runs%rowtype;
begin
  if new.is_emergency then
    if new.centre_id is null or new.course_id is null then raise exception 'course_not_found'; end if;
    new.slot_id := null; new.run_id := null; new.cohort_id := null;
    return new;
  end if;
  if new.run_id is not null then
    select * into v_run from public.course_runs where id = new.run_id;
    if not found then raise exception 'run_not_found'; end if;
    new.centre_id := v_run.centre_id;
    new.course_id := v_run.course_id;
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

-- ---------- 3. Attendance for an emergency class: any active registration at the centre ----------
create or replace function private.prepare_attendance()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_s public.class_sessions%rowtype;
begin
  select * into v_s from public.class_sessions where id = new.session_id;
  if not found then raise exception 'session_not_found'; end if;
  new.course_id := v_s.course_id;
  new.cohort_id := v_s.cohort_id;
  new.centre_id := v_s.centre_id;

  if v_s.is_emergency then
    if new.enrolment_id is null then
      select e.id into new.enrolment_id
        from public.enrolments e
       where e.student_id = new.student_id and e.centre_id = v_s.centre_id and e.status = 'active'
       order by exists (select 1 from public.enrolment_courses ec where ec.enrolment_id = e.id and ec.course_id = v_s.course_id) desc, e.created_at desc
       limit 1;
    end if;
    if new.enrolment_id is null or not exists (
         select 1 from public.enrolments e
          where e.id = new.enrolment_id and e.student_id = new.student_id and e.centre_id = v_s.centre_id and e.status = 'active') then
      raise exception 'not_enrolled' using hint = 'Student has no active registration at this centre.';
    end if;
    return new;
  end if;

  if new.enrolment_id is null then
    select e.id into new.enrolment_id
    from public.enrolments e
    join public.enrolment_courses ec on ec.enrolment_id = e.id
    where e.student_id = new.student_id and e.centre_id = v_s.centre_id
      and ec.course_id = v_s.course_id and e.status in ('active','completed')
    limit 1;
  end if;
  if new.enrolment_id is null or not exists (
       select 1 from public.enrolments e
       join public.enrolment_courses ec on ec.enrolment_id = e.id
       where e.id = new.enrolment_id and e.student_id = new.student_id
         and e.centre_id = v_s.centre_id and ec.course_id = v_s.course_id) then
    raise exception 'not_enrolled' using hint = 'Student is not enrolled in this course/cohort.';
  end if;
  return new;
end $$;

-- ---------- 4. Nobody is marked absent for an emergency class; the head count is just who came ----------
create or replace function private.log_absentees(p_session_id uuid)
returns integer language plpgsql security definer set search_path = '' as $$
declare v_s public.class_sessions%rowtype; v_n integer;
begin
  select * into v_s from public.class_sessions where id = p_session_id;
  if not found or v_s.is_emergency then return 0; end if;
  insert into public.attendance (session_id, student_id, enrolment_id, status, method)
  select p_session_id, e.student_id, e.id, 'absent', 'system'
    from public.enrolments e join public.enrolment_courses ec on ec.enrolment_id = e.id
   where e.centre_id = v_s.centre_id and private.clock_open(e.id, v_s.session_date) and private.in_own_run(e.id, v_s.course_id, v_s.run_id) and ec.course_id = v_s.course_id and e.status = 'active'
     and private.enrolment_course_access(e.id, v_s.course_id)
     and not exists (select 1 from public.attendance a where a.session_id = p_session_id and a.student_id = e.student_id)
  on conflict (session_id, student_id) do nothing;
  get diagnostics v_n = row_count;
  return v_n;
end $$;

create or replace function private.refresh_session_counts(p_session_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_s        public.class_sessions%rowtype;
  v_present  integer; v_absent integer; v_excused integer;
  v_eligible integer;
begin
  select * into v_s from public.class_sessions where id = p_session_id;
  if not found then return; end if;

  select count(*) filter (where status = 'present'),
         count(*) filter (where status = 'absent'),
         count(*) filter (where status = 'excused')
    into v_present, v_absent, v_excused
    from public.attendance where session_id = p_session_id;

  if v_s.is_emergency then
    v_eligible := 0;
  else
    select count(*) into v_eligible
      from public.enrolments e join public.enrolment_courses ec on ec.enrolment_id = e.id
     where e.centre_id = v_s.centre_id and private.clock_open(e.id, v_s.session_date) and private.in_own_run(e.id, v_s.course_id, v_s.run_id) and ec.course_id = v_s.course_id and e.status = 'active'
       and private.enrolment_course_access(e.id, v_s.course_id);
  end if;

  update public.class_sessions
     set students_present  = v_present,
         students_absent   = v_absent,
         students_excused  = v_excused,
         students_enrolled = greatest(v_eligible, v_present + v_absent + v_excused)
   where id = p_session_id;
end $$;

-- ---------- 5. check_in: same door rules, emergency classes open to the whole centre ----------
create or replace function public.check_in(p_token text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_uid    uuid := (select auth.uid());
  v_tok    public.session_checkin_tokens%rowtype;
  v_s      public.class_sessions%rowtype;
  v_enrol  uuid;
  v_status public.enrolment_status;
  v_own    uuid;
  v_makeup boolean := false;
  v_info   record;
  v_row    public.attendance%rowtype;
  v_reason text;
  v_first  text; v_course text; v_lesson text; v_centre text;
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

  select nullif(split_part(trim(full_name), ' ', 1), '') into v_first from public.profiles where id = v_uid;
  select c.title into v_course from public.courses c where c.id = v_s.course_id;
  select l.title into v_lesson from public.course_lessons l where l.id = v_s.lesson_id;
  select ce.name into v_centre from public.centres ce where ce.id = v_s.centre_id;

  if v_s.is_emergency then
    -- any active registration at this centre will do; if they are on this course too, its payment rules still apply
    select e.id, e.status into v_enrol, v_status
      from public.enrolments e
     where e.student_id = v_uid and e.centre_id = v_s.centre_id and e.status = 'active'
     order by exists (select 1 from public.enrolment_courses ec where ec.enrolment_id = e.id and ec.course_id = v_s.course_id) desc, e.created_at desc
     limit 1;
    if v_enrol is null then v_reason := 'not_enrolled';
    elsif exists (select 1 from public.enrolment_courses ec where ec.enrolment_id = v_enrol and ec.course_id = v_s.course_id)
          and not private.enrolment_course_access(v_enrol, v_s.course_id) then
      v_reason := 'payment_required';
    end if;
  else
    select e.id, e.status into v_enrol, v_status
      from public.enrolments e join public.enrolment_courses ec on ec.enrolment_id = e.id
     where e.student_id = v_uid and e.centre_id = v_s.centre_id and ec.course_id = v_s.course_id
       and e.status in ('active', 'completed') and private.clock_open(e.id, v_s.session_date)
     order by (e.status = 'active') desc, e.created_at desc
     limit 1;

    if v_enrol is null then
      v_reason := 'not_enrolled';
    else
      v_own := private.own_run(v_enrol, v_s.course_id);
      v_makeup := v_s.run_id is not null and v_own is not null and v_s.run_id <> v_own;
      if v_makeup then
        select * into v_info from private.makeup_info(v_enrol);
        if v_info.state <> 'open' then v_reason := 'makeup_not_open';
        elsif not exists (select 1 from private.missed_lessons(v_enrol) m where m.lesson_id = v_s.lesson_id) then v_reason := 'not_a_missed_class';
        elsif v_info.slots_left <= 0 then v_reason := 'makeup_limit_reached';
        elsif v_status = 'active' and not private.enrolment_course_access(v_enrol, v_s.course_id) then v_reason := 'payment_required';
        end if;
      else
        if v_status <> 'active' then v_reason := 'not_enrolled';
        elsif not private.enrolment_course_access(v_enrol, v_s.course_id) then v_reason := 'payment_required';
        end if;
      end if;
    end if;
  end if;

  if v_reason is not null then
    insert into public.checkin_denials (session_id, centre_id, student_id, reason) values (v_s.id, v_s.centre_id, v_uid, v_reason);
    return jsonb_build_object('ok', false, 'reason', v_reason, 'first_name', v_first, 'course_title', v_course, 'centre_name', v_centre);
  end if;

  insert into public.attendance (session_id, student_id, enrolment_id, status, method)
  values (v_s.id, v_uid, v_enrol, 'present', 'qr_scan')
  on conflict (session_id, student_id) do update
    set status = 'present', method = 'qr_scan', checked_in_at = now()
    where public.attendance.status <> 'present'
  returning * into v_row;

  return jsonb_build_object(
    'ok', true, 'already_checked_in', v_row.id is null, 'makeup', v_makeup, 'emergency', v_s.is_emergency,
    'session_id', v_s.id, 'course_id', v_s.course_id, 'lesson_id', v_s.lesson_id,
    'first_name', v_first, 'course_title', v_course, 'lesson_title', v_lesson, 'centre_name', v_centre);
end $$;

-- ---------- 6. Manual marking for an emergency class: any active student at the centre ----------
create or replace function public.mark_attendance(p_session_id uuid, p_student_id uuid, p_status public.attendance_status default 'present', p_notes text default null)
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_s public.class_sessions%rowtype;
  v_enrol uuid;
begin
  select * into v_s from public.class_sessions where id = p_session_id;
  if not found then raise exception 'session_not_found'; end if;
  if not (private.is_admin() or v_s.instructor_id = (select auth.uid()) or private.is_centre_staff(v_s.centre_id)) then raise exception 'forbidden' using errcode = '42501'; end if;

  if v_s.is_emergency then
    select e.id into v_enrol
      from public.enrolments e
     where e.student_id = p_student_id and e.centre_id = v_s.centre_id and e.status = 'active'
     order by exists (select 1 from public.enrolment_courses ec where ec.enrolment_id = e.id and ec.course_id = v_s.course_id) desc, e.created_at desc
     limit 1;
  else
    select e.id into v_enrol
      from public.enrolments e join public.enrolment_courses ec on ec.enrolment_id = e.id
     where e.student_id = p_student_id and e.centre_id = v_s.centre_id and ec.course_id = v_s.course_id
       and e.status = 'active'
     limit 1;
  end if;
  if v_enrol is null then raise exception 'not_enrolled'; end if;

  insert into public.attendance (session_id, student_id, enrolment_id, status, method, marked_by, notes)
  values (p_session_id, p_student_id, v_enrol, p_status,
          case when private.is_admin() then 'admin'::public.attendance_method
               when private.is_centre_staff(v_s.centre_id) then 'centre_staff'::public.attendance_method
               else 'instructor'::public.attendance_method end,
          (select auth.uid()), p_notes)
  on conflict (session_id, student_id) do update
    set status = excluded.status, method = excluded.method, marked_by = excluded.marked_by,
        notes = excluded.notes, checked_in_at = now();
end $$;

-- ---------- 7. Roster for an emergency class: the centre's active students ----------
create or replace function public.session_attendance_roster(p_session_id uuid)
returns table (student_id uuid, full_name text, status public.attendance_status, method public.attendance_method, checked_in_at timestamptz)
language plpgsql stable security definer set search_path = '' as $$
#variable_conflict use_column
declare v_s public.class_sessions%rowtype;
begin
  select * into v_s from public.class_sessions where id = p_session_id;
  if not found then raise exception 'session_not_found'; end if;
  if not (private.is_admin() or v_s.instructor_id = (select auth.uid()) or private.is_centre_staff(v_s.centre_id)) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if v_s.is_emergency then
    return query
    select pr.id, pr.full_name, a.status, a.method, a.checked_in_at
      from (select e.student_id from public.enrolments e where e.centre_id = v_s.centre_id and e.status = 'active'
            union select a2.student_id from public.attendance a2 where a2.session_id = p_session_id) st
      join public.profiles pr on pr.id = st.student_id
      left join public.attendance a on a.session_id = p_session_id and a.student_id = st.student_id
     order by (a.status = 'present') desc nulls last, pr.full_name;
    return;
  end if;
  return query
  select pr.id, pr.full_name, a.status, a.method, a.checked_in_at
    from (select distinct e.student_id
            from public.enrolments e join public.enrolment_courses ec on ec.enrolment_id = e.id
           where e.centre_id = v_s.centre_id and private.clock_open(e.id, v_s.session_date) and (private.in_own_run(e.id, v_s.course_id, v_s.run_id) or exists (select 1 from public.attendance a2 where a2.session_id = p_session_id and a2.student_id = e.student_id)) and ec.course_id = v_s.course_id and e.status in ('active','completed')) st
    join public.profiles pr on pr.id = st.student_id
    left join public.attendance a on a.session_id = p_session_id and a.student_id = st.student_id
   order by pr.full_name;
end $$;

-- ---------- 8. Cancelling an emergency class tells the whole centre ----------
create or replace function public.cancel_session(p_session_id uuid, p_reason text default null)
returns void language plpgsql security definer set search_path = '' as $$
declare v_s public.class_sessions%rowtype; v_students uuid[];
begin
  select * into v_s from public.class_sessions where id = p_session_id;
  if not found then raise exception 'session_not_found'; end if;
  if not (private.is_admin() or v_s.instructor_id = (select auth.uid())) then raise exception 'forbidden' using errcode = '42501'; end if;
  if v_s.status = 'completed' then raise exception 'already_completed'; end if;

  update public.class_sessions
     set status = 'cancelled', cancelled_at = now(), cancel_reason = p_reason
   where id = p_session_id;
  delete from public.session_checkin_tokens where session_id = p_session_id;

  if v_s.is_emergency then
    select array_agg(distinct e.student_id) into v_students
      from public.enrolments e where e.centre_id = v_s.centre_id and e.status = 'active';
  else
    select array_agg(e.student_id) into v_students
      from public.enrolments e join public.enrolment_courses ec on ec.enrolment_id = e.id
     where e.centre_id = v_s.centre_id and ec.course_id = v_s.course_id and e.status = 'active';
  end if;
  perform private.notify(v_students, 'session_cancelled', case when v_s.is_emergency then 'Emergency class cancelled' else 'Class cancelled' end,
         'The ' || case when v_s.is_emergency then 'emergency ' else '' end || 'class on ' || to_char(v_s.session_date, 'Dy DD Mon') || ' has been cancelled.' ||
         coalesce(' Reason: ' || p_reason, ''),
         jsonb_build_object('session_id', p_session_id));
end $$;

-- ---------- 9. Roster bulk assignment never moves an emergency class ----------
create or replace function public.roster_assign(p_scope text, p_instructor_id uuid, p_session_ids uuid[] default null, p_course_id uuid default null, p_centre_id uuid default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := (select auth.uid());
  r record;
  v_assigned integer := 0; v_same integer := 0; v_locked integer := 0;
  v_clash jsonb := '[]'::jsonb; v_changes jsonb := '[]'::jsonb;
  v_prev uuid;
begin
  if not (private.is_admin() or private.is_privileged()) then raise exception 'forbidden' using errcode = '42501'; end if;
  if p_scope not in ('sessions', 'course_centre', 'course_all') then raise exception 'bad_scope'; end if;
  if p_scope = 'sessions' and coalesce(array_length(p_session_ids, 1), 0) = 0 then raise exception 'nothing_selected'; end if;
  if p_scope <> 'sessions' and not exists (select 1 from public.courses where id = p_course_id) then raise exception 'course_not_found'; end if;
  if p_scope = 'course_centre' and not exists (select 1 from public.centres where id = p_centre_id) then raise exception 'centre_not_found'; end if;
  if p_instructor_id is not null and not exists (
       select 1 from public.user_roles ur where ur.user_id = p_instructor_id and ur.is_active and ur.role = 'instructor') then
    raise exception 'not_an_instructor';
  end if;

  for r in
    select cs.id, cs.course_id, cs.centre_id, cs.status, cs.start_at, cs.end_at, cs.instructor_id as prev, co.title, ce.timezone as tz
      from public.class_sessions cs
      join public.courses co on co.id = cs.course_id
      join public.centres ce on ce.id = cs.centre_id
     where cs.status <> 'cancelled'
       and case p_scope
             when 'sessions' then cs.id = any (p_session_ids)
             when 'course_centre' then cs.course_id = p_course_id and cs.centre_id = p_centre_id and not cs.is_emergency
             else cs.course_id = p_course_id and not cs.is_emergency end
     order by cs.start_at, cs.id
       for update of cs
  loop
    if r.status <> 'scheduled' or r.start_at <= now() then v_locked := v_locked + 1; continue; end if;
    if r.prev is not distinct from p_instructor_id then v_same := v_same + 1; continue; end if;
    if p_instructor_id is not null and exists (
         select 1 from public.class_sessions o
          where o.instructor_id = p_instructor_id and o.status <> 'cancelled' and o.id <> r.id
            and tstzrange(o.start_at, o.end_at) && tstzrange(r.start_at, r.end_at)) then
      v_clash := v_clash || jsonb_build_object('id', r.id, 'course', r.title, 'at', to_char(r.start_at at time zone r.tz, 'Dy DD Mon, HH24:MI'));
      continue;
    end if;
    update public.class_sessions set instructor_id = p_instructor_id where id = r.id;
    v_assigned := v_assigned + 1;
    v_changes := v_changes || jsonb_build_object('course_id', r.course_id, 'centre_id', r.centre_id, 'prev', r.prev, 'start_at', r.start_at, 'tz', r.tz);
  end loop;

  if v_assigned > 0 then
    if p_instructor_id is not null and p_instructor_id is distinct from v_uid then
      perform private.notify(array[p_instructor_id], 'class_assigned',
        case when v_assigned = 1 then 'New class assigned' else 'New classes assigned' end,
        private.roster_lines(v_changes, null), jsonb_build_object('count', v_assigned));
    end if;
    for v_prev in select distinct (x ->> 'prev')::uuid from jsonb_array_elements(v_changes) x where x ->> 'prev' is not null loop
      if v_prev is distinct from p_instructor_id and v_prev is distinct from v_uid then
        perform private.notify(array[v_prev], 'class_unassigned', 'Teaching change',
          'You are no longer assigned to:' || E'\n' || private.roster_lines(v_changes, v_prev), '{}'::jsonb);
      end if;
    end loop;
  end if;

  return jsonb_build_object('assigned', v_assigned, 'unchanged', v_same, 'locked', v_locked, 'clashes', v_clash);
end $$;

-- ---------- 10. Emergency flag where classes are listed ----------
-- my_classes gains is_emergency as its last column (a changed result type needs a drop and re-create)
drop function if exists public.my_classes();
create function public.my_classes()
returns table (id uuid, session_no integer, start_at timestamptz, end_at timestamptz, status text, course_id uuid, course_title text,
               total_sessions integer, lesson_title text, centre_id uuid, centre_name text, centre_city text, centre_address text, is_emergency boolean)
language sql stable security definer set search_path = '' as $$
  select s.id, s.session_no, s.start_at, s.end_at, s.status::text,
         co.id, co.title, co.total_sessions::integer, l.title,
         ce.id, ce.name, ce.city, ce.address, s.is_emergency
    from public.class_sessions s
    join public.courses co on co.id = s.course_id
    join public.centres ce on ce.id = s.centre_id
    left join public.course_lessons l on l.id = s.lesson_id
   where s.instructor_id = (select auth.uid()) and s.status in ('scheduled', 'in_progress') and s.end_at >= now()
   order by s.start_at
$$;
revoke all on function public.my_classes() from public, anon;
grant execute on function public.my_classes() to authenticated;

-- v_session_details gains is_emergency as its last column
create or replace view public.v_session_details with (security_invoker = true) as
 SELECT s.id, s.session_date, s.start_at, s.end_at, s.status, s.session_no, s.cohort_id, s.centre_id,
    c.name AS centre_name, c.address AS centre_address, s.course_id, co.title AS course_title,
    s.instructor_id, d.full_name AS instructor_name, s.lesson_id, l.title AS lesson_title,
    s.students_enrolled, s.students_present, s.students_absent, s.students_excused, s.completed_at, s.auto_closed,
    ts.room, c.city AS centre_city, s.run_id, l.summary AS lesson_summary, s.is_emergency
   FROM class_sessions s
     JOIN centres c ON c.id = s.centre_id
     JOIN courses co ON co.id = s.course_id
     LEFT JOIN timetable_slots ts ON ts.id = s.slot_id
     LEFT JOIN course_lessons l ON l.id = s.lesson_id
     LEFT JOIN v_staff_directory d ON d.id = s.instructor_id;

-- ---------- 11. Create an emergency class ----------
create or replace function public.create_emergency_class(
  p_centre_id uuid, p_course_id uuid, p_lesson_id uuid, p_start timestamptz,
  p_minutes integer default 120, p_instructor_id uuid default null, p_note text default null)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  v_uid     uuid := (select auth.uid());
  v_admin   boolean := private.is_admin();
  v_instr   uuid;
  v_tz      text;
  v_lesson  public.course_lessons%rowtype;
  v_course  text;
  v_end     timestamptz;
  v_id      uuid;
  v_who     text;
  v_when    text;
  v_place   text;
begin
  if v_uid is null then raise exception 'not_authenticated' using errcode = '28000'; end if;
  if not (v_admin or private.is_instructor()) then raise exception 'forbidden' using errcode = '42501'; end if;

  -- who teaches it: an instructor teaches their own; an admin must name an instructor
  if v_admin then
    v_instr := p_instructor_id;
    if v_instr is null then raise exception 'instructor_required'; end if;
    if not exists (select 1 from public.user_roles ur where ur.user_id = v_instr and ur.is_active and ur.role = 'instructor') then
      raise exception 'not_an_instructor';
    end if;
  else
    if p_instructor_id is not null and p_instructor_id <> v_uid then raise exception 'forbidden' using errcode = '42501'; end if;
    v_instr := v_uid;
  end if;

  select timezone into v_tz from public.centres where id = p_centre_id and is_active;
  if not found then raise exception 'centre_not_available'; end if;
  select title into v_course from public.courses where id = p_course_id and is_active;
  if not found then raise exception 'course_not_available'; end if;
  select * into v_lesson from public.course_lessons where id = p_lesson_id and course_id = p_course_id;
  if not found then raise exception 'emergency_no_topic'; end if;

  if p_start is null then raise exception 'emergency_bad_time'; end if;
  if p_start < now() - interval '15 minutes' then raise exception 'emergency_time_passed'; end if;
  if p_start > now() + interval '30 days' then raise exception 'emergency_too_far'; end if;
  if p_minutes is null or p_minutes < 15 or p_minutes > 480 then raise exception 'emergency_bad_length'; end if;
  if char_length(coalesce(p_note, '')) > 300 then raise exception 'emergency_note_long'; end if;
  v_end := p_start + make_interval(mins => p_minutes);

  if exists (select 1 from public.class_sessions o
              where o.instructor_id = v_instr and o.status <> 'cancelled'
                and tstzrange(o.start_at, o.end_at) && tstzrange(p_start, v_end)) then
    raise exception 'instructor_clash';
  end if;

  insert into public.class_sessions (centre_id, course_id, instructor_id, lesson_id, session_no, session_date, start_at, end_at,
                                     status, title, notes, is_emergency, created_by)
  values (p_centre_id, p_course_id, v_instr, p_lesson_id, v_lesson.lesson_no, (p_start at time zone v_tz)::date, p_start, v_end,
          'scheduled', 'Emergency class', nullif(trim(p_note), ''), true, v_uid)
  returning id into v_id;

  v_place := private.centre_place(p_centre_id);
  v_when  := to_char(p_start at time zone v_tz, 'Dy DD Mon, HH12:MI AM');
  select nullif(split_part(trim(full_name), ' ', 1), '') into v_who from public.profiles where id = v_instr;

  -- students registered at the centre
  perform private.notify((select array_agg(distinct e.student_id) from public.enrolments e where e.centre_id = p_centre_id and e.status = 'active'),
    'emergency_class', 'Emergency class',
    v_course || ': ' || v_lesson.title || ' at ' || v_place || ', ' || v_when || '. Check in at the centre with the class code.',
    jsonb_build_object('session_id', v_id));
  -- centre staff, who open the door
  perform private.notify((select array_agg(distinct ur.user_id) from public.user_roles ur
                           where ur.is_active and ur.role in ('centre_director', 'coordinator') and ur.centre_id = p_centre_id and ur.user_id <> v_uid),
    'emergency_class_staff', 'Emergency class at your centre',
    v_course || ': ' || v_lesson.title || ', ' || v_when || coalesce(' with ' || v_who, '') || '. Open check-in when students arrive.',
    jsonb_build_object('session_id', v_id));
  if v_admin then
    -- the instructor an admin picked
    if v_instr <> v_uid then
      perform private.notify(array[v_instr], 'class_assigned', 'Emergency class assigned',
        v_course || ': ' || v_lesson.title || ' at ' || v_place || ', ' || v_when || '.', jsonb_build_object('session_id', v_id));
    end if;
  else
    -- admins hear about one an instructor started
    perform private.notify((select array_agg(distinct ur.user_id) from public.user_roles ur where ur.is_active and ur.role in ('admin', 'super_admin') and ur.user_id <> v_uid),
      'emergency_class_admin', 'Instructor started an emergency class',
      coalesce(v_who, 'An instructor') || ': ' || v_course || ' (' || v_lesson.title || ') at ' || v_place || ', ' || v_when || '.',
      jsonb_build_object('session_id', v_id));
  end if;

  return v_id;
end $$;
revoke all on function public.create_emergency_class(uuid, uuid, uuid, timestamptz, integer, uuid, text) from public, anon;
grant execute on function public.create_emergency_class(uuid, uuid, uuid, timestamptz, integer, uuid, text) to authenticated;

-- ---------- 12. What a student sees: open emergency classes at the centres they are registered at ----------
create or replace function public.emergency_classes_for_me()
returns table (id uuid, start_at timestamptz, end_at timestamptz, status text, course_title text, lesson_title text,
               centre_name text, centre_city text, centre_address text, instructor_first_name text, note text, checked_in boolean)
language sql stable security definer set search_path = '' as $$
  select s.id, s.start_at, s.end_at, s.status::text, co.title, l.title, ce.name, ce.city, ce.address,
         nullif(split_part(trim(pr.full_name), ' ', 1), ''), s.notes,
         exists (select 1 from public.attendance a where a.session_id = s.id and a.student_id = (select auth.uid()) and a.status = 'present')
    from public.class_sessions s
    join public.courses co on co.id = s.course_id
    join public.centres ce on ce.id = s.centre_id
    left join public.course_lessons l on l.id = s.lesson_id
    left join public.profiles pr on pr.id = s.instructor_id
   where s.is_emergency and s.status in ('scheduled', 'in_progress') and s.end_at >= now() - interval '30 minutes'
     and exists (select 1 from public.enrolments e where e.student_id = (select auth.uid()) and e.centre_id = s.centre_id and e.status = 'active')
   order by s.start_at
$$;
revoke all on function public.emergency_classes_for_me() from public, anon;
grant execute on function public.emergency_classes_for_me() to authenticated;

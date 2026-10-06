-- 46_emergency_followups.sql   (applied to the live DB as "emergency_followups")
-- Follow-ups to 43_emergency_classes, built on the live class clock (45) and door check-in (43_door_check_in):
--   1. Notifications say who they are for. Students on the course get "your course"; everyone else active at the
--      centre gets "open to everyone here". The teacher is never told about their own class as a student.
--   2. create_emergency_class now returns { id, notified, on_course } so the screen can say how many were told,
--      and emergency_audience() lets the form show that number before the class is created.
--   3. The instructor who teaches an emergency class can open its check-in (read the code, make a new one, see who was
--      turned away). Other classes are unchanged: only door staff and admins.
--   4. A student whose registration at the centre is still unpaid gets "Payment due" at the door, not "Not on the list".

-- ---------- 1. Who hosts an emergency class ----------
create or replace function private.hosts_emergency_class(p_session_id uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.class_sessions cs
                  where cs.id = p_session_id and cs.is_emergency and cs.instructor_id = (select auth.uid()))
$$;
revoke all on function private.hosts_emergency_class(uuid) from public, anon, authenticated;

drop policy if exists checkin_tokens_select on public.session_checkin_tokens;
create policy checkin_tokens_select on public.session_checkin_tokens for select to authenticated
  using (private.is_admin() or private.staffs_session(session_id) or private.hosts_emergency_class(session_id));

drop policy if exists checkin_denials_select on public.checkin_denials;
create policy checkin_denials_select on public.checkin_denials for select to authenticated
  using (private.is_admin() or private.is_centre_staff(centre_id) or private.hosts_emergency_class(session_id));

-- rewrite one function in place; fails loudly if the text to change isn't there
create or replace function pg_temp.patch_fn(p_schema text, p_name text, p_old text, p_new text) returns void
language plpgsql as $f$
declare v_oid oid; v_def text;
begin
  select p.oid into strict v_oid from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = p_schema and p.proname = p_name;
  v_def := pg_get_functiondef(v_oid);
  if position(p_old in v_def) = 0 then raise exception 'patch target not found in %.%: %', p_schema, p_name, p_old; end if;
  execute replace(v_def, p_old, p_new);
end $f$;

select pg_temp.patch_fn('public', 'generate_checkin_token',
  $o$if not (private.is_admin() or private.is_centre_staff(v_s.centre_id)) then raise exception 'forbidden' using errcode = '42501'; end if;$o$,
  $n$if not (private.is_admin() or private.is_centre_staff(v_s.centre_id) or (v_s.is_emergency and v_s.instructor_id = (select auth.uid()))) then raise exception 'forbidden' using errcode = '42501'; end if;$n$);
select pg_temp.patch_fn('public', 'session_denied_attempts',
  $o$if not (private.is_admin() or private.is_centre_staff(v_s.centre_id)) then raise exception 'forbidden' using errcode = '42501'; end if;$o$,
  $n$if not (private.is_admin() or private.is_centre_staff(v_s.centre_id) or (v_s.is_emergency and v_s.instructor_id = (select auth.uid()))) then raise exception 'forbidden' using errcode = '42501'; end if;$n$);

-- ---------- 4. Unpaid registration at the door ----------
select pg_temp.patch_fn('public', 'check_in',
  $o$    if v_enrol is null then v_reason := 'not_enrolled';
    elsif exists (select 1 from public.enrolment_courses ec where ec.enrolment_id = v_enrol and ec.course_id = v_s.course_id)$o$,
  $n$    if v_enrol is null then
      v_reason := case when exists (select 1 from public.enrolments e2 where e2.student_id = v_uid and e2.centre_id = v_s.centre_id and e2.status = 'pending_payment')
                       then 'payment_required' else 'not_enrolled' end;
    elsif exists (select 1 from public.enrolment_courses ec where ec.enrolment_id = v_enrol and ec.course_id = v_s.course_id)$n$);

-- ---------- 2. Audience preview ----------
create or replace function public.emergency_audience(p_centre_id uuid, p_course_id uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_students integer; v_on_course integer;
begin
  if not (private.is_admin() or private.is_instructor()) then raise exception 'forbidden' using errcode = '42501'; end if;
  select count(distinct e.student_id),
         count(distinct e.student_id) filter (where exists (select 1 from public.enrolment_courses ec where ec.enrolment_id = e.id and ec.course_id = p_course_id))
    into v_students, v_on_course
    from public.enrolments e where e.centre_id = p_centre_id and e.status = 'active';
  return jsonb_build_object('students', coalesce(v_students, 0), 'on_course', coalesce(v_on_course, 0));
end $$;
revoke all on function public.emergency_audience(uuid, uuid) from public, anon;
grant execute on function public.emergency_audience(uuid, uuid) to authenticated;

-- ---------- 1+2. Create: targeted notifications and a result the screen can use ----------
drop function if exists public.create_emergency_class(uuid, uuid, uuid, timestamptz, integer, uuid, text);
create function public.create_emergency_class(
  p_centre_id uuid, p_course_id uuid, p_lesson_id uuid, p_start timestamptz,
  p_minutes integer default 120, p_instructor_id uuid default null, p_note text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
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
  v_on      uuid[];
  v_rest    uuid[];
begin
  if v_uid is null then raise exception 'not_authenticated' using errcode = '28000'; end if;
  if not (v_admin or private.is_instructor()) then raise exception 'forbidden' using errcode = '42501'; end if;

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

  -- students with an active registration at the centre: those on this course first, then everyone else
  select array_agg(distinct e.student_id) filter (where exists (select 1 from public.enrolment_courses ec where ec.enrolment_id = e.id and ec.course_id = p_course_id)),
         array_agg(distinct e.student_id)
    into v_on, v_rest
    from public.enrolments e where e.centre_id = p_centre_id and e.status = 'active' and e.student_id <> v_instr;
  v_rest := array(select x from unnest(coalesce(v_rest, '{}'::uuid[])) x where not (x = any (coalesce(v_on, '{}'::uuid[]))));

  perform private.notify(v_on, 'emergency_class', 'Emergency class for your course',
    v_course || ': ' || v_lesson.title || E'\n' || v_when || ' at ' || v_place || '. Check in with the class code when you arrive.'
      || coalesce(E'\n' || nullif(trim(p_note), ''), ''),
    jsonb_build_object('session_id', v_id));
  perform private.notify(v_rest, 'emergency_class', 'Emergency class at ' || v_place,
    'Open to everyone registered here. ' || v_course || ': ' || v_lesson.title || E'\n' || v_when || '. Check in with the class code when you arrive.'
      || coalesce(E'\n' || nullif(trim(p_note), ''), ''),
    jsonb_build_object('session_id', v_id));

  perform private.notify((select array_agg(distinct ur.user_id) from public.user_roles ur
                           where ur.is_active and ur.role in ('centre_director', 'coordinator') and ur.centre_id = p_centre_id and ur.user_id <> v_uid),
    'emergency_class_staff', 'Emergency class at your centre',
    v_course || ': ' || v_lesson.title || ', ' || v_when || coalesce(' with ' || v_who, '') || '. The class code is ready 30 minutes before.',
    jsonb_build_object('session_id', v_id));
  if v_admin then
    if v_instr <> v_uid then
      perform private.notify(array[v_instr], 'class_assigned', 'Emergency class assigned',
        v_course || ': ' || v_lesson.title || ' at ' || v_place || ', ' || v_when || '.', jsonb_build_object('session_id', v_id));
    end if;
  else
    perform private.notify((select array_agg(distinct ur.user_id) from public.user_roles ur where ur.is_active and ur.role in ('admin', 'super_admin') and ur.user_id <> v_uid),
      'emergency_class_admin', 'Instructor started an emergency class',
      coalesce(v_who, 'An instructor') || ': ' || v_course || ' (' || v_lesson.title || ') at ' || v_place || ', ' || v_when || '.',
      jsonb_build_object('session_id', v_id));
  end if;

  return jsonb_build_object('id', v_id,
    'on_course', coalesce(cardinality(v_on), 0),
    'notified', coalesce(cardinality(v_on), 0) + coalesce(cardinality(v_rest), 0));
end $$;
revoke all on function public.create_emergency_class(uuid, uuid, uuid, timestamptz, integer, uuid, text) from public, anon;
grant execute on function public.create_emergency_class(uuid, uuid, uuid, timestamptz, integer, uuid, text) to authenticated;

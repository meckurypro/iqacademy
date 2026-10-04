-- 23_course_builder.sql
-- Course builder: admin sets how many classes a course has and the topic + description of each class.
-- Instructors teach from it (the class screen shows today's topic) and students see the whole outline
-- with a per-class tick as they attend.

-- ---------------------------------------------------------------------------
-- 1) save_course_outline: replace a course's whole outline atomically.
--    p_lessons = [{"title": "...", "description": "..."}, ...]   (position in the array = class number)
--    courses.total_sessions follows the array length, so the timetable, progress bars and the
--    "classes needed to pass" rule all stay in step with the outline.
-- ---------------------------------------------------------------------------
create or replace function public.save_course_outline(p_course_id uuid, p_lessons jsonb)
returns integer
language plpgsql security definer set search_path = '' as $$
declare
  v_n       integer;
  v_i       integer;
  v_title   text;
  v_desc    text;
  v_removed uuid[];
  v_run     uuid;
  v_ec      record;
begin
  if not private.is_admin() then raise exception 'forbidden' using errcode = '42501'; end if;
  if not exists (select 1 from public.courses where id = p_course_id) then raise exception 'course_not_found'; end if;
  if p_lessons is null or jsonb_typeof(p_lessons) <> 'array' then raise exception 'outline_invalid'; end if;

  v_n := jsonb_array_length(p_lessons);
  if v_n < 1 or v_n > 40 then raise exception 'class_count_invalid'; end if;

  for v_i in 1 .. v_n loop
    v_title := btrim(coalesce(p_lessons -> (v_i - 1) ->> 'title', ''));
    v_desc  := btrim(coalesce(p_lessons -> (v_i - 1) ->> 'description', ''));
    if v_title = '' then raise exception 'topic_required'; end if;
    if char_length(v_title) > 120 then raise exception 'topic_too_long'; end if;
    if char_length(v_desc) > 1000 then raise exception 'description_too_long'; end if;
  end loop;

  -- classes being dropped (outline got shorter)
  select array_agg(id) into v_removed from public.course_lessons where course_id = p_course_id and lesson_no > v_n;
  if v_removed is not null then
    if exists (select 1 from public.lesson_materials where lesson_id = any (v_removed)) then
      raise exception 'lesson_has_materials';
    end if;
    update public.class_sessions set lesson_id = null where lesson_id = any (v_removed);
    delete from public.course_lessons where id = any (v_removed);
  end if;

  insert into public.course_lessons (course_id, lesson_no, title, summary)
  select p_course_id, ord::integer, btrim(x ->> 'title'), nullif(btrim(coalesce(x ->> 'description', '')), '')
    from jsonb_array_elements(p_lessons) with ordinality as t(x, ord)
  on conflict (course_id, lesson_no) do update
    set title = excluded.title, summary = excluded.summary, updated_at = now();

  update public.courses set total_sessions = v_n where id = p_course_id;

  -- upcoming classes of runs that haven't finished get rebuilt so each one points at the right topic
  for v_run in select id from public.course_runs
                where course_id = p_course_id and status = 'scheduled' and end_date >= current_date loop
    perform private.build_run_sessions(v_run);
  end loop;

  -- "classes needed" depends on the class count, so refresh anyone still working through this course
  for v_ec in select ec.enrolment_id from public.enrolment_courses ec
               join public.enrolments e on e.id = ec.enrolment_id
              where ec.course_id = p_course_id and ec.status <> 'completed' and e.status = 'active' loop
    perform private.refresh_course_progress(v_ec.enrolment_id, p_course_id);
  end loop;

  return v_n;
end $$;

revoke all on function public.save_course_outline(uuid, jsonb) from public, anon;
grant execute on function public.save_course_outline(uuid, jsonb) to authenticated;

-- ---------------------------------------------------------------------------
-- 2) v_lesson_progress: one row per class of each course a student is taking.
--    attended = they checked in / were marked present; missed = that class has been held
--    since they joined and they weren't there; upcoming = not held yet.
--    security_invoker, so a student only ever sees their own rows.
-- ---------------------------------------------------------------------------
create or replace view public.v_lesson_progress with (security_invoker = true) as
select e.id as enrolment_id, e.student_id, e.status as enrolment_status,
       ec.course_id, ec.sequence_no, l.id as lesson_id, l.lesson_no, l.title, l.summary,
       case
         when exists (select 1 from public.attendance a join public.class_sessions s on s.id = a.session_id
                       where a.enrolment_id = e.id and a.status = 'present' and s.lesson_id = l.id) then 'attended'
         when exists (select 1 from public.class_sessions s
                       where s.centre_id = e.centre_id and s.course_id = l.course_id and s.lesson_id = l.id
                         and s.status = 'completed'
                         and s.end_at >= coalesce(e.activated_at, e.created_at)) then 'missed'
         else 'upcoming'
       end as state
  from public.enrolments e
  join public.enrolment_courses ec on ec.enrolment_id = e.id
  join public.course_lessons l on l.course_id = ec.course_id;

grant select on public.v_lesson_progress to authenticated;

-- ---------------------------------------------------------------------------
-- 3) Instructors see the topic description on the class screen.
-- ---------------------------------------------------------------------------
create or replace view public.v_session_details as
 SELECT s.id, s.session_date, s.start_at, s.end_at, s.status, s.session_no, s.cohort_id, s.centre_id,
    c.name AS centre_name, c.address AS centre_address, s.course_id, co.title AS course_title,
    s.instructor_id, d.full_name AS instructor_name, s.lesson_id, l.title AS lesson_title,
    s.students_enrolled, s.students_present, s.students_absent, s.students_excused,
    s.completed_at, s.auto_closed, ts.room, c.city AS centre_city, s.run_id,
    l.summary AS lesson_summary
   FROM class_sessions s
     JOIN centres c ON c.id = s.centre_id
     JOIN courses co ON co.id = s.course_id
     LEFT JOIN timetable_slots ts ON ts.id = s.slot_id
     LEFT JOIN course_lessons l ON l.id = s.lesson_id
     LEFT JOIN v_staff_directory d ON d.id = s.instructor_id;

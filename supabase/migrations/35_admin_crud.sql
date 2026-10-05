-- 35_admin_crud.sql
-- Admin create / edit / delete for courses and packages (the Course Builder and Prices pages).
-- Written against the LIVE schema (checked 2026-10-05) and applied to the live project as "admin_crud_courses_packages".
-- Replaces an earlier draft 31_admin_crud.sql that was never applied: cohorts and timetable slots no longer exist, and
-- delete_centre is already defined in migration 21, so this file deliberately does not touch it.
--
--   save_course     create or edit a course, its outline and its prerequisites in ONE transaction
--   delete_course   delete a course that nothing depends on
--   delete_package  delete a package nobody has enrolled on (never the hidden SOLO package)
--
-- Every delete refuses, with a readable error key, when something still depends on the row; hiding (is_active = false)
-- is the way to retire anything that has history. Error keys are translated in src/lib/supabase.ts.

-- p_lessons       = [{"title": "...", "description": "..."}, ...]   (null = leave the outline alone)
-- p_prerequisites = [["<course id>", ...], ...]  one inner array per requirement; ANY one course in an array satisfies
--                   it and ALL requirements must be met (null = leave prerequisites alone)
-- A new course is created hidden, with the standard number of classes, and no outline until one is saved.
create or replace function public.save_course(
  p_course_id uuid, p_code text, p_title text, p_summary text, p_is_active boolean,
  p_lessons jsonb default null, p_prerequisites jsonb default null
) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_id    uuid;
  v_code  text := upper(btrim(coalesce(p_code, '')));
  v_group jsonb;
  v_pre   text;
  v_pid   uuid;
  v_no    integer := 0;
begin
  if not private.is_admin() then raise exception 'forbidden' using errcode = '42501'; end if;
  if btrim(coalesce(p_title, '')) = '' then raise exception 'course_title_required'; end if;
  if char_length(btrim(p_title)) > 120 then raise exception 'topic_too_long'; end if;

  if p_course_id is null then
    if v_code !~ '^[A-Z0-9_-]{2,20}$' then raise exception 'course_code_invalid'; end if;
    if exists (select 1 from public.courses where upper(code) = v_code) then raise exception 'course_code_taken'; end if;
    insert into public.courses (code, title, summary, is_active, sort_order)
    values (v_code, btrim(p_title), nullif(btrim(coalesce(p_summary, '')), ''), coalesce(p_is_active, false),
            coalesce((select max(sort_order) from public.courses), 0) + 1)
    returning id into v_id;
  else
    select id into v_id from public.courses where id = p_course_id for update;
    if not found then raise exception 'course_not_found'; end if;
    -- the code is fixed once created: other tables, prices and migrations refer to it
    update public.courses
       set title = btrim(p_title), summary = nullif(btrim(coalesce(p_summary, '')), ''), is_active = coalesce(p_is_active, is_active)
     where id = v_id;
  end if;

  if p_lessons is not null then
    perform public.save_course_outline(v_id, p_lessons);   -- keeps total_sessions, upcoming runs and student progress in step
  end if;

  if p_prerequisites is not null then
    if jsonb_typeof(p_prerequisites) <> 'array' then raise exception 'prerequisite_invalid'; end if;
    delete from public.course_prerequisites where course_id = v_id;
    for v_group in select * from jsonb_array_elements(p_prerequisites) loop
      if jsonb_typeof(v_group) <> 'array' or jsonb_array_length(v_group) = 0 then continue; end if;
      v_no := v_no + 1;
      for v_pre in select jsonb_array_elements_text(v_group) loop
        begin v_pid := v_pre::uuid; exception when others then raise exception 'prerequisite_invalid'; end;
        if v_pid = v_id or not exists (select 1 from public.courses where id = v_pid) then raise exception 'prerequisite_invalid'; end if;
        insert into public.course_prerequisites (course_id, prerequisite_id, group_no) values (v_id, v_pid, v_no) on conflict do nothing;
      end loop;
    end loop;
    -- two courses may never depend on each other, directly or through a chain
    if exists (
      with recursive chain(id) as (
        select prerequisite_id from public.course_prerequisites where course_id = v_id
        union
        select p.prerequisite_id from public.course_prerequisites p join chain c on p.course_id = c.id)
      select 1 from chain where id = v_id) then
      raise exception 'prerequisite_cycle';
    end if;
  end if;
  return v_id;
end $$;

-- Deleting a course cascades to its lessons, prices, instructor links, pathway links and project briefs, so it is
-- refused whenever a student, a class or anything uploaded depends on it. Other courses' prerequisites are never
-- silently loosened: if another course requires this one, the delete is refused.
create or replace function public.delete_course(p_course_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if not private.is_admin() then raise exception 'forbidden' using errcode = '42501'; end if;
  if not exists (select 1 from public.courses where id = p_course_id) then raise exception 'course_not_found'; end if;
  if exists (select 1 from public.course_prerequisites where prerequisite_id = p_course_id) then raise exception 'course_is_prerequisite'; end if;
  if exists (select 1 from public.enrolment_courses where course_id = p_course_id)
     or exists (select 1 from public.class_sessions where course_id = p_course_id)
     or exists (select 1 from public.timetable_slots where course_id = p_course_id)
     or exists (select 1 from public.course_runs where course_id = p_course_id)
     or exists (select 1 from public.attendance where course_id = p_course_id)
     or exists (select 1 from public.project_submissions where course_id = p_course_id) then
    raise exception 'course_in_use';
  end if;
  if exists (select 1 from public.lesson_materials m join public.course_lessons l on l.id = m.lesson_id where l.course_id = p_course_id) then
    raise exception 'course_has_content';
  end if;
  delete from public.courses where id = p_course_id;
exception when foreign_key_violation then raise exception 'course_in_use';
end $$;

-- The hidden SOLO package (single-course purchases) can never be deleted. Instalments go with the package.
create or replace function public.delete_package(p_package_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare v_code text;
begin
  if not private.is_admin() then raise exception 'forbidden' using errcode = '42501'; end if;
  select code into v_code from public.packages where id = p_package_id;
  if not found or v_code = 'SOLO' then raise exception 'package_not_found'; end if;
  if exists (select 1 from public.enrolments where package_id = p_package_id) then raise exception 'package_in_use'; end if;
  delete from public.packages where id = p_package_id;
exception when foreign_key_violation then raise exception 'package_in_use';
end $$;

revoke all on function public.save_course(uuid, text, text, text, boolean, jsonb, jsonb) from public, anon;
revoke all on function public.delete_course(uuid) from public, anon;
revoke all on function public.delete_package(uuid) from public, anon;
grant execute on function public.save_course(uuid, text, text, text, boolean, jsonb, jsonb) to authenticated;
grant execute on function public.delete_course(uuid) to authenticated;
grant execute on function public.delete_package(uuid) to authenticated;

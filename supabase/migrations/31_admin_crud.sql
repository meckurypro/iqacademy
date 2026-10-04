-- 31_admin_crud.sql
-- DRAFT — NOT YET APPLIED. Written without access to the live schema (migrations 28 and 29 are not in the repo),
-- like migration 20. Review it, then run it in the Supabase SQL editor.
--
-- What this adds: the database half of "whatever an admin can create, they can edit and delete".
--   save_course            create / edit a course, its outline and its prerequisites in ONE transaction
--   delete_course          delete a course nobody uses
--   delete_centre          delete a centre nobody uses
--   delete_package         delete a package nobody has enrolled on (never the hidden SOLO package)
--   delete_cohort          delete a cohort nobody enrolled in, with its timetable
--   update_timetable_slot  change a weekly class slot and move its upcoming classes with it
--   remove_timetable_slot  take a weekly class slot off the timetable
--
-- Design rule: every delete is a single transaction that REFUSES (with a readable error key) when anything still
-- depends on the row. Anything this file doesn't know about is caught by the foreign-key safety net at the bottom of
-- each function, so a delete can never half-happen and can never orphan a student's data. Hiding (is_active = false)
-- is always the way to retire something that has history.
--
-- Until this is applied the app keeps working: the Course Builder falls back to save_course_outline, and the new
-- delete / slot buttons show "This needs a database update that hasn't been applied yet."

-- ---------------------------------------------------------------------------
-- Upcoming classes of a slot that nobody has touched yet (not held, nobody checked in). Used when a slot is edited
-- or removed so the classes follow it. Classes with attendance are never removed.
-- ---------------------------------------------------------------------------
create or replace function private.drop_future_empty_sessions(p_slot_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
begin
  delete from public.class_sessions s
   where s.slot_id = p_slot_id and s.status = 'scheduled' and s.start_at > now()
     and not exists (select 1 from public.attendance a where a.session_id = s.id);
end $$;

-- ---------------------------------------------------------------------------
-- Courses
-- p_lessons       = [{"title": "...", "description": "..."}, ...]   (null = leave the outline alone)
-- p_prerequisites = [["<course id>", ...], ...]   one inner array per requirement; ANY one course in an array
--                   satisfies it, ALL requirements must be met (null = leave prerequisites alone)
-- A new course starts with one class slot and is hidden until an admin turns it on.
-- ---------------------------------------------------------------------------
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

  if p_course_id is null then
    if v_code !~ '^[A-Z0-9_-]{2,20}$' then raise exception 'course_code_invalid'; end if;
    if exists (select 1 from public.courses where upper(code) = v_code) then raise exception 'course_code_taken'; end if;
    insert into public.courses (code, title, summary, total_sessions, is_active, sort_order)
    values (v_code, btrim(p_title), nullif(btrim(coalesce(p_summary, '')), ''), 1, coalesce(p_is_active, false),
            coalesce((select max(sort_order) from public.courses), 0) + 1)
    returning id into v_id;
  else
    select id into v_id from public.courses where id = p_course_id for update;
    if not found then raise exception 'course_not_found'; end if;
    -- the code is fixed once created (other tables and migrations refer to it)
    update public.courses
       set title = btrim(p_title), summary = nullif(btrim(coalesce(p_summary, '')), ''), is_active = coalesce(p_is_active, is_active)
     where id = v_id;
  end if;

  if p_lessons is not null then
    perform public.save_course_outline(v_id, p_lessons);   -- keeps total_sessions, timetable and student progress in step
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

create or replace function public.delete_course(p_course_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if not private.is_admin() then raise exception 'forbidden' using errcode = '42501'; end if;
  if not exists (select 1 from public.courses where id = p_course_id) then raise exception 'course_not_found'; end if;
  if exists (select 1 from public.course_prerequisites where prerequisite_id = p_course_id) then raise exception 'course_is_prerequisite'; end if;
  if exists (select 1 from public.enrolment_courses where course_id = p_course_id)
     or exists (select 1 from public.class_sessions where course_id = p_course_id)
     or exists (select 1 from public.timetable_slots where course_id = p_course_id)
     or exists (select 1 from public.course_runs where course_id = p_course_id) then
    raise exception 'course_in_use';
  end if;
  delete from public.course_prerequisites where course_id = p_course_id;   -- its own requirements
  delete from public.course_lessons where course_id = p_course_id;         -- (course_prices cascades)
  delete from public.courses where id = p_course_id;
exception when foreign_key_violation then raise exception 'course_in_use';
end $$;

-- ---------------------------------------------------------------------------
-- Centres
-- ---------------------------------------------------------------------------
create or replace function public.delete_centre(p_centre_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if not private.is_admin() then raise exception 'forbidden' using errcode = '42501'; end if;
  if not exists (select 1 from public.centres where id = p_centre_id) then raise exception 'centre_not_found'; end if;
  if exists (select 1 from public.enrolments where centre_id = p_centre_id)
     or exists (select 1 from public.cohorts where centre_id = p_centre_id)
     or exists (select 1 from public.class_sessions where centre_id = p_centre_id)
     or exists (select 1 from public.timetable_slots where centre_id = p_centre_id)
     or exists (select 1 from public.course_runs where centre_id = p_centre_id)
     or exists (select 1 from public.user_roles where centre_id = p_centre_id) then
    raise exception 'centre_in_use';
  end if;
  delete from public.centre_terms where centre_id = p_centre_id;
  delete from public.centre_payout_accounts where centre_id = p_centre_id;   -- VERIFY column name against the live table
  delete from public.centres where id = p_centre_id;                         -- payments / payouts / refunds keep it alive via FK
exception when foreign_key_violation then raise exception 'centre_in_use';
end $$;

-- ---------------------------------------------------------------------------
-- Packages (the hidden single-course package, code SOLO, can never be deleted)
-- ---------------------------------------------------------------------------
create or replace function public.delete_package(p_package_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare v_code text;
begin
  if not private.is_admin() then raise exception 'forbidden' using errcode = '42501'; end if;
  select code into v_code from public.packages where id = p_package_id;
  if not found or v_code = 'SOLO' then raise exception 'package_not_found'; end if;
  delete from public.package_instalments where package_id = p_package_id;
  delete from public.packages where id = p_package_id;                       -- enrolments keep it alive via FK
exception when foreign_key_violation then raise exception 'package_in_use';
end $$;

-- ---------------------------------------------------------------------------
-- Cohorts and their weekly timetable
-- ---------------------------------------------------------------------------
create or replace function public.delete_cohort(p_cohort_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if not private.is_admin() then raise exception 'forbidden' using errcode = '42501'; end if;
  if not exists (select 1 from public.cohorts where id = p_cohort_id) then raise exception 'cohort_not_found'; end if;
  if exists (select 1 from public.enrolments where cohort_id = p_cohort_id) then raise exception 'cohort_in_use'; end if;
  perform private.drop_future_empty_sessions(s.id) from public.timetable_slots s where s.cohort_id = p_cohort_id;
  delete from public.timetable_slots where cohort_id = p_cohort_id;          -- fails (and rolls back) if classes were already held
  delete from public.cohorts where id = p_cohort_id;
exception when foreign_key_violation then raise exception 'cohort_in_use';
end $$;

create or replace function public.update_timetable_slot(
  p_slot_id uuid, p_course_id uuid, p_instructor_id uuid, p_day integer, p_start time, p_end time, p_room text
) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if not private.is_admin() then raise exception 'forbidden' using errcode = '42501'; end if;
  if not exists (select 1 from public.timetable_slots where id = p_slot_id and is_active) then raise exception 'slot_not_found'; end if;
  if p_day is null or p_day not between 1 and 7 or p_start is null or p_end is null or p_start >= p_end then raise exception 'slot_invalid'; end if;
  update public.timetable_slots
     set course_id = p_course_id, instructor_id = p_instructor_id, day_of_week = p_day,
         start_time = p_start, end_time = p_end, room = nullif(btrim(coalesce(p_room, '')), '')
   where id = p_slot_id;
  -- upcoming classes follow the slot: drop the untouched ones and build them again from the new times
  perform private.drop_future_empty_sessions(p_slot_id);
  perform public.generate_class_sessions(p_slot_id, (current_date + 28));
end $$;

create or replace function public.remove_timetable_slot(p_slot_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if not private.is_admin() then raise exception 'forbidden' using errcode = '42501'; end if;
  if not exists (select 1 from public.timetable_slots where id = p_slot_id and is_active) then raise exception 'slot_not_found'; end if;
  update public.timetable_slots set is_active = false where id = p_slot_id;   -- history stays; the slot just stops producing classes
  perform private.drop_future_empty_sessions(p_slot_id);
end $$;

-- ---------------------------------------------------------------------------
-- Permissions: admins only (each function also checks private.is_admin() itself)
-- ---------------------------------------------------------------------------
revoke all on function public.save_course(uuid, text, text, text, boolean, jsonb, jsonb) from public, anon;
revoke all on function public.delete_course(uuid) from public, anon;
revoke all on function public.delete_centre(uuid) from public, anon;
revoke all on function public.delete_package(uuid) from public, anon;
revoke all on function public.delete_cohort(uuid) from public, anon;
revoke all on function public.update_timetable_slot(uuid, uuid, uuid, integer, time, time, text) from public, anon;
revoke all on function public.remove_timetable_slot(uuid) from public, anon;
grant execute on function public.save_course(uuid, text, text, text, boolean, jsonb, jsonb) to authenticated;
grant execute on function public.delete_course(uuid) to authenticated;
grant execute on function public.delete_centre(uuid) to authenticated;
grant execute on function public.delete_package(uuid) to authenticated;
grant execute on function public.delete_cohort(uuid) to authenticated;
grant execute on function public.update_timetable_slot(uuid, uuid, uuid, integer, time, time, text) to authenticated;
grant execute on function public.remove_timetable_slot(uuid) to authenticated;

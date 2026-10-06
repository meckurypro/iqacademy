-- 47_custom_classes.sql   (applied to the live DB as "custom_classes")
--
-- "Emergency class" is now "Custom class", and WHO MAY ATTEND IS DECIDED BY INVITATION.
--
-- NOTE FOR THE NEXT CLAUDE SESSION (read before touching custom classes):
--
--   1. Naming. In the app, in notifications and in new functions this is a "custom class". The database still calls the
--      flag is_emergency (class_sessions.is_emergency, my_classes().is_emergency, v_session_details.is_emergency,
--      my_class_clock().is_emergency and the 'emergency' key in check_in()'s result). Those names are historic: live
--      views and functions depend on them and renaming gains nothing. Treat is_emergency = "this is a custom class".
--
--   2. Eligibility is an explicit invitation, NOT the centre and NOT automatic. Migrations 43 and 46 let every active
--      student at the centre in ("open to everyone registered here"); that is gone. The owner uses custom classes for
--      make-up, revision, practical and weekend classes. Those cut across centres, courses and course runs, and only the
--      instructor knows who should be there. So the instructor (or an admin) invites students: by name search, or by group
--      (centre, course, or course run). Do NOT bring back "everyone registered at the centre", and do NOT auto-add
--      students to a custom class. The centre on a custom class is only WHERE it is held (door staff, class code); it
--      does not limit who can be invited.
--
--   3. Invitations feed everything that asks "who is in this class":
--        private.session_students()   -> the 1-hour reminder, "N students are expected", the dashboard countdown
--        public.my_class_clock()      -> a student sees an invited class even at a centre they are not registered at
--        check_in / mark_attendance / prepare_attendance / session_attendance_roster / cancel_session / refresh_session_counts
--      If you add another place that lists a class's students, make it use private.session_students().
--
--   4. A student needs an ACTIVE registration somewhere to be invited or marked present (attendance.enrolment_id is NOT
--      NULL). Attendance is recorded against the registration that includes the class's course if they have one, else
--      their newest active registration. If they are on that course, its payment rules still apply at check-in.
--
--   5. Invited students are notified (custom_class_invite). They are also told when removed (custom_class_removed) or when
--      the time, place, course or topic changes (custom_class_changed). Cancelling tells the invited students only.
--
--   6. Check-in is unchanged apart from eligibility: same door rules and class clock (45), the teaching instructor can
--      still open their own class's check-in (46), same window, same denial logging. A student who was not invited is
--      denied with reason 'not_invited'.
--
--   7. The instructor can add, remove and edit invites and class details until 30 minutes before the class starts
--      (app_settings key custom_class_edit_lock_minutes, default 30). Admins are not locked out; they can change a custom
--      class until it ends. The cut-off is enforced here, in the database, not just in the UI.
--
--   8. Nobody is marked absent when a custom class ends (it is optional), as before. students_enrolled on a custom class
--      is the number invited.
--
-- HOW THIS MIGRATION CHANGES EXISTING FUNCTIONS (so it cannot silently undo other work):
--   * check_in and my_class_clock are patched in place with pg_temp.patch_fn (the technique 44 and 46 use): it rewrites
--     the live definition and fails loudly if the text it expects is not there.
--   * prepare_attendance, refresh_session_counts, mark_attendance, session_attendance_roster, cancel_session and
--     session_students are replaced whole, each behind pg_temp.guard_fn, which aborts the migration if the live function
--     is not byte-for-byte the one this was written against. If a guard trips, read the live function, then update here.
--   * Replaces create_emergency_class, emergency_audience and emergency_classes_for_me (dropped at the end).

-- ---------- 0. Safety helpers (session-local; dropped at the end) ----------
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

create or replace function pg_temp.guard_fn(p_schema text, p_name text, p_md5 text) returns void
language plpgsql as $f$
declare v_h text;
begin
  select md5(p.prosrc) into strict v_h from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = p_schema and p.proname = p_name;
  if v_h <> p_md5 then
    raise exception 'live %.% changed since this migration was written (md5 % , expected %): read the live function and update this migration', p_schema, p_name, v_h, p_md5;
  end if;
end $f$;

-- ---------- 1. Invitations ----------
create table if not exists public.custom_class_invites (
  session_id uuid not null references public.class_sessions (id) on delete cascade,
  student_id uuid not null references public.profiles (id) on delete cascade,
  invited_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  primary key (session_id, student_id)
);
create index if not exists custom_class_invites_student_idx on public.custom_class_invites (student_id);
alter table public.custom_class_invites enable row level security;
-- No policies and no direct grants on purpose: every read and write goes through the security-definer functions below.
revoke all on public.custom_class_invites from anon, authenticated;
comment on table public.custom_class_invites is 'Students invited to a custom class. The only thing that makes a student eligible for one. See migration 47.';
comment on column public.class_sessions.is_emergency is 'Historic name: true means this is a CUSTOM class (one-off, invitation only, not part of any course run). See migration 47.';

update public.class_sessions set title = 'Custom class' where is_emergency and title = 'Emergency class';

-- ---------- 2. Helpers ----------
-- The registration a custom-class attendance is recorded against: one that includes the class's course if there is one,
-- otherwise the newest active registration. Any centre.
create or replace function private.custom_class_enrolment(p_student uuid, p_course uuid)
returns uuid language sql stable security definer set search_path = '' as $$
  select e.id from public.enrolments e
   where e.student_id = p_student and e.status = 'active'
   order by exists (select 1 from public.enrolment_courses ec where ec.enrolment_id = e.id and ec.course_id = p_course) desc, e.created_at desc
   limit 1
$$;

create or replace function private.custom_class_lock_minutes()
returns integer language sql stable security definer set search_path = '' as $$
  select private.setting_int('custom_class_edit_lock_minutes', 30)
$$;

-- Loads a custom class for editing and raises if the caller may not change it right now.
create or replace function private.custom_class_assert_editable(p_session_id uuid)
returns public.class_sessions language plpgsql security definer set search_path = '' as $$
declare v_s public.class_sessions%rowtype; v_admin boolean := private.is_admin();
begin
  select * into v_s from public.class_sessions where id = p_session_id for update;
  if not found then raise exception 'session_not_found'; end if;
  if not v_s.is_emergency then raise exception 'custom_not_editable'; end if;
  if not (v_admin or v_s.instructor_id = (select auth.uid())) then raise exception 'forbidden' using errcode = '42501'; end if;
  if v_admin then
    if v_s.status not in ('scheduled', 'in_progress') or now() > v_s.end_at then raise exception 'custom_not_editable'; end if;
  else
    if v_s.status <> 'scheduled' then raise exception 'custom_not_editable'; end if;
    if now() > v_s.start_at - make_interval(mins => private.custom_class_lock_minutes()) then raise exception 'custom_locked'; end if;
  end if;
  return v_s;
end $$;

-- Adds and removes invitations and tells the students. Callers have already checked who may do this.
create or replace function private.custom_class_apply_invites(p_session_id uuid, p_add uuid[], p_remove uuid[], p_actor uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_s public.class_sessions%rowtype;
  v_eligible uuid[]; v_added uuid[]; v_removed uuid[];
  v_wanted integer; v_kept integer; v_total integer;
  v_course text; v_lesson text; v_place text; v_when text; v_who text; v_detail text;
begin
  select * into v_s from public.class_sessions where id = p_session_id;
  if not found then raise exception 'session_not_found'; end if;

  -- additions: real, active students who have an active registration (attendance needs one)
  select count(distinct u) into v_wanted from unnest(coalesce(p_add, '{}'::uuid[])) u where u is not null;
  select coalesce(array_agg(distinct u), '{}'::uuid[]) into v_eligible
    from unnest(coalesce(p_add, '{}'::uuid[])) u
   where u is not null
     and exists (select 1 from public.profiles pr where pr.id = u and pr.is_active and pr.deleted_at is null)
     and exists (select 1 from public.enrolments e where e.student_id = u and e.status = 'active');
  with ins as (
    insert into public.custom_class_invites (session_id, student_id, invited_by)
    select p_session_id, u, p_actor from unnest(v_eligible) u
    on conflict (session_id, student_id) do nothing
    returning student_id)
  select coalesce(array_agg(student_id), '{}'::uuid[]) into v_added from ins;

  -- removals: not for anyone who already has attendance recorded
  with del as (
    delete from public.custom_class_invites i
     where i.session_id = p_session_id and i.student_id = any (coalesce(p_remove, '{}'::uuid[]))
       and not exists (select 1 from public.attendance a where a.session_id = i.session_id and a.student_id = i.student_id)
    returning i.student_id)
  select coalesce(array_agg(student_id), '{}'::uuid[]) into v_removed from del;
  select count(*) into v_kept from public.custom_class_invites i
   where i.session_id = p_session_id and i.student_id = any (coalesce(p_remove, '{}'::uuid[]));

  select count(*) into v_total from public.custom_class_invites where session_id = p_session_id;
  if v_total > 500 then raise exception 'custom_too_many'; end if;

  if cardinality(v_added) > 0 or cardinality(v_removed) > 0 then
    select title into v_course from public.courses where id = v_s.course_id;
    select title into v_lesson from public.course_lessons where id = v_s.lesson_id;
    select nullif(split_part(trim(full_name), ' ', 1), '') into v_who from public.profiles where id = v_s.instructor_id;
    v_place := private.centre_place(v_s.centre_id);
    v_when := to_char(v_s.start_at at time zone 'Africa/Lagos', 'Dy DD Mon, HH12:MI AM');
    v_detail := v_course || coalesce(': ' || v_lesson, '') || ' at ' || v_place || ', ' || v_when;
    perform private.notify(v_added, 'custom_class_invite', 'You''re invited to a class',
      coalesce(v_who, 'Your instructor') || ' invited you to ' || v_detail || '. Check in with the class code when you arrive.',
      jsonb_build_object('session_id', p_session_id));
    perform private.notify(v_removed, 'custom_class_removed', 'Class invitation withdrawn',
      'You''re no longer invited to ' || v_detail || '.', jsonb_build_object('session_id', p_session_id));
  end if;

  perform private.refresh_session_counts(p_session_id);
  return jsonb_build_object('added', cardinality(v_added), 'removed', cardinality(v_removed),
                            'not_eligible', greatest(v_wanted - cardinality(v_eligible), 0), 'kept', v_kept, 'total', v_total);
end $$;

-- ---------- 3. Who is in a class: a custom class is the students invited ----------
-- Feeds the 1-hour reminder, "N students are expected" and the dashboard countdown (migration 45).
select pg_temp.guard_fn('private', 'session_students', '67c962aac47718268b200d4cd7555f8a');
create or replace function private.session_students(p_session_id uuid) returns setof uuid
language sql stable security definer set search_path = '' as $$
  -- a custom class: the students who were invited (and still have an active registration), at any centre
  select i.student_id
    from public.custom_class_invites i
    join public.class_sessions s on s.id = i.session_id and s.is_emergency
   where s.id = p_session_id
     and exists (select 1 from public.enrolments e where e.student_id = i.student_id and e.status = 'active')
  union
  -- any other class: as before
  select e.student_id
    from public.class_sessions s
    join public.enrolments e on e.centre_id = s.centre_id and e.status = 'active'
   where s.id = p_session_id and not s.is_emergency
     and (exists (select 1 from public.enrolment_courses ec where ec.enrolment_id = e.id and ec.course_id = s.course_id)
          and private.clock_open(e.id, s.session_date)
          and private.in_own_run(e.id, s.course_id, s.run_id)
          and private.enrolment_course_access(e.id, s.course_id))
$$;

-- The dashboard countdown: a student sees a class they belong to even at a centre they are not registered at.
-- (session_students already guarantees membership, and for ordinary classes membership implies a registration there.)
select pg_temp.patch_fn('public', 'my_class_clock',
  $o$where c.centre_id in (select e.centre_id from public.enrolments e where e.student_id = v_uid and e.status = 'active')
       and exists (select 1 from private.session_students(c.id) as t(student_id) where t.student_id = v_uid)$o$,
  $n$where exists (select 1 from private.session_students(c.id) as t(student_id) where t.student_id = v_uid)$n$);

-- ---------- 4. Attendance: invited students only, at any centre ----------
select pg_temp.guard_fn('private', 'prepare_attendance', '7d38ec20fe9696f11738b76b76b0343b');
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
    -- custom class: invited students only; their registration can be at any centre
    if not exists (select 1 from public.custom_class_invites i where i.session_id = v_s.id and i.student_id = new.student_id) then
      raise exception 'not_invited' using hint = 'Student was not invited to this custom class.';
    end if;
    if new.enrolment_id is null then
      new.enrolment_id := private.custom_class_enrolment(new.student_id, v_s.course_id);
    end if;
    if new.enrolment_id is null or not exists (
         select 1 from public.enrolments e
          where e.id = new.enrolment_id and e.student_id = new.student_id and e.status = 'active') then
      raise exception 'not_enrolled' using hint = 'Student has no active registration.';
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

-- A custom class counts the students invited as its enrolment
select pg_temp.guard_fn('private', 'refresh_session_counts', '5dfcd0b414caf83007dc1436f4d9bc16');
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
    select count(*) into v_eligible from public.custom_class_invites where session_id = p_session_id;
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

-- ---------- 5. check_in: a custom class admits only students who were invited ----------
-- Patched in place so the live version's other behaviour (unpaid-registration verdict from 46, the window, the denial log)
-- is kept exactly as it is. Two edits to the custom-class branch: any centre, and 'not_invited'.
select pg_temp.patch_fn('public', 'check_in',
  $o$where e.student_id = v_uid and e.centre_id = v_s.centre_id and e.status = 'active'
     order by exists$o$,
  $n$where e.student_id = v_uid and e.status = 'active'
     order by exists$n$);
select pg_temp.patch_fn('public', 'check_in',
  $o$    if v_enrol is null then
      v_reason := case when exists (select 1 from public.enrolments e2 where e2.student_id = v_uid and e2.centre_id = v_s.centre_id and e2.status = 'pending_payment')$o$,
  $n$    -- custom class: only students the instructor invited. Not by centre, not automatic (see the header of migration 47).
    if not exists (select 1 from public.custom_class_invites i where i.session_id = v_s.id and i.student_id = v_uid) then
      v_reason := 'not_invited';
    elsif v_enrol is null then
      v_reason := case when exists (select 1 from public.enrolments e2 where e2.student_id = v_uid and e2.status = 'pending_payment')$n$);

-- ---------- 6. Manual marking: a custom class only for invited students ----------
select pg_temp.guard_fn('public', 'mark_attendance', '73f053a34e4496b56868068439c5194a');
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
    if not exists (select 1 from public.custom_class_invites i where i.session_id = p_session_id and i.student_id = p_student_id) then
      raise exception 'not_invited';
    end if;
    v_enrol := private.custom_class_enrolment(p_student_id, v_s.course_id);
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

-- ---------- 7. Roster: a custom class lists the students invited (plus anyone already marked) ----------
select pg_temp.guard_fn('public', 'session_attendance_roster', 'da4033ad9e42af88ebb3cb01b1f1919c');
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
      from (select i.student_id from public.custom_class_invites i where i.session_id = p_session_id
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

-- ---------- 8. Cancelling a custom class tells the students invited, not the whole centre ----------
select pg_temp.guard_fn('public', 'cancel_session', 'c1df20549672e725880ae6703e741a38');
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
    select array_agg(i.student_id) into v_students from public.custom_class_invites i where i.session_id = p_session_id;
  else
    select array_agg(e.student_id) into v_students
      from public.enrolments e join public.enrolment_courses ec on ec.enrolment_id = e.id
     where e.centre_id = v_s.centre_id and ec.course_id = v_s.course_id and e.status = 'active';
  end if;
  perform private.notify(v_students, 'session_cancelled', 'Class cancelled',
         'The class on ' || to_char(v_s.session_date, 'Dy DD Mon') || ' has been cancelled.' ||
         coalesce(' Reason: ' || p_reason, ''),
         jsonb_build_object('session_id', p_session_id));
end $$;

-- ---------- 9. Create a custom class (optionally with its first invitations) ----------
create or replace function public.create_custom_class(
  p_centre_id uuid, p_course_id uuid, p_lesson_id uuid, p_start timestamptz,
  p_minutes integer default 120, p_instructor_id uuid default null, p_note text default null,
  p_student_ids uuid[] default '{}')
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
  if not found then raise exception 'custom_no_topic'; end if;

  if p_start is null then raise exception 'custom_bad_time'; end if;
  if p_start < now() - interval '15 minutes' then raise exception 'custom_time_passed'; end if;
  if p_start > now() + interval '30 days' then raise exception 'custom_too_far'; end if;
  if p_minutes is null or p_minutes < 15 or p_minutes > 480 then raise exception 'custom_bad_length'; end if;
  if char_length(coalesce(p_note, '')) > 300 then raise exception 'custom_note_long'; end if;
  v_end := p_start + make_interval(mins => p_minutes);

  if exists (select 1 from public.class_sessions o
              where o.instructor_id = v_instr and o.status <> 'cancelled'
                and tstzrange(o.start_at, o.end_at) && tstzrange(p_start, v_end)) then
    raise exception 'instructor_clash';
  end if;

  insert into public.class_sessions (centre_id, course_id, instructor_id, lesson_id, session_no, session_date, start_at, end_at,
                                     status, title, notes, is_emergency, created_by)
  values (p_centre_id, p_course_id, v_instr, p_lesson_id, v_lesson.lesson_no, (p_start at time zone v_tz)::date, p_start, v_end,
          'scheduled', 'Custom class', nullif(trim(p_note), ''), true, v_uid)
  returning id into v_id;

  -- the students invited (they are told straight away)
  perform private.custom_class_apply_invites(v_id, p_student_ids, '{}'::uuid[], v_uid);

  v_place := private.centre_place(p_centre_id);
  v_when  := to_char(p_start at time zone 'Africa/Lagos', 'Dy DD Mon, HH12:MI AM');
  select nullif(split_part(trim(full_name), ' ', 1), '') into v_who from public.profiles where id = v_instr;

  -- centre staff, who can also open the door
  perform private.notify((select array_agg(distinct ur.user_id) from public.user_roles ur
                           where ur.is_active and ur.role in ('centre_director', 'coordinator') and ur.centre_id = p_centre_id and ur.user_id <> v_uid),
    'custom_class_staff', 'Custom class at your centre',
    v_course || ': ' || v_lesson.title || ', ' || v_when || coalesce(' with ' || v_who, '') || '. The class code is ready 30 minutes before.',
    jsonb_build_object('session_id', v_id));
  if v_admin then
    -- the instructor an admin picked
    if v_instr <> v_uid then
      perform private.notify(array[v_instr], 'class_assigned', 'Custom class assigned',
        v_course || ': ' || v_lesson.title || ' at ' || v_place || ', ' || v_when || '.', jsonb_build_object('session_id', v_id));
    end if;
  else
    -- admins hear about one an instructor started
    perform private.notify((select array_agg(distinct ur.user_id) from public.user_roles ur where ur.is_active and ur.role in ('admin', 'super_admin') and ur.user_id <> v_uid),
      'custom_class_admin', 'Instructor created a custom class',
      coalesce(v_who, 'An instructor') || ': ' || v_course || ' (' || v_lesson.title || ') at ' || v_place || ', ' || v_when || '.',
      jsonb_build_object('session_id', v_id));
  end if;

  return v_id;
end $$;
revoke all on function public.create_custom_class(uuid, uuid, uuid, timestamptz, integer, uuid, text, uuid[]) from public, anon;
grant execute on function public.create_custom_class(uuid, uuid, uuid, timestamptz, integer, uuid, text, uuid[]) to authenticated;

-- ---------- 10. Edit a custom class and its invitations in one go ----------
-- Anything left null stays as it is (a blank note clears the note). Students already invited are told if the time, place,
-- course or topic changes. p_add / p_remove change the invitations in the same transaction.
create or replace function public.edit_custom_class(
  p_session_id uuid, p_centre_id uuid default null, p_course_id uuid default null, p_lesson_id uuid default null,
  p_start timestamptz default null, p_minutes integer default null, p_note text default null,
  p_add uuid[] default '{}', p_remove uuid[] default '{}')
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_uid     uuid := (select auth.uid());
  v_s       public.class_sessions%rowtype;
  v_centre  uuid; v_course uuid; v_lesson uuid; v_start timestamptz; v_end timestamptz; v_minutes integer;
  v_tz      text; v_lesson_row public.course_lessons%rowtype;
  v_ctitle  text; v_changed boolean; v_centre_changed boolean;
  v_place   text; v_when text; v_who text;
begin
  if v_uid is null then raise exception 'not_authenticated' using errcode = '28000'; end if;
  v_s := private.custom_class_assert_editable(p_session_id);   -- who, which state, and the 30-minute cut-off

  v_centre  := coalesce(p_centre_id, v_s.centre_id);
  v_course  := coalesce(p_course_id, v_s.course_id);
  v_lesson  := coalesce(p_lesson_id, v_s.lesson_id);
  v_start   := coalesce(p_start, v_s.start_at);
  v_minutes := coalesce(p_minutes, round(extract(epoch from (v_s.end_at - v_s.start_at)) / 60)::integer);

  select timezone into v_tz from public.centres where id = v_centre and is_active;
  if not found then raise exception 'centre_not_available'; end if;
  select title into v_ctitle from public.courses where id = v_course and is_active;
  if not found then raise exception 'course_not_available'; end if;
  select * into v_lesson_row from public.course_lessons where id = v_lesson and course_id = v_course;
  if not found then raise exception 'custom_no_topic'; end if;

  if v_start is distinct from v_s.start_at and v_start < now() then raise exception 'custom_time_passed'; end if;
  if v_start > now() + interval '30 days' then raise exception 'custom_too_far'; end if;
  if v_minutes < 15 or v_minutes > 480 then raise exception 'custom_bad_length'; end if;
  if char_length(coalesce(p_note, '')) > 300 then raise exception 'custom_note_long'; end if;
  v_end := v_start + make_interval(mins => v_minutes);

  v_centre_changed := v_centre is distinct from v_s.centre_id;
  v_changed := v_centre_changed or v_course is distinct from v_s.course_id or v_lesson is distinct from v_s.lesson_id or v_start is distinct from v_s.start_at;
  if (v_centre_changed or v_course is distinct from v_s.course_id)
     and exists (select 1 from public.attendance a where a.session_id = p_session_id) then
    raise exception 'custom_has_attendance';
  end if;

  if v_s.instructor_id is not null and exists (select 1 from public.class_sessions o
              where o.instructor_id = v_s.instructor_id and o.status <> 'cancelled' and o.id <> p_session_id
                and tstzrange(o.start_at, o.end_at) && tstzrange(v_start, v_end)) then
    raise exception 'instructor_clash';
  end if;

  update public.class_sessions
     set centre_id = v_centre, course_id = v_course, lesson_id = v_lesson, session_no = v_lesson_row.lesson_no,
         session_date = (v_start at time zone v_tz)::date, start_at = v_start, end_at = v_end,
         notes = case when p_note is null then notes else nullif(trim(p_note), '') end
   where id = p_session_id;

  if v_changed then
    v_place := private.centre_place(v_centre);
    v_when  := to_char(v_start at time zone 'Africa/Lagos', 'Dy DD Mon, HH12:MI AM');
    -- students who stay invited are told; those being removed get the "withdrawn" message instead
    perform private.notify((select array_agg(i.student_id) from public.custom_class_invites i
                             where i.session_id = p_session_id and i.student_id <> all (coalesce(p_remove, '{}'::uuid[]))),
      'custom_class_changed', 'Class updated',
      'Your class has changed: ' || v_ctitle || ': ' || v_lesson_row.title || ' at ' || v_place || ', ' || v_when || '.',
      jsonb_build_object('session_id', p_session_id));
    if v_centre_changed then
      select nullif(split_part(trim(full_name), ' ', 1), '') into v_who from public.profiles where id = v_s.instructor_id;
      perform private.notify((select array_agg(distinct ur.user_id) from public.user_roles ur
                               where ur.is_active and ur.role in ('centre_director', 'coordinator') and ur.centre_id = v_centre and ur.user_id <> v_uid),
        'custom_class_staff', 'Custom class at your centre',
        v_ctitle || ': ' || v_lesson_row.title || ', ' || v_when || coalesce(' with ' || v_who, '') || '. The class code is ready 30 minutes before.',
        jsonb_build_object('session_id', p_session_id));
    end if;
  end if;

  return private.custom_class_apply_invites(p_session_id, p_add, p_remove, v_uid);
end $$;
revoke all on function public.edit_custom_class(uuid, uuid, uuid, uuid, timestamptz, integer, text, uuid[], uuid[]) from public, anon;
grant execute on function public.edit_custom_class(uuid, uuid, uuid, uuid, timestamptz, integer, text, uuid[], uuid[]) to authenticated;

-- ---------- 11. Reading: the instructor's list, one class's invitations, finding students ----------
-- An instructor's own custom classes (an admin sees all of them). can_edit follows the 30-minute rule.
create or replace function public.custom_classes_overview()
returns table (id uuid, start_at timestamptz, end_at timestamptz, status text, course_id uuid, course_title text, lesson_id uuid, lesson_title text,
               centre_id uuid, centre_name text, centre_city text, centre_address text, instructor_id uuid, instructor_name text, notes text,
               students_invited integer, students_present integer, can_edit boolean)
language sql stable security definer set search_path = '' as $$
  select s.id, s.start_at, s.end_at, s.status::text, s.course_id, co.title, s.lesson_id, l.title,
         s.centre_id, ce.name, ce.city, ce.address, s.instructor_id, pr.full_name, s.notes,
         (select count(*)::integer from public.custom_class_invites i where i.session_id = s.id),
         s.students_present,
         case when private.is_admin() then s.status in ('scheduled', 'in_progress') and now() <= s.end_at
              else s.status = 'scheduled' and now() <= s.start_at - make_interval(mins => private.custom_class_lock_minutes()) end
    from public.class_sessions s
    join public.courses co on co.id = s.course_id
    join public.centres ce on ce.id = s.centre_id
    left join public.course_lessons l on l.id = s.lesson_id
    left join public.profiles pr on pr.id = s.instructor_id
   where s.is_emergency and (private.is_admin() or s.instructor_id = (select auth.uid()))
   order by s.start_at desc
   limit 60
$$;
revoke all on function public.custom_classes_overview() from public, anon;
grant execute on function public.custom_classes_overview() to authenticated;

create or replace function public.custom_class_students(p_session_id uuid)
returns table (student_id uuid, full_name text, centre_name text, status public.attendance_status, checked_in_at timestamptz)
language plpgsql stable security definer set search_path = '' as $$
#variable_conflict use_column
declare v_s public.class_sessions%rowtype;
begin
  select * into v_s from public.class_sessions where id = p_session_id and is_emergency;
  if not found then raise exception 'session_not_found'; end if;
  if not (private.is_admin() or v_s.instructor_id = (select auth.uid()) or private.is_centre_staff(v_s.centre_id)) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  return query
  select i.student_id, pr.full_name,
         (select ce.name from public.enrolments e join public.centres ce on ce.id = e.centre_id
           where e.student_id = i.student_id and e.status = 'active' order by e.created_at desc limit 1),
         a.status, a.checked_in_at
    from public.custom_class_invites i
    join public.profiles pr on pr.id = i.student_id
    left join public.attendance a on a.session_id = i.session_id and a.student_id = i.student_id
   where i.session_id = p_session_id
   order by pr.full_name;
end $$;
revoke all on function public.custom_class_students(uuid) from public, anon;
grant execute on function public.custom_class_students(uuid) to authenticated;

-- Find students to invite: by name, or by group (centre, course, or a course run); any mix. Only students with an
-- active registration. Instructors and admins only. A name needs 2+ letters; with no name and no group nothing is returned.
create or replace function public.search_students_for_custom_class(
  p_query text default null, p_centre_id uuid default null, p_course_id uuid default null, p_run_id uuid default null, p_limit integer default 40)
returns table (student_id uuid, full_name text, centre_name text, courses text)
language plpgsql stable security definer set search_path = '' as $$
#variable_conflict use_column
declare
  v_q text := lower(trim(coalesce(p_query, '')));
  v_course uuid := p_course_id;
  v_run public.course_runs%rowtype;
  v_lim integer := least(greatest(coalesce(p_limit, 40), 1), 500);
begin
  if not (private.is_admin() or private.is_instructor()) then raise exception 'forbidden' using errcode = '42501'; end if;
  if p_run_id is not null then
    select * into v_run from public.course_runs where id = p_run_id;
    if not found then return; end if;
    v_course := v_run.course_id;
  end if;
  if char_length(v_q) < 2 and p_centre_id is null and v_course is null then return; end if;
  return query
  select pr.id, pr.full_name,
         (select ce.name from public.enrolments e2 join public.centres ce on ce.id = e2.centre_id
           where e2.student_id = pr.id and e2.status = 'active' order by e2.created_at desc limit 1),
         (select string_agg(distinct co.title, ', ') from public.enrolments e3
            join public.enrolment_courses ec3 on ec3.enrolment_id = e3.id
            join public.courses co on co.id = ec3.course_id
           where e3.student_id = pr.id and e3.status = 'active')
    from public.profiles pr
   where pr.is_active and pr.deleted_at is null
     and (v_q = '' or position(v_q in lower(coalesce(pr.full_name, ''))) > 0)
     and exists (select 1 from public.enrolments e
                  where e.student_id = pr.id and e.status = 'active'
                    and (p_centre_id is null or e.centre_id = p_centre_id)
                    and (v_course is null or exists (
                          select 1 from public.enrolment_courses ec
                           where ec.enrolment_id = e.id and ec.course_id = v_course
                             and (p_run_id is null or private.own_run(e.id, ec.course_id) is not distinct from p_run_id))))
   order by pr.full_name
   limit v_lim;
end $$;
revoke all on function public.search_students_for_custom_class(text, uuid, uuid, uuid, integer) from public, anon;
grant execute on function public.search_students_for_custom_class(text, uuid, uuid, uuid, integer) to authenticated;

-- Course runs, so a group of students can be picked by run
create or replace function public.custom_class_runs(p_centre_id uuid default null, p_course_id uuid default null)
returns table (id uuid, centre_id uuid, centre_name text, centre_city text, course_id uuid, course_title text, start_date date, end_date date)
language plpgsql stable security definer set search_path = '' as $$
#variable_conflict use_column
begin
  if not (private.is_admin() or private.is_instructor()) then raise exception 'forbidden' using errcode = '42501'; end if;
  return query
  select r.id, r.centre_id, ce.name, ce.city, r.course_id, co.title, r.start_date, r.end_date
    from public.course_runs r
    join public.centres ce on ce.id = r.centre_id
    join public.courses co on co.id = r.course_id
   where r.status = 'scheduled' and r.end_date >= (now() at time zone 'Africa/Lagos')::date - 30
     and (p_centre_id is null or r.centre_id = p_centre_id)
     and (p_course_id is null or r.course_id = p_course_id)
   order by r.start_date desc
   limit 100;
end $$;
revoke all on function public.custom_class_runs(uuid, uuid) from public, anon;
grant execute on function public.custom_class_runs(uuid, uuid) to authenticated;

-- ---------- 12. What a student sees: the custom classes they were invited to ----------
create or replace function public.custom_classes_for_me()
returns table (id uuid, start_at timestamptz, end_at timestamptz, status text, course_title text, lesson_title text,
               centre_name text, centre_city text, centre_address text, instructor_first_name text, note text, checked_in boolean)
language sql stable security definer set search_path = '' as $$
  select s.id, s.start_at, s.end_at, s.status::text, co.title, l.title, ce.name, ce.city, ce.address,
         nullif(split_part(trim(pr.full_name), ' ', 1), ''), s.notes,
         exists (select 1 from public.attendance a where a.session_id = s.id and a.student_id = (select auth.uid()) and a.status = 'present')
    from public.custom_class_invites i
    join public.class_sessions s on s.id = i.session_id and s.is_emergency
    join public.courses co on co.id = s.course_id
    join public.centres ce on ce.id = s.centre_id
    left join public.course_lessons l on l.id = s.lesson_id
    left join public.profiles pr on pr.id = s.instructor_id
   where i.student_id = (select auth.uid())
     and s.status in ('scheduled', 'in_progress') and s.end_at >= now() - interval '30 minutes'
   order by s.start_at
$$;
revoke all on function public.custom_classes_for_me() from public, anon;
grant execute on function public.custom_classes_for_me() to authenticated;

-- ---------- 13. The emergency-class entry points are replaced ----------
drop function if exists public.create_emergency_class(uuid, uuid, uuid, timestamptz, integer, uuid, text);
drop function if exists public.emergency_audience(uuid, uuid);
drop function if exists public.emergency_classes_for_me();

drop function if exists pg_temp.patch_fn(text, text, text, text);
drop function if exists pg_temp.guard_fn(text, text, text);

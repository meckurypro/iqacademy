-- 43_door_check_in.sql   (applied to the live DB as "door_check_in"; do not re-run it on that database.)
-- Sorts before 43_emergency_classes.sql on purpose: that migration builds on the check_in, mark_attendance and
-- checkin_denials defined here, and replaces the versions of check_in and mark_attendance below.
-- Door check-in. The class code is created by the centre's coordinator or director (or an admin), not the instructor.
--   * the code can be created from `checkin_opens_minutes_before` (default 30) before the class starts until it ends
--   * the code stops working when the class ends
--   * check_in() now answers with a verdict (ok true/false + reason) instead of raising for entitlement problems,
--     so the student sees a green or red screen and every refusal is logged for the door staff
--   * coordinators/directors can also mark attendance by hand and end the class; instructors keep doing both

-- who is door staff for a class
create or replace function private.staffs_session(p_session_id uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.class_sessions cs where cs.id = p_session_id and private.is_centre_staff(cs.centre_id))
$$;

-- refused check-ins
create table if not exists public.checkin_denials (
  id         uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.class_sessions(id) on delete cascade,
  centre_id  uuid not null references public.centres(id) on delete cascade,
  student_id uuid not null references public.profiles(id) on delete cascade,
  reason     text not null,
  created_at timestamptz not null default now()
);
create index if not exists checkin_denials_session_idx on public.checkin_denials (session_id, created_at desc);
alter table public.checkin_denials enable row level security;
drop policy if exists checkin_denials_select on public.checkin_denials;
create policy checkin_denials_select on public.checkin_denials for select to authenticated
  using (private.is_admin() or private.is_centre_staff(centre_id));
grant select on public.checkin_denials to authenticated;
do $$ begin
  alter publication supabase_realtime add table public.checkin_denials;
exception when duplicate_object then null; end $$;

-- only door staff (and admins) can read the live code; instructors no longer can
drop policy if exists checkin_tokens_select on public.session_checkin_tokens;
create policy checkin_tokens_select on public.session_checkin_tokens for select to authenticated
  using (private.is_admin() or private.staffs_session(session_id));

-- create / show the class code
drop function if exists public.generate_checkin_token(uuid, integer);
create or replace function public.generate_checkin_token(p_session_id uuid, p_rotate boolean default false)
returns text language plpgsql security definer set search_path = '' as $$
declare
  v_s     public.class_sessions%rowtype;
  v_cur   public.session_checkin_tokens%rowtype;
  v_token text;
  v_try   integer := 0;
begin
  select * into v_s from public.class_sessions where id = p_session_id;
  if not found then raise exception 'session_not_found'; end if;
  if not (private.is_admin() or private.is_centre_staff(v_s.centre_id)) then raise exception 'forbidden' using errcode = '42501'; end if;
  if v_s.status = 'cancelled' then raise exception 'session_cancelled'; end if;
  if v_s.status = 'completed' then raise exception 'session_closed'; end if;
  if now() < v_s.start_at - make_interval(mins => private.setting_int('checkin_opens_minutes_before', 30))
     or now() > v_s.end_at then
    raise exception 'outside_checkin_window';
  end if;

  select * into v_cur from public.session_checkin_tokens where session_id = p_session_id;
  if found and not p_rotate and (v_cur.expires_at is null or v_cur.expires_at > now()) then
    update public.class_sessions set status = 'in_progress' where id = p_session_id and status = 'scheduled';
    return v_cur.token;
  end if;

  loop
    v_token := upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 8));
    begin
      insert into public.session_checkin_tokens (session_id, token, issued_by, expires_at)
      values (p_session_id, v_token, (select auth.uid()), v_s.end_at)
      on conflict (session_id) do update
        set token = excluded.token, issued_by = excluded.issued_by, issued_at = now(), expires_at = excluded.expires_at;
      exit;
    exception when unique_violation then
      v_try := v_try + 1;
      if v_try > 5 then raise; end if;
    end;
  end loop;

  update public.class_sessions set status = 'in_progress' where id = p_session_id and status = 'scheduled';
  return v_token;
end $$;
revoke execute on function public.generate_checkin_token(uuid, boolean) from public, anon;
grant execute on function public.generate_checkin_token(uuid, boolean) to authenticated;

-- the student scans or types the code: green (ok true) or red (ok false + reason)
create or replace function public.check_in(p_token text) returns jsonb
language plpgsql security definer set search_path = '' as $$
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
    'ok', true, 'already_checked_in', v_row.id is null, 'makeup', v_makeup,
    'session_id', v_s.id, 'course_id', v_s.course_id, 'lesson_id', v_s.lesson_id,
    'first_name', v_first, 'course_title', v_course, 'lesson_title', v_lesson, 'centre_name', v_centre);
end $$;

-- door staff can mark attendance by hand (a student's phone died) and end the class, as well as the instructor
create or replace function public.mark_attendance(p_session_id uuid, p_student_id uuid, p_status public.attendance_status default 'present', p_notes text default null)
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_s public.class_sessions%rowtype;
  v_enrol uuid;
begin
  select * into v_s from public.class_sessions where id = p_session_id;
  if not found then raise exception 'session_not_found'; end if;
  if not (private.is_admin() or v_s.instructor_id = (select auth.uid()) or private.is_centre_staff(v_s.centre_id)) then raise exception 'forbidden' using errcode = '42501'; end if;

  select e.id into v_enrol
    from public.enrolments e join public.enrolment_courses ec on ec.enrolment_id = e.id
   where e.student_id = p_student_id and e.centre_id = v_s.centre_id and ec.course_id = v_s.course_id
     and e.status = 'active'
   limit 1;
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

create or replace function public.complete_session(p_session_id uuid, p_mark_absentees boolean default true)
returns void language plpgsql security definer set search_path = '' as $$
declare v_s public.class_sessions%rowtype;
begin
  select * into v_s from public.class_sessions where id = p_session_id;
  if not found then raise exception 'session_not_found'; end if;
  if not (private.is_admin() or v_s.instructor_id = (select auth.uid()) or private.is_centre_staff(v_s.centre_id)) then raise exception 'forbidden' using errcode = '42501'; end if;
  if v_s.status = 'cancelled' then raise exception 'session_cancelled'; end if;

  update public.class_sessions
     set status = 'completed', completed_at = now(), completed_by = (select auth.uid())
   where id = p_session_id;
  delete from public.session_checkin_tokens where session_id = p_session_id;   -- close the door

  if p_mark_absentees then perform private.log_absentees(p_session_id); end if;
  perform private.refresh_session_counts(p_session_id);
end $$;

-- door staff: who was turned away, one row per person
create or replace function public.session_denied_attempts(p_session_id uuid)
returns table (student_id uuid, full_name text, reason text, attempts integer, last_at timestamptz)
language plpgsql stable security definer set search_path = '' as $$
#variable_conflict use_column
declare v_s public.class_sessions%rowtype;
begin
  select * into v_s from public.class_sessions where id = p_session_id;
  if not found then raise exception 'session_not_found'; end if;
  if not (private.is_admin() or private.is_centre_staff(v_s.centre_id)) then raise exception 'forbidden' using errcode = '42501'; end if;
  return query
  select d.student_id, p.full_name, (array_agg(d.reason order by d.created_at desc))[1], count(*)::int, max(d.created_at)
    from public.checkin_denials d join public.profiles p on p.id = d.student_id
   where d.session_id = p_session_id
   group by d.student_id, p.full_name
   order by max(d.created_at) desc;
end $$;
revoke execute on function public.session_denied_attempts(uuid) from public, anon;
grant execute on function public.session_denied_attempts(uuid) to authenticated;

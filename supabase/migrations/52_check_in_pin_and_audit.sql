-- supabase/migrations/52_check_in_pin_and_audit.sql   (applied to the live DB as "check_in_pin_and_audit")
--
-- Stops anyone checking a student in without their knowledge.
-- 1. A STUDENT PIN. Four digits, stored only as a bcrypt hash, so no staff member or admin can read it. A student must set one after
--    their first successful payment (pin_required()); the app blocks until they do. Changing it needs the account password typed twice.
-- 2. HAND CHECK-IN NEEDS THAT PIN. mark_attendance(... p_pin) replaces the registration number of migration 51. Five wrong PINs lock hand
--    check-ins for that student for 15 minutes. An admin can instead check in with a written reason (admin override); a student with no
--    PIN can only be checked in that way.
-- 3. EVERY HAND CHECK-IN IS LOGGED (hand_check_ins) and the student is notified at once, with a "That wasn't me" button
--    (dispute_hand_check_in) that undoes it and alerts the admins.
-- 4. ADMINS SEE THE LOG (admin_hand_check_ins): who checked in whom, how, and what was disputed.
-- mark_attendance now returns text: 'ok', or pin_required / pin_incorrect / pin_locked / pin_not_set. Failures are returned, not raised,
-- so the wrong-PIN count is kept.

create table if not exists public.student_pins (
  student_id         uuid primary key references public.students (id) on delete cascade,
  pin_hash           text not null,
  set_at             timestamptz not null default now(),
  failed_attempts    integer not null default 0,
  locked_until       timestamptz,
  pw_failed_attempts integer not null default 0,
  pw_locked_until    timestamptz
);
alter table public.student_pins enable row level security;
revoke all on public.student_pins from anon, authenticated;   -- no policies: only the functions below can touch it

create table if not exists public.hand_check_ins (
  id              uuid primary key default gen_random_uuid(),
  session_id      uuid not null references public.class_sessions (id) on delete cascade,
  student_id      uuid not null references public.profiles (id) on delete cascade,
  marked_by       uuid references public.profiles (id) on delete set null,
  method          text not null check (method in ('pin', 'admin_override')),
  override_reason text check (override_reason is null or char_length(override_reason) <= 300),
  prev_status     public.attendance_status,          -- what the student's record said before; null means there was none
  created_at      timestamptz not null default now(),
  disputed_at     timestamptz
);
create index if not exists hand_check_ins_created_idx on public.hand_check_ins (created_at desc);
create index if not exists hand_check_ins_marker_idx on public.hand_check_ins (marked_by, created_at desc);
alter table public.hand_check_ins enable row level security;
revoke all on public.hand_check_ins from anon, authenticated;
grant select on public.hand_check_ins to authenticated;
create policy hand_check_ins_select on public.hand_check_ins for select to authenticated using (private.is_admin());

-- ---------- PIN: status, first set, change ----------
create or replace function public.has_pin() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.student_pins where student_id = (select auth.uid()))
$$;
revoke all on function public.has_pin() from public, anon;
grant execute on function public.has_pin() to authenticated;

-- True for a student who has paid at least once and still has no PIN. The app does not let them go on until they set one.
create or replace function public.pin_required() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.students where id = (select auth.uid()))
     and not exists (select 1 from public.student_pins where student_id = (select auth.uid()))
     and exists (select 1 from public.payments p where p.student_id = (select auth.uid()) and p.status in ('succeeded', 'partially_refunded', 'refunded'))
$$;
revoke all on function public.pin_required() from public, anon;
grant execute on function public.pin_required() to authenticated;

create or replace function public.set_pin(p_pin text) returns void
language plpgsql security definer set search_path = '' as $$
declare v_uid uuid := (select auth.uid());
begin
  if v_uid is null or not exists (select 1 from public.students where id = v_uid) then raise exception 'forbidden' using errcode = '42501'; end if;
  if p_pin is null or p_pin !~ '^[0-9]{4}$' then raise exception 'invalid_pin'; end if;
  if exists (select 1 from public.student_pins where student_id = v_uid) then raise exception 'pin_already_set'; end if;
  insert into public.student_pins (student_id, pin_hash) values (v_uid, extensions.crypt(p_pin, extensions.gen_salt('bf')));
end $$;
revoke all on function public.set_pin(text) from public, anon;
grant execute on function public.set_pin(text) to authenticated;

-- Change the PIN. Needs the account password, typed twice. Returns 'ok', 'password_mismatch', 'password_incorrect' or 'pw_locked'
-- (returned, not raised, so wrong-password tries are counted: 5 in a row lock this for 15 minutes).
create or replace function public.change_pin(p_new_pin text, p_password text, p_password_confirm text) returns text
language plpgsql security definer set search_path = '' as $$
declare v_uid uuid := (select auth.uid()); v_row public.student_pins%rowtype; v_good boolean;
begin
  if v_uid is null then raise exception 'forbidden' using errcode = '42501'; end if;
  if p_new_pin is null or p_new_pin !~ '^[0-9]{4}$' then raise exception 'invalid_pin'; end if;
  select * into v_row from public.student_pins where student_id = v_uid for update;
  if not found then raise exception 'pin_not_set'; end if;
  if p_password is null or p_password = '' or p_password is distinct from p_password_confirm then return 'password_mismatch'; end if;
  if v_row.pw_locked_until is not null and v_row.pw_locked_until > now() then return 'pw_locked'; end if;

  select (u.encrypted_password = extensions.crypt(p_password, u.encrypted_password)) into v_good from auth.users u where u.id = v_uid;
  if not coalesce(v_good, false) then
    update public.student_pins
       set pw_failed_attempts = case when pw_failed_attempts + 1 >= 5 then 0 else pw_failed_attempts + 1 end,
           pw_locked_until = case when pw_failed_attempts + 1 >= 5 then now() + interval '15 minutes' else pw_locked_until end
     where student_id = v_uid;
    return case when v_row.pw_failed_attempts + 1 >= 5 then 'pw_locked' else 'password_incorrect' end;
  end if;

  update public.student_pins set pin_hash = extensions.crypt(p_new_pin, extensions.gen_salt('bf')), set_at = now(),
         failed_attempts = 0, locked_until = null, pw_failed_attempts = 0, pw_locked_until = null where student_id = v_uid;
  perform private.notify(array[v_uid], 'pin_changed', 'Your check-in PIN was changed', 'If this wasn''t you, change your password now.', '{}'::jsonb);
  return 'ok';
end $$;
revoke all on function public.change_pin(text, text, text) from public, anon;
grant execute on function public.change_pin(text, text, text) to authenticated;

-- ---------- mark_attendance with the PIN ----------
do $$
declare v_def text;
begin
  select pg_get_functiondef(p.oid) into strict v_def from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'mark_attendance' and pg_get_function_identity_arguments(p.oid) = 'p_session_id uuid, p_student_id uuid, p_status attendance_status, p_notes text, p_reg_number text';
  if position('private.custom_class_enrolment(p_student_id, v_s.course_id)' in v_def) = 0 or position('reg_number_mismatch' in v_def) = 0 then raise exception 'mark_attendance has changed since migration 51; review before replacing'; end if;
end $$;

create function public.mark_attendance(p_session_id uuid, p_student_id uuid, p_status public.attendance_status default 'present',
                                       p_notes text default null, p_pin text default null, p_override_reason text default null) returns text
language plpgsql security definer set search_path = '' as $$
declare
  v_s public.class_sessions%rowtype; v_enrol uuid; v_uid uuid := (select auth.uid());
  v_pin public.student_pins%rowtype; v_prev public.attendance_status; v_method text;
  v_reason text := nullif(btrim(coalesce(p_override_reason, '')), ''); v_log uuid; v_who text; v_course text;
begin
  select * into v_s from public.class_sessions where id = p_session_id;
  if not found then raise exception 'session_not_found'; end if;
  if not (private.is_admin() or v_s.instructor_id = v_uid or private.is_centre_staff(v_s.centre_id)) then raise exception 'forbidden' using errcode = '42501'; end if;

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

  select status into v_prev from public.attendance where session_id = p_session_id and student_id = p_student_id;
  if p_status = 'present' and v_prev = 'present' then return 'ok'; end if;   -- already in; never overwrite how they got in

  if p_status = 'present' then
    if v_reason is not null and char_length(v_reason) > 300 then raise exception 'reason_too_long'; end if;
    if private.is_admin() and v_reason is not null and char_length(v_reason) >= 5 then
      v_method := 'admin_override';                       -- an admin's written reason stands in for the PIN; the student is told and can dispute it
    else
      select * into v_pin from public.student_pins where student_id = p_student_id for update;
      if not found then return 'pin_not_set'; end if;
      if v_pin.locked_until is not null and v_pin.locked_until > now() then return 'pin_locked'; end if;
      if nullif(p_pin, '') is null then return 'pin_required'; end if;
      if v_pin.pin_hash <> extensions.crypt(p_pin, v_pin.pin_hash) then
        update public.student_pins
           set failed_attempts = case when failed_attempts + 1 >= 5 then 0 else failed_attempts + 1 end,
               locked_until = case when failed_attempts + 1 >= 5 then now() + interval '15 minutes' else locked_until end
         where student_id = p_student_id;
        return case when v_pin.failed_attempts + 1 >= 5 then 'pin_locked' else 'pin_incorrect' end;
      end if;
      update public.student_pins set failed_attempts = 0, locked_until = null where student_id = p_student_id;
      v_method := 'pin';
    end if;
  end if;

  insert into public.attendance (session_id, student_id, enrolment_id, status, method, marked_by, notes)
  values (p_session_id, p_student_id, v_enrol, p_status,
          case when private.is_admin() then 'admin'::public.attendance_method
               when private.is_centre_staff(v_s.centre_id) then 'centre_staff'::public.attendance_method
               else 'instructor'::public.attendance_method end,
          v_uid, p_notes)
  on conflict (session_id, student_id) do update
    set status = excluded.status, method = excluded.method, marked_by = excluded.marked_by,
        notes = excluded.notes, checked_in_at = now();

  if p_status = 'present' then
    insert into public.hand_check_ins (session_id, student_id, marked_by, method, override_reason, prev_status)
    values (p_session_id, p_student_id, v_uid, v_method, case when v_method = 'admin_override' then v_reason end, v_prev) returning id into v_log;
    select coalesce(nullif(trim(full_name), ''), 'Someone') into v_who from public.profiles where id = v_uid;
    select title into v_course from public.courses where id = v_s.course_id;
    perform private.notify(array[p_student_id], 'hand_check_in', 'You were checked in to a class',
      v_who || ' checked you in to ' || coalesce(v_course, 'a class') || case when v_method = 'admin_override' then ' without your PIN.' else ' with your PIN.' end
        || ' If this wasn''t you, tap "That wasn''t me".',
      jsonb_build_object('log_id', v_log, 'session_id', p_session_id));
  end if;
  return 'ok';
end $$;
drop function public.mark_attendance(uuid, uuid, public.attendance_status, text, text);
revoke all on function public.mark_attendance(uuid, uuid, public.attendance_status, text, text, text) from public, anon;
grant execute on function public.mark_attendance(uuid, uuid, public.attendance_status, text, text, text) to authenticated;

-- ---------- "That wasn't me" ----------
create or replace function public.dispute_hand_check_in(p_log_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare v_l public.hand_check_ins%rowtype; v_uid uuid := (select auth.uid()); v_student text; v_marker text; v_course text; v_admins uuid[];
begin
  select * into v_l from public.hand_check_ins where id = p_log_id for update;
  if not found or v_l.student_id <> v_uid then raise exception 'forbidden' using errcode = '42501'; end if;
  if v_l.disputed_at is not null then return; end if;

  update public.hand_check_ins set disputed_at = now() where id = p_log_id;
  if v_l.prev_status is null then delete from public.attendance where session_id = v_l.session_id and student_id = v_uid and status = 'present';
  else update public.attendance set status = v_l.prev_status where session_id = v_l.session_id and student_id = v_uid and status = 'present'; end if;
  perform private.refresh_session_counts(v_l.session_id);
  update public.notifications set data = coalesce(data, '{}'::jsonb) || '{"disputed": true}'::jsonb
   where user_id = v_uid and type = 'hand_check_in' and data ->> 'log_id' = p_log_id::text;

  select coalesce(nullif(trim(full_name), ''), 'A student') into v_student from public.profiles where id = v_uid;
  select coalesce(nullif(trim(full_name), ''), 'a staff member') into v_marker from public.profiles where id = v_l.marked_by;
  select c.title into v_course from public.class_sessions s join public.courses c on c.id = s.course_id where s.id = v_l.session_id;
  select array_agg(distinct r.user_id) into v_admins from public.user_roles r where r.is_active and r.role in ('admin', 'super_admin');
  perform private.notify(v_admins, 'hand_check_in_disputed', 'A student disputed a hand check-in',
    v_student || ' says they did not agree to be checked in by ' || v_marker || ' for ' || coalesce(v_course, 'a class') || '. Open Hand check-ins to review it.',
    jsonb_build_object('log_id', p_log_id, 'session_id', v_l.session_id));
end $$;
revoke all on function public.dispute_hand_check_in(uuid) from public, anon;
grant execute on function public.dispute_hand_check_in(uuid) to authenticated;

-- ---------- Admin report ----------
create or replace function public.admin_hand_check_ins(p_days integer default 30)
returns table (id uuid, created_at timestamptz, marker_id uuid, marker_name text, student_name text, course_title text, session_date date,
               centre_name text, method text, override_reason text, disputed boolean)
language plpgsql stable security definer set search_path = '' as $$
begin
  if not private.is_admin() then raise exception 'forbidden' using errcode = '42501'; end if;
  return query
  select h.id, h.created_at, h.marked_by, coalesce(nullif(trim(mp.full_name), ''), 'Unknown'), coalesce(nullif(trim(sp.full_name), ''), 'Student'),
         c.title, s.session_date, ce.name, h.method, h.override_reason, h.disputed_at is not null
    from public.hand_check_ins h
    left join public.profiles mp on mp.id = h.marked_by
    left join public.profiles sp on sp.id = h.student_id
    left join public.class_sessions s on s.id = h.session_id
    left join public.courses c on c.id = s.course_id
    left join public.centres ce on ce.id = s.centre_id
   where h.created_at > now() - make_interval(days => least(greatest(coalesce(p_days, 30), 1), 365))
   order by h.created_at desc limit 1000;
end $$;
revoke all on function public.admin_hand_check_ins(integer) from public, anon;
grant execute on function public.admin_hand_check_ins(integer) to authenticated;

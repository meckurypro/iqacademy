-- supabase/migrations/53_hand_check_in_window_and_coordinator_scope.sql   (applied to the live DB as "hand_check_in_window_and_coordinator_scope")
--
-- 1. PIN BYPASS FIXED. mark_attendance (migration 52) returned 'ok' as soon as the student was already present, BEFORE it looked at the PIN.
--    So choosing "Check in" on a student who was already present accepted any PIN, right or wrong, and the app said "checked in".
--    It now returns 'already_present' (the app shows "Already checked in" and never claims a check-in happened), and nothing is changed.
-- 2. HAND CHECK-IN HAS A WINDOW. Marking someone PRESENT by hand works only from checkin_opens_minutes_before (default 30) before the class
--    starts until the class's end time, the same moment the class code unlocks and expires. Not after the class has ended or been cancelled.
--    Applies to everyone, admins included. Absent / excused are not affected. Checked before the PIN, so a wrong PIN outside the window is not counted.
-- 3. DOOR WORK IS THE COORDINATOR'S. Only the centre's coordinator (or an admin, or the class's own instructor) can mark attendance by hand.
--    A centre director no longer can; directors only see income and student numbers.
-- 4. DIRECTORS NO LONGER GET CLASS REMINDERS or a "next class" countdown (class_clock_tick, my_class_clock): those are for coordinators.

create or replace function private.is_centre_coordinator(p_centre_id uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.user_roles r
                  where r.user_id = (select auth.uid()) and r.is_active and r.role = 'coordinator' and r.centre_id = p_centre_id)
$$;
revoke all on function private.is_centre_coordinator(uuid) from public, anon;
grant execute on function private.is_centre_coordinator(uuid) to authenticated;

create or replace function public.mark_attendance(p_session_id uuid, p_student_id uuid, p_status public.attendance_status default 'present',
                                                  p_notes text default null, p_pin text default null, p_override_reason text default null) returns text
language plpgsql security definer set search_path = '' as $$
declare
  v_s public.class_sessions%rowtype; v_enrol uuid; v_uid uuid := (select auth.uid());
  v_pin public.student_pins%rowtype; v_prev public.attendance_status; v_method text;
  v_reason text := nullif(btrim(coalesce(p_override_reason, '')), ''); v_log uuid; v_who text; v_course text;
begin
  select * into v_s from public.class_sessions where id = p_session_id;
  if not found then raise exception 'session_not_found'; end if;
  if not (private.is_admin() or v_s.instructor_id = v_uid or private.is_centre_coordinator(v_s.centre_id)) then raise exception 'forbidden' using errcode = '42501'; end if;

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
  -- already in: change nothing and say so. Never answer 'ok' here, because no PIN was checked.
  if p_status = 'present' and v_prev = 'present' then return 'already_present'; end if;

  if p_status = 'present' then
    -- only while the class code is live: from checkin_opens_minutes_before until the class ends
    if v_s.status in ('completed', 'cancelled')
       or now() < v_s.start_at - make_interval(mins => private.setting_int('checkin_opens_minutes_before', 30))
       or now() > v_s.end_at then
      raise exception 'outside_checkin_window';
    end if;

    if v_reason is not null and char_length(v_reason) > 300 then raise exception 'reason_too_long'; end if;
    if private.is_admin() and v_reason is not null and char_length(v_reason) >= 5 then
      v_method := 'admin_override';
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
               when private.is_centre_coordinator(v_s.centre_id) then 'centre_staff'::public.attendance_method
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

-- ---------- directors out of class reminders and the countdown (patches the live definitions) ----------
do $$
declare v_def text; v_tick text := $q$ur.role in ('centre_director', 'coordinator')$q$; v_clock text := $q$ur.role in ('coordinator', 'centre_director')$q$;
begin
  select pg_get_functiondef(p.oid) into strict v_def from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'private' and p.proname = 'class_clock_tick';
  if position(v_tick in v_def) = 0 then raise exception 'class_clock_tick: reminder recipient filter not found'; end if;
  execute replace(v_def, v_tick, $q$ur.role = 'coordinator'$q$);

  select pg_get_functiondef(p.oid) into strict v_def from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = 'my_class_clock';
  if position(v_clock in v_def) = 0 then raise exception 'my_class_clock: staff filter not found'; end if;
  execute replace(v_def, v_clock, $q$ur.role = 'coordinator'$q$);
end $$;

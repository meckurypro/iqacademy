-- 45_class_clock.sql
-- The class clock. Classes now run themselves; nobody has to press Start or End.
--
-- One scheduler function, private.class_clock_tick(), runs every minute from pg_cron (already used by this project for
-- reminders). Every step is driven by the class's own timestamps, never by "it is exactly minute X", so a missed or
-- late run catches up on the next one. Each step is idempotent and safe to run twice.
--
--   1. END       a class whose end_at has passed becomes 'completed'; its check-in code is deleted; absentees are
--                logged and the head count refreshed (the same work complete_session does by hand).
--                Only classes that ended in the last `class_clock_catchup_hours` (default 12) are touched, so deploying
--                this migration can't rewrite attendance for old classes nobody ended by hand.
--   2. OPEN DOOR from `checkin_opens_minutes_before` (default 30) before the start, a check-in code exists for the
--                class. It expires at end_at, and step 1 deletes it.
--   3. START     a scheduled class whose start_at has passed becomes 'in_progress'.
--   4. REMIND    `class_reminder_minutes_before` (default 60) before the start, the class's students, instructor and
--                the centre's coordinators / directors each get one notification. reminder_sent_at makes it once only.
--
-- Also here:
--   * generate_checkin_token no longer starts the class (the clock does); door staff can still use it to fetch the
--     code or make a fresh one.
--   * my_class_clock(): the caller's live and upcoming classes (as student, instructor or centre staff) for the
--     dashboard countdown. The server decides who a class belongs to; the browser only draws it.
-- Nothing here changes check_in(): it already checks the time window itself, so a late cron run can never let
-- someone in outside the window.

-- ---------- 1. Settings and columns ----------
insert into public.app_settings (key, value, description) values
  ('class_reminder_minutes_before', '60'::jsonb, 'Minutes before a class when its students, instructor and centre staff are reminded'),
  ('class_clock_catchup_hours',    '12'::jsonb, 'The class clock only auto-completes classes that ended within this many hours')
on conflict (key) do nothing;

alter table public.class_sessions
  add column if not exists reminder_sent_at   timestamptz,
  add column if not exists checkin_opened_at  timestamptz;
create index if not exists class_sessions_clock_idx on public.class_sessions (start_at) where status in ('scheduled', 'in_progress');

-- the system, not a person, now issues the code
alter table public.session_checkin_tokens alter column issued_by drop not null;

-- ---------- 2. Who is in a class ----------
-- Same rule log_absentees uses, so "who gets the reminder", "who is marked absent" and "whose dashboard shows the
-- class" can never disagree. An emergency class is open to every active registration at the centre.
create or replace function private.session_students(p_session_id uuid) returns setof uuid
language sql stable security definer set search_path = '' as $$
  select distinct e.student_id
    from public.class_sessions s
    join public.enrolments e on e.centre_id = s.centre_id and e.status = 'active'
   where s.id = p_session_id
     and (s.is_emergency
          or (exists (select 1 from public.enrolment_courses ec where ec.enrolment_id = e.id and ec.course_id = s.course_id)
              and private.clock_open(e.id, s.session_date)
              and private.in_own_run(e.id, s.course_id, s.run_id)
              and private.enrolment_course_access(e.id, s.course_id)))
$$;
revoke all on function private.session_students(uuid) from public, anon, authenticated;

-- ---------- 3. Door staff fetch / rotate the code; it no longer starts the class ----------
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
  return v_token;
end $$;
revoke execute on function public.generate_checkin_token(uuid, boolean) from public, anon;
grant execute on function public.generate_checkin_token(uuid, boolean) to authenticated;

-- ---------- 4. The clock ----------
create or replace function private.class_clock_tick() returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_now     timestamptz := clock_timestamp();
  v_open    integer := private.setting_int('checkin_opens_minutes_before', 30);
  v_rem     integer := private.setting_int('class_reminder_minutes_before', 60);
  v_catchup integer := private.setting_int('class_clock_catchup_hours', 12);
  s         record;
  v_token   text; v_try integer;
  v_course  text; v_lesson text; v_place text; v_at text; v_door text; v_who text; v_title text;
  v_students uuid[]; v_staff uuid[]; v_roster integer;
  n_end integer := 0; n_door integer := 0; n_start integer := 0; n_rem integer := 0;
begin
  -- two overlapping runs would double-notify; the second simply skips
  if not pg_try_advisory_xact_lock(hashtext('iqa_class_clock')) then return jsonb_build_object('skipped', true); end if;

  -- 1. END ---------------------------------------------------------------
  for s in
    select cs.id from public.class_sessions cs
     where cs.status in ('scheduled', 'in_progress')
       and cs.end_at <= v_now and cs.end_at > v_now - make_interval(hours => v_catchup)
     order by cs.end_at
       for update skip locked
  loop
    begin
      update public.class_sessions set status = 'completed', completed_at = coalesce(completed_at, v_now) where id = s.id;
      delete from public.session_checkin_tokens where session_id = s.id;     -- the code stops working
      perform private.log_absentees(s.id);
      perform private.refresh_session_counts(s.id);
      n_end := n_end + 1;
    exception when others then
      raise warning 'class_clock_tick: ending % failed: %', s.id, sqlerrm;
    end;
  end loop;

  -- 2. OPEN THE DOOR -----------------------------------------------------
  for s in
    select cs.id, cs.end_at from public.class_sessions cs
     where cs.status in ('scheduled', 'in_progress')
       and v_now >= cs.start_at - make_interval(mins => v_open) and v_now < cs.end_at
       and not exists (select 1 from public.session_checkin_tokens t
                        where t.session_id = cs.id and (t.expires_at is null or t.expires_at > v_now))
     order by cs.start_at
       for update of cs skip locked
  loop
    begin
      v_try := 0;
      loop
        v_token := upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 8));
        begin
          insert into public.session_checkin_tokens (session_id, token, issued_by, expires_at)
          values (s.id, v_token, null, s.end_at)
          on conflict (session_id) do update
            set token = excluded.token, issued_by = null, issued_at = now(), expires_at = excluded.expires_at;
          exit;
        exception when unique_violation then
          v_try := v_try + 1;
          if v_try > 5 then raise; end if;
        end;
      end loop;
      update public.class_sessions set checkin_opened_at = coalesce(checkin_opened_at, v_now) where id = s.id;
      n_door := n_door + 1;
    exception when others then
      raise warning 'class_clock_tick: opening check-in for % failed: %', s.id, sqlerrm;
    end;
  end loop;

  -- 3. START -------------------------------------------------------------
  update public.class_sessions set status = 'in_progress'
   where status = 'scheduled' and start_at <= v_now and end_at > v_now;
  get diagnostics n_start = row_count;

  -- 4. REMIND ------------------------------------------------------------
  for s in
    select cs.id, cs.centre_id, cs.course_id, cs.instructor_id, cs.start_at
      from public.class_sessions cs
     where cs.status = 'scheduled' and cs.reminder_sent_at is null
       and cs.start_at > v_now and cs.start_at <= v_now + make_interval(mins => v_rem)
     order by cs.start_at
       for update skip locked
  loop
    begin
      select c.title into v_course from public.courses c where c.id = s.course_id;
      select l.title into v_lesson from public.class_sessions x join public.course_lessons l on l.id = x.lesson_id where x.id = s.id;
      v_place := private.centre_place(s.centre_id);
      v_at    := to_char(s.start_at at time zone 'Africa/Lagos', 'HH12:MI AM');
      v_door  := to_char((s.start_at - make_interval(mins => v_open)) at time zone 'Africa/Lagos', 'HH12:MI AM');
      v_title := case when v_rem = 60 then 'Class in 1 hour' else 'Class in ' || v_rem || ' minutes' end;

      select array_agg(t) into v_students from private.session_students(s.id) as t;
      v_roster := coalesce(cardinality(v_students), 0);

      if v_roster > 0 then
        perform private.notify(v_students, 'class_reminder', v_title,
          v_course || coalesce(' · ' || v_lesson, '') || ' starts at ' || v_at || ' at ' || v_place
            || '. Check-in opens at ' || v_door || '.',
          jsonb_build_object('session_id', s.id));
      end if;

      if s.instructor_id is not null then
        perform private.notify(array[s.instructor_id], 'class_reminder', v_title,
          'You teach ' || v_course || coalesce(' · ' || v_lesson, '') || ' at ' || v_at || ' at ' || v_place
            || '. ' || v_roster || case when v_roster = 1 then ' student is' else ' students are' end || ' expected.',
          jsonb_build_object('session_id', s.id));
      end if;

      select nullif(split_part(trim(p.full_name), ' ', 1), '') into v_who from public.profiles p where p.id = s.instructor_id;
      select array_agg(distinct ur.user_id) into v_staff from public.user_roles ur
       where ur.is_active and ur.role in ('centre_director', 'coordinator') and ur.centre_id = s.centre_id
         and ur.user_id is distinct from s.instructor_id;
      if coalesce(cardinality(v_staff), 0) > 0 then
        perform private.notify(v_staff, 'class_reminder_staff', v_title || ' at your centre',
          v_course || coalesce(' · ' || v_lesson, '') || ' starts at ' || v_at
            || coalesce(' with ' || v_who, ', no instructor assigned yet')
            || '. The check-in code is ready from ' || v_door || '.',
          jsonb_build_object('session_id', s.id));
      end if;

      update public.class_sessions set reminder_sent_at = v_now where id = s.id;
      n_rem := n_rem + 1;
    exception when others then
      raise warning 'class_clock_tick: reminder for % failed: %', s.id, sqlerrm;
    end;
  end loop;

  -- housekeeping: codes of cancelled or long-finished classes
  delete from public.session_checkin_tokens where expires_at is not null and expires_at < v_now;

  return jsonb_build_object('ended', n_end, 'door_opened', n_door, 'started', n_start, 'reminded', n_rem);
end $$;
revoke all on function private.class_clock_tick() from public, anon, authenticated;

-- ---------- 5. My live and upcoming classes (dashboard countdown) ----------
create or replace function public.my_class_clock(p_limit integer default 3)
returns table (
  id uuid, start_at timestamptz, end_at timestamptz, status text, as_role text, is_emergency boolean,
  course_title text, lesson_title text, room text, centre_id uuid, centre_name text, centre_city text,
  centre_address text, instructor_name text, checkin_opens_at timestamptz)
language plpgsql stable security definer set search_path = '' as $$
#variable_conflict use_column
declare
  v_uid  uuid := (select auth.uid());
  v_now  timestamptz := clock_timestamp();
  v_open integer := private.setting_int('checkin_opens_minutes_before', 30);
begin
  if v_uid is null then raise exception 'not_authenticated' using errcode = '28000'; end if;
  return query
  with cand as (
    select cs.id, cs.centre_id, cs.instructor_id
      from public.class_sessions cs
     where cs.status in ('scheduled', 'in_progress') and cs.end_at > v_now and cs.start_at < v_now + interval '45 days'
  ),
  mine as (
    select c.id, 1 as rank, 'instructor'::text as as_role from cand c where c.instructor_id = v_uid
    union all
    select c.id, 2, 'staff'::text from cand c
     where exists (select 1 from public.user_roles ur
                    where ur.user_id = v_uid and ur.is_active and ur.role in ('coordinator', 'centre_director') and ur.centre_id = c.centre_id)
    union all
    select c.id, 3, 'student'::text from cand c
     where c.centre_id in (select e.centre_id from public.enrolments e where e.student_id = v_uid and e.status = 'active')
       and exists (select 1 from private.session_students(c.id) as t(student_id) where t.student_id = v_uid)
  ),
  best as (select distinct on (m.id) m.id, m.as_role from mine m order by m.id, m.rank)
  select v.id, v.start_at, v.end_at, v.status::text, b.as_role, v.is_emergency,
         v.course_title, v.lesson_title, v.room, v.centre_id, v.centre_name, v.centre_city, v.centre_address,
         v.instructor_name, v.start_at - make_interval(mins => v_open)
    from best b join public.v_session_details v on v.id = b.id
   order by v.start_at
   limit greatest(1, least(coalesce(p_limit, 3), 10));
end $$;
revoke execute on function public.my_class_clock(integer) from public, anon;
grant execute on function public.my_class_clock(integer) to authenticated;

-- ---------- 6. Schedule: every minute ----------
do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.unschedule('iqa-class-clock') where exists (select 1 from cron.job where jobname = 'iqa-class-clock');
    perform cron.schedule('iqa-class-clock', '* * * * *', 'select private.class_clock_tick()');
  else
    raise notice 'pg_cron is not enabled: enable it (Database > Extensions) and re-run this block to schedule the class clock.';
  end if;
end $$;

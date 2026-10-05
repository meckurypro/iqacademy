-- 41_roster_followups.sql  (applied to the live DB as "roster_followups")
-- Migration 40 moved instructors from runs to individual classes. Everything that still looked at
-- course_runs.instructor_id now looks at who actually teaches the classes:
--   * runs_select: an instructor can see a run when they teach a class in it
--   * save_course_run / cancel_course_run: instructors keep scheduling the next run of their own course
--     (as before). A run an instructor creates or extends has its open classes assigned to them; a run an
--     admin creates stays unassigned until the Roster is filled in. Instructors on a run are told when it is cancelled.
--   * remind_run_endings: reminds admins and the instructors who teach the run
--   * resolve_audience: "instructors of course X / at centre Y" announcements follow class assignments

-- ---------- runs visible to the instructors who teach in them ----------
drop policy if exists runs_select on public.course_runs;
create policy runs_select on public.course_runs for select to authenticated using (
  private.is_admin() or private.is_centre_staff(centre_id)
  or exists (select 1 from public.class_sessions cs where cs.run_id = course_runs.id and cs.instructor_id = (select auth.uid())));

-- ---------- save_course_run ----------
create or replace function public.save_course_run(p_run_id uuid, p_centre_id uuid, p_course_id uuid, p_instructor_id uuid, p_start date, p_end date)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_uid   uuid := (select auth.uid());
  v_admin boolean := private.is_admin() or private.is_privileged();
  v_today date := (now() at time zone 'Africa/Lagos')::date;
  v_run   public.course_runs%rowtype;
  v_id uuid; v_n integer; v_planned integer; v_expected integer; v_last date; v_title text;
  v_before date[]; v_after date[];
begin
  if v_uid is null and not private.is_privileged() then raise exception 'not_authenticated' using errcode = '28000'; end if;
  if not (v_admin or private.is_instructor()) then raise exception 'forbidden' using errcode = '42501'; end if;

  if p_run_id is not null then
    select * into v_run from public.course_runs where id = p_run_id for update;
    if not found then raise exception 'run_not_found'; end if;
    if not v_admin and not exists (select 1 from public.class_sessions cs where cs.run_id = p_run_id and cs.instructor_id = v_uid) then
      raise exception 'forbidden' using errcode = '42501';
    end if;
    if v_run.status = 'cancelled' then raise exception 'run_cancelled'; end if;
    p_centre_id := v_run.centre_id;
    p_course_id := v_run.course_id;
  end if;

  if not exists (select 1 from public.centres where id = p_centre_id and is_active) then raise exception 'centre_not_available'; end if;
  select title, total_sessions into v_title, v_expected from public.courses where id = p_course_id and is_active;
  if not found then raise exception 'invalid_course'; end if;
  if not exists (select 1 from public.centre_class_days where centre_id = p_centre_id) then raise exception 'no_class_days'; end if;

  if p_start is null or p_end is null or p_end < p_start then raise exception 'bad_dates'; end if;
  if (p_run_id is null or p_start <> v_run.start_date) and p_start < v_today then raise exception 'start_in_past'; end if;
  if p_start > (v_today + interval '4 months')::date then raise exception 'too_far_ahead'; end if;
  if p_end > (p_start + interval '4 months')::date then raise exception 'run_too_long'; end if;

  if exists (select 1 from public.course_runs r
              where r.centre_id = p_centre_id and r.course_id = p_course_id and r.status = 'scheduled'
                and r.id is distinct from p_run_id
                and daterange(r.start_date, r.end_date, '[]') && daterange(p_start, p_end, '[]')) then
    raise exception 'run_overlap';
  end if;

  select count(*), max(session_date) into v_planned, v_last from private.session_plan(p_centre_id, p_course_id, p_start, p_end);
  if v_planned = 0 then raise exception 'no_class_in_range'; end if;

  -- an instructor scheduling their own run can't be double-booked
  if not v_admin and exists (
       select 1 from private.session_plan(p_centre_id, p_course_id, p_start, p_end) p
         join public.centres c on c.id = p_centre_id
         join public.class_sessions cs on cs.instructor_id = v_uid and cs.status <> 'cancelled'
                                      and (p_run_id is null or cs.run_id is distinct from p_run_id)
        where tstzrange((p.session_date + p.start_time) at time zone c.timezone, (p.session_date + p.end_time) at time zone c.timezone)
              && tstzrange(cs.start_at, cs.end_at)) then
    raise exception 'instructor_clash';
  end if;

  if p_run_id is null then
    insert into public.course_runs (centre_id, course_id, start_date, end_date)
    values (p_centre_id, p_course_id, p_start, p_end) returning id into v_id;
  else
    update public.course_runs
       set start_date = p_start, end_date = p_end,
           end_reminded_at = case when p_end is distinct from v_run.end_date then null else end_reminded_at end
     where id = p_run_id;
    v_id := p_run_id;
    select array_agg(session_date order by session_no) into v_before from public.class_sessions where run_id = v_id and status = 'scheduled' and start_at > now();
  end if;

  v_n := private.build_run_sessions(v_id);

  -- the instructor who set the dates takes the classes nobody else teaches
  if not v_admin then
    update public.class_sessions set instructor_id = v_uid
     where run_id = v_id and status = 'scheduled' and start_at > now() and instructor_id is null;
  end if;

  if p_run_id is not null then
    select array_agg(session_date order by session_no) into v_after from public.class_sessions where run_id = v_id and status = 'scheduled' and start_at > now();
    if v_before is distinct from v_after then
      perform private.notify(
        (select array_agg(distinct cs.instructor_id) from public.class_sessions cs
          where cs.run_id = v_id and cs.instructor_id is not null and cs.instructor_id is distinct from v_uid
            and cs.status = 'scheduled' and cs.start_at > now()),
        'class_changed', 'Class dates changed',
        v_title || ' at ' || private.centre_place(p_centre_id) || ' now runs ' || to_char(p_start, 'DD Mon') || ' to ' || to_char(p_end, 'DD Mon') || '. Open My classes to see your new dates.',
        jsonb_build_object('run_id', v_id));
    end if;
  end if;

  return jsonb_build_object('run_id', v_id, 'sessions', v_n, 'planned', v_planned, 'expected', v_expected,
                            'last_session_date', v_last, 'short_by', greatest(v_expected - v_planned, 0));
end $$;

-- ---------- cancel_course_run ----------
create or replace function public.cancel_course_run(p_run_id uuid, p_reason text default null) returns void
language plpgsql security definer set search_path = '' as $$
declare v_run public.course_runs%rowtype; v_students uuid[]; v_staff uuid[]; v_title text;
begin
  select * into v_run from public.course_runs where id = p_run_id for update;
  if not found then raise exception 'run_not_found'; end if;
  if not (private.is_admin() or private.is_privileged()
          or exists (select 1 from public.class_sessions cs where cs.run_id = p_run_id and cs.instructor_id = (select auth.uid()))) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if v_run.status = 'cancelled' then return; end if;

  select array_agg(distinct cs.instructor_id) into v_staff from public.class_sessions cs
   where cs.run_id = p_run_id and cs.instructor_id is not null and cs.instructor_id is distinct from (select auth.uid())
     and cs.status = 'scheduled' and cs.start_at > now();

  update public.course_runs set status = 'cancelled', cancel_reason = p_reason where id = p_run_id;
  delete from public.session_checkin_tokens where session_id in (
    select id from public.class_sessions where run_id = p_run_id and status = 'scheduled' and start_at > now());
  update public.class_sessions set status = 'cancelled', cancelled_at = now(), cancel_reason = coalesce(p_reason, 'Run cancelled')
   where run_id = p_run_id and status = 'scheduled' and start_at > now();

  select title into v_title from public.courses where id = v_run.course_id;
  select array_agg(distinct e.student_id) into v_students
    from public.enrolments e join public.enrolment_courses ec on ec.enrolment_id = e.id
   where e.centre_id = v_run.centre_id and ec.course_id = v_run.course_id and e.status = 'active';
  perform private.notify(v_students, 'run_cancelled', 'Classes cancelled',
    v_title || ' at ' || private.centre_place(v_run.centre_id) || ' has been cancelled.' || coalesce(' Reason: ' || p_reason, ''),
    jsonb_build_object('run_id', p_run_id));
  perform private.notify(v_staff, 'run_cancelled', 'Classes cancelled',
    v_title || ' at ' || private.centre_place(v_run.centre_id) || ' has been cancelled, so those classes are off your list.' || coalesce(' Reason: ' || p_reason, ''),
    jsonb_build_object('run_id', p_run_id));
  perform private.refresh_clocks(v_run.centre_id, v_run.course_id);
end $$;

-- ---------- remind_run_endings ----------
create or replace function public.remind_run_endings() returns integer
language plpgsql security definer set search_path = '' as $$
declare r record; v_n integer := 0; v_today date := (now() at time zone 'Africa/Lagos')::date;
begin
  if not (private.is_privileged() or private.is_admin()) then raise exception 'forbidden' using errcode = '42501'; end if;
  for r in
    select x.id, x.centre_id, x.course_id, x.start_date, x.last_date, co.title
      from (select ru.*,
                   (select max(cs.session_date) from public.class_sessions cs where cs.run_id = ru.id and cs.status <> 'cancelled') as last_date,
                   (select count(*) from public.class_sessions cs where cs.run_id = ru.id and cs.status = 'scheduled' and cs.start_at > now()) as left_n
              from public.course_runs ru where ru.status = 'scheduled' and ru.end_reminded_at is null) x
      join public.courses co on co.id = x.course_id
     where x.last_date is not null and x.last_date >= v_today and x.left_n <= 2
  loop
    if not private.has_next_run(r.centre_id, r.course_id, r.start_date) then
      perform private.notify(
        (select array_agg(distinct u) from unnest(private.admin_ids() || coalesce(
            (select array_agg(distinct cs.instructor_id) from public.class_sessions cs
              where cs.run_id = r.id and cs.instructor_id is not null and cs.status <> 'cancelled'), '{}')) u where u is not null),
        'run_ending', 'Set the next run',
        r.title || ' at ' || private.centre_place(r.centre_id) || ' holds its last class on ' || to_char(r.last_date, 'Dy DD Mon') || '. Set the next start date.',
        jsonb_build_object('run_id', r.id, 'centre_id', r.centre_id, 'course_id', r.course_id));
      v_n := v_n + 1;
    end if;
    update public.course_runs set end_reminded_at = now() where id = r.id;
  end loop;
  return v_n;
end $$;

-- ---------- announcements to "instructors of course X at centre Y" ----------
do $patch$
declare d text; n text;
begin
  select pg_get_functiondef('private.resolve_audience(jsonb)'::regprocedure) into d;
  if position('from public.class_sessions cs' in d) > 0 then return; end if;   -- already patched
  n := regexp_replace(d,
    'array\(select distinct s\.instructor_id from public\.course_runs s.*?\(v_courses is null or s\.course_id = any \(v_courses\)\)\)',
    'array(select distinct cs.instructor_id from public.class_sessions cs
                         where cs.instructor_id is not null and cs.status in (''scheduled'', ''in_progress'') and cs.end_at >= now()
                           and (v_centres is null or cs.centre_id = any (v_centres))
                           and (v_courses is null or cs.course_id = any (v_courses)))');
  if n = d then raise exception 'resolve_audience patch target missing'; end if;
  execute n;
end $patch$;

-- 40_roster.sql  (applied to the live DB as "roster_assign_and_my_classes")
-- Instructors are assigned to classes, not to course runs: several instructors can teach one course.
--   * A run only says when a course begins and ends at a centre (the class days decide the dates).
--   * class_sessions.instructor_id is the roster. Admins assign one class, a run of classes, a course at one
--     centre, or a course at every centre (public.roster_assign).
--   * Re-saving a run (new dates) keeps the people already on the roster, by class number.
--   * Assigned instructors are told once per assignment; instructors who are replaced are told too.
--   * public.my_classes() is what an instructor sees: their upcoming classes with topic and venue.

-- ---------- 1. Runs stop carrying instructors ----------
update public.course_runs set instructor_id = null where instructor_id is not null;
comment on column public.course_runs.instructor_id is 'Unused. Instructors are assigned to individual classes (class_sessions.instructor_id) on the Roster.';

-- A new class no longer inherits an instructor from its run (older timetable slots still do).
create or replace function private.fill_session_from_slot()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_slot public.timetable_slots%rowtype; v_run public.course_runs%rowtype;
begin
  if new.run_id is not null then
    select * into v_run from public.course_runs where id = new.run_id;
    if not found then raise exception 'run_not_found'; end if;
    new.centre_id := v_run.centre_id;
    new.course_id := v_run.course_id;
    return new;
  end if;
  select * into v_slot from public.timetable_slots where id = new.slot_id;
  if not found then raise exception 'slot_not_found'; end if;
  new.cohort_id := v_slot.cohort_id;
  new.centre_id := v_slot.centre_id;
  new.course_id := v_slot.course_id;
  if tg_op = 'INSERT' and new.instructor_id is null then new.instructor_id := v_slot.instructor_id; end if;
  return new;
end $$;

create index if not exists class_sessions_instructor_time_idx
  on public.class_sessions (instructor_id, start_at) where instructor_id is not null;

-- ---------- 2. Rebuilding a run keeps its roster ----------
create or replace function private.build_run_sessions(p_run_id uuid)
returns integer language plpgsql security definer set search_path = '' as $$
declare v_run public.course_runs%rowtype; v_tz text; v_n integer; v_keep jsonb;
begin
  select * into v_run from public.course_runs where id = p_run_id;
  if not found or v_run.status <> 'scheduled' then return 0; end if;
  select timezone into v_tz from public.centres where id = v_run.centre_id;

  -- who teaches which class number, for the classes about to be rebuilt
  select coalesce(jsonb_object_agg(cs.session_no::text, cs.instructor_id), '{}'::jsonb) into v_keep
    from public.class_sessions cs
   where cs.run_id = p_run_id and cs.status = 'scheduled' and cs.start_at > now() and cs.instructor_id is not null
     and not exists (select 1 from public.attendance a where a.session_id = cs.id);

  delete from public.session_checkin_tokens where session_id in (
    select cs.id from public.class_sessions cs where cs.run_id = p_run_id and cs.status = 'scheduled' and cs.start_at > now()
       and not exists (select 1 from public.attendance a where a.session_id = cs.id));
  delete from public.class_sessions cs
   where cs.run_id = p_run_id and cs.status = 'scheduled' and cs.start_at > now()
     and not exists (select 1 from public.attendance a where a.session_id = cs.id);

  insert into public.class_sessions (run_id, centre_id, course_id, instructor_id, lesson_id, session_no, session_date, start_at, end_at)
  select p_run_id, v_run.centre_id, v_run.course_id, x.instr,
         (select l.id from public.course_lessons l where l.course_id = v_run.course_id and l.lesson_no = p.session_no),
         p.session_no, p.session_date,
         (p.session_date + p.start_time) at time zone v_tz,
         (p.session_date + p.end_time)   at time zone v_tz
    from private.session_plan(v_run.centre_id, v_run.course_id, v_run.start_date, v_run.end_date) p
    cross join lateral (select nullif(v_keep ->> p.session_no::text, '')::uuid as cand) c
    cross join lateral (select case when c.cand is not null and not exists (
            select 1 from public.class_sessions o
             where o.instructor_id = c.cand and o.status <> 'cancelled'
               and tstzrange(o.start_at, o.end_at) && tstzrange((p.session_date + p.start_time) at time zone v_tz, (p.session_date + p.end_time) at time zone v_tz))
          then c.cand end as instr) x
   where (p.session_date + p.start_time) at time zone v_tz > now()
  on conflict do nothing;
  get diagnostics v_n = row_count;
  perform private.refresh_clocks(v_run.centre_id, v_run.course_id);
  return v_n;
end $$;

-- ---------- 3. Saving a run: dates only, admins only ----------
-- p_instructor_id stays in the signature so older app builds keep working; it is ignored.
create or replace function public.save_course_run(p_run_id uuid, p_centre_id uuid, p_course_id uuid, p_instructor_id uuid, p_start date, p_end date)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_uid   uuid := (select auth.uid());
  v_today date := (now() at time zone 'Africa/Lagos')::date;
  v_run   public.course_runs%rowtype;
  v_id uuid; v_n integer; v_planned integer; v_expected integer; v_last date; v_title text;
  v_before date[]; v_after date[];
begin
  if v_uid is null and not private.is_privileged() then raise exception 'not_authenticated' using errcode = '28000'; end if;
  if not (private.is_admin() or private.is_privileged()) then raise exception 'forbidden' using errcode = '42501'; end if;

  if p_run_id is not null then
    select * into v_run from public.course_runs where id = p_run_id for update;
    if not found then raise exception 'run_not_found'; end if;
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

  if p_run_id is null then
    insert into public.course_runs (centre_id, course_id, start_date, end_date)
    values (p_centre_id, p_course_id, p_start, p_end) returning id into v_id;
  else
    update public.course_runs
       set start_date = p_start, end_date = p_end,
           end_reminded_at = case when p_end is distinct from v_run.end_date then null else end_reminded_at end
     where id = p_run_id;
    v_id := p_run_id;
  end if;

  if p_run_id is not null then
    select array_agg(session_date order by session_no) into v_before from public.class_sessions where run_id = v_id and status = 'scheduled' and start_at > now();
  end if;
  v_n := private.build_run_sessions(v_id);

  -- instructors on this run are told when their class dates actually move
  if p_run_id is not null then
    select array_agg(session_date order by session_no) into v_after from public.class_sessions where run_id = v_id and status = 'scheduled' and start_at > now();
    if v_before is distinct from v_after then
      perform private.notify(
        (select array_agg(distinct cs.instructor_id) from public.class_sessions cs
          where cs.run_id = v_id and cs.instructor_id is not null and cs.status = 'scheduled' and cs.start_at > now()),
        'class_changed', 'Class dates changed',
        v_title || ' at ' || private.centre_place(p_centre_id) || ' now runs ' || to_char(p_start, 'DD Mon') || ' to ' || to_char(p_end, 'DD Mon') || '. Open My classes to see your new dates.',
        jsonb_build_object('run_id', v_id));
    end if;
  end if;

  return jsonb_build_object('run_id', v_id, 'sessions', v_n, 'planned', v_planned, 'expected', v_expected,
                            'last_session_date', v_last, 'short_by', greatest(v_expected - v_planned, 0));
end $$;

-- ---------- 4. The roster ----------
-- One line per course and centre: "Prompt Engineering at Lekki: 6 classes, 05 Oct to 17 Oct".
create or replace function private.roster_lines(p_changes jsonb, p_prev uuid default null)
returns text language sql stable security definer set search_path = '' as $$
  with ch as (
    select (x ->> 'course_id')::uuid as course_id, (x ->> 'centre_id')::uuid as centre_id,
           (x ->> 'start_at')::timestamptz at time zone (x ->> 'tz') as ls
      from jsonb_array_elements(p_changes) x
     where p_prev is null or (x ->> 'prev')::uuid = p_prev
  ), g as (
    select co.title, private.centre_place(ch.centre_id) as place, count(*) as n, min(ch.ls) as t1, max(ch.ls) as t2
      from ch join public.courses co on co.id = ch.course_id
     group by co.title, ch.centre_id
  )
  select string_agg(
           title || ' at ' || place || ': ' ||
           case when n = 1 then to_char(t1, 'Dy DD Mon, HH24:MI')
                else n || ' classes, ' || to_char(t1, 'DD Mon') || ' to ' || to_char(t2, 'DD Mon') end,
           E'\n' order by t1, title)
    from g
$$;

-- Assign (or clear, when p_instructor_id is null) the instructor of upcoming classes.
--   p_scope 'sessions'      -> exactly the classes in p_session_ids
--   p_scope 'course_centre' -> every upcoming class of p_course_id at p_centre_id
--   p_scope 'course_all'    -> every upcoming class of p_course_id at every centre
-- Classes that already started, finished or were cancelled are never touched. A class that would put the
-- instructor in two places at once is skipped and reported, the rest still go through.
create or replace function public.roster_assign(
  p_scope text, p_instructor_id uuid, p_session_ids uuid[] default null, p_course_id uuid default null, p_centre_id uuid default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := (select auth.uid());
  r record;
  v_assigned integer := 0; v_same integer := 0; v_locked integer := 0;
  v_clash jsonb := '[]'::jsonb; v_changes jsonb := '[]'::jsonb;
  v_prev uuid;
begin
  if not (private.is_admin() or private.is_privileged()) then raise exception 'forbidden' using errcode = '42501'; end if;
  if p_scope not in ('sessions', 'course_centre', 'course_all') then raise exception 'bad_scope'; end if;
  if p_scope = 'sessions' and coalesce(array_length(p_session_ids, 1), 0) = 0 then raise exception 'nothing_selected'; end if;
  if p_scope <> 'sessions' and not exists (select 1 from public.courses where id = p_course_id) then raise exception 'course_not_found'; end if;
  if p_scope = 'course_centre' and not exists (select 1 from public.centres where id = p_centre_id) then raise exception 'centre_not_found'; end if;
  if p_instructor_id is not null and not exists (
       select 1 from public.user_roles ur where ur.user_id = p_instructor_id and ur.is_active and ur.role = 'instructor') then
    raise exception 'not_an_instructor';
  end if;

  for r in
    select cs.id, cs.course_id, cs.centre_id, cs.status, cs.start_at, cs.end_at, cs.instructor_id as prev, co.title, ce.timezone as tz
      from public.class_sessions cs
      join public.courses co on co.id = cs.course_id
      join public.centres ce on ce.id = cs.centre_id
     where cs.status <> 'cancelled'
       and case p_scope
             when 'sessions' then cs.id = any (p_session_ids)
             when 'course_centre' then cs.course_id = p_course_id and cs.centre_id = p_centre_id
             else cs.course_id = p_course_id end
     order by cs.start_at, cs.id
       for update of cs
  loop
    if r.status <> 'scheduled' or r.start_at <= now() then v_locked := v_locked + 1; continue; end if;
    if r.prev is not distinct from p_instructor_id then v_same := v_same + 1; continue; end if;
    if p_instructor_id is not null and exists (
         select 1 from public.class_sessions o
          where o.instructor_id = p_instructor_id and o.status <> 'cancelled' and o.id <> r.id
            and tstzrange(o.start_at, o.end_at) && tstzrange(r.start_at, r.end_at)) then
      v_clash := v_clash || jsonb_build_object('id', r.id, 'course', r.title, 'at', to_char(r.start_at at time zone r.tz, 'Dy DD Mon, HH24:MI'));
      continue;
    end if;
    update public.class_sessions set instructor_id = p_instructor_id where id = r.id;
    v_assigned := v_assigned + 1;
    v_changes := v_changes || jsonb_build_object('course_id', r.course_id, 'centre_id', r.centre_id, 'prev', r.prev, 'start_at', r.start_at, 'tz', r.tz);
  end loop;

  if v_assigned > 0 then
    if p_instructor_id is not null and p_instructor_id is distinct from v_uid then
      perform private.notify(array[p_instructor_id], 'class_assigned',
        case when v_assigned = 1 then 'New class assigned' else 'New classes assigned' end,
        private.roster_lines(v_changes, null), jsonb_build_object('count', v_assigned));
    end if;
    for v_prev in select distinct (x ->> 'prev')::uuid from jsonb_array_elements(v_changes) x where x ->> 'prev' is not null loop
      if v_prev is distinct from p_instructor_id and v_prev is distinct from v_uid then
        perform private.notify(array[v_prev], 'class_unassigned', 'Teaching change',
          'You are no longer assigned to:' || E'\n' || private.roster_lines(v_changes, v_prev), '{}'::jsonb);
      end if;
    end loop;
  end if;

  return jsonb_build_object('assigned', v_assigned, 'unchanged', v_same, 'locked', v_locked, 'clashes', v_clash);
end $$;

-- ---------- 5. What an instructor sees ----------
create or replace function public.my_classes()
returns table (id uuid, session_no integer, start_at timestamptz, end_at timestamptz, status text,
               course_id uuid, course_title text, total_sessions integer, lesson_title text,
               centre_id uuid, centre_name text, centre_city text, centre_address text)
language sql stable security definer set search_path = '' as $$
  select s.id, s.session_no, s.start_at, s.end_at, s.status::text,
         co.id, co.title, co.total_sessions::integer, l.title,
         ce.id, ce.name, ce.city, ce.address
    from public.class_sessions s
    join public.courses co on co.id = s.course_id
    join public.centres ce on ce.id = s.centre_id
    left join public.course_lessons l on l.id = s.lesson_id
   where s.instructor_id = (select auth.uid()) and s.status in ('scheduled', 'in_progress') and s.end_at >= now()
   order by s.start_at
$$;

revoke all on function public.roster_assign(text, uuid, uuid[], uuid, uuid) from public, anon;
revoke all on function public.my_classes() from public, anon;
grant execute on function public.roster_assign(text, uuid, uuid[], uuid, uuid) to authenticated;
grant execute on function public.my_classes() to authenticated;
revoke all on function private.roster_lines(jsonb, uuid) from public, anon, authenticated;

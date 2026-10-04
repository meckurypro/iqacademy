-- 20_centre_course_starts.sql
-- Centres no longer run cohorts. Instructors build each centre's timetable, and a student who picks
-- courses first is shown, per centre, the date their FIRST course starts there.
--
-- DRAFT: written without access to the live schema. Review before running.
-- NOT covered here: public.create_enrolment still takes p_cohort_id, and the app now sends null.
-- That function (and enrolments.cohort_id) must accept "no cohort" before the new flow goes live.

-- 1) Timetable slots belong to a centre directly (backfilled from their old cohort).
alter table public.timetable_slots add column if not exists centre_id uuid references public.centres(id);

update public.timetable_slots s
   set centre_id = c.centre_id
  from public.cohorts c
 where c.id = s.cohort_id and s.centre_id is null;

alter table public.timetable_slots alter column cohort_id drop not null;

-- 2) Earliest date each centre can start a course: the next occurrence of any active weekly slot
--    on or after today (Lagos time) and the slot's effective_from. day_of_week is 1 = Monday .. 7 = Sunday.
--    Centres with no active slot for the course return no row.
create or replace function public.centre_course_starts(p_course_id uuid)
returns table (centre_id uuid, starts_on date)
language sql stable security definer set search_path = '' as $$
  with base as (
    select s.centre_id, s.day_of_week,
           greatest(s.effective_from, (now() at time zone 'Africa/Lagos')::date) as from_date
      from public.timetable_slots s
      join public.centres c on c.id = s.centre_id and c.is_active
     where s.course_id = p_course_id and s.is_active and s.centre_id is not null
  )
  select b.centre_id,
         min(b.from_date + ((b.day_of_week - extract(isodow from b.from_date)::int + 7) % 7))::date
    from base b
   group by b.centre_id
$$;

revoke all on function public.centre_course_starts(uuid) from public, anon;
grant execute on function public.centre_course_starts(uuid) to authenticated;

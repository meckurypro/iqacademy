-- 56_solo_needs_pack.sql   (builds on 30_makeup_and_solo and 42_solo_for_everyone)
-- A single course can only be bought by a student who has already paid for a course pack
-- (2 courses / 6 weeks or 3 courses / 10 weeks). Exploring single courses stays open to everyone;
-- the check happens when the student goes on to register, and the database is the one that enforces it.
-- "Paid for a pack" is private.has_paid_pack(): a non-SOLO enrolment that is activated and fully paid.

create or replace function public.can_buy_solo() returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce((select auth.uid()) is not null and private.has_paid_pack((select auth.uid())), false)
$$;
revoke all on function public.can_buy_solo() from public, anon;
grant execute on function public.can_buy_solo() to authenticated;

create or replace function public.create_solo_enrolment(p_centre_id uuid, p_course_id uuid) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := (select auth.uid());
  v_pkg public.packages%rowtype;
  v_q   record;
  v_id  uuid;
begin
  if v_uid is null then raise exception 'not_authenticated' using errcode = '28000'; end if;
  if not exists (select 1 from public.students where id = v_uid) then raise exception 'student_not_found'; end if;
  if not private.has_paid_pack(v_uid) then raise exception 'not_eligible_for_solo'; end if;
  if not exists (select 1 from public.courses where id = p_course_id and is_active) then raise exception 'course_not_available'; end if;
  if not exists (select 1 from public.centres where id = p_centre_id and is_active) then raise exception 'centre_not_available'; end if;
  if private.course_in_progress(v_uid, p_course_id) then raise exception 'already_enrolled_in_course'; end if;

  select * into v_q from private.solo_quote(v_uid, p_course_id);
  if v_q.price is null then raise exception 'solo_price_not_set'; end if;

  if not exists (select 1 from public.centre_course_starts(p_course_id) s where s.centre_id = p_centre_id) then
    raise exception 'no_classes_scheduled';
  end if;

  select * into v_pkg from public.packages where code = 'SOLO';
  insert into public.enrolments (student_id, centre_id, package_id, plan, currency, total_amount)
  values (v_uid, p_centre_id, v_pkg.id, 'full', v_pkg.currency, v_q.price)
  returning id into v_id;
  insert into public.enrolment_courses (enrolment_id, course_id, sequence_no) values (v_id, p_course_id, 1);
  insert into public.enrolment_instalments (enrolment_id, number, label, amount, due_rule) values (v_id, 1, 'Full payment', v_q.price, 'before_start');
  return v_id;
end $$;
revoke all on function public.create_solo_enrolment(uuid, uuid) from public, anon;
grant execute on function public.create_solo_enrolment(uuid, uuid) to authenticated;

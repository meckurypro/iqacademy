-- 42_solo_for_everyone.sql   (builds on 30_makeup_and_solo)
-- Any student can buy a single course, not only those who have fully paid for a pack.
-- Prices still come from course_prices: solo_price when the prerequisite(s) are completed (or the course has none),
-- solo_price_unmet when they are not. offers now also say whether the student has taken the course before (taken)
-- and which prerequisite(s) are still missing (needs).

drop function if exists public.solo_course_offers();

create function public.solo_course_offers()
returns table (course_id uuid, title text, summary text, price bigint, prereq_met boolean, has_prereq boolean, taken boolean, needs text, blocked text)
language plpgsql stable security definer set search_path = '' as $$
#variable_conflict use_column
declare v_uid uuid := (select auth.uid());
begin
  if v_uid is null or not exists (select 1 from public.students where id = v_uid) then return; end if;
  return query
  select c.id, c.title, c.summary, q.price, q.prereq_met, q.has_prereq,
         exists (select 1 from public.enrolments e join public.enrolment_courses ec on ec.enrolment_id = e.id
                  where e.student_id = v_uid and ec.course_id = c.id
                    and e.activated_at is not null and e.status in ('active', 'completed', 'expired')),
         case when q.prereq_met then null else
           (select string_agg(g.names, ' and ' order by g.group_no)
              from (select p.group_no, string_agg(pc.title, ' or ' order by pc.sort_order) as names
                      from public.course_prerequisites p join public.courses pc on pc.id = p.prerequisite_id
                     where p.course_id = c.id
                       and not exists (select 1 from public.course_prerequisites p2
                                        where p2.course_id = c.id and p2.group_no = p.group_no
                                          and exists (select 1 from public.enrolment_courses ec2 join public.enrolments e2 on e2.id = ec2.enrolment_id
                                                       where e2.student_id = v_uid and ec2.course_id = p2.prerequisite_id and ec2.status = 'completed'))
                     group by p.group_no) g)
         end,
         case when private.course_in_progress(v_uid, c.id) then 'in_progress' when q.price is null then 'price_not_set' end
    from public.courses c cross join lateral private.solo_quote(v_uid, c.id) q
   where c.is_active
   order by c.sort_order;
end $$;
revoke all on function public.solo_course_offers() from public, anon;
grant execute on function public.solo_course_offers() to authenticated;

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

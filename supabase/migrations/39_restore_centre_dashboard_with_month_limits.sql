-- 39 (applied in the DB as "34_restore_centre_dashboard_with_month_limits")
-- Migration 38 first shipped a centre_dashboard written without the live definition, which dropped the class-days
-- join from 21 and the centre address from 29. This restores the real one (08 + 21 + 29) and adds only the director
-- month limits: no future months, nothing outside the director's window, and balances, refunds and payouts limited
-- to the months they may see.
create or replace function public.centre_dashboard(p_centre_id uuid, p_month date default null) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_admin boolean := private.is_admin();
  v_cur   date := date_trunc('month', (now() at time zone 'Africa/Lagos'))::date;
  v_month date := date_trunc('month', coalesce(p_month, v_cur))::date;
begin
  if not (v_admin or private.has_role_at('centre_director', p_centre_id)) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if not v_admin and (v_month > v_cur or not private.director_sees_month(p_centre_id, v_month)) then v_month := v_cur; end if;
  return jsonb_build_object(
    'centre',  (select jsonb_build_object('id', c.id, 'name', c.name, 'city', c.city, 'address', c.address) from public.centres c where c.id = p_centre_id),
    'month',   v_month,
    'share_pct', (select t.revenue_share_pct from public.centre_terms t where t.centre_id = p_centre_id),
    'students_active', (select count(distinct e.student_id) from public.enrolments e
                         where e.centre_id = p_centre_id and e.status = 'active'),
    'students_total',  (select count(distinct e.student_id) from public.enrolments e
                         where e.centre_id = p_centre_id and e.status in ('active','completed')),
    'earned_month',    coalesce((select sum(l.amount) from public.centre_ledger_entries l
                                  where l.centre_id = p_centre_id and l.period_month = v_month and l.entry_type = 'earning'), 0),
    'refunds_month',   coalesce((select -sum(l.amount) from public.centre_ledger_entries l
                                  where l.centre_id = p_centre_id and l.period_month = v_month and l.entry_type = 'refund_reversal'), 0),
    'earnings_month',  coalesce((select sum(l.amount) from public.centre_ledger_entries l
                                  where l.centre_id = p_centre_id and l.period_month = v_month
                                    and l.entry_type in ('earning','refund_reversal','adjustment')), 0),
    'balance_owed',    coalesce((select sum(l.amount) from public.centre_ledger_entries l
                                  where l.centre_id = p_centre_id and (v_admin or private.director_sees_month(p_centre_id, l.period_month))), 0),
    'paid_out_total',  coalesce((select -sum(l.amount) from public.centre_ledger_entries l
                                  where l.centre_id = p_centre_id and l.entry_type in ('payout','payout_reversal')
                                    and (v_admin or private.director_sees_month(p_centre_id, l.period_month))), 0),
    'by_course', coalesce((select jsonb_agg(x order by x.students desc) from (
        select c.id as course_id, c.title, count(distinct e.student_id) as students
          from public.enrolments e
          join public.enrolment_courses ec on ec.enrolment_id = e.id
          join public.courses c on c.id = ec.course_id
         where e.centre_id = p_centre_id and e.status = 'active'
         group by c.id, c.title) x), '[]'::jsonb),
    'by_weekday', coalesce((select jsonb_agg(x order by x.day_of_week) from (
        select ts.day_of_week, count(distinct e.student_id) as students
          from public.enrolments e
          join public.enrolment_courses ec on ec.enrolment_id = e.id
          join public.centre_class_days ts on ts.centre_id = e.centre_id
         where e.centre_id = p_centre_id and e.status = 'active'
         group by ts.day_of_week) x), '[]'::jsonb),
    'recent_refunds', coalesce((select jsonb_agg(x) from (
        select l.created_at, -l.amount as share_deducted, l.description
          from public.centre_ledger_entries l
         where l.centre_id = p_centre_id and l.entry_type = 'refund_reversal'
           and (v_admin or private.director_sees_month(p_centre_id, l.period_month))
         order by l.created_at desc limit 5) x), '[]'::jsonb),
    'recent_payouts', coalesce((select jsonb_agg(x) from (
        select po.id, po.amount, po.status, po.period_start, po.period_end, po.period_month, po.paid_at
          from public.payouts po
         where po.centre_id = p_centre_id
           and (v_admin or private.director_sees_month(p_centre_id, coalesce(po.period_month, date_trunc('month', po.created_at)::date)))
         order by po.created_at desc limit 6) x), '[]'::jsonb)
  );
end $$;
revoke all on function public.centre_dashboard(uuid, date) from public, anon;
grant execute on function public.centre_dashboard(uuid, date) to authenticated;

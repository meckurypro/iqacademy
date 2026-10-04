-- 26_public_landing_stats.sql
-- One call for all the landing-page figures (aggregates only, safe for signed-out visitors):
--   centres  = active training centres
--   courses  = active courses
--   paid     = distinct students who have a successful (or partly refunded) payment
create or replace function public.public_landing_stats()
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object(
    'centres', (select count(*) from public.centres where is_active),
    'courses', (select count(*) from public.courses where is_active),
    'paid',    (select count(distinct student_id) from public.payments where status in ('succeeded', 'partially_refunded'))
  );
$$;

revoke all on function public.public_landing_stats() from public;
grant execute on function public.public_landing_stats() to anon, authenticated;

-- 25_public_centre_count.sql
-- The signed-out landing page shows how many training centres we run. Visitors have no session, so expose just
-- the number (not the rows) through a security-definer function instead of opening the centres table to anon.
create or replace function public.public_centre_count()
returns integer
language sql
stable
security definer
set search_path = public
as $$ select count(*)::int from public.centres where is_active; $$;

revoke all on function public.public_centre_count() from public;
grant execute on function public.public_centre_count() to anon, authenticated;

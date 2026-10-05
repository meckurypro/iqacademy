-- 44_time_calibration.sql
-- Time audit. The database clock is UTC and every timestamp column is timestamptz, which is correct. Business days and
-- months are Lagos days and months (Africa/Lagos, UTC+1, no daylight saving). A few places still cut "today" or "this
-- month" at UTC midnight, so for one hour a day (00:00-01:00 Lagos) they disagreed with the rest of the app.
--   * public.server_now(): the app asks for the real time, so a phone with a wrong clock can't skew what it shows
--   * admin_overview: "sessions today" and "paid this month" use the Lagos day and month
--   * generate_class_sessions / generate_upcoming_sessions / save_course_outline: "today" is the Lagos date
--   * centre_dashboard: payout month fallback uses the Lagos month
--   * v_centre_financials: payments are bucketed by Lagos month, matching centre_ledger_entries.period_month
--   * expenses.incurred_on defaults to the Lagos date

create or replace function public.server_now() returns timestamptz
language sql stable security definer set search_path = '' as $$ select clock_timestamp() $$;
revoke all on function public.server_now() from public, anon;
grant execute on function public.server_now() to authenticated;

-- rewrite one function in place; fails loudly if the text to change isn't there
create or replace function pg_temp.patch_fn(p_schema text, p_name text, p_old text, p_new text) returns void
language plpgsql as $f$
declare v_oid oid; v_def text;
begin
  select p.oid into strict v_oid from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = p_schema and p.proname = p_name;
  v_def := pg_get_functiondef(v_oid);
  if position(p_old in v_def) = 0 then raise exception 'patch target not found in %.%: %', p_schema, p_name, p_old; end if;
  execute replace(v_def, p_old, p_new);
end $f$;

select pg_temp.patch_fn('public', 'admin_overview', $o$date_trunc('month', p.paid_at) = date_trunc('month', now())$o$,
  $n$date_trunc('month', p.paid_at at time zone 'Africa/Lagos') = date_trunc('month', now() at time zone 'Africa/Lagos')$n$);
select pg_temp.patch_fn('public', 'admin_overview', 'session_date = current_date', $n$session_date = (now() at time zone 'Africa/Lagos')::date$n$);
select pg_temp.patch_fn('public', 'generate_class_sessions', 'current_date + 28', $n$(now() at time zone 'Africa/Lagos')::date + 28$n$);
select pg_temp.patch_fn('public', 'generate_upcoming_sessions', 'current_date + p_weeks_ahead * 7', $n$(now() at time zone 'Africa/Lagos')::date + p_weeks_ahead * 7$n$);
select pg_temp.patch_fn('public', 'save_course_outline', 'end_date >= current_date', $n$end_date >= (now() at time zone 'Africa/Lagos')::date$n$);
select pg_temp.patch_fn('public', 'centre_dashboard', 'date_trunc(''month'', po.created_at)::date', $n$date_trunc('month', po.created_at at time zone 'Africa/Lagos')::date$n$);

do $$
declare v text;
begin
  v := pg_get_viewdef('public.v_centre_financials'::regclass);
  if position($o$date_trunc('month'::text, p.paid_at)$o$ in v) = 0 then raise exception 'v_centre_financials changed; patch needs updating'; end if;
  v := replace(v, $o$date_trunc('month'::text, p.paid_at)$o$, $n$date_trunc('month'::text, (p.paid_at AT TIME ZONE 'Africa/Lagos'::text))$n$);
  execute 'create or replace view public.v_centre_financials with (security_invoker = true) as ' || rtrim(v, '; ' || E'\n');
end $$;

alter table public.expenses alter column incurred_on set default ((now() at time zone 'Africa/Lagos')::date);

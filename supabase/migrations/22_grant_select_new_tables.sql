-- 22: new tables had no privileges for the API role; reads go through RLS, writes go through the RPCs.
grant select on public.centre_class_days, public.course_runs to authenticated;

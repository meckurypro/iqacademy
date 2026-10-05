-- 29: staff dashboards also return the centre's town (and address) so the UI can lead with the location.
do $patch$
declare p record; d text;
begin
  for p in select * from (values
    ('public.instructor_dashboard(uuid,date,date)',
     'select s.id, s.start_at, s.end_at, s.status, c.name as centre_name, co.title as course_title,',
     'select s.id, s.start_at, s.end_at, s.status, c.name as centre_name, c.city as centre_city, c.address as centre_address, co.title as course_title,'),
    ('public.instructor_dashboard(uuid,date,date)',
     'select s.id, s.start_at, s.end_at, c.name as centre_name, c.address as centre_address, co.title as course_title',
     'select s.id, s.start_at, s.end_at, c.name as centre_name, c.city as centre_city, c.address as centre_address, co.title as course_title'),
    ('public.centre_dashboard(uuid,date)',
     'jsonb_build_object(''id'', c.id, ''name'', c.name)',
     'jsonb_build_object(''id'', c.id, ''name'', c.name, ''city'', c.city, ''address'', c.address)'),
    ('public.search_users(text,app_role,integer,integer)',
     '''centre_name'', c.name)',
     '''centre_name'', c.name, ''centre_city'', c.city)')
  ) as t(fn, old, new) loop
    select pg_get_functiondef(p.fn::regprocedure) into d;
    if position(p.old in d) = 0 then raise exception 'patch target missing in %', p.fn; end if;
    execute replace(d, p.old, p.new);
  end loop;
end $patch$;

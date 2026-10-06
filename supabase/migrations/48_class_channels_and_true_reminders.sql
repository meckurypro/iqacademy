-- supabase/migrations/48_class_channels_and_true_reminders.sql   (applied to the live DB as "class_channels_and_true_reminders")
--
-- 1. REMINDERS TELL THE TRUTH. class_clock_tick (45) used to write "Class in 1 hour" for any class that was inside the
--    reminder window, even one created or moved to 4 minutes from now. The title and the check-in sentence are now
--    worked out from the real time left when the reminder is sent, and the notification carries start_at so the app can
--    keep the wording live afterwards.
--
-- 2. EACH CLASS IS A ONE-WAY CHANNEL. Instructor to the students who joined the class with the code or QR (unchanged from
--    33: attendance.method = 'qr_scan'; students marked by hand still do not receive messages).
--      * the instructor can write from the moment check-in opens, during the class, and AFTER it ends, with no cut-off
--      * a cancelled class has no channel
--      * unread is counted per class (class_channel_reads), so opening one class does not mark the others as read
--      * new RPCs: my_class_channels (student), instructor_class_channels (instructor), class_channel_messages (either),
--        mark_channel_read (student)
--
-- Patches use pg_temp.patch_fn (same technique as 44, 46, 47): it rewrites the live definition and fails loudly if the
-- text it expects is not there.

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

-- ---------- 1. Reminders ----------
select pg_temp.patch_fn('private', 'class_clock_tick',
  'v_students uuid[]; v_staff uuid[]; v_roster integer;',
  'v_students uuid[]; v_staff uuid[]; v_roster integer; v_mins integer;');

select pg_temp.patch_fn('private', 'class_clock_tick',
  $o$v_title := case when v_rem = 60 then 'Class in 1 hour' else 'Class in ' || v_rem || ' minutes' end;$o$,
  $n$v_mins  := greatest(1, ceil(extract(epoch from (s.start_at - v_now)) / 60.0)::integer);
      v_title := case when v_mins <= 1 then 'Class starts now'
                      when v_mins >= 58 and v_mins <= 62 then 'Class in 1 hour'
                      when v_mins >= 63 then 'Class in ' || round(v_mins / 60.0)::integer || case when round(v_mins / 60.0) = 1 then ' hour' else ' hours' end
                      else 'Class in ' || v_mins || ' minutes' end;$n$);

select pg_temp.patch_fn('private', 'class_clock_tick',
  $o$|| '. Check-in opens at ' || v_door || '.',$o$,
  $n$|| case when s.start_at - make_interval(mins => v_open) <= v_now then '. Check-in is open now.' else '. Check-in opens at ' || v_door || '.' end,$n$);

select pg_temp.patch_fn('private', 'class_clock_tick',
  $o$|| '. The check-in code is ready from ' || v_door || '.',$o$,
  $n$|| case when s.start_at - make_interval(mins => v_open) <= v_now then '. The check-in code is ready now.' else '. The check-in code is ready from ' || v_door || '.' end,$n$);

select pg_temp.patch_fn('private', 'class_clock_tick',
  $o$jsonb_build_object('session_id', s.id)$o$,
  $n$jsonb_build_object('session_id', s.id, 'start_at', s.start_at)$n$);

-- Reminders already sent: give them their class's start time so the app can show the real countdown.
update public.notifications n
   set data = n.data || jsonb_build_object('start_at', cs.start_at)
  from public.class_sessions cs
 where n.type in ('class_reminder', 'class_reminder_staff')
   and n.data ? 'session_id' and not (n.data ? 'start_at')
   and cs.id::text = n.data ->> 'session_id';

-- ---------- 2. Writing to a class channel ----------
-- Before: only while the class was in progress. Now: from the moment check-in opens, and for ever after the class.
select pg_temp.patch_fn('public', 'send_class_message',
  $o$if v_s.status <> 'in_progress' then raise exception 'session_not_active'; end if;$o$,
  $n$if v_s.status = 'cancelled' or not (v_s.status in ('in_progress', 'completed') or v_s.checkin_opened_at is not null) then
    raise exception 'session_not_active';
  end if;$n$);

-- ---------- 3. Per-class read marks ----------
create table if not exists public.class_channel_reads (
  user_id      uuid not null references public.profiles (id) on delete cascade,
  session_id   uuid not null references public.class_sessions (id) on delete cascade,
  last_read_at timestamptz not null default now(),
  primary key (user_id, session_id)
);
alter table public.class_channel_reads enable row level security;   -- no policies: only the functions below touch it
revoke all on public.class_channel_reads from anon, authenticated;

create or replace function public.mark_channel_read(p_session_id uuid) returns void
language sql security definer set search_path = '' as $$
  insert into public.class_channel_reads (user_id, session_id, last_read_at)
  values ((select auth.uid()), p_session_id, now())
  on conflict (user_id, session_id) do update set last_read_at = excluded.last_read_at
$$;
revoke all on function public.mark_channel_read(uuid) from public, anon;
grant execute on function public.mark_channel_read(uuid) to authenticated;

-- The tab badge: unread across every channel the student belongs to. "Read" is the later of the old all-messages mark
-- and that class's own mark, so nothing that was already read comes back as unread.
create or replace function public.unread_message_count() returns integer
language sql stable security definer set search_path = '' as $$
  select count(*)::int from public.class_messages m
   where exists (select 1 from public.attendance a where a.session_id = m.session_id and a.student_id = (select auth.uid())
                    and a.status = 'present' and a.method = 'qr_scan')
     and m.created_at > greatest(
           coalesce((select r.last_read_at from public.message_reads r where r.user_id = (select auth.uid())), '-infinity'::timestamptz),
           coalesce((select c.last_read_at from public.class_channel_reads c where c.user_id = (select auth.uid()) and c.session_id = m.session_id), '-infinity'::timestamptz))
$$;

-- ---------- 4. Channel lists ----------
-- A student's channels: every class they joined, newest activity first. A class with no messages yet is still listed.
create or replace function public.my_class_channels()
returns table (session_id uuid, course_title text, lesson_title text, session_date date, start_at timestamptz, end_at timestamptz,
               status text, centre_name text, instructor_first_name text, message_count integer, unread integer,
               last_message_at timestamptz, last_body text, last_has_media boolean)
language sql stable security definer set search_path = '' as $$
  select s.id, co.title, l.title, s.session_date, s.start_at, s.end_at, s.status::text, ce.name,
         nullif(split_part(trim(pr.full_name), ' ', 1), ''),
         (select count(*)::int from public.class_messages m where m.session_id = s.id),
         (select count(*)::int from public.class_messages m
           where m.session_id = s.id
             and m.created_at > greatest(
                   coalesce((select r.last_read_at from public.message_reads r where r.user_id = (select auth.uid())), '-infinity'::timestamptz),
                   coalesce((select c.last_read_at from public.class_channel_reads c where c.user_id = (select auth.uid()) and c.session_id = s.id), '-infinity'::timestamptz))),
         lm.created_at, lm.body, coalesce(lm.media_path is not null, false)
    from public.class_sessions s
    join public.courses co on co.id = s.course_id
    join public.centres ce on ce.id = s.centre_id
    left join public.course_lessons l on l.id = s.lesson_id
    left join public.profiles pr on pr.id = s.instructor_id
    left join lateral (select m.created_at, m.body, m.media_path from public.class_messages m where m.session_id = s.id order by m.created_at desc limit 1) lm on true
   where s.status <> 'cancelled'
     and exists (select 1 from public.attendance a where a.session_id = s.id and a.student_id = (select auth.uid())
                    and a.status = 'present' and a.method = 'qr_scan')
   order by coalesce(lm.created_at, s.start_at) desc
   limit 60
$$;
revoke all on function public.my_class_channels() from public, anon;
grant execute on function public.my_class_channels() to authenticated;

-- An instructor's channels: classes they teach whose check-in has opened (or that have started or finished).
create or replace function public.instructor_class_channels()
returns table (session_id uuid, course_title text, lesson_title text, session_date date, start_at timestamptz, end_at timestamptz,
               status text, centre_name text, joined integer, message_count integer,
               last_message_at timestamptz, last_body text, last_has_media boolean)
language sql stable security definer set search_path = '' as $$
  select s.id, co.title, l.title, s.session_date, s.start_at, s.end_at, s.status::text, ce.name,
         (select count(*)::int from public.attendance a where a.session_id = s.id and a.status = 'present' and a.method = 'qr_scan'),
         (select count(*)::int from public.class_messages m where m.session_id = s.id),
         lm.created_at, lm.body, coalesce(lm.media_path is not null, false)
    from public.class_sessions s
    join public.courses co on co.id = s.course_id
    join public.centres ce on ce.id = s.centre_id
    left join public.course_lessons l on l.id = s.lesson_id
    left join lateral (select m.created_at, m.body, m.media_path from public.class_messages m where m.session_id = s.id order by m.created_at desc limit 1) lm on true
   where s.instructor_id = (select auth.uid()) and s.status <> 'cancelled'
     and (s.status in ('in_progress', 'completed') or s.checkin_opened_at is not null)
   order by (s.status = 'in_progress') desc, coalesce(lm.created_at, s.start_at) desc
   limit 60
$$;
revoke all on function public.instructor_class_channels() from public, anon;
grant execute on function public.instructor_class_channels() to authenticated;

-- One channel's messages, for the instructor of that class, an admin, or a student who joined it (same rule as the
-- class_messages policy). Security definer so the join to the class does not depend on what a student may see of
-- class_sessions; the access test below is the gate.
create or replace function public.class_channel_messages(p_session_id uuid, p_limit integer default 50, p_before timestamptz default null)
returns table (id uuid, session_id uuid, sender_label text, body text, media_path text, media_name text, media_mime text,
               media_size integer, created_at timestamptz, course_title text, session_date date)
language plpgsql stable security definer set search_path = '' as $$
#variable_conflict use_column
begin
  return query
  select m.id, m.session_id, m.sender_label, m.body, m.media_path, m.media_name, m.media_mime, m.media_size, m.created_at, c.title, s.session_date
    from public.class_messages m
    join public.class_sessions s on s.id = m.session_id
    join public.courses c on c.id = s.course_id
   where m.session_id = p_session_id and (p_before is null or m.created_at < p_before)
     and (private.is_admin() or s.instructor_id = (select auth.uid())
          or exists (select 1 from public.attendance a where a.session_id = m.session_id and a.student_id = (select auth.uid())
                        and a.status = 'present' and a.method = 'qr_scan'))
   order by m.created_at desc
   limit least(greatest(coalesce(p_limit, 50), 1), 100);
end $$;
revoke all on function public.class_channel_messages(uuid, integer, timestamptz) from public, anon;
grant execute on function public.class_channel_messages(uuid, integer, timestamptz) to authenticated;

drop function if exists pg_temp.patch_fn(text, text, text, text);

-- 33_class_messages_active_and_connected.sql
-- Class messages, tightened:
--   * an instructor can only send while the class is in progress (it starts when they show the class code)
--   * only students who joined with the class code or QR (attendance.method = 'qr_scan') receive messages
--   * the instructor's Messages tab: the class they have running now, and everything they have sent

create or replace function public.send_class_message(
  p_session_id uuid, p_body text default null,
  p_media_path text default null, p_media_name text default null, p_media_mime text default null, p_media_size integer default null)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_s public.class_sessions%rowtype; v_uid uuid := (select auth.uid()); v_body text := nullif(trim(coalesce(p_body, '')), '');
        v_label text := 'IQ Academy'; v_first text; v_id uuid;
begin
  select * into v_s from public.class_sessions where id = p_session_id;
  if not found then raise exception 'session_not_found'; end if;
  if not (private.is_admin() or v_s.instructor_id = v_uid) then raise exception 'forbidden' using errcode = '42501'; end if;
  if v_s.status <> 'in_progress' then raise exception 'session_not_active'; end if;
  if v_body is null and p_media_path is null then raise exception 'message_empty'; end if;
  if char_length(coalesce(v_body, '')) > 4000 then raise exception 'message_too_long'; end if;
  if p_media_path is not null and (
       p_media_path not like p_session_id::text || '/%'
       or p_media_mime is null or p_media_mime not in ('image/jpeg', 'image/png', 'image/webp', 'image/gif')
       or coalesce(p_media_size, 0) > 10485760) then raise exception 'invalid_media'; end if;
  if not private.is_admin() then
    select nullif(split_part(trim(full_name), ' ', 1), '') into v_first from public.profiles where id = v_uid;
    v_label := 'Instructor ' || coalesce(v_first, '');
  end if;
  insert into public.class_messages (session_id, sender_id, sender_label, body, media_path, media_name, media_mime, media_size)
  values (p_session_id, v_uid, trim(v_label), v_body, p_media_path, left(p_media_name, 200), p_media_mime, p_media_size)
  returning id into v_id;
  return v_id;
end $$;

-- Who can read a message: admins, the class's instructor, and students who joined with the code / QR.
drop policy if exists class_messages_select on public.class_messages;
create policy class_messages_select on public.class_messages for select to authenticated using (
  private.is_admin() or private.instructs_session(session_id)
  or exists (select 1 from public.attendance a
              where a.session_id = class_messages.session_id and a.student_id = (select auth.uid())
                and a.status = 'present' and a.method = 'qr_scan')
);

drop policy if exists class_messages_read on storage.objects;
create policy class_messages_read on storage.objects for select to authenticated using (
  bucket_id = 'class-messages' and (
    private.is_admin() or private.instructs_session(private.try_uuid((storage.foldername(name))[1]))
    or exists (select 1 from public.attendance a
                where a.session_id = private.try_uuid((storage.foldername(name))[1])
                  and a.student_id = (select auth.uid()) and a.status = 'present' and a.method = 'qr_scan')));

create or replace function public.class_message_feed(p_limit integer default 50, p_before timestamptz default null)
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
   where exists (select 1 from public.attendance a where a.session_id = m.session_id and a.student_id = (select auth.uid())
                    and a.status = 'present' and a.method = 'qr_scan')
     and (p_before is null or m.created_at < p_before)
   order by m.created_at desc
   limit least(greatest(coalesce(p_limit, 50), 1), 100);
end $$;

create or replace function public.unread_message_count()
returns integer language sql stable security definer set search_path = '' as $$
  select count(*)::int from public.class_messages m
   where m.created_at > coalesce((select r.last_read_at from public.message_reads r where r.user_id = (select auth.uid())), '-infinity'::timestamptz)
     and exists (select 1 from public.attendance a where a.session_id = m.session_id and a.student_id = (select auth.uid())
                    and a.status = 'present' and a.method = 'qr_scan')
$$;

-- Instructor: the classes they have running right now (status in_progress).
create or replace function public.instructor_active_classes()
returns table (id uuid, course_title text, centre_name text, start_at timestamptz, end_at timestamptz, joined integer)
language sql stable security definer set search_path = '' as $$
  select s.id, c.title, ce.name, s.start_at, s.end_at,
         (select count(*)::int from public.attendance a where a.session_id = s.id and a.status = 'present' and a.method = 'qr_scan')
    from public.class_sessions s
    join public.courses c on c.id = s.course_id
    join public.centres ce on ce.id = s.centre_id
   where s.instructor_id = (select auth.uid()) and s.status = 'in_progress'
   order by s.start_at
$$;

-- Instructor: every message sent to their classes, newest first.
create or replace function public.instructor_message_feed(p_limit integer default 50, p_before timestamptz default null)
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
   where s.instructor_id = (select auth.uid())
     and (p_before is null or m.created_at < p_before)
   order by m.created_at desc
   limit least(greatest(coalesce(p_limit, 50), 1), 100);
end $$;

revoke all on function public.instructor_active_classes() from public, anon;
revoke all on function public.instructor_message_feed(integer, timestamptz) from public, anon;
grant execute on function public.instructor_active_classes() to authenticated;
grant execute on function public.instructor_message_feed(integer, timestamptz) to authenticated;

-- 32_sender_labels_and_class_messages.sql
-- 1) Notifications show who they are from: "IQ Academy" (admins and the system) or "Instructor <first name>".
-- 2) Class messages: an instructor sends text and/or an image to the students who were present in a class.
--    Students only receive. Nobody can edit or delete except an admin. Media sits in a private bucket and is only
--    downloaded when the person taps it (signed URL, minted on tap).

-- ---------- 1. Notification sender ----------
alter table public.notifications add column if not exists sender_label text;

create or replace function private.set_notification_sender()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_uid uuid := (select auth.uid()); v_first text;
begin
  if new.sender_label is not null then return new; end if;
  new.sender_label := 'IQ Academy';
  if v_uid is not null and v_uid <> new.user_id and not private.is_admin() and private.is_instructor() then
    select nullif(split_part(trim(full_name), ' ', 1), '') into v_first from public.profiles where id = v_uid;
    if v_first is not null then new.sender_label := 'Instructor ' || v_first; end if;
  end if;
  return new;
end $$;

drop trigger if exists notifications_sender on public.notifications;
create trigger notifications_sender before insert on public.notifications
  for each row execute function private.set_notification_sender();

-- ---------- 2. Class messages ----------
create table if not exists public.class_messages (
  id           uuid primary key default gen_random_uuid(),
  session_id   uuid not null references public.class_sessions(id) on delete cascade,
  sender_id    uuid not null references public.profiles(id),
  sender_label text not null,
  body         text,
  media_path   text,
  media_name   text,
  media_mime   text,
  media_size   integer,
  created_at   timestamptz not null default now(),
  constraint class_messages_has_content check (coalesce(char_length(trim(body)), 0) > 0 or media_path is not null),
  constraint class_messages_body_len check (body is null or char_length(body) <= 4000)
);
create index if not exists class_messages_session_idx on public.class_messages (session_id, created_at);
create index if not exists class_messages_created_idx on public.class_messages (created_at desc);

alter table public.class_messages enable row level security;
-- Read: admins, the instructor of that class, and students who were marked present in it. No insert/update policy:
-- writes go through send_class_message(). Delete: admins only.
drop policy if exists class_messages_select on public.class_messages;
create policy class_messages_select on public.class_messages for select to authenticated using (
  private.is_admin() or private.instructs_session(session_id)
  or exists (select 1 from public.attendance a
              where a.session_id = class_messages.session_id and a.student_id = (select auth.uid()) and a.status = 'present')
);
drop policy if exists class_messages_admin_delete on public.class_messages;
create policy class_messages_admin_delete on public.class_messages for delete to authenticated using (private.is_admin());

-- Which messages a person has already seen (drives the unread badge on the Messages tab).
create table if not exists public.message_reads (
  user_id uuid primary key references public.profiles(id) on delete cascade,
  last_read_at timestamptz not null default now()
);
alter table public.message_reads enable row level security;   -- no policies: only the functions below touch it

do $$ begin
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'class_messages') then
    alter publication supabase_realtime add table public.class_messages;
  end if;
end $$;

-- Instructor (of that class) or admin sends a message. Media is uploaded first to class-messages/<session_id>/...
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
  if v_s.status = 'cancelled' then raise exception 'session_cancelled'; end if;
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

-- A student's chat: messages from classes they were present in, newest first.
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
   where exists (select 1 from public.attendance a where a.session_id = m.session_id and a.student_id = (select auth.uid()) and a.status = 'present')
     and (p_before is null or m.created_at < p_before)
   order by m.created_at desc
   limit least(greatest(coalesce(p_limit, 50), 1), 100);
end $$;

create or replace function public.unread_message_count()
returns integer language sql stable security definer set search_path = '' as $$
  select count(*)::int from public.class_messages m
   where m.created_at > coalesce((select r.last_read_at from public.message_reads r where r.user_id = (select auth.uid())), '-infinity'::timestamptz)
     and exists (select 1 from public.attendance a where a.session_id = m.session_id and a.student_id = (select auth.uid()) and a.status = 'present')
$$;

create or replace function public.mark_messages_read()
returns void language sql security definer set search_path = '' as $$
  insert into public.message_reads (user_id, last_read_at) values ((select auth.uid()), now())
  on conflict (user_id) do update set last_read_at = excluded.last_read_at
$$;

-- Admin: everything sent to classes, and the only way to remove a message.
create or replace function public.admin_class_messages(p_limit integer default 50, p_before timestamptz default null)
returns table (id uuid, session_id uuid, sender_label text, body text, media_path text, media_name text, media_mime text,
               media_size integer, created_at timestamptz, course_title text, centre_name text, session_date date)
language plpgsql stable security definer set search_path = '' as $$
#variable_conflict use_column
begin
  if not private.is_admin() then raise exception 'forbidden' using errcode = '42501'; end if;
  return query
  select m.id, m.session_id, m.sender_label, m.body, m.media_path, m.media_name, m.media_mime, m.media_size, m.created_at, c.title, ce.name, s.session_date
    from public.class_messages m
    join public.class_sessions s on s.id = m.session_id
    join public.courses c on c.id = s.course_id
    join public.centres ce on ce.id = s.centre_id
   where p_before is null or m.created_at < p_before
   order by m.created_at desc
   limit least(greatest(coalesce(p_limit, 50), 1), 100);
end $$;

-- Deletes the row and returns the media path so the app can remove the file from storage.
create or replace function public.admin_delete_class_message(p_id uuid)
returns text language plpgsql security definer set search_path = '' as $$
declare v_path text;
begin
  if not private.is_admin() then raise exception 'forbidden' using errcode = '42501'; end if;
  delete from public.class_messages where id = p_id returning media_path into v_path;
  if not found then raise exception 'message_not_found'; end if;
  return v_path;
end $$;

revoke all on function public.send_class_message(uuid, text, text, text, text, integer) from public, anon;
revoke all on function public.class_message_feed(integer, timestamptz) from public, anon;
revoke all on function public.unread_message_count() from public, anon;
revoke all on function public.mark_messages_read() from public, anon;
revoke all on function public.admin_class_messages(integer, timestamptz) from public, anon;
revoke all on function public.admin_delete_class_message(uuid) from public, anon;
grant execute on function public.send_class_message(uuid, text, text, text, text, integer) to authenticated;
grant execute on function public.class_message_feed(integer, timestamptz) to authenticated;
grant execute on function public.unread_message_count() to authenticated;
grant execute on function public.mark_messages_read() to authenticated;
grant execute on function public.admin_class_messages(integer, timestamptz) to authenticated;
grant execute on function public.admin_delete_class_message(uuid) to authenticated;

-- ---------- 3. Media storage (private) ----------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('class-messages', 'class-messages', false, 10485760, array['image/jpeg', 'image/png', 'image/webp', 'image/gif'])
on conflict (id) do nothing;

drop policy if exists class_messages_upload on storage.objects;
create policy class_messages_upload on storage.objects for insert to authenticated with check (
  bucket_id = 'class-messages' and (private.is_admin() or private.instructs_session(private.try_uuid((storage.foldername(name))[1]))));

drop policy if exists class_messages_read on storage.objects;
create policy class_messages_read on storage.objects for select to authenticated using (
  bucket_id = 'class-messages' and (
    private.is_admin() or private.instructs_session(private.try_uuid((storage.foldername(name))[1]))
    or exists (select 1 from public.attendance a
                where a.session_id = private.try_uuid((storage.foldername(name))[1])
                  and a.student_id = (select auth.uid()) and a.status = 'present')));

drop policy if exists class_messages_admin_remove on storage.objects;
create policy class_messages_admin_remove on storage.objects for delete to authenticated using (
  bucket_id = 'class-messages' and private.is_admin());

-- ---------- 4. Grants ----------
-- Row-level security decides which rows; this lets signed-in users reach the table at all (reads only: writes go through functions).
grant select on public.class_messages to authenticated;
revoke all on public.class_messages from anon;
revoke all on public.message_reads from anon, authenticated;

-- supabase/migrations/50_end_reason_cohort_lock_reviews.sql   (applied to the live DB as "end_reason_cohort_lock_reviews")
--
-- 1. ENDING A CLASS THAT IS RUNNING NEEDS A REASON. An instructor (or admin) ends an in-progress class with
--    end_class_early(session, reason). The class becomes "completed" (not "cancelled"), so its channel, attendance and
--    reviews stay. cancel_session() on a class that is in progress is routed here, so the rule cannot be skipped.
-- 2. CHANNELS CLOSE FOR STUDENTS WHEN THE COHORT ENDS. A student keeps seeing the channel in their list, but its messages
--    (and files) are no longer readable once the class's course run has ended (custom classes: the student's registration
--    end date). Instructors and admins are never locked out.
-- 3. CLASS REVIEWS. A student who attended a class that has ended can leave one review: stars, honest comment, and an
--    optional report about the instructor. Admins read them, feature up to 10 on the landing page, and can un-feature.

-- ---------- 1. Ending a class with a reason ----------
alter table public.class_sessions add column if not exists ended_early_at timestamptz;
alter table public.class_sessions add column if not exists end_reason text;

create or replace function public.end_class_early(p_session_id uuid, p_reason text) returns void
language plpgsql security definer set search_path = '' as $$
declare v_s public.class_sessions%rowtype; v_uid uuid := (select auth.uid()); v_reason text := nullif(trim(coalesce(p_reason, '')), '');
begin
  select * into v_s from public.class_sessions where id = p_session_id for update;
  if not found then raise exception 'session_not_found'; end if;
  if not (private.is_admin() or v_s.instructor_id = v_uid) then raise exception 'forbidden' using errcode = '42501'; end if;
  if v_s.status <> 'in_progress' then raise exception 'not_in_progress'; end if;
  if v_reason is null or char_length(v_reason) < 5 or lower(v_reason) = 'cancelled by instructor' then raise exception 'reason_required'; end if;
  if char_length(v_reason) > 300 then raise exception 'reason_too_long'; end if;

  update public.class_sessions
     set status = 'completed', completed_at = now(), completed_by = v_uid, auto_closed = false,
         end_at = least(end_at, now()), ended_early_at = now(), end_reason = v_reason
   where id = p_session_id;
  delete from public.session_checkin_tokens where session_id = p_session_id;
  perform private.log_absentees(p_session_id);
  perform private.refresh_session_counts(p_session_id);
end $$;
revoke all on function public.end_class_early(uuid, text) from public, anon;
grant execute on function public.end_class_early(uuid, text) to authenticated;

do $$
declare v_def text;
begin
  select pg_get_functiondef(p.oid) into strict v_def from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'cancel_session';
  if position($o$  if v_s.status = 'completed' then raise exception 'already_completed'; end if;$o$ in v_def) = 0 then raise exception 'cancel_session patch target not found'; end if;
  execute replace(v_def, $o$  if v_s.status = 'completed' then raise exception 'already_completed'; end if;$o$,
$n$  if v_s.status = 'completed' then raise exception 'already_completed'; end if;
  -- a class that is running is ended (kept, with its chat), and that always needs a reason
  if v_s.status = 'in_progress' then perform public.end_class_early(p_session_id, p_reason); return; end if;$n$);
end $$;

-- ---------- 2. Cohort lock ----------
-- The last day a student may use a class's channel. A course run has an end date. A class outside any run (a custom class)
-- follows the student's own registration. No date found means no lock.
create or replace function private.channel_end_date(p_session_id uuid, p_student uuid) returns date
language sql stable security definer set search_path = '' as $$
  select coalesce(
    (select r.end_date from public.class_sessions s join public.course_runs r on r.id = s.run_id where s.id = p_session_id),
    (select e.ends_on from public.attendance a join public.enrolments e on e.id = a.enrolment_id
      where a.session_id = p_session_id and a.student_id = p_student))
$$;
revoke all on function private.channel_end_date(uuid, uuid) from public, anon, authenticated;

-- True when the signed-in person is a student whose cohort has ended. Admins and the class's instructor are never locked.
create or replace function private.channel_locked(p_session_id uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select not private.is_admin() and not private.instructs_session(p_session_id)
     and coalesce(private.channel_end_date(p_session_id, (select auth.uid())) < (now() at time zone 'Africa/Lagos')::date, false)
$$;
revoke all on function private.channel_locked(uuid) from public, anon;
grant execute on function private.channel_locked(uuid) to authenticated;

-- The student branch of reading messages and files now also needs an open channel.
drop policy if exists class_messages_select on public.class_messages;
create policy class_messages_select on public.class_messages for select to authenticated using (
  private.is_admin() or private.instructs_session(session_id)
  or (exists (select 1 from public.attendance a where a.session_id = class_messages.session_id and a.student_id = (select auth.uid())
                and a.status = 'present' and a.method = 'qr_scan') and not private.channel_locked(class_messages.session_id)));

drop policy if exists class_messages_read on storage.objects;
create policy class_messages_read on storage.objects for select to authenticated using (
  bucket_id = 'class-messages' and (private.is_admin() or private.instructs_session(private.try_uuid((storage.foldername(name))[1]))
    or (exists (select 1 from public.attendance a where a.session_id = private.try_uuid((storage.foldername(objects.name))[1])
                  and a.student_id = (select auth.uid()) and a.status = 'present' and a.method = 'qr_scan')
        and not private.channel_locked(private.try_uuid((storage.foldername(objects.name))[1])))));

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
          or (exists (select 1 from public.attendance a where a.session_id = m.session_id and a.student_id = (select auth.uid())
                        and a.status = 'present' and a.method = 'qr_scan') and not private.channel_locked(m.session_id)))
   order by m.created_at desc
   limit least(greatest(coalesce(p_limit, 50), 1), 100);
end $$;

-- A locked channel adds nothing to the unread badge.
create or replace function public.unread_message_count() returns integer
language sql stable security definer set search_path = '' as $$
  select count(*)::int from public.class_messages m
   where exists (select 1 from public.attendance a where a.session_id = m.session_id and a.student_id = (select auth.uid())
                    and a.status = 'present' and a.method = 'qr_scan')
     and not private.channel_locked(m.session_id)
     and m.created_at > greatest(
           coalesce((select r.last_read_at from public.message_reads r where r.user_id = (select auth.uid())), '-infinity'::timestamptz),
           coalesce((select c.last_read_at from public.class_channel_reads c where c.user_id = (select auth.uid()) and c.session_id = m.session_id), '-infinity'::timestamptz))
$$;

-- ---------- 3. Reviews ----------
create table if not exists public.class_reviews (
  id             uuid primary key default gen_random_uuid(),
  session_id     uuid not null references public.class_sessions (id) on delete cascade,
  student_id     uuid not null references public.profiles (id) on delete cascade,
  instructor_id  uuid references public.profiles (id) on delete set null,
  course_id      uuid references public.courses (id) on delete set null,
  centre_id      uuid references public.centres (id) on delete set null,
  rating         smallint not null check (rating between 1 and 5),
  comment        text check (comment is null or char_length(comment) <= 2000),
  report_instructor boolean not null default false,
  report_reason  text check (report_reason is null or char_length(report_reason) <= 1000),
  featured       boolean not null default false,
  featured_at    timestamptz,
  created_at     timestamptz not null default now(),
  unique (session_id, student_id),
  check (not report_instructor or char_length(coalesce(report_reason, '')) >= 10)
);
create index if not exists class_reviews_featured_idx on public.class_reviews (featured_at desc) where featured;
create index if not exists class_reviews_created_idx on public.class_reviews (created_at desc);
alter table public.class_reviews enable row level security;
revoke all on public.class_reviews from anon, authenticated;
grant select on public.class_reviews to authenticated;
-- Students see only their own; admins see all. Writes happen only through the functions below.
create policy class_reviews_select on public.class_reviews for select to authenticated using (student_id = (select auth.uid()) or private.is_admin());


-- The student's list: same as before plus `locked` (cohort over), `reviewed` and the rating they gave. A locked channel shows no preview.
drop function if exists public.my_class_channels();
create function public.my_class_channels()
returns table (session_id uuid, course_title text, lesson_title text, session_date date, start_at timestamptz, end_at timestamptz,
               status text, centre_name text, instructor_first_name text, message_count integer, unread integer,
               last_message_at timestamptz, last_body text, last_has_media boolean, locked boolean, my_rating integer)
language sql stable security definer set search_path = '' as $$
  select s.id, co.title, l.title, s.session_date, s.start_at, s.end_at, s.status::text, ce.name,
         nullif(split_part(trim(pr.full_name), ' ', 1), ''),
         (select count(*)::int from public.class_messages m where m.session_id = s.id),
         case when lk.locked then 0 else (select count(*)::int from public.class_messages m
           where m.session_id = s.id
             and m.created_at > greatest(
                   coalesce((select r.last_read_at from public.message_reads r where r.user_id = (select auth.uid())), '-infinity'::timestamptz),
                   coalesce((select c.last_read_at from public.class_channel_reads c where c.user_id = (select auth.uid()) and c.session_id = s.id), '-infinity'::timestamptz))) end,
         case when lk.locked then null else lm.created_at end, case when lk.locked then null else lm.body end,
         case when lk.locked then false else coalesce(lm.media_path is not null, false) end,
         lk.locked,
         (select rv.rating::int from public.class_reviews rv where rv.session_id = s.id and rv.student_id = (select auth.uid()))
    from public.class_sessions s
    join public.courses co on co.id = s.course_id
    join public.centres ce on ce.id = s.centre_id
    left join public.course_lessons l on l.id = s.lesson_id
    left join public.profiles pr on pr.id = s.instructor_id
    left join lateral (select m.created_at, m.body, m.media_path from public.class_messages m where m.session_id = s.id order by m.created_at desc limit 1) lm on true
    cross join lateral (select coalesce(private.channel_end_date(s.id, (select auth.uid())) < (now() at time zone 'Africa/Lagos')::date, false) as locked) lk
   where s.status <> 'cancelled'
     and exists (select 1 from public.attendance a where a.session_id = s.id and a.student_id = (select auth.uid())
                    and a.status = 'present' and a.method = 'qr_scan')
   order by coalesce(case when lk.locked then null else lm.created_at end, s.start_at) desc
   limit 60
$$;
revoke all on function public.my_class_channels() from public, anon;
grant execute on function public.my_class_channels() to authenticated;

-- ---------- 3. Reviews (functions) ----------
create or replace function public.submit_class_review(p_session_id uuid, p_rating integer, p_comment text default null,
                                                       p_report boolean default false, p_report_reason text default null) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_s public.class_sessions%rowtype; v_uid uuid := (select auth.uid()); v_id uuid;
        v_comment text := nullif(trim(coalesce(p_comment, '')), ''); v_reason text := nullif(trim(coalesce(p_report_reason, '')), '');
        v_name text; v_admins uuid[];
begin
  if v_uid is null then raise exception 'forbidden' using errcode = '42501'; end if;
  select * into v_s from public.class_sessions where id = p_session_id;
  if not found then raise exception 'session_not_found'; end if;
  if v_s.status <> 'completed' then raise exception 'review_not_open'; end if;
  if not exists (select 1 from public.attendance a where a.session_id = p_session_id and a.student_id = v_uid and a.status = 'present') then
    raise exception 'review_not_attended';
  end if;
  if p_rating is null or p_rating < 1 or p_rating > 5 then raise exception 'invalid_rating'; end if;
  if char_length(coalesce(v_comment, '')) > 2000 then raise exception 'review_too_long'; end if;
  if coalesce(p_report, false) then
    if v_s.instructor_id is null then raise exception 'no_instructor_to_report'; end if;
    if char_length(coalesce(v_reason, '')) < 10 then raise exception 'report_reason_required'; end if;
    if char_length(v_reason) > 1000 then raise exception 'review_too_long'; end if;
  else v_reason := null; end if;
  if exists (select 1 from public.class_reviews where session_id = p_session_id and student_id = v_uid) then raise exception 'already_reviewed'; end if;

  insert into public.class_reviews (session_id, student_id, instructor_id, course_id, centre_id, rating, comment, report_instructor, report_reason)
  values (p_session_id, v_uid, v_s.instructor_id, v_s.course_id, v_s.centre_id, p_rating, v_comment, coalesce(p_report, false), v_reason)
  returning id into v_id;

  if coalesce(p_report, false) then
    select nullif(trim(full_name), '') into v_name from public.profiles where id = v_uid;
    select array_agg(distinct r.user_id) into v_admins from public.user_roles r where r.is_active and r.role in ('admin', 'super_admin');
    perform private.notify(v_admins, 'instructor_reported', 'Instructor reported in a class review',
      coalesce(v_name, 'A student') || ' reported an instructor. Open Class reviews to read it.', jsonb_build_object('session_id', p_session_id, 'review_id', v_id));
  end if;
  return v_id;
end $$;
revoke all on function public.submit_class_review(uuid, integer, text, boolean, text) from public, anon;
grant execute on function public.submit_class_review(uuid, integer, text, boolean, text) to authenticated;

-- The most recent class (last 30 days) the student attended that has ended and that they have not reviewed yet.
create or replace function public.my_pending_review()
returns table (session_id uuid, course_title text, lesson_title text, session_date date, instructor_first_name text)
language sql stable security definer set search_path = '' as $$
  select s.id, co.title, l.title, s.session_date, nullif(split_part(trim(pr.full_name), ' ', 1), '')
    from public.class_sessions s
    join public.courses co on co.id = s.course_id
    left join public.course_lessons l on l.id = s.lesson_id
    left join public.profiles pr on pr.id = s.instructor_id
   where s.status = 'completed' and s.end_at > now() - interval '30 days'
     and exists (select 1 from public.attendance a where a.session_id = s.id and a.student_id = (select auth.uid()) and a.status = 'present')
     and not exists (select 1 from public.class_reviews r where r.session_id = s.id and r.student_id = (select auth.uid()))
   order by s.end_at desc limit 1
$$;
revoke all on function public.my_pending_review() from public, anon;
grant execute on function public.my_pending_review() to authenticated;

-- Admin: every review with who wrote it and about what.
create or replace function public.admin_class_reviews()
returns table (id uuid, session_id uuid, rating integer, comment text, report_instructor boolean, report_reason text, featured boolean, created_at timestamptz,
               student_name text, student_avatar text, instructor_name text, course_title text, centre_name text, session_date date)
language plpgsql stable security definer set search_path = '' as $$
begin
  if not private.is_admin() then raise exception 'forbidden' using errcode = '42501'; end if;
  return query
  select r.id, r.session_id, r.rating::int, r.comment, r.report_instructor, r.report_reason, r.featured, r.created_at,
         coalesce(nullif(trim(sp.full_name), ''), 'Student'), sp.avatar_url, nullif(trim(ip.full_name), ''), co.title, ce.name, s.session_date
    from public.class_reviews r
    left join public.profiles sp on sp.id = r.student_id
    left join public.profiles ip on ip.id = r.instructor_id
    left join public.courses co on co.id = r.course_id
    left join public.centres ce on ce.id = r.centre_id
    left join public.class_sessions s on s.id = r.session_id
   order by r.created_at desc limit 500;
end $$;
revoke all on function public.admin_class_reviews() from public, anon;
grant execute on function public.admin_class_reviews() to authenticated;

-- Admin: show or hide a review on the landing page. Up to 10 at a time. A review that reports an instructor, or has no
-- written comment, is never shown publicly.
create or replace function public.set_review_featured(p_id uuid, p_featured boolean) returns void
language plpgsql security definer set search_path = '' as $$
declare v_r public.class_reviews%rowtype;
begin
  if not private.is_admin() then raise exception 'forbidden' using errcode = '42501'; end if;
  perform pg_advisory_xact_lock(hashtext('iqa_featured_reviews'));
  select * into v_r from public.class_reviews where id = p_id for update;
  if not found then raise exception 'review_not_found'; end if;
  if coalesce(p_featured, false) then
    if v_r.featured then return; end if;
    if v_r.report_instructor then raise exception 'review_reported'; end if;
    if char_length(coalesce(v_r.comment, '')) < 10 then raise exception 'review_needs_text'; end if;
    if (select count(*) from public.class_reviews where featured) >= 10 then raise exception 'featured_limit'; end if;
    update public.class_reviews set featured = true, featured_at = now() where id = p_id;
  else
    update public.class_reviews set featured = false, featured_at = null where id = p_id;
  end if;
end $$;
revoke all on function public.set_review_featured(uuid, boolean) from public, anon;
grant execute on function public.set_review_featured(uuid, boolean) to authenticated;

-- Landing page: the featured reviews. Name, photo, stars, words and date only.
create or replace function public.public_featured_reviews()
returns table (id uuid, rating integer, comment text, student_name text, student_avatar text, created_at timestamptz, course_title text)
language sql stable security definer set search_path = '' as $$
  select r.id, r.rating::int, r.comment, coalesce(nullif(trim(p.full_name), ''), 'Student'), p.avatar_url, r.created_at, co.title
    from public.class_reviews r
    left join public.profiles p on p.id = r.student_id
    left join public.courses co on co.id = r.course_id
   where r.featured and not r.report_instructor
   order by r.featured_at desc nulls last
   limit 10
$$;
revoke all on function public.public_featured_reviews() from public;
grant execute on function public.public_featured_reviews() to anon, authenticated;

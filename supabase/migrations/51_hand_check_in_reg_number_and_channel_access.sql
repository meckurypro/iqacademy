-- supabase/migrations/51_hand_check_in_reg_number_and_channel_access.sql   (applied to the live DB as "hand_check_in_reg_number_and_channel_access")
-- NOTE: the registration-number check in section 1 was replaced by the student PIN in migration 52.
--
-- 1. MARKING A STUDENT PRESENT BY HAND NEEDS THEIR REGISTRATION NUMBER (students.student_number, e.g. IQA-26-00001). Whoever
--    checks them in (admin, centre staff or instructor) must type it, which shows the student agreed. Absent / excused need no number.
-- 2. EVERY CHECKED-IN STUDENT GETS THE CHANNEL, however they were checked in (scan, centre staff, instructor or admin).
--    Before, only scanned check-ins did. The cohort lock from migration 50 still applies.
-- Both are done by patching the live function definitions, so anything changed in them since the last migration is kept.

-- ---------- 1. mark_attendance(..., p_reg_number) ----------
do $$
declare v_def text; v_old text := 'CREATE OR REPLACE FUNCTION public.mark_attendance(p_session_id uuid, p_student_id uuid, p_status attendance_status DEFAULT ''present''::attendance_status, p_notes text DEFAULT NULL::text)';
        v_anchor text := E'  if v_s.is_emergency then';
begin
  select pg_get_functiondef(p.oid) into strict v_def from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'mark_attendance' and pg_get_function_identity_arguments(p.oid) = 'p_session_id uuid, p_student_id uuid, p_status attendance_status, p_notes text';
  if position(v_old in v_def) = 0 or position(v_anchor in v_def) = 0 then raise exception 'mark_attendance patch target not found'; end if;
  v_def := replace(v_def, v_old, 'CREATE OR REPLACE FUNCTION public.mark_attendance(p_session_id uuid, p_student_id uuid, p_status attendance_status DEFAULT ''present''::attendance_status, p_notes text DEFAULT NULL::text, p_reg_number text DEFAULT NULL::text)');
  v_def := replace(v_def, v_anchor, $n$  -- present by hand needs the student's registration number
  if p_status = 'present' then
    if nullif(btrim(coalesce(p_reg_number, '')), '') is null then raise exception 'reg_number_required'; end if;
    if not exists (select 1 from public.students st where st.id = p_student_id
                      and upper(regexp_replace(coalesce(st.student_number, '#'), '\s', '', 'g')) = upper(regexp_replace(p_reg_number, '\s', '', 'g'))) then
      raise exception 'reg_number_mismatch';
    end if;
  end if;

  if v_s.is_emergency then$n$);
  execute v_def;
  drop function public.mark_attendance(uuid, uuid, public.attendance_status, text);
end $$;
revoke all on function public.mark_attendance(uuid, uuid, public.attendance_status, text, text) from public, anon;
grant execute on function public.mark_attendance(uuid, uuid, public.attendance_status, text, text) to authenticated;

-- ---------- 2. Channel access for every checked-in student ----------
do $$
declare r record; v_def text; v_pat constant text := ' and a.method = ''qr_scan''';
begin
  for r in select p.oid, p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'public' and p.proname in ('class_message_feed', 'instructor_active_classes', 'instructor_class_channels', 'unread_message_count', 'class_channel_messages', 'my_class_channels')
  loop
    v_def := pg_get_functiondef(r.oid);
    if position(v_pat in v_def) = 0 then raise exception 'no qr_scan filter found in %', r.proname; end if;
    execute replace(v_def, v_pat, '');
  end loop;
end $$;

drop policy if exists class_messages_select on public.class_messages;
create policy class_messages_select on public.class_messages for select to authenticated using (
  private.is_admin() or private.instructs_session(session_id)
  or (exists (select 1 from public.attendance a where a.session_id = class_messages.session_id and a.student_id = (select auth.uid())
                and a.status = 'present') and not private.channel_locked(class_messages.session_id)));

drop policy if exists class_messages_read on storage.objects;
create policy class_messages_read on storage.objects for select to authenticated using (
  bucket_id = 'class-messages' and (private.is_admin() or private.instructs_session(private.try_uuid((storage.foldername(name))[1]))
    or (exists (select 1 from public.attendance a where a.session_id = private.try_uuid((storage.foldername(objects.name))[1])
                  and a.student_id = (select auth.uid()) and a.status = 'present')
        and not private.channel_locked(private.try_uuid((storage.foldername(objects.name))[1])))));

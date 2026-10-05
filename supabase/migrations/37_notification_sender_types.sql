-- 37_notification_sender_types.sql
-- "Instructor <first name>" is only for what an instructor sends to students (cancelling a class, reviewing a project).
-- Anything else an instructor happens to trigger (for example paying for a course as a student) stays "IQ Academy".
create or replace function private.set_notification_sender()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_uid uuid := (select auth.uid()); v_first text;
begin
  if new.sender_label is not null then return new; end if;
  new.sender_label := 'IQ Academy';
  if v_uid is not null and v_uid <> new.user_id and new.type in ('session_cancelled', 'project_reviewed')
     and not private.is_admin() and private.is_instructor() then
    select nullif(split_part(trim(full_name), ' ', 1), '') into v_first from public.profiles where id = v_uid;
    if v_first is not null then new.sender_label := 'Instructor ' || v_first; end if;
  end if;
  return new;
end $$;

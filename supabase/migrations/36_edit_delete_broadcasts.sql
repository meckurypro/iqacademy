-- 36_edit_delete_broadcasts.sql
-- Admins can already SEND an announcement (send_broadcast). This lets them correct or retract one afterwards.
-- Applied to the live project as "edit_delete_broadcasts".
--
--   edit_broadcast    change the title / text; everyone who received it sees the new wording (read state is kept)
--   delete_broadcast  retract it: removes it from every recipient's notifications, then removes the record
--
-- notifications.broadcast_id is ON DELETE SET NULL, so delete_broadcast deletes the notifications itself;
-- otherwise the announcement would stay in everyone's bell with no record behind it.
-- The title / text limits match send_broadcast.

create or replace function public.edit_broadcast(p_id uuid, p_title text, p_body text) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if not private.is_admin() then raise exception 'forbidden' using errcode = '42501'; end if;
  if p_title is null or char_length(trim(p_title)) = 0 or char_length(p_title) > 120 then raise exception 'invalid_title'; end if;
  if p_body is not null and char_length(p_body) > 2000 then raise exception 'body_too_long'; end if;
  if not exists (select 1 from public.broadcasts where id = p_id) then raise exception 'broadcast_not_found'; end if;
  update public.broadcasts set title = trim(p_title), body = nullif(btrim(coalesce(p_body, '')), '') where id = p_id;
  update public.notifications set title = trim(p_title), body = nullif(btrim(coalesce(p_body, '')), '') where broadcast_id = p_id;
end $$;

create or replace function public.delete_broadcast(p_id uuid) returns integer
language plpgsql security definer set search_path = '' as $$
declare v_n integer;
begin
  if not private.is_admin() then raise exception 'forbidden' using errcode = '42501'; end if;
  if not exists (select 1 from public.broadcasts where id = p_id) then raise exception 'broadcast_not_found'; end if;
  delete from public.notifications where broadcast_id = p_id;
  get diagnostics v_n = row_count;
  delete from public.broadcasts where id = p_id;
  return v_n;
end $$;

revoke all on function public.edit_broadcast(uuid, text, text) from public, anon;
revoke all on function public.delete_broadcast(uuid) from public, anon;
grant execute on function public.edit_broadcast(uuid, text, text) to authenticated;
grant execute on function public.delete_broadcast(uuid) to authenticated;

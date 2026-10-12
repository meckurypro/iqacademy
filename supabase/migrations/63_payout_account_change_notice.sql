-- 63_payout_account_change_notice.sql — instructors and centre directors now save their own bank accounts (paystack-create-recipient).
-- Whenever one changes, the owner and the admins are told. Callable only by the Edge Function (service role).
create or replace function public.log_payout_account_change(p_kind text, p_id uuid, p_actor uuid) returns void
language plpgsql security definer set search_path = '' as $f$
declare v_name text;
begin
  if not private.is_privileged() then raise exception 'forbidden' using errcode = '42501'; end if;
  if p_kind = 'instructor' then
    select coalesce(nullif(trim(full_name), ''), 'An instructor') into v_name from public.profiles where id = p_id;
    perform private.notify(array[p_id], 'payout_account_changed', 'Bank account updated',
      'Your payout bank account was updated. If this was not you, tell an admin right away.', '{}'::jsonb);
  else
    select name into v_name from public.centres where id = p_id;
  end if;
  perform private.notify(private.admin_ids(), 'payout_account_changed', 'Payout bank account changed',
    coalesce(v_name, 'Someone') || ' updated a payout bank account.', jsonb_build_object('kind', p_kind, 'id', p_id));
end $f$;
revoke all on function public.log_payout_account_change(text, uuid, uuid) from public, anon, authenticated;
grant execute on function public.log_payout_account_change(text, uuid, uuid) to service_role;

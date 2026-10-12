-- 62_instructor_wallet_hooks.sql — Part 2 of 2: the hooks that connect the instructor ledger to the live flows.
-- Tested first in a rolled-back transaction (see docs/INSTRUCTOR_WALLET.md). Triggers never block attendance or payments:
-- any error is logged to instructor_earning_errors (visible to admins) and retried by the sweep / next event.

-- Private helpers are not part of the client surface.
do $g$
declare r record;
begin
  for r in select p.oid::regprocedure as sig from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'private' and p.proname in ('accrue_earning','release_pending','sync_attendance_earning','post_session_earnings',
              'post_due_session_earnings','release_withdrawal','fail_instructor_withdrawal','handle_instructor_transfer','enrolment_base',
              'course_allocation','enrolment_collected','earning_amount','earnings_since','eligible_through') loop
    execute format('revoke all on function %s from public, anon, authenticated', r.sig);
  end loop;
end $g$;

create or replace function private.log_earning_error(p_session uuid, p_enrolment uuid, p_error text) returns void
language plpgsql security definer set search_path = '' as $f$
begin
  insert into public.instructor_earning_errors (session_id, enrolment_id, error) values (p_session, p_enrolment, left(p_error, 500))
  on conflict (session_id) where resolved_at is null and session_id is not null do update set error = excluded.error, occurred_at = now();
end $f$;
revoke all on function private.log_earning_error(uuid, uuid, text) from public, anon, authenticated;

create or replace function private.trg_attendance_earnings() returns trigger language plpgsql security definer set search_path = '' as $f$
begin
  begin
    if tg_op = 'DELETE' then
      perform private.sync_attendance_earning(old.session_id, old.student_id, old.enrolment_id, false);
    else
      perform private.sync_attendance_earning(new.session_id, new.student_id, new.enrolment_id, new.status = 'present');
    end if;
  exception when others then
    if tg_op = 'DELETE' then perform private.log_earning_error(old.session_id, old.enrolment_id, sqlerrm);
    else perform private.log_earning_error(new.session_id, new.enrolment_id, sqlerrm); end if;
  end;
  return null;
end $f$;
revoke all on function private.trg_attendance_earnings() from public, anon, authenticated;
create trigger trg_attendance_earnings after insert or update of status or delete on public.attendance
  for each row execute function private.trg_attendance_earnings();

create or replace function private.trg_payments_instructor_release() returns trigger language plpgsql security definer set search_path = '' as $f$
begin
  begin
    if new.status in ('succeeded','partially_refunded','refunded') then perform private.release_pending(new.enrolment_id); end if;
  exception when others then
    perform private.log_earning_error(null, new.enrolment_id, sqlerrm);
  end;
  return null;
end $f$;
revoke all on function private.trg_payments_instructor_release() from public, anon, authenticated;
create trigger trg_payments_instructor_release after insert or update of status, refunded_amount on public.payments
  for each row execute function private.trg_payments_instructor_release();

-- The webhook's transfer router: identical to before, plus a third lookup for instructor withdrawals.
create or replace function public.handle_transfer_event(p_reference text, p_status text, p_transfer_code text default null::text, p_raw jsonb default null::jsonb)
 returns jsonb language plpgsql security definer set search_path to '' as $f$
declare v_p public.payouts%rowtype; v_rf public.refunds%rowtype; v_directors uuid[];
begin
  if not private.is_privileged() then raise exception 'forbidden' using errcode = '42501'; end if;
  select * into v_p from public.payouts where reference = p_reference for update;
  if not found then
    select * into v_rf from public.refunds where reference = p_reference for update;
    if not found then return private.handle_instructor_transfer(p_reference, p_status, p_transfer_code, p_raw); end if;
    if p_status = 'success' then
      if v_rf.status = 'processing' then
        update public.refunds set status = 'paid', paid_at = now(), raw = p_raw,
               provider_transfer_code = coalesce(p_transfer_code, provider_transfer_code) where id = v_rf.id;
        perform private.notify(array[v_rf.student_id], 'refund_update', 'Refund sent',
                private.fmt_naira(v_rf.amount) || ' has been sent to your bank account.', jsonb_build_object('refund_id', v_rf.id));
      end if;
    elsif p_status in ('failed','reversed') then
      perform public.fail_refund(v_rf.id, 'Transfer ' || p_status);
    end if;
    return jsonb_build_object('ok', true, 'refund_id', v_rf.id);
  end if;

  if p_status = 'success' then
    if v_p.status = 'processing' then
      update public.payouts
         set status = 'paid', paid_at = now(), provider_transfer_code = coalesce(p_transfer_code, provider_transfer_code), raw = p_raw
       where id = v_p.id;
      select array_agg(r.user_id) into v_directors from public.user_roles r
       where r.centre_id = v_p.centre_id and r.role = 'centre_director' and r.is_active;
      perform private.notify(v_directors, 'payout_paid', 'Payout sent',
              'We sent ' || private.fmt_naira(v_p.amount) || ' to your bank account.',
              jsonb_build_object('payout_id', v_p.id));
    end if;
  elsif p_status in ('failed','reversed') then
    perform public.fail_payout(v_p.id, 'Transfer ' || p_status);
  end if;
  return jsonb_build_object('ok', true, 'payout_id', v_p.id);
end $f$;

-- Sweep: post finished classes every 10 minutes.
do $c$
begin
  if exists (select 1 from cron.job where jobname = 'iqa-post-instructor-earnings') then perform cron.unschedule('iqa-post-instructor-earnings'); end if;
  perform cron.schedule('iqa-post-instructor-earnings', '*/10 * * * *', 'select private.post_due_session_earnings()');
end $c$;

-- 38 (applied in the DB as "33_director_income_months_and_withdrawals")
-- Directors see income for the current and previous month only (older months only while money is still
-- unwithdrawn), never future months. Each month has its own optional withdrawal that opens on the last day of
-- that month. Directors ask; admins still approve and send (Payouts page).
-- centre_dashboard is replaced in 39, which supersedes the copy that originally shipped with this migration.

alter table public.payouts add column if not exists period_month date;
create unique index if not exists payouts_one_open_per_month
  on public.payouts (centre_id, period_month) where status in ('draft','processing') and period_month is not null;

insert into public.app_settings (key, value, description)
values ('withdraw_opens_days_before_month_end', '0'::jsonb,
        'A month''s withdrawal opens this many days before the month ends. 0 = on the last day of the month.')
on conflict (key) do nothing;

create or replace function private.director_sees_month(p_centre uuid, p_month date) returns boolean
language sql stable security definer set search_path = '' as $$
  with t as (select date_trunc('month', (now() at time zone 'Africa/Lagos'))::date as cur)
  select p_month <= t.cur
     and (p_month >= (t.cur - interval '1 month')::date
          or coalesce((select sum(l.amount) from public.centre_ledger_entries l
                        where l.centre_id = p_centre and l.period_month = p_month), 0) > 0)
    from t
$$;

drop policy if exists ledger_select on public.centre_ledger_entries;
create policy ledger_select on public.centre_ledger_entries for select to authenticated using (
  private.is_admin()
  or (private.has_role_at('centre_director'::public.app_role, centre_id) and private.director_sees_month(centre_id, period_month)));

drop policy if exists payouts_select on public.payouts;
create policy payouts_select on public.payouts for select to authenticated using (
  private.is_admin()
  or (private.has_role_at('centre_director'::public.app_role, centre_id)
      and private.director_sees_month(centre_id, coalesce(period_month, date_trunc('month', created_at)::date))));

-- A payout (or its reversal) belongs to the month it withdraws
create or replace function public.approve_payout(p_payout_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_p   public.payouts%rowtype;
  v_acc public.centre_payout_accounts%rowtype;
  v_bal bigint;
  v_ref text;
begin
  if not (private.is_privileged() or private.is_admin()) then raise exception 'forbidden' using errcode = '42501'; end if;
  select * into v_p from public.payouts where id = p_payout_id for update;
  if not found then raise exception 'payout_not_found'; end if;
  if v_p.status <> 'draft' then raise exception 'payout_not_draft'; end if;

  select * into v_acc from public.centre_payout_accounts where centre_id = v_p.centre_id;
  if v_acc.provider_recipient_code is null then raise exception 'no_payout_account'; end if;

  select coalesce(sum(amount), 0) into v_bal from public.centre_ledger_entries where centre_id = v_p.centre_id;
  if v_bal < v_p.amount then raise exception 'insufficient_balance'; end if;

  v_ref := 'po-' || to_char(now(), 'YYMM') || '-' || lower(substr(replace(gen_random_uuid()::text, '-', ''), 1, 10));
  insert into public.centre_ledger_entries (centre_id, entry_type, amount, currency, payout_id, description, created_by, period_month)
  values (v_p.centre_id, 'payout', -v_p.amount, v_p.currency, v_p.id, 'Payout ' || v_ref, (select auth.uid()),
          coalesce(v_p.period_month, date_trunc('month', (now() at time zone 'Africa/Lagos'))::date));

  update public.payouts
     set status = 'processing', reference = v_ref, recipient_code = v_acc.provider_recipient_code,
         approved_by = (select auth.uid()), approved_at = now()
   where id = v_p.id;

  return jsonb_build_object('payout_id', v_p.id, 'reference', v_ref, 'amount', v_p.amount,
                            'currency', v_p.currency, 'recipient_code', v_acc.provider_recipient_code,
                            'centre_id', v_p.centre_id);
end $$;

create or replace function public.fail_payout(p_payout_id uuid, p_reason text default null) returns void
language plpgsql security definer set search_path = '' as $$
declare v_p public.payouts%rowtype;
begin
  if not (private.is_privileged() or private.is_admin()) then raise exception 'forbidden' using errcode = '42501'; end if;
  select * into v_p from public.payouts where id = p_payout_id for update;
  if not found or v_p.status <> 'processing' then return; end if;

  update public.payouts set status = 'failed', failure_reason = p_reason where id = p_payout_id;
  insert into public.centre_ledger_entries (centre_id, entry_type, amount, currency, payout_id, description, period_month)
  values (v_p.centre_id, 'payout_reversal', v_p.amount, v_p.currency, v_p.id,
          'Payout ' || coalesce(v_p.reference, '') || ' failed or reversed',
          coalesce(v_p.period_month, date_trunc('month', (now() at time zone 'Africa/Lagos'))::date));
  perform private.notify(private.admin_ids(), 'payout_failed', 'Payout failed',
          'Payout ' || coalesce(v_p.reference, '') || ' did not go through: ' || coalesce(p_reason, 'unknown reason'),
          jsonb_build_object('payout_id', p_payout_id));
end $$;

-- Withdrawals are asked for by directors, month by month. Nothing is drafted automatically any more.
create or replace function public.create_payout_drafts(p_min_amount bigint default null) returns integer
language plpgsql security definer set search_path = '' as $$
begin
  if not (private.is_privileged() or private.is_admin()) then raise exception 'forbidden' using errcode = '42501'; end if;
  return 0;
end $$;
select cron.unschedule('iqa-payout-drafts') where exists (select 1 from cron.job where jobname = 'iqa-payout-drafts');

create or replace function public.centre_income_months(p_centre_id uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_admin boolean := private.is_admin();
  v_today date := (now() at time zone 'Africa/Lagos')::date;
  v_cur   date := date_trunc('month', (now() at time zone 'Africa/Lagos'))::date;
  v_days  integer := private.setting_int('withdraw_opens_days_before_month_end', 0);
  v_acc   public.centre_payout_accounts%rowtype;
  v_months jsonb;
begin
  if not (v_admin or private.has_role_at('centre_director', p_centre_id)) then raise exception 'forbidden' using errcode = '42501'; end if;
  select * into v_acc from public.centre_payout_accounts where centre_id = p_centre_id;

  with m as (
    select period_month as month from public.centre_ledger_entries where centre_id = p_centre_id
    union select v_cur
  ), agg as (
    select m.month,
      coalesce(sum(l.amount) filter (where l.entry_type = 'earning'), 0)                                  as earned,
      coalesce(-sum(l.amount) filter (where l.entry_type = 'refund_reversal'), 0)                         as refunds,
      coalesce(sum(l.amount) filter (where l.entry_type = 'adjustment'), 0)                               as adjustments,
      coalesce(-sum(l.amount) filter (where l.entry_type in ('payout','payout_reversal')), 0)             as withdrawn,
      coalesce(sum(l.amount), 0)                                                                           as available
      from m left join public.centre_ledger_entries l on l.centre_id = p_centre_id and l.period_month = m.month
     where m.month <= v_cur and (v_admin or private.director_sees_month(p_centre_id, m.month))
     group by m.month
  )
  select coalesce(jsonb_agg(jsonb_build_object(
      'month', a.month, 'is_current', a.month = v_cur,
      'earned', a.earned, 'refunds', a.refunds, 'adjustments', a.adjustments, 'withdrawn', a.withdrawn,
      'available', a.available,
      'opens_on', o.opens_on,
      'can_withdraw', (v_today >= o.opens_on and a.available > 0 and po.id is null and v_acc.provider_recipient_code is not null),
      'payout', case when po.id is null then null else jsonb_build_object('id', po.id, 'status', po.status, 'amount', po.amount, 'paid_at', po.paid_at) end
    ) order by a.month desc), '[]'::jsonb)
    into v_months
    from agg a
    cross join lateral (select ((a.month + interval '1 month')::date - 1 - v_days) as opens_on) o
    left join lateral (select p.id, p.status, p.amount, p.paid_at from public.payouts p
                        where p.centre_id = p_centre_id and p.period_month = a.month
                        order by (p.status in ('draft','processing')) desc, p.created_at desc limit 1) po on true;

  return jsonb_build_object('centre_id', p_centre_id, 'today', v_today,
    'account', jsonb_build_object('ready', v_acc.provider_recipient_code is not null, 'bank_name', v_acc.bank_name, 'account_last4', v_acc.account_last4),
    'months', v_months);
end $$;

create or replace function public.request_withdrawal(p_centre_id uuid, p_month date) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_uid   uuid := (select auth.uid());
  v_admin boolean := private.is_admin();
  v_today date := (now() at time zone 'Africa/Lagos')::date;
  v_cur   date := date_trunc('month', (now() at time zone 'Africa/Lagos'))::date;
  v_month date := date_trunc('month', p_month)::date;
  v_days  integer := private.setting_int('withdraw_opens_days_before_month_end', 0);
  v_acc   public.centre_payout_accounts%rowtype;
  v_amt   bigint; v_id uuid; v_name text;
begin
  if v_uid is null then raise exception 'not_authenticated' using errcode = '28000'; end if;
  if not (v_admin or private.has_role_at('centre_director', p_centre_id)) then raise exception 'forbidden' using errcode = '42501'; end if;
  if p_month is null or v_month > v_cur or not (v_admin or private.director_sees_month(p_centre_id, v_month)) then raise exception 'month_not_available'; end if;
  if v_today < ((v_month + interval '1 month')::date - 1 - v_days) then raise exception 'withdraw_not_open'; end if;

  select * into v_acc from public.centre_payout_accounts where centre_id = p_centre_id;
  if v_acc.provider_recipient_code is null then raise exception 'no_payout_account'; end if;

  perform 1 from public.centres where id = p_centre_id for update;   -- one request at a time per centre
  if exists (select 1 from public.payouts where centre_id = p_centre_id and period_month = v_month and status in ('draft','processing')) then
    raise exception 'withdrawal_pending';
  end if;
  select coalesce(sum(amount), 0) into v_amt from public.centre_ledger_entries where centre_id = p_centre_id and period_month = v_month;
  if v_amt <= 0 then raise exception 'nothing_to_withdraw'; end if;

  insert into public.payouts (centre_id, period_start, period_end, period_month, amount, recipient_code, created_by)
  values (p_centre_id, v_month, (v_month + interval '1 month')::date - 1, v_month, v_amt, v_acc.provider_recipient_code, v_uid)
  returning id into v_id;

  select coalesce(city, name) into v_name from public.centres where id = p_centre_id;
  perform private.notify(private.admin_ids(), 'withdrawal_requested', 'Withdrawal requested',
    v_name || ' asked to withdraw ' || private.fmt_naira(v_amt) || ' for ' || to_char(v_month, 'FMMonth YYYY') || '. Review it in Payouts.',
    jsonb_build_object('payout_id', v_id, 'centre_id', p_centre_id));
  return v_id;
end $$;

create or replace function public.cancel_withdrawal(p_payout_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare v_p public.payouts%rowtype;
begin
  select * into v_p from public.payouts where id = p_payout_id for update;
  if not found then raise exception 'payout_not_found'; end if;
  if not (private.is_admin() or private.has_role_at('centre_director', v_p.centre_id)) then raise exception 'forbidden' using errcode = '42501'; end if;
  if v_p.status <> 'draft' then raise exception 'payout_not_draft'; end if;
  update public.payouts set status = 'cancelled' where id = p_payout_id;
end $$;

do $$
declare f text;
begin
  foreach f in array array['public.centre_income_months(uuid)','public.request_withdrawal(uuid, date)','public.cancel_withdrawal(uuid)'] loop
    execute format('revoke all on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
end $$;

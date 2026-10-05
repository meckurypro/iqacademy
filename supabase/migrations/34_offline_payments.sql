-- 34_offline_payments.sql   (recorded in the database as "31_offline_payments"; the repo already used 31-33 when it was applied)
-- Offline (cash / bank transfer) payments, end to end.
--   Student: picks "pay offline" at checkout -> a pending manual payment is saved (reference OFF-XXXXXXXX), they pay outside
--            the app and can upload a receipt. While that registration is open they can't register again unless they cancel it.
--   Admin:   sees the list, approves (-> the existing payment trigger activates the enrolment and sends the usual
--            "Payment received" notification), declines (reason + optionally purge the registration), or just ignores it.
-- Approval re-uses private.apply_payment_effects(): flipping a manual payment from 'pending' to 'succeeded' marks the
-- instalment paid, recomputes the balance, activates the enrolment, books the centre's share and notifies the student.

-- ---------------------------------------------------------------------------
-- Where students pay (admin-editable) + receipt storage
-- ---------------------------------------------------------------------------
insert into public.app_settings (key, value, description) values
  ('offline_payment_details',
   jsonb_build_object('bank_name', '', 'account_name', '', 'account_number',
                      '', 'instructions', 'Pay in cash at your centre, or transfer to the account above. Put your reference in the transfer narration.'),
   'Where students pay offline (bank transfer / cash) and what to tell them')
on conflict (key) do nothing;

create unique index if not exists payments_one_open_offline
  on public.payments (instalment_id) where provider = 'manual' and status = 'pending';

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('payment-receipts', 'payment-receipts', false, 5242880, array['image/jpeg', 'image/png', 'image/webp', 'application/pdf'])
on conflict (id) do nothing;

drop policy if exists payment_receipts_upload on storage.objects;
create policy payment_receipts_upload on storage.objects for insert to authenticated with check (
  bucket_id = 'payment-receipts' and (storage.foldername(name))[1] = (select auth.uid())::text);
drop policy if exists payment_receipts_read on storage.objects;
create policy payment_receipts_read on storage.objects for select to authenticated using (
  bucket_id = 'payment-receipts' and ((storage.foldername(name))[1] = (select auth.uid())::text or private.is_admin() or private.is_privileged()));
drop policy if exists payment_receipts_admin_remove on storage.objects;
create policy payment_receipts_admin_remove on storage.objects for delete to authenticated using (
  bucket_id = 'payment-receipts' and private.is_admin());

create or replace function public.offline_payment_details() returns jsonb
language sql stable security definer set search_path = '' as $$
  select coalesce((select value from public.app_settings where key = 'offline_payment_details'), '{}'::jsonb)
$$;

create or replace function public.save_offline_payment_details(p_bank_name text, p_account_name text, p_account_number text, p_instructions text)
returns void language plpgsql security definer set search_path = '' as $$
declare v_num text := regexp_replace(coalesce(p_account_number, ''), '\s', '', 'g');
begin
  if not private.is_admin() then raise exception 'forbidden' using errcode = '42501'; end if;
  if v_num <> '' and v_num !~ '^[0-9]{6,20}$' then raise exception 'invalid_account_number'; end if;
  if char_length(coalesce(p_bank_name, '')) > 80 or char_length(coalesce(p_account_name, '')) > 120 or char_length(coalesce(p_instructions, '')) > 600 then
    raise exception 'details_too_long';
  end if;
  insert into public.app_settings (key, value, description, updated_by, updated_at)
  values ('offline_payment_details',
          jsonb_build_object('bank_name', btrim(coalesce(p_bank_name, '')), 'account_name', btrim(coalesce(p_account_name, '')),
                             'account_number', v_num, 'instructions', btrim(coalesce(p_instructions, ''))),
          'Where students pay offline (bank transfer / cash) and what to tell them', (select auth.uid()), now())
  on conflict (key) do update set value = excluded.value, updated_by = excluded.updated_by, updated_at = now();
end $$;

-- ---------------------------------------------------------------------------
-- Student: ask to pay offline, send a receipt, change their mind
-- ---------------------------------------------------------------------------
create or replace function private.has_open_offline_registration(p_student uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.payments p join public.enrolments e on e.id = p.enrolment_id
                  where p.student_id = p_student and p.provider = 'manual' and p.status = 'pending' and e.status = 'pending_payment')
$$;
grant execute on function private.has_open_offline_registration(uuid) to authenticated;

create or replace function public.request_offline_payment(p_instalment_id uuid) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_uid uuid := (select auth.uid()); v_i public.enrolment_instalments%rowtype; v_e public.enrolments%rowtype; v_id uuid;
begin
  if v_uid is null then raise exception 'not_authenticated' using errcode = '28000'; end if;
  select * into v_i from public.enrolment_instalments where id = p_instalment_id for update;
  if not found then raise exception 'instalment_not_found'; end if;
  select * into v_e from public.enrolments where id = v_i.enrolment_id;
  if v_e.student_id <> v_uid then raise exception 'forbidden' using errcode = '42501'; end if;
  if v_e.status not in ('pending_payment', 'active') then raise exception 'enrolment_not_payable'; end if;
  if v_i.status <> 'pending' then raise exception 'instalment_not_pending'; end if;
  if exists (select 1 from public.enrolment_instalments x where x.enrolment_id = v_e.id and x.number < v_i.number and x.status = 'pending') then
    raise exception 'pay_earlier_instalment_first';
  end if;

  select id into v_id from public.payments where instalment_id = v_i.id and provider = 'manual' and status = 'pending';
  if found then return v_id; end if;

  insert into public.payments (reference, enrolment_id, instalment_id, student_id, centre_id, provider, amount, currency, status, channel, metadata)
  values ('OFF-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 8)), v_e.id, v_i.id, v_e.student_id, v_e.centre_id,
          'manual', v_i.amount, v_e.currency, 'pending', 'offline', jsonb_build_object('offline', true))
  returning id into v_id;
  return v_id;
end $$;

create or replace function public.submit_offline_receipt(p_payment_id uuid, p_path text, p_name text, p_mime text, p_size integer, p_note text default null)
returns void language plpgsql security definer set search_path = '' as $$
declare v_uid uuid := (select auth.uid()); v_p public.payments%rowtype; v_had boolean; v_admins uuid[]; v_who text;
begin
  if v_uid is null then raise exception 'not_authenticated' using errcode = '28000'; end if;
  select * into v_p from public.payments where id = p_payment_id for update;
  if not found or v_p.student_id <> v_uid then raise exception 'payment_not_found'; end if;
  if v_p.provider <> 'manual' or v_p.status <> 'pending' then raise exception 'payment_not_open'; end if;
  if p_path is null or p_path not like v_uid::text || '/' || p_payment_id::text || '/%'
     or p_mime is null or p_mime not in ('image/jpeg', 'image/png', 'image/webp', 'application/pdf')
     or coalesce(p_size, 0) <= 0 or p_size > 5242880 then
    raise exception 'invalid_receipt';
  end if;
  v_had := v_p.metadata ? 'receipt';
  update public.payments
     set metadata = v_p.metadata || jsonb_build_object(
           'receipt', jsonb_build_object('path', p_path, 'name', left(coalesce(p_name, 'receipt'), 200), 'mime', p_mime, 'size', p_size, 'uploaded_at', now()),
           'student_note', nullif(left(btrim(coalesce(p_note, '')), 500), ''))
   where id = p_payment_id;

  if not v_had then
    select array_agg(distinct r.user_id) into v_admins from public.user_roles r where r.role in ('admin', 'super_admin') and r.is_active;
    select full_name into v_who from public.profiles where id = v_uid;
    perform private.notify(v_admins, 'offline_receipt', 'Offline payment to review',
      coalesce(v_who, 'A student') || ' uploaded a receipt for ' || private.fmt_naira(v_p.amount) || ' (' || v_p.reference || ').',
      jsonb_build_object('payment_id', v_p.id));
  end if;
end $$;

create or replace function public.cancel_offline_request(p_payment_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare v_uid uuid := (select auth.uid());
begin
  update public.payments set status = 'abandoned'
   where id = p_payment_id and student_id = v_uid and provider = 'manual' and status = 'pending';
  if not found then raise exception 'payment_not_open'; end if;
end $$;

create or replace function public.my_offline_payments() returns jsonb
language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', p.id, 'reference', p.reference, 'amount', p.amount, 'created_at', p.created_at,
           'enrolment_id', p.enrolment_id, 'instalment_id', p.instalment_id, 'instalment_number', i.number, 'instalment_label', i.label,
           'enrolment_status', e.status, 'package', pk.name,
           'courses', (select coalesce(jsonb_agg(c.title order by ec.sequence_no), '[]'::jsonb)
                         from public.enrolment_courses ec join public.courses c on c.id = ec.course_id where ec.enrolment_id = e.id),
           'receipt', p.metadata -> 'receipt', 'student_note', p.metadata ->> 'student_note') order by p.created_at desc), '[]'::jsonb)
    from public.payments p
    join public.enrolments e on e.id = p.enrolment_id
    join public.packages pk on pk.id = e.package_id
    left join public.enrolment_instalments i on i.id = p.instalment_id
   where p.student_id = (select auth.uid()) and p.provider = 'manual' and p.status = 'pending'
$$;

-- ---------------------------------------------------------------------------
-- Admin: review list, approve, decline
-- ---------------------------------------------------------------------------
create or replace function public.admin_offline_payments(p_view text default 'open') returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  if not (private.is_admin() or private.is_privileged()) then raise exception 'forbidden' using errcode = '42501'; end if;
  return (
    select coalesce(jsonb_agg(x.row order by x.sort_key desc), '[]'::jsonb) from (
      select jsonb_build_object(
               'id', p.id, 'reference', p.reference, 'status', p.status, 'amount', p.amount, 'created_at', p.created_at, 'updated_at', p.updated_at,
               'student_name', pr.full_name, 'student_phone', pr.phone, 'student_email', pr.email,
               'centre_name', ce.name, 'centre_city', ce.city, 'package', pk.name, 'plan', e.plan, 'enrolment_status', e.status,
               'instalment_number', i.number, 'instalment_label', i.label, 'instalments_total', (select count(*) from public.enrolment_instalments z where z.enrolment_id = e.id),
               'courses', (select coalesce(jsonb_agg(c.title order by ec.sequence_no), '[]'::jsonb)
                             from public.enrolment_courses ec join public.courses c on c.id = ec.course_id where ec.enrolment_id = e.id),
               'receipt', p.metadata -> 'receipt', 'student_note', p.metadata ->> 'student_note',
               'failed_reason', p.failed_reason, 'admin_note', p.metadata ->> 'admin_note') as row,
             coalesce((p.metadata -> 'receipt' ->> 'uploaded_at')::timestamptz, p.created_at) as sort_key
        from public.payments p
        join public.enrolments e on e.id = p.enrolment_id
        join public.packages pk on pk.id = e.package_id
        join public.profiles pr on pr.id = p.student_id
        join public.centres ce on ce.id = p.centre_id
        left join public.enrolment_instalments i on i.id = p.instalment_id
       where p.provider = 'manual' and p.channel = 'offline'
         and case when p_view = 'handled' then p.status in ('succeeded', 'failed') and p.updated_at > now() - interval '30 days'
                  else p.status = 'pending' and coalesce(i.status, 'pending') = 'pending' end
    ) x);
end $$;

create or replace function public.offline_payment_counts() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_open integer; v_receipts integer;
begin
  if not (private.is_admin() or private.is_privileged()) then return jsonb_build_object('open', 0, 'with_receipt', 0); end if;
  select count(*), count(*) filter (where p.metadata ? 'receipt') into v_open, v_receipts
    from public.payments p left join public.enrolment_instalments i on i.id = p.instalment_id
   where p.provider = 'manual' and p.channel = 'offline' and p.status = 'pending' and coalesce(i.status, 'pending') = 'pending';
  return jsonb_build_object('open', v_open, 'with_receipt', v_receipts);
end $$;

create or replace function public.approve_offline_payment(p_payment_id uuid, p_note text default null) returns void
language plpgsql security definer set search_path = '' as $$
declare v_p public.payments%rowtype; v_i public.enrolment_instalments%rowtype; v_e public.enrolments%rowtype;
begin
  if not (private.is_admin() or private.is_privileged()) then raise exception 'forbidden' using errcode = '42501'; end if;
  select * into v_p from public.payments where id = p_payment_id for update;
  if not found then raise exception 'payment_not_found'; end if;
  if v_p.provider <> 'manual' or v_p.status <> 'pending' then raise exception 'payment_not_open'; end if;
  select * into v_i from public.enrolment_instalments where id = v_p.instalment_id for update;
  if not found or v_i.status <> 'pending' then raise exception 'instalment_already_paid'; end if;
  select * into v_e from public.enrolments where id = v_p.enrolment_id;
  if v_e.status not in ('pending_payment', 'active') then raise exception 'enrolment_not_payable'; end if;

  -- the existing payment trigger does the rest: instalment paid, balance, activation, centre share, "Payment received" notice
  update public.payments
     set status = 'succeeded', paid_at = now(), recorded_by = (select auth.uid()),
         metadata = v_p.metadata || jsonb_build_object('approved_by', (select auth.uid()), 'approved_at', now(), 'admin_note', nullif(btrim(coalesce(p_note, '')), ''))
   where id = p_payment_id;
end $$;

create or replace function public.decline_offline_payment(p_payment_id uuid, p_reason text, p_cancel_registration boolean default true) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_p public.payments%rowtype; v_e public.enrolments%rowtype; v_reason text := btrim(coalesce(p_reason, '')); v_cancel boolean := false;
begin
  if not (private.is_admin() or private.is_privileged()) then raise exception 'forbidden' using errcode = '42501'; end if;
  if char_length(v_reason) < 3 then raise exception 'reason_required'; end if;
  if char_length(v_reason) > 300 then raise exception 'reason_too_long'; end if;
  select * into v_p from public.payments where id = p_payment_id for update;
  if not found then raise exception 'payment_not_found'; end if;
  if v_p.provider <> 'manual' or v_p.status <> 'pending' then raise exception 'payment_not_open'; end if;
  select * into v_e from public.enrolments where id = v_p.enrolment_id;

  update public.payments
     set status = 'failed', failed_reason = v_reason,
         metadata = v_p.metadata || jsonb_build_object('declined_by', (select auth.uid()), 'declined_at', now())
   where id = p_payment_id;

  -- purge the registration too (only an unpaid one; an active enrolment paying a later instalment stays as it is)
  if coalesce(p_cancel_registration, false) and v_e.status = 'pending_payment' then
    v_cancel := true;
    update public.enrolments set status = 'cancelled', cancelled_at = now(), cancel_reason = 'Offline payment declined: ' || v_reason where id = v_e.id;
    update public.enrolment_instalments set status = 'cancelled' where enrolment_id = v_e.id and status = 'pending';
  end if;

  perform private.notify(array[v_p.student_id], 'payment_declined', 'We couldn''t confirm your payment',
    case when v_cancel then 'We couldn''t confirm your offline payment of ' || private.fmt_naira(v_p.amount) || ' (' || v_reason || '). Your registration was cancelled. You can register again any time.'
         else 'We couldn''t confirm your offline payment of ' || private.fmt_naira(v_p.amount) || ' (' || v_reason || '). You can pay again online or offline from your home screen.' end,
    jsonb_build_object('payment_id', v_p.id, 'enrolment_id', v_p.enrolment_id, 'cancelled', v_cancel));

  return jsonb_build_object('receipt_path', v_p.metadata -> 'receipt' ->> 'path', 'cancelled', v_cancel);
end $$;

revoke all on function public.offline_payment_details(), public.request_offline_payment(uuid), public.submit_offline_receipt(uuid, text, text, text, integer, text),
  public.cancel_offline_request(uuid), public.my_offline_payments(), public.admin_offline_payments(text), public.offline_payment_counts(),
  public.approve_offline_payment(uuid, text), public.decline_offline_payment(uuid, text, boolean), public.save_offline_payment_details(text, text, text, text)
  from public, anon;
grant execute on function public.offline_payment_details(), public.request_offline_payment(uuid), public.submit_offline_receipt(uuid, text, text, text, integer, text),
  public.cancel_offline_request(uuid), public.my_offline_payments(), public.admin_offline_payments(text), public.offline_payment_counts(),
  public.approve_offline_payment(uuid, text), public.decline_offline_payment(uuid, text, boolean), public.save_offline_payment_details(text, text, text, text)
  to authenticated;

-- ---------------------------------------------------------------------------
-- Patch the live functions in place (they're shared with earlier migrations, so we don't re-create them from a copy):
--  * one open offline registration at a time: no new enrolment (bundle or single course) until it's cancelled or settled
--  * cancelling a registration closes its offline request
--  * unpaid enrolments still expire, except one that already has a receipt waiting for review; expired ones leave the queue
-- ---------------------------------------------------------------------------
do $patch$
declare p record; d text;
begin
  for p in select * from (values
    ('public.create_enrolment(uuid,uuid,plan_type,uuid[],uuid,uuid)',
     'if not exists (select 1 from public.students where id = v_student) then raise exception ''student_not_found''; end if;',
     'if not exists (select 1 from public.students where id = v_student) then raise exception ''student_not_found''; end if;
  if private.has_open_offline_registration(v_student) then raise exception ''offline_payment_pending''; end if;',
     'has_open_offline_registration'),
    ('public.create_solo_enrolment(uuid,uuid)',
     'if not private.has_paid_pack(v_uid) then raise exception ''not_eligible_for_solo''; end if;',
     'if not private.has_paid_pack(v_uid) then raise exception ''not_eligible_for_solo''; end if;
  if private.has_open_offline_registration(v_uid) then raise exception ''offline_payment_pending''; end if;',
     'has_open_offline_registration'),
    ('public.cancel_enrolment(uuid,text)',
     'update public.enrolment_instalments set status = ''cancelled'' where enrolment_id = p_enrolment_id and status = ''pending'';',
     'update public.enrolment_instalments set status = ''cancelled'' where enrolment_id = p_enrolment_id and status = ''pending'';
  update public.payments set status = ''abandoned'' where enrolment_id = p_enrolment_id and provider = ''manual'' and status = ''pending'';',
     'provider = ''manual'''),
    ('public.expire_stale_enrolments()',
     'and created_at < now() - make_interval(days => private.setting_int(''enrolment_expiry_days'', 14))',
     'and created_at < now() - make_interval(days => private.setting_int(''enrolment_expiry_days'', 14))
       and not exists (select 1 from public.payments pp where pp.enrolment_id = public.enrolments.id and pp.provider = ''manual'' and pp.status = ''pending'' and pp.metadata ? ''receipt'')',
     'pp.provider'),
    ('public.expire_stale_enrolments()',
     'return v_n;',
     'update public.payments set status = ''abandoned'' where provider = ''manual'' and status = ''pending''
     and enrolment_id in (select id from public.enrolments where status = ''expired'');
  return v_n;',
     'set status = ''abandoned''')
  ) as t(fn, old, new, marker) loop
    select pg_get_functiondef(p.fn::regprocedure) into d;
    if position(p.marker in d) > 0 then continue; end if;   -- already patched
    if position(p.old in d) = 0 then raise exception 'patch target missing in %', p.fn; end if;
    execute replace(d, p.old, p.new);
  end loop;
end $patch$;

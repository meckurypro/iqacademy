-- 60_cash_payments.sql
--
-- Cash paid in person at a centre.
--
--   1. A coordinator or director of the centre records "student paid cash" (cash_record_payment). The payment is
--      succeeded at once (channel 'cash'), so the student's classes unlock. The cash is now HELD BY THE CENTRE.
--   2. The centre gets the cash to IQ Academy in one of two ways:
--        a. bank transfer + receipt photo   -> an admin approves        (cash_remit_transfer, approve_cash_remittance)
--        b. hand it to an admin in person   -> the admin types their PIN on the coordinator's phone
--                                              (cash_start_handover, cash_confirm_handover)
--   3. An admin holding cash remits it by bank transfer + receipt -> a super admin approves
--                                              (cash_remit_admin_transfer, approve_cash_remittance)
--
-- Money rules
--   * Cash is remitted in full. The centre's revenue share is credited to its ledger when the centre has discharged the
--     cash (transfer approved, or handover confirmed), NOT when it is collected (apply_payment_effects skips channel 'cash').
--   * The amount typed for a cash payment must equal the instalment due. There are no part payments.
--   * Everything is written through RPCs. The two new tables have RLS on and no policies and no grants.
--
-- Undo: drop the cash_* functions, the two tables and the three types, and restore apply_payment_effects from migration 11.
-- (Do not undo after real cash has been recorded.)

-- ---------------------------------------------------------------------------------------------------------------------
-- Types
-- ---------------------------------------------------------------------------------------------------------------------
create type public.cash_stage as enum ('at_centre', 'transfer_pending', 'handover_pending', 'with_admin', 'admin_transfer_pending', 'settled');
create type public.cash_leg as enum ('centre_transfer', 'handover', 'admin_transfer');
create type public.cash_remit_status as enum ('pending', 'approved', 'declined', 'cancelled');

-- ---------------------------------------------------------------------------------------------------------------------
-- Tables (RPC-only)
-- ---------------------------------------------------------------------------------------------------------------------
create table public.cash_remittances (
  id            uuid primary key default gen_random_uuid(),
  reference     text not null unique default ('CR-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 8))),
  leg           public.cash_leg not null,
  centre_id     uuid references public.centres (id),
  amount        bigint not null check (amount > 0),
  currency      char(3) not null default 'NGN',
  status        public.cash_remit_status not null default 'pending',
  submitted_by  uuid not null references public.profiles (id),
  to_admin      uuid references public.profiles (id),
  receipt       jsonb,
  note          text,
  pin_attempts  integer not null default 0,
  decided_by    uuid references public.profiles (id),
  decided_at    timestamptz,
  decision_note text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  constraint cash_remittance_shape check (
       (leg = 'handover'        and to_admin is not null and centre_id is not null)
    or (leg = 'centre_transfer' and to_admin is null and centre_id is not null and receipt is not null)
    or (leg = 'admin_transfer'  and to_admin is null and centre_id is null     and receipt is not null))
);

create table public.cash_collections (
  payment_id            uuid primary key references public.payments (id),
  centre_id             uuid not null references public.centres (id),
  amount                bigint not null check (amount > 0),
  currency              char(3) not null default 'NGN',
  collected_by          uuid not null references public.profiles (id),
  collected_at          timestamptz not null default now(),
  stage                 public.cash_stage not null default 'at_centre',
  holder_admin          uuid references public.profiles (id),
  centre_remittance_id  uuid references public.cash_remittances (id),
  admin_remittance_id   uuid references public.cash_remittances (id),
  settled_at            timestamptz,
  constraint cash_holder_when_with_admin check (stage not in ('with_admin', 'admin_transfer_pending') or holder_admin is not null)
);

create index cash_collections_centre_stage_idx on public.cash_collections (centre_id, stage);
create index cash_collections_holder_idx on public.cash_collections (holder_admin) where holder_admin is not null;
create index cash_collections_centre_rem_idx on public.cash_collections (centre_remittance_id) where centre_remittance_id is not null;
create index cash_collections_admin_rem_idx on public.cash_collections (admin_remittance_id) where admin_remittance_id is not null;
create index cash_remittances_status_idx on public.cash_remittances (status, leg, created_at desc);
create index cash_remittances_centre_idx on public.cash_remittances (centre_id, created_at desc);

alter table public.cash_remittances enable row level security;
alter table public.cash_collections enable row level security;
revoke all on public.cash_remittances, public.cash_collections from public, anon, authenticated;

create trigger trg_cash_remittances_updated_at before update on public.cash_remittances for each row execute function private.set_updated_at();
create trigger audit_cash_remittances after insert or update or delete on public.cash_remittances for each row execute function private.audit_row('id');
create trigger audit_cash_collections after insert or update or delete on public.cash_collections for each row execute function private.audit_row('payment_id');

-- ---------------------------------------------------------------------------------------------------------------------
-- Helpers (private)
-- ---------------------------------------------------------------------------------------------------------------------
create or replace function private.is_super_admin()
returns boolean language sql stable security definer set search_path = '' as $fn$
  select exists (select 1 from public.user_roles r where r.user_id = (select auth.uid()) and r.is_active and r.role = 'super_admin')
$fn$;

create or replace function private.mask_email(p text)
returns text language sql immutable set search_path = '' as $fn$
  select case when p is null or position('@' in p) < 2 then null
              else left(p, 1) || repeat('*', greatest(least(length(split_part(p, '@', 1)) - 1, 5), 1)) || '@' || split_part(p, '@', 2) end
$fn$;

create or replace function private.mask_phone(p text)
returns text language sql immutable set search_path = '' as $fn$
  select case when p is null or regexp_replace(p, '\D', '', 'g') = '' then null
              else repeat('*', greatest(length(regexp_replace(p, '\D', '', 'g')) - 3, 0)) || right(regexp_replace(p, '\D', '', 'g'), 3) end
$fn$;

-- Same lockout rules as verify_staff_pin, but for a named user (the admin whose PIN is typed on a coordinator's phone).
-- Returns 'ok' | 'pin_incorrect' | 'pin_locked' | 'pin_not_set'. Never raises, so a wrong attempt is kept.
create or replace function private.check_staff_pin_for(p_user uuid, p_pin text)
returns text language plpgsql security definer set search_path = '' as $fn$
declare v_row public.staff_pins%rowtype;
begin
  select * into v_row from public.staff_pins where user_id = p_user for update;
  if not found then return 'pin_not_set'; end if;
  if v_row.locked_until is not null and v_row.locked_until > now() then return 'pin_locked'; end if;
  if p_pin is null or p_pin !~ '^[0-9]{4}$' or v_row.pin_hash <> extensions.crypt(p_pin, v_row.pin_hash) then
    update public.staff_pins
       set failed_attempts = case when failed_attempts + 1 >= 5 then 0 else failed_attempts + 1 end,
           locked_until    = case when failed_attempts + 1 >= 5 then now() + interval '15 minutes' else locked_until end
     where user_id = p_user;
    return case when v_row.failed_attempts + 1 >= 5 then 'pin_locked' else 'pin_incorrect' end;
  end if;
  update public.staff_pins set failed_attempts = 0, locked_until = null where user_id = p_user;
  return 'ok';
end $fn$;

-- The centre's share of a cash payment, credited once the centre has discharged the cash. Idempotent (one earning per payment).
create or replace function private.recognise_cash_earning(p_payment_id uuid)
returns void language plpgsql security definer set search_path = '' as $fn$
declare v_p public.payments%rowtype; v_pct numeric(5,2); v_base bigint; v_earn bigint; v_directors uuid[];
begin
  select * into v_p from public.payments where id = p_payment_id;
  if not found then return; end if;
  v_base := v_p.amount - v_p.refunded_amount;
  if v_base <= 0 then return; end if;
  select t.revenue_share_pct into v_pct from public.centre_terms t where t.centre_id = v_p.centre_id;
  v_pct := coalesce(v_pct, 0);
  v_earn := round(v_base * v_pct / 100.0);
  if v_earn <= 0 then return; end if;
  insert into public.centre_ledger_entries (centre_id, entry_type, amount, currency, payment_id, share_pct, base_amount, description)
  values (v_p.centre_id, 'earning', v_earn, v_p.currency, v_p.id, v_pct, v_base, 'Share of payment ' || v_p.reference)
  on conflict do nothing;
  if found then
    select array_agg(r.user_id) into v_directors from public.user_roles r where r.centre_id = v_p.centre_id and r.role = 'centre_director' and r.is_active;
    perform private.notify(v_directors, 'centre_earning', 'New payment received',
            'Your share: ' || private.fmt_naira(v_earn) || ' (' || v_pct || '%).', jsonb_build_object('payment_id', v_p.id, 'amount', v_earn));
  end if;
end $fn$;

-- Cash earns the centre its share when the centre hands the cash over, not when it takes it (see recognise_cash_earning).
-- Everything else in this trigger function is exactly as before.
create or replace function private.apply_payment_effects()
returns trigger language plpgsql security definer set search_path = '' as $fn$
declare
  v_pct      numeric(5,2);
  v_earning  bigint;
  v_delta    bigint;
  v_orig_pct numeric(5,2);
  v_directors uuid[];
begin
  -- ---- payment succeeded ----
  if new.status = 'succeeded' and (tg_op = 'INSERT' or old.status in ('initiated','pending','failed','abandoned')) then
    if new.instalment_id is not null then
      update public.enrolment_instalments
         set status = 'paid', paid_at = coalesce(new.paid_at, now()), payment_id = new.id
       where id = new.instalment_id and status <> 'paid';
    end if;

    perform private.recompute_enrolment_paid(new.enrolment_id);

    update public.enrolments e
       set status = 'active', activated_at = now()
     where e.id = new.enrolment_id and e.status = 'pending_payment'
       and exists (select 1 from public.enrolment_instalments i
                   where i.enrolment_id = e.id and i.number = 1 and i.status in ('paid','waived'));

    if coalesce(new.channel, '') <> 'cash' then
      select t.revenue_share_pct into v_pct from public.centre_terms t where t.centre_id = new.centre_id;
      v_pct := coalesce(v_pct, 0);
      v_earning := round(new.amount * v_pct / 100.0);
      if v_earning > 0 then
        insert into public.centre_ledger_entries
          (centre_id, entry_type, amount, currency, payment_id, share_pct, base_amount, description)
        values (new.centre_id, 'earning', v_earning, new.currency, new.id, v_pct, new.amount,
                'Share of payment ' || new.reference)
        on conflict do nothing;

        select array_agg(r.user_id) into v_directors from public.user_roles r
         where r.centre_id = new.centre_id and r.role = 'centre_director' and r.is_active;
        perform private.notify(v_directors, 'centre_earning', 'New payment received',
               'Your share: ' || private.fmt_naira(v_earning) || ' (' || v_pct || '%).',
               jsonb_build_object('payment_id', new.id, 'amount', v_earning));
      end if;
    end if;

    perform private.notify(array[new.student_id], 'payment_received', 'Payment received',
           'We received your payment of ' || private.fmt_naira(new.amount) || '. Thank you!',
           jsonb_build_object('payment_id', new.id, 'enrolment_id', new.enrolment_id));
  end if;

  -- ---- refund (full or partial) ----
  if tg_op = 'UPDATE' and new.refunded_amount > old.refunded_amount then
    v_delta := new.refunded_amount - old.refunded_amount;
    perform private.recompute_enrolment_paid(new.enrolment_id);
    select l.share_pct into v_orig_pct from public.centre_ledger_entries l
     where l.payment_id = new.id and l.entry_type = 'earning';
    if v_orig_pct is not null and round(v_delta * v_orig_pct / 100.0) > 0 then
      insert into public.centre_ledger_entries
        (centre_id, entry_type, amount, currency, payment_id, share_pct, base_amount, description, refund_id)
      values (new.centre_id, 'refund_reversal', -round(v_delta * v_orig_pct / 100.0), new.currency,
              new.id, v_orig_pct, v_delta, 'Refund on payment ' || new.reference,
              nullif(current_setting('app.refund_id', true), '')::uuid);
      select array_agg(r.user_id) into v_directors from public.user_roles r
       where r.centre_id = new.centre_id and r.role = 'centre_director' and r.is_active;
      perform private.notify(v_directors, 'centre_refund', 'A refund affected your share',
             'A student refund reduced your balance by ' || private.fmt_naira(round(v_delta * v_orig_pct / 100.0)::bigint) ||
             '. It is deducted from your next payout.', jsonb_build_object('payment_id', new.id));
    end if;
  end if;
  return new;
end $fn$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 1. Centre staff: find the student, see what they can pay, record the cash
-- ---------------------------------------------------------------------------------------------------------------------

-- Search by exact email, phone, registration number, or every word of the name. Contact details stay masked unless the
-- search itself was the exact email or phone.
create or replace function public.cash_find_student(p_centre_id uuid, p_query text)
returns jsonb language plpgsql stable security definer set search_path = '' as $fn$
declare
  v_q      text := lower(btrim(coalesce(p_query, '')));
  v_digits text := regexp_replace(coalesce(p_query, ''), '\D', '', 'g');
  v_tokens text[];
begin
  if not private.is_centre_staff(p_centre_id) then raise exception 'forbidden' using errcode = '42501'; end if;
  if char_length(v_q) < 3 then return '[]'::jsonb; end if;
  v_tokens := array(select '%' || replace(replace(replace(t, '\', '\\'), '%', '\%'), '_', '\_') || '%'
                      from unnest(string_to_array(v_q, ' ')) as t where t <> '');
  return coalesce((
    select jsonb_agg(jsonb_build_object('id', x.id, 'full_name', x.full_name, 'student_number', x.student_number, 'email', x.email, 'phone', x.phone) order by x.rank, x.full_name)
      from (
        select p.id, p.full_name, s.student_number,
               case when lower(coalesce(p.email, '')) = v_q then p.email else private.mask_email(p.email) end as email,
               case when length(v_digits) >= 7 and right(regexp_replace(coalesce(p.phone, ''), '\D', '', 'g'), 10) = right(v_digits, 10) then p.phone
                    else private.mask_phone(p.phone) end as phone,
               case when lower(coalesce(p.email, '')) = v_q then 0
                    when lower(coalesce(s.student_number, '')) = v_q then 0
                    when length(v_digits) >= 7 and right(regexp_replace(coalesce(p.phone, ''), '\D', '', 'g'), 10) = right(v_digits, 10) then 1
                    else 2 end as rank
          from public.profiles p
          join public.students s on s.id = p.id
         where p.deleted_at is null and p.is_active
           and (lower(coalesce(p.email, '')) = v_q
                or lower(coalesce(s.student_number, '')) = v_q
                or (length(v_digits) >= 7 and right(regexp_replace(coalesce(p.phone, ''), '\D', '', 'g'), 10) = right(v_digits, 10))
                or (cardinality(v_tokens) > 0 and not exists (select 1 from unnest(v_tokens) tk where lower(p.full_name) not like tk)))
         order by rank, p.full_name
         limit 8) x), '[]'::jsonb);
end $fn$;

-- What this student can pay at this centre: unpaid or part-paid registrations here (with the next instalment due), plus the
-- courses they have already completed (so the registration form can apply prerequisites).
create or replace function public.cash_student_options(p_centre_id uuid, p_student_id uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $fn$
declare v_stu jsonb; v_enr jsonb; v_done uuid[];
begin
  if not private.is_centre_staff(p_centre_id) then raise exception 'forbidden' using errcode = '42501'; end if;
  select jsonb_build_object('id', p.id, 'full_name', p.full_name, 'student_number', s.student_number,
                            'email', private.mask_email(p.email), 'phone', private.mask_phone(p.phone))
    into v_stu
    from public.profiles p join public.students s on s.id = p.id
   where p.id = p_student_id and p.deleted_at is null and p.is_active;
  if v_stu is null then raise exception 'student_not_found'; end if;

  select coalesce(array_agg(distinct ec.course_id), '{}') into v_done
    from public.enrolment_courses ec join public.enrolments e on e.id = ec.enrolment_id
   where e.student_id = p_student_id and ec.status = 'completed';

  select coalesce(jsonb_agg(to_jsonb(x) order by x.created_at), '[]'::jsonb) into v_enr from (
    select e.id, e.status, e.plan, e.total_amount, e.amount_paid, e.created_at, pk.name as package,
           (select coalesce(jsonb_agg(c.title order by ec.sequence_no), '[]'::jsonb)
              from public.enrolment_courses ec join public.courses c on c.id = ec.course_id where ec.enrolment_id = e.id) as courses,
           (select coalesce(jsonb_agg(jsonb_build_object('id', i.id, 'number', i.number, 'label', i.label, 'amount', i.amount, 'status', i.status) order by i.number), '[]'::jsonb)
              from public.enrolment_instalments i where i.enrolment_id = e.id) as instalments,
           (select jsonb_build_object('id', i.id, 'number', i.number, 'label', i.label, 'amount', i.amount,
                     'claim', (select jsonb_build_object('payment_id', pp.id, 'reference', pp.reference, 'has_receipt', pp.metadata ? 'receipt')
                                 from public.payments pp where pp.instalment_id = i.id and pp.provider = 'manual' and pp.status = 'pending'))
              from public.enrolment_instalments i where i.enrolment_id = e.id and i.status = 'pending' order by i.number limit 1) as next
      from public.enrolments e
      join public.packages pk on pk.id = e.package_id
     where e.student_id = p_student_id and e.centre_id = p_centre_id and e.status in ('pending_payment', 'active')
       and exists (select 1 from public.enrolment_instalments i where i.enrolment_id = e.id and i.status = 'pending')) x;

  return jsonb_build_object('student', v_stu, 'enrolments', v_enr, 'completed_course_ids', to_jsonb(v_done),
                            'open_transfer', private.has_open_offline_registration(p_student_id));
end $fn$;

-- Record cash. Either pay an instalment that exists (p_instalment_id), or register the student (package, plan, courses, as
-- create_enrolment does) and take the first instalment. p_amount must equal the instalment, to the kobo.
create or replace function public.cash_record_payment(
  p_centre_id uuid, p_student_id uuid, p_amount bigint,
  p_instalment_id uuid default null, p_package_id uuid default null, p_plan public.plan_type default null,
  p_course_ids uuid[] default null, p_note text default null)
returns jsonb language plpgsql security definer set search_path = '' as $fn$
declare
  v_uid  uuid := (select auth.uid());
  v_i    public.enrolment_instalments%rowtype;
  v_e    public.enrolments%rowtype;
  v_open public.payments%rowtype;
  v_enr  uuid; v_pid uuid; v_ref text; v_name text; v_new boolean := false; v_directors uuid[];
begin
  if v_uid is null then raise exception 'not_authenticated' using errcode = '28000'; end if;
  if not private.is_centre_staff(p_centre_id) then raise exception 'forbidden' using errcode = '42501'; end if;
  if p_amount is null or p_amount <= 0 then raise exception 'amount_mismatch'; end if;
  if not exists (select 1 from public.centres where id = p_centre_id and is_active) then raise exception 'centre_not_available'; end if;
  select p.full_name into v_name from public.profiles p join public.students s on s.id = p.id
   where p.id = p_student_id and p.deleted_at is null and p.is_active;
  if v_name is null then raise exception 'student_not_found'; end if;

  if p_instalment_id is null then
    if p_package_id is null or p_plan is null or p_course_ids is null then raise exception 'registration_details_required'; end if;
    v_new := true;
    v_enr := public.create_enrolment(p_centre_id, p_package_id, p_plan, p_course_ids, p_student_id);
    select * into v_i from public.enrolment_instalments where enrolment_id = v_enr and number = 1 for update;
  else
    select * into v_i from public.enrolment_instalments where id = p_instalment_id for update;
    if not found then raise exception 'instalment_not_found'; end if;
  end if;

  select * into v_e from public.enrolments where id = v_i.enrolment_id;
  if v_e.student_id is distinct from p_student_id or v_e.centre_id is distinct from p_centre_id then raise exception 'forbidden' using errcode = '42501'; end if;
  if v_e.status not in ('pending_payment', 'active') then raise exception 'enrolment_not_payable'; end if;
  if v_i.status <> 'pending' then raise exception 'instalment_not_pending'; end if;
  if exists (select 1 from public.enrolment_instalments x where x.enrolment_id = v_e.id and x.number < v_i.number and x.status = 'pending') then
    raise exception 'pay_earlier_instalment_first';
  end if;
  if p_amount <> v_i.amount then raise exception 'amount_mismatch' using detail = v_i.amount::text; end if;

  -- The student may already have asked to pay this instalment by transfer. A receipt under review must be dealt with first
  -- (otherwise the same money could be counted twice); a bare request is simply replaced by this cash payment.
  select * into v_open from public.payments where instalment_id = v_i.id and provider = 'manual' and status = 'pending' for update;
  if found then
    if v_open.metadata ? 'receipt' then raise exception 'transfer_receipt_pending'; end if;
    update public.payments set status = 'abandoned', metadata = v_open.metadata || jsonb_build_object('superseded_by', 'cash', 'superseded_at', now()) where id = v_open.id;
  end if;

  v_ref := 'CSH-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 10));
  insert into public.payments (reference, enrolment_id, instalment_id, student_id, centre_id, provider, amount, currency, status, paid_at, channel, recorded_by, metadata)
  values (v_ref, v_e.id, v_i.id, v_e.student_id, v_e.centre_id, 'manual', v_i.amount, v_e.currency, 'succeeded', now(), 'cash', v_uid,
          jsonb_build_object('cash', true, 'collected_by', v_uid, 'note', nullif(left(btrim(coalesce(p_note, '')), 300), '')))
  returning id into v_pid;

  insert into public.cash_collections (payment_id, centre_id, amount, currency, collected_by)
  values (v_pid, v_e.centre_id, v_i.amount, v_e.currency, v_uid);

  select array_agg(r.user_id) into v_directors from public.user_roles r
   where r.centre_id = v_e.centre_id and r.role = 'centre_director' and r.is_active and r.user_id <> v_uid;
  perform private.notify(v_directors, 'cash_collected', 'Cash payment recorded',
         v_name || ' paid ' || private.fmt_naira(v_i.amount) || ' in cash (' || v_ref || ').', jsonb_build_object('payment_id', v_pid));

  return jsonb_build_object(
    'payment_id', v_pid, 'reference', v_ref, 'amount', v_i.amount, 'student_name', v_name, 'enrolment_id', v_e.id,
    'instalment_label', v_i.label, 'new_registration', v_new,
    'balance_left', (select coalesce(sum(i.amount), 0) from public.enrolment_instalments i where i.enrolment_id = v_e.id and i.status = 'pending'),
    'next', (select jsonb_build_object('label', i.label, 'amount', i.amount) from public.enrolment_instalments i where i.enrolment_id = v_e.id and i.status = 'pending' order by i.number limit 1));
end $fn$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 2. Centre staff: what the centre holds, and getting it to IQ Academy
-- ---------------------------------------------------------------------------------------------------------------------
create or replace function public.cash_centre_summary(p_centre_id uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $fn$
begin
  if not (private.is_admin() or private.is_centre_staff(p_centre_id)) then raise exception 'forbidden' using errcode = '42501'; end if;
  return jsonb_build_object(
    'centre', (select jsonb_build_object('id', c.id, 'name', c.name, 'city', c.city) from public.centres c where c.id = p_centre_id),
    'totals', (select jsonb_build_object(
                 'at_centre',        coalesce(sum(amount) filter (where stage = 'at_centre'), 0),
                 'in_review',        coalesce(sum(amount) filter (where stage = 'transfer_pending'), 0),
                 'handover_pending', coalesce(sum(amount) filter (where stage = 'handover_pending'), 0),
                 'handed_over',      coalesce(sum(amount) filter (where stage in ('with_admin', 'admin_transfer_pending', 'settled')), 0))
                 from public.cash_collections where centre_id = p_centre_id),
    'collections', (select coalesce(jsonb_agg(jsonb_build_object(
                 'payment_id', c.payment_id, 'reference', p.reference, 'student_name', pr.full_name, 'amount', c.amount, 'collected_at', c.collected_at,
                 'stage', c.stage, 'collected_by', cb.full_name, 'remittance_id', c.centre_remittance_id) order by c.collected_at desc), '[]'::jsonb)
               from (select * from public.cash_collections where centre_id = p_centre_id order by collected_at desc limit 200) c
               join public.payments p on p.id = c.payment_id
               join public.profiles pr on pr.id = p.student_id
               join public.profiles cb on cb.id = c.collected_by),
    'remittances', (select coalesce(jsonb_agg(jsonb_build_object(
                 'id', r.id, 'reference', r.reference, 'leg', r.leg, 'status', r.status, 'amount', r.amount, 'created_at', r.created_at, 'decided_at', r.decided_at,
                 'decision_note', r.decision_note, 'to_admin_name', ta.full_name, 'submitted_by_name', sb.full_name, 'receipt', r.receipt,
                 'items', (select count(*) from public.cash_collections cc where cc.centre_remittance_id = r.id)) order by r.created_at desc), '[]'::jsonb)
               from (select * from public.cash_remittances where centre_id = p_centre_id order by created_at desc limit 30) r
               left join public.profiles ta on ta.id = r.to_admin
               join public.profiles sb on sb.id = r.submitted_by),
    'bank', public.offline_payment_details());
end $fn$;

-- Remit by bank transfer. The staff member has already uploaded the receipt to payment-receipts at <their uid>/<p_remittance_id>/<file>;
-- the client makes up p_remittance_id so a retry after a lost reply is harmless (the same id returns the same remittance).
-- p_payment_ids null or empty means "everything the centre still holds".
create or replace function public.cash_remit_transfer(
  p_remittance_id uuid, p_centre_id uuid, p_payment_ids uuid[], p_path text, p_name text, p_mime text, p_size integer, p_note text default null)
returns jsonb language plpgsql security definer set search_path = '' as $fn$
declare
  v_uid uuid := (select auth.uid());
  v_ids uuid[]; v_total bigint; v_n integer; v_cur text; v_want integer; v_ref text; v_ex public.cash_remittances%rowtype; v_who text; v_c text;
begin
  if v_uid is null then raise exception 'not_authenticated' using errcode = '28000'; end if;
  if not private.is_centre_staff(p_centre_id) then raise exception 'forbidden' using errcode = '42501'; end if;
  if p_remittance_id is null then raise exception 'invalid_request'; end if;

  select * into v_ex from public.cash_remittances where id = p_remittance_id;
  if found then
    if v_ex.submitted_by is distinct from v_uid or v_ex.leg <> 'centre_transfer' then raise exception 'forbidden' using errcode = '42501'; end if;
    return jsonb_build_object('id', v_ex.id, 'reference', v_ex.reference, 'amount', v_ex.amount, 'repeat', true);
  end if;

  if p_path is null or p_path not like v_uid::text || '/' || p_remittance_id::text || '/%'
     or p_mime is null or p_mime not in ('image/jpeg', 'image/png', 'image/webp', 'application/pdf')
     or coalesce(p_size, 0) <= 0 or p_size > 5242880 then
    raise exception 'invalid_receipt';
  end if;

  with locked as (
    select payment_id, amount, currency from public.cash_collections
     where centre_id = p_centre_id and stage = 'at_centre'
       and (p_payment_ids is null or cardinality(p_payment_ids) = 0 or payment_id = any (p_payment_ids))
     order by payment_id for update)
  select array_agg(payment_id), sum(amount), count(*), min(currency) into v_ids, v_total, v_n, v_cur from locked;
  if coalesce(v_n, 0) = 0 then raise exception 'nothing_to_remit'; end if;
  if p_payment_ids is not null and cardinality(p_payment_ids) > 0 then
    select count(distinct x) into v_want from unnest(p_payment_ids) x;
    if v_want <> v_n then raise exception 'cash_item_unavailable'; end if;
  end if;

  insert into public.cash_remittances (id, leg, centre_id, amount, currency, submitted_by, receipt, note)
  values (p_remittance_id, 'centre_transfer', p_centre_id, v_total, v_cur, v_uid,
          jsonb_build_object('path', p_path, 'name', left(coalesce(p_name, 'receipt'), 200), 'mime', p_mime, 'size', p_size, 'uploaded_at', now()),
          nullif(left(btrim(coalesce(p_note, '')), 500), ''))
  returning reference into v_ref;
  update public.cash_collections set stage = 'transfer_pending', centre_remittance_id = p_remittance_id where payment_id = any (v_ids);

  select full_name into v_who from public.profiles where id = v_uid;
  select name into v_c from public.centres where id = p_centre_id;
  perform private.notify(private.admin_ids(), 'cash_remittance_review', 'Cash transfer to review',
         coalesce(v_who, 'A centre') || ' (' || coalesce(v_c, 'centre') || ') sent ' || private.fmt_naira(v_total) || ' with a receipt (' || v_ref || ').',
         jsonb_build_object('remittance_id', p_remittance_id));
  return jsonb_build_object('id', p_remittance_id, 'reference', v_ref, 'amount', v_total, 'count', v_n, 'repeat', false);
end $fn$;

-- Admins the centre can hand cash to (by email or name). Email is masked unless the search is the exact address.
create or replace function public.cash_find_admin(p_centre_id uuid, p_query text)
returns jsonb language plpgsql stable security definer set search_path = '' as $fn$
declare v_q text := lower(btrim(coalesce(p_query, ''))); v_esc text;
begin
  if not private.is_centre_staff(p_centre_id) then raise exception 'forbidden' using errcode = '42501'; end if;
  if char_length(v_q) < 3 then return '[]'::jsonb; end if;
  v_esc := replace(replace(replace(v_q, '\', '\\'), '%', '\%'), '_', '\_');
  return coalesce((
    select jsonb_agg(jsonb_build_object('id', p.id, 'full_name', p.full_name,
             'email', case when lower(coalesce(p.email, '')) = v_q then p.email else private.mask_email(p.email) end,
             'has_pin', exists (select 1 from public.staff_pins sp where sp.user_id = p.id)) order by p.full_name)
      from (select * from public.profiles p0
             where p0.deleted_at is null and p0.is_active and p0.id <> (select auth.uid())
               and exists (select 1 from public.user_roles r where r.user_id = p0.id and r.is_active and r.role in ('admin', 'super_admin'))
               and (lower(coalesce(p0.email, '')) = v_q or lower(coalesce(p0.email, '')) like v_esc || '%' or lower(p0.full_name) like '%' || v_esc || '%')
             order by p0.full_name limit 5) p), '[]'::jsonb);
end $fn$;

-- Start a hand-over: the centre says "I am giving this cash to <admin>". Nothing moves until that admin types their PIN.
create or replace function public.cash_start_handover(p_centre_id uuid, p_admin_id uuid, p_payment_ids uuid[] default null)
returns jsonb language plpgsql security definer set search_path = '' as $fn$
declare
  v_uid uuid := (select auth.uid());
  v_ids uuid[]; v_total bigint; v_n integer; v_cur text; v_want integer; v_id uuid; v_ref text; v_aname text; v_cname text; v_who text;
begin
  if v_uid is null then raise exception 'not_authenticated' using errcode = '28000'; end if;
  if not private.is_centre_staff(p_centre_id) then raise exception 'forbidden' using errcode = '42501'; end if;
  if p_admin_id is null or p_admin_id = v_uid then raise exception 'admin_not_found'; end if;
  select p.full_name into v_aname from public.profiles p
   where p.id = p_admin_id and p.deleted_at is null and p.is_active
     and exists (select 1 from public.user_roles r where r.user_id = p_admin_id and r.is_active and r.role in ('admin', 'super_admin'));
  if v_aname is null then raise exception 'admin_not_found'; end if;
  if not exists (select 1 from public.staff_pins where user_id = p_admin_id) then raise exception 'admin_has_no_pin'; end if;

  with locked as (
    select payment_id, amount, currency from public.cash_collections
     where centre_id = p_centre_id and stage = 'at_centre'
       and (p_payment_ids is null or cardinality(p_payment_ids) = 0 or payment_id = any (p_payment_ids))
     order by payment_id for update)
  select array_agg(payment_id), sum(amount), count(*), min(currency) into v_ids, v_total, v_n, v_cur from locked;
  if coalesce(v_n, 0) = 0 then raise exception 'nothing_to_remit'; end if;
  if p_payment_ids is not null and cardinality(p_payment_ids) > 0 then
    select count(distinct x) into v_want from unnest(p_payment_ids) x;
    if v_want <> v_n then raise exception 'cash_item_unavailable'; end if;
  end if;

  insert into public.cash_remittances (leg, centre_id, amount, currency, submitted_by, to_admin)
  values ('handover', p_centre_id, v_total, v_cur, v_uid, p_admin_id)
  returning id, reference into v_id, v_ref;
  update public.cash_collections set stage = 'handover_pending', centre_remittance_id = v_id where payment_id = any (v_ids);

  select full_name into v_who from public.profiles where id = v_uid;
  select name into v_cname from public.centres where id = p_centre_id;
  perform private.notify(array[p_admin_id], 'cash_handover_started', 'Cash is being handed to you',
         coalesce(v_who, 'A centre') || ' (' || coalesce(v_cname, 'centre') || ') is handing you ' || private.fmt_naira(v_total) || ' (' || v_ref || '). Count it, then type your PIN on their phone.',
         jsonb_build_object('remittance_id', v_id));
  return jsonb_build_object('id', v_id, 'reference', v_ref, 'amount', v_total, 'count', v_n, 'admin_name', v_aname);
end $fn$;

-- The admin has counted the cash and typed their PIN on the coordinator's phone. Returns a status text instead of raising,
-- so a wrong PIN is remembered: 'ok' | 'pin_incorrect' | 'pin_locked' | 'pin_not_set' | 'handover_voided'.
create or replace function public.cash_confirm_handover(p_remittance_id uuid, p_pin text)
returns text language plpgsql security definer set search_path = '' as $fn$
declare
  v_uid uuid := (select auth.uid());
  v_r public.cash_remittances%rowtype; v_res text; v_pid uuid; v_cname text; v_aname text; v_directors uuid[]; v_locked timestamptz;
begin
  if v_uid is null then raise exception 'not_authenticated' using errcode = '28000'; end if;
  select * into v_r from public.cash_remittances where id = p_remittance_id for update;
  if not found or v_r.leg <> 'handover' then raise exception 'remittance_not_found'; end if;
  if v_r.submitted_by is distinct from v_uid or not private.is_centre_staff(v_r.centre_id) then raise exception 'forbidden' using errcode = '42501'; end if;
  if v_r.status <> 'pending' then raise exception 'remittance_not_open'; end if;

  select locked_until into v_locked from public.staff_pins where user_id = v_r.to_admin;
  if not found then return 'pin_not_set'; end if;
  if v_locked is not null and v_locked > now() then return 'pin_locked'; end if;

  v_res := private.check_staff_pin_for(v_r.to_admin, p_pin);
  if v_res = 'pin_not_set' then return 'pin_not_set'; end if;

  select name into v_cname from public.centres where id = v_r.centre_id;
  select full_name into v_aname from public.profiles where id = v_r.to_admin;

  if v_res <> 'ok' then
    update public.cash_remittances set pin_attempts = pin_attempts + 1 where id = v_r.id;
    if v_r.pin_attempts + 1 >= 5 then
      update public.cash_remittances set status = 'cancelled', decided_at = now(), decision_note = 'Cancelled after 5 wrong PINs' where id = v_r.id;
      update public.cash_collections set stage = 'at_centre', centre_remittance_id = null where centre_remittance_id = v_r.id;
      perform private.notify(array[v_r.to_admin], 'cash_handover_pin_failed', 'Wrong PIN entered for a cash hand-over',
             'A hand-over of ' || private.fmt_naira(v_r.amount) || ' from ' || coalesce(v_cname, 'a centre') || ' (' || v_r.reference || ') was cancelled after 5 wrong PIN attempts. If that was not you, change your PIN and tell the super admin.',
             jsonb_build_object('remittance_id', v_r.id));
      return 'handover_voided';
    end if;
    return v_res;
  end if;

  update public.cash_remittances set status = 'approved', decided_by = v_r.to_admin, decided_at = now(), decision_note = 'Confirmed with PIN' where id = v_r.id;
  update public.cash_collections set stage = 'with_admin', holder_admin = v_r.to_admin where centre_remittance_id = v_r.id;
  for v_pid in select payment_id from public.cash_collections where centre_remittance_id = v_r.id order by payment_id loop
    perform private.recognise_cash_earning(v_pid);
  end loop;

  perform private.notify(array[v_r.to_admin], 'cash_handover_received', 'Cash received',
         'You received ' || private.fmt_naira(v_r.amount) || ' in cash from ' || coalesce(v_cname, 'a centre') || ' (' || v_r.reference || '). It is now with you until you send it to the academy account. If you did not receive this, tell the super admin straight away.',
         jsonb_build_object('remittance_id', v_r.id));
  select array_agg(r.user_id) into v_directors from public.user_roles r
   where r.centre_id = v_r.centre_id and r.role = 'centre_director' and r.is_active and r.user_id <> v_uid;
  perform private.notify(v_directors, 'cash_handed_over', 'Cash handed to IQ Academy',
         private.fmt_naira(v_r.amount) || ' was handed to ' || coalesce(v_aname, 'an admin') || ' (' || v_r.reference || ').', jsonb_build_object('remittance_id', v_r.id));
  return 'ok';
end $fn$;

-- Cancel something still waiting (a hand-over nobody confirmed, a transfer nobody has reviewed, an admin's own transfer).
-- The cash goes back to where it was. Returns the receipt path so the client can delete the file.
create or replace function public.cash_cancel_remittance(p_remittance_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $fn$
declare v_uid uuid := (select auth.uid()); v_r public.cash_remittances%rowtype;
begin
  if v_uid is null then raise exception 'not_authenticated' using errcode = '28000'; end if;
  select * into v_r from public.cash_remittances where id = p_remittance_id for update;
  if not found then raise exception 'remittance_not_found'; end if;
  if not (v_r.submitted_by is not distinct from v_uid
          or (v_r.leg <> 'admin_transfer' and private.has_role_at('centre_director', v_r.centre_id))) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if v_r.status <> 'pending' then raise exception 'remittance_not_open'; end if;

  update public.cash_remittances set status = 'cancelled', decided_by = v_uid, decided_at = now(), decision_note = 'Cancelled by sender' where id = v_r.id;
  if v_r.leg = 'admin_transfer' then
    update public.cash_collections set stage = 'with_admin', admin_remittance_id = null where admin_remittance_id = v_r.id;
  else
    update public.cash_collections set stage = 'at_centre', centre_remittance_id = null where centre_remittance_id = v_r.id;
  end if;
  return jsonb_build_object('receipt_path', v_r.receipt ->> 'path');
end $fn$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 3. Admins: what is owed, what they hold, review transfers, remit what they hold
-- ---------------------------------------------------------------------------------------------------------------------
create or replace function public.admin_cash_counts()
returns jsonb language plpgsql stable security definer set search_path = '' as $fn$
declare v_uid uuid := (select auth.uid());
begin
  if not private.is_admin() then return jsonb_build_object('to_review', 0, 'holding', 0); end if;
  return jsonb_build_object(
    'to_review', (select count(*) from public.cash_remittances r where r.status = 'pending'
                   and (r.leg = 'centre_transfer' or (r.leg = 'admin_transfer' and private.is_super_admin()))),
    'holding', coalesce((select sum(amount) from public.cash_collections where holder_admin = v_uid and stage = 'with_admin'), 0));
end $fn$;

create or replace function public.admin_cash_overview()
returns jsonb language plpgsql stable security definer set search_path = '' as $fn$
declare v_uid uuid := (select auth.uid()); v_super boolean := private.is_super_admin();
begin
  if not private.is_admin() then raise exception 'forbidden' using errcode = '42501'; end if;
  return jsonb_build_object(
    'is_super', v_super,
    'bank', public.offline_payment_details(),
    'totals', (select jsonb_build_object(
                 'at_centres',  coalesce(sum(amount) filter (where stage in ('at_centre', 'transfer_pending', 'handover_pending')), 0),
                 'with_admins', coalesce(sum(amount) filter (where stage in ('with_admin', 'admin_transfer_pending')), 0),
                 'settled',     coalesce(sum(amount) filter (where stage = 'settled'), 0)) from public.cash_collections),
    'centres', (select coalesce(jsonb_agg(jsonb_build_object('centre_id', c.id, 'name', c.name, 'city', c.city,
                 'at_centre', t.at_centre, 'in_review', t.in_review, 'handover_pending', t.handover_pending, 'oldest', t.oldest) order by t.at_centre desc, c.name), '[]'::jsonb)
                from (select centre_id,
                             coalesce(sum(amount) filter (where stage = 'at_centre'), 0) as at_centre,
                             coalesce(sum(amount) filter (where stage = 'transfer_pending'), 0) as in_review,
                             coalesce(sum(amount) filter (where stage = 'handover_pending'), 0) as handover_pending,
                             min(collected_at) filter (where stage = 'at_centre') as oldest
                        from public.cash_collections where stage in ('at_centre', 'transfer_pending', 'handover_pending') group by centre_id) t
                join public.centres c on c.id = t.centre_id),
    'reviews', (select coalesce(jsonb_agg(jsonb_build_object(
                 'id', r.id, 'reference', r.reference, 'leg', r.leg, 'amount', r.amount, 'created_at', r.created_at, 'receipt', r.receipt, 'note', r.note,
                 'centre_name', c.name, 'centre_city', c.city, 'submitted_by', r.submitted_by, 'submitted_by_name', sb.full_name,
                 'can_act', (r.leg = 'centre_transfer' and r.submitted_by is distinct from v_uid) or (r.leg = 'admin_transfer' and v_super),
                 'items', (select coalesce(jsonb_agg(jsonb_build_object('reference', p.reference, 'student_name', pr.full_name, 'amount', cc.amount, 'collected_at', cc.collected_at) order by cc.collected_at), '[]'::jsonb)
                             from public.cash_collections cc join public.payments p on p.id = cc.payment_id join public.profiles pr on pr.id = p.student_id
                            where cc.centre_remittance_id = r.id or cc.admin_remittance_id = r.id)) order by r.created_at), '[]'::jsonb)
                from public.cash_remittances r
                left join public.centres c on c.id = r.centre_id
                join public.profiles sb on sb.id = r.submitted_by
               where r.status = 'pending' and (r.leg = 'centre_transfer' or (r.leg = 'admin_transfer' and (v_super or r.submitted_by = v_uid)))),
    'mine', jsonb_build_object(
      'holding',   coalesce((select sum(amount) from public.cash_collections where holder_admin = v_uid and stage = 'with_admin'), 0),
      'in_review', coalesce((select sum(amount) from public.cash_collections where holder_admin = v_uid and stage = 'admin_transfer_pending'), 0),
      'items', (select coalesce(jsonb_agg(jsonb_build_object('payment_id', cc.payment_id, 'reference', p.reference, 'student_name', pr.full_name, 'amount', cc.amount,
                         'centre_name', c.name, 'collected_at', cc.collected_at) order by cc.collected_at), '[]'::jsonb)
                  from public.cash_collections cc join public.payments p on p.id = cc.payment_id join public.profiles pr on pr.id = p.student_id join public.centres c on c.id = cc.centre_id
                 where cc.holder_admin = v_uid and cc.stage = 'with_admin'),
      'incoming', (select coalesce(jsonb_agg(jsonb_build_object('id', r.id, 'reference', r.reference, 'amount', r.amount, 'centre_name', c.name, 'created_at', r.created_at) order by r.created_at), '[]'::jsonb)
                     from public.cash_remittances r join public.centres c on c.id = r.centre_id where r.leg = 'handover' and r.status = 'pending' and r.to_admin = v_uid),
      'has_pin', exists (select 1 from public.staff_pins where user_id = v_uid)),
    'holders', case when v_super then (select coalesce(jsonb_agg(jsonb_build_object('admin_id', h.holder_admin, 'name', pr.full_name, 'holding', h.holding, 'in_review', h.in_review) order by h.holding desc), '[]'::jsonb)
                from (select holder_admin, coalesce(sum(amount) filter (where stage = 'with_admin'), 0) as holding, coalesce(sum(amount) filter (where stage = 'admin_transfer_pending'), 0) as in_review
                        from public.cash_collections where stage in ('with_admin', 'admin_transfer_pending') group by holder_admin) h
                join public.profiles pr on pr.id = h.holder_admin) else '[]'::jsonb end,
    'recent', (select coalesce(jsonb_agg(jsonb_build_object('id', r.id, 'reference', r.reference, 'leg', r.leg, 'status', r.status, 'amount', r.amount, 'decided_at', r.decided_at,
                 'decision_note', r.decision_note, 'centre_name', c.name, 'submitted_by_name', sb.full_name, 'to_admin_name', ta.full_name) order by r.decided_at desc), '[]'::jsonb)
                from (select * from public.cash_remittances where status <> 'pending' order by decided_at desc nulls last limit 20) r
                left join public.centres c on c.id = r.centre_id
                join public.profiles sb on sb.id = r.submitted_by
                left join public.profiles ta on ta.id = r.to_admin));
end $fn$;

-- An admin remits cash they are holding (collected from centres) by bank transfer. Same receipt rules as cash_remit_transfer.
create or replace function public.cash_remit_admin_transfer(
  p_remittance_id uuid, p_payment_ids uuid[], p_path text, p_name text, p_mime text, p_size integer, p_note text default null)
returns jsonb language plpgsql security definer set search_path = '' as $fn$
declare
  v_uid uuid := (select auth.uid());
  v_ids uuid[]; v_total bigint; v_n integer; v_cur text; v_want integer; v_ref text; v_ex public.cash_remittances%rowtype; v_who text; v_supers uuid[];
begin
  if v_uid is null then raise exception 'not_authenticated' using errcode = '28000'; end if;
  if not private.is_admin() then raise exception 'forbidden' using errcode = '42501'; end if;
  if p_remittance_id is null then raise exception 'invalid_request'; end if;

  select * into v_ex from public.cash_remittances where id = p_remittance_id;
  if found then
    if v_ex.submitted_by is distinct from v_uid or v_ex.leg <> 'admin_transfer' then raise exception 'forbidden' using errcode = '42501'; end if;
    return jsonb_build_object('id', v_ex.id, 'reference', v_ex.reference, 'amount', v_ex.amount, 'repeat', true);
  end if;

  if p_path is null or p_path not like v_uid::text || '/' || p_remittance_id::text || '/%'
     or p_mime is null or p_mime not in ('image/jpeg', 'image/png', 'image/webp', 'application/pdf')
     or coalesce(p_size, 0) <= 0 or p_size > 5242880 then
    raise exception 'invalid_receipt';
  end if;

  with locked as (
    select payment_id, amount, currency from public.cash_collections
     where holder_admin = v_uid and stage = 'with_admin'
       and (p_payment_ids is null or cardinality(p_payment_ids) = 0 or payment_id = any (p_payment_ids))
     order by payment_id for update)
  select array_agg(payment_id), sum(amount), count(*), min(currency) into v_ids, v_total, v_n, v_cur from locked;
  if coalesce(v_n, 0) = 0 then raise exception 'nothing_to_remit'; end if;
  if p_payment_ids is not null and cardinality(p_payment_ids) > 0 then
    select count(distinct x) into v_want from unnest(p_payment_ids) x;
    if v_want <> v_n then raise exception 'cash_item_unavailable'; end if;
  end if;

  insert into public.cash_remittances (id, leg, centre_id, amount, currency, submitted_by, receipt, note)
  values (p_remittance_id, 'admin_transfer', null, v_total, v_cur, v_uid,
          jsonb_build_object('path', p_path, 'name', left(coalesce(p_name, 'receipt'), 200), 'mime', p_mime, 'size', p_size, 'uploaded_at', now()),
          nullif(left(btrim(coalesce(p_note, '')), 500), ''))
  returning reference into v_ref;
  update public.cash_collections set stage = 'admin_transfer_pending', admin_remittance_id = p_remittance_id where payment_id = any (v_ids);

  select full_name into v_who from public.profiles where id = v_uid;
  select array_agg(distinct r.user_id) into v_supers from public.user_roles r where r.role = 'super_admin' and r.is_active and r.user_id <> v_uid;
  perform private.notify(v_supers, 'cash_admin_transfer_review', 'Admin cash transfer to review',
         coalesce(v_who, 'An admin') || ' sent ' || private.fmt_naira(v_total) || ' with a receipt (' || v_ref || ').', jsonb_build_object('remittance_id', p_remittance_id));
  return jsonb_build_object('id', p_remittance_id, 'reference', v_ref, 'amount', v_total, 'count', v_n, 'repeat', false);
end $fn$;

-- Approve a remittance once the money is in the academy account.
--   centre transfer -> any admin (not the sender); the centre is discharged and its share is credited.
--   admin transfer  -> a super admin only (a super admin may approve their own, which is recorded).
create or replace function public.approve_cash_remittance(p_remittance_id uuid, p_note text default null)
returns void language plpgsql security definer set search_path = '' as $fn$
declare
  v_uid uuid := (select auth.uid());
  v_r public.cash_remittances%rowtype; v_pid uuid; v_own boolean; v_cname text; v_directors uuid[]; v_note text := nullif(left(btrim(coalesce(p_note, '')), 300), '');
begin
  if v_uid is null then raise exception 'not_authenticated' using errcode = '28000'; end if;
  select * into v_r from public.cash_remittances where id = p_remittance_id for update;
  if not found or v_r.leg = 'handover' then raise exception 'remittance_not_found'; end if;
  if v_r.status <> 'pending' then raise exception 'remittance_not_open'; end if;
  if v_r.leg = 'centre_transfer' and not private.is_admin() then raise exception 'forbidden' using errcode = '42501'; end if;
  if v_r.leg = 'admin_transfer' and not private.is_super_admin() then raise exception 'forbidden' using errcode = '42501'; end if;
  v_own := v_r.submitted_by is not distinct from v_uid;
  if v_own and v_r.leg = 'centre_transfer' then raise exception 'cannot_approve_own'; end if;

  update public.cash_remittances
     set status = 'approved', decided_by = v_uid, decided_at = now(),
         decision_note = case when v_own then '(self-approved by super admin)' || coalesce(' ' || v_note, '') else v_note end
   where id = v_r.id;

  if v_r.leg = 'centre_transfer' then
    update public.cash_collections set stage = 'settled', settled_at = now() where centre_remittance_id = v_r.id;
    for v_pid in select payment_id from public.cash_collections where centre_remittance_id = v_r.id order by payment_id loop
      perform private.recognise_cash_earning(v_pid);
    end loop;
    select name into v_cname from public.centres where id = v_r.centre_id;
    select array_agg(distinct u) into v_directors from (
      select v_r.submitted_by as u
      union select r.user_id from public.user_roles r where r.centre_id = v_r.centre_id and r.role = 'centre_director' and r.is_active) z;
    perform private.notify(v_directors, 'cash_remittance_approved', 'Cash transfer confirmed',
           'We received ' || private.fmt_naira(v_r.amount) || ' from ' || coalesce(v_cname, 'your centre') || ' (' || v_r.reference || '). Thank you.', jsonb_build_object('remittance_id', v_r.id));
  else
    update public.cash_collections set stage = 'settled', settled_at = now() where admin_remittance_id = v_r.id;
    perform private.notify(array[v_r.submitted_by], 'cash_remittance_approved', 'Cash transfer confirmed',
           'Your transfer of ' || private.fmt_naira(v_r.amount) || ' (' || v_r.reference || ') was confirmed.', jsonb_build_object('remittance_id', v_r.id));
  end if;
end $fn$;

create or replace function public.decline_cash_remittance(p_remittance_id uuid, p_reason text)
returns jsonb language plpgsql security definer set search_path = '' as $fn$
declare v_uid uuid := (select auth.uid()); v_r public.cash_remittances%rowtype; v_reason text := btrim(coalesce(p_reason, '')); v_cname text; v_directors uuid[];
begin
  if v_uid is null then raise exception 'not_authenticated' using errcode = '28000'; end if;
  if char_length(v_reason) < 3 then raise exception 'reason_required'; end if;
  if char_length(v_reason) > 300 then raise exception 'reason_too_long'; end if;
  select * into v_r from public.cash_remittances where id = p_remittance_id for update;
  if not found or v_r.leg = 'handover' then raise exception 'remittance_not_found'; end if;
  if v_r.status <> 'pending' then raise exception 'remittance_not_open'; end if;
  if v_r.leg = 'centre_transfer' and not private.is_admin() then raise exception 'forbidden' using errcode = '42501'; end if;
  if v_r.leg = 'admin_transfer' and not private.is_super_admin() then raise exception 'forbidden' using errcode = '42501'; end if;
  if v_r.submitted_by is not distinct from v_uid and v_r.leg = 'centre_transfer' then raise exception 'cannot_approve_own'; end if;

  update public.cash_remittances set status = 'declined', decided_by = v_uid, decided_at = now(), decision_note = v_reason where id = v_r.id;
  if v_r.leg = 'centre_transfer' then
    update public.cash_collections set stage = 'at_centre', centre_remittance_id = null where centre_remittance_id = v_r.id;
    select name into v_cname from public.centres where id = v_r.centre_id;
    select array_agg(distinct u) into v_directors from (
      select v_r.submitted_by as u
      union select r.user_id from public.user_roles r where r.centre_id = v_r.centre_id and r.role = 'centre_director' and r.is_active) z;
    perform private.notify(v_directors, 'cash_remittance_declined', 'Cash transfer not confirmed',
           'We could not confirm ' || private.fmt_naira(v_r.amount) || ' from ' || coalesce(v_cname, 'your centre') || ' (' || v_r.reference || '): ' || v_reason || '. The cash is back on your list, so you can send it again.',
           jsonb_build_object('remittance_id', v_r.id));
  else
    update public.cash_collections set stage = 'with_admin', admin_remittance_id = null where admin_remittance_id = v_r.id;
    perform private.notify(array[v_r.submitted_by], 'cash_remittance_declined', 'Cash transfer not confirmed',
           'Your transfer of ' || private.fmt_naira(v_r.amount) || ' (' || v_r.reference || ') was not confirmed: ' || v_reason || '. The cash is back in your holdings.', jsonb_build_object('remittance_id', v_r.id));
  end if;
  return jsonb_build_object('receipt_path', v_r.receipt ->> 'path');
end $fn$;

-- ---------------------------------------------------------------------------------------------------------------------
-- Grants: signed-in users only (each function checks the caller's role itself)
-- ---------------------------------------------------------------------------------------------------------------------
do $grants$
declare f record;
begin
  for f in select p.oid::regprocedure as sig from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'public' and p.proname in (
              'cash_find_student', 'cash_student_options', 'cash_record_payment', 'cash_centre_summary', 'cash_remit_transfer', 'cash_find_admin',
              'cash_start_handover', 'cash_confirm_handover', 'cash_cancel_remittance', 'admin_cash_counts', 'admin_cash_overview',
              'cash_remit_admin_transfer', 'approve_cash_remittance', 'decline_cash_remittance')
  loop
    execute format('revoke all on function %s from public, anon', f.sig);
    execute format('grant execute on function %s to authenticated, service_role', f.sig);
  end loop;
  for f in select p.oid::regprocedure as sig from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'private' and p.proname in ('is_super_admin', 'mask_email', 'mask_phone', 'check_staff_pin_for', 'recognise_cash_earning')
  loop
    execute format('revoke all on function %s from public, anon', f.sig);
    execute format('grant execute on function %s to authenticated, service_role', f.sig);
  end loop;
end $grants$;

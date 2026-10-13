-- 65_instalment_extra_fee.sql — an explicit "extra fee" for paying in instalments.
--
-- Admin sets: full price (e.g. 50,000), the instalment parts (25,000 + 25,000, which must add up to the full price) and an extra fee (5,000).
-- The fee is charged together with the LAST instalment, so the student pays 25,000 then 30,000. The fee belongs to IQ Academy:
--   * instructors never earn from it (their class price is built on the full price only), and
--   * centres never earn from it (their share is taken on the payment minus the fee).
-- package_instalments.amount stays "what the student is charged" (the last one includes the fee) so every screen and payment flow that
-- already reads it keeps working. packages.instalment_fee says how much of the last instalment is the fee, and
-- enrolment_instalments.fee_amount remembers it per enrolment, so later price changes never touch students who already enrolled.
-- Existing packages and enrolments are converted without changing what anyone is charged: fee = (sum of instalments) - (full price).

alter table public.packages add column instalment_fee bigint not null default 0 check (instalment_fee >= 0);
alter table public.enrolment_instalments add column fee_amount bigint not null default 0 check (fee_amount >= 0 and fee_amount <= amount);

update public.packages p
   set instalment_fee = least(
         greatest(coalesce((select sum(i.amount) from public.package_instalments i where i.package_id = p.id), 0) - p.price_full, 0),
         coalesce((select i.amount from public.package_instalments i where i.package_id = p.id order by i.number desc limit 1), 0))
 where exists (select 1 from public.package_instalments i where i.package_id = p.id);

update public.enrolment_instalments ei
   set fee_amount = least(ei.amount, greatest(
         (select sum(x.amount) from public.enrolment_instalments x where x.enrolment_id = ei.enrolment_id) - pk.price_full, 0))
  from public.enrolments e join public.packages pk on pk.id = e.package_id
 where e.id = ei.enrolment_id and e.plan = 'instalment' and pk.price_full > 0
   and ei.number = (select max(y.number) from public.enrolment_instalments y where y.enrolment_id = ei.enrolment_id);

-- The part of a payment that is the extra fee (zero for every other payment).
create or replace function private.instalment_fee_part(p_instalment_id uuid, p_amount bigint) returns bigint
language sql stable security definer set search_path = '' as $f$
  select coalesce((select least(i.fee_amount, p_amount) from public.enrolment_instalments i where i.id = p_instalment_id), 0) $f$;
revoke all on function private.instalment_fee_part(uuid, bigint) from public, anon, authenticated;

-- What the course tuition is, for instructors' class price: everything the student is charged except the fee. Taken from the enrolment itself.
create or replace function private.enrolment_base(p_enrolment uuid) returns bigint language sql stable security definer set search_path = '' as $f$
  select e.total_amount - coalesce((select sum(i.fee_amount) from public.enrolment_instalments i where i.enrolment_id = e.id), 0)
    from public.enrolments e where e.id = p_enrolment $f$;

-- Admin saves a package. p_instalments are the PARTS (they must add up to the full price); p_instalment_fee is charged with the last part.
-- Older app versions that do not send p_instalment_fee keep working: their amounts are treated as what is charged and the fee is worked out.
drop function if exists public.save_package(uuid, text, text, text, integer, integer, bigint, boolean, jsonb);
create or replace function public.save_package(p_package_id uuid, p_code text, p_name text, p_description text, p_course_count integer, p_duration_weeks integer,
                                               p_price_full bigint, p_is_active boolean, p_instalments jsonb, p_instalment_fee bigint default null)
returns uuid language plpgsql security definer set search_path = '' as $function$
declare
  v_id uuid; v_code text := upper(btrim(coalesce(p_code, ''))); v_courses integer; v_n integer; v_i integer; v_item jsonb; v_label text; v_amount bigint;
  v_rule text; v_k integer; v_prev integer := 0; v_sum bigint := 0; v_fee bigint; v_last bigint;
begin
  if not private.is_admin() then raise exception 'forbidden' using errcode = '42501'; end if;

  if coalesce(btrim(p_name), '') = '' then raise exception 'package_name_required'; end if;
  if p_price_full is null or p_price_full <= 0 then raise exception 'price_must_be_positive'; end if;
  if p_duration_weeks is not null and p_duration_weeks <= 0 then raise exception 'duration_invalid'; end if;

  select count(*) into v_courses from public.courses where is_active;
  if p_course_count is null or p_course_count < 1 or p_course_count > greatest(v_courses, 1) then
    raise exception 'course_count_invalid' using hint = 'Choose between 1 and ' || greatest(v_courses, 1) || ' courses.';
  end if;

  p_instalments := coalesce(p_instalments, '[]'::jsonb);
  if jsonb_typeof(p_instalments) <> 'array' then raise exception 'instalments_invalid'; end if;
  v_n := jsonb_array_length(p_instalments);
  if v_n > 6 then raise exception 'too_many_instalments'; end if;

  for v_i in 1 .. v_n loop
    v_item  := p_instalments -> (v_i - 1);
    v_label := btrim(coalesce(v_item ->> 'label', ''));
    v_rule  := coalesce(v_item ->> 'due_rule', '');
    begin
      v_amount := (v_item ->> 'amount')::bigint;
    exception when others then
      raise exception 'instalment_amount_invalid';
    end;
    if v_label = '' then raise exception 'instalment_label_required'; end if;
    if v_amount is null or v_amount <= 0 then raise exception 'instalment_amount_invalid'; end if;
    v_sum := v_sum + v_amount; v_last := v_amount;

    if v_i = 1 then
      if v_rule <> 'before_start' then raise exception 'first_instalment_must_be_before_start'; end if;
    elsif v_rule = 'custom' then
      null;
    elsif v_rule ~ '^before_course_[2-4]$' then
      v_k := substr(v_rule, 15)::integer;
      if v_k > p_course_count then raise exception 'instalment_rule_beyond_courses'; end if;
      if v_k < v_prev then raise exception 'instalments_out_of_order'; end if;
      v_prev := v_k;
    else
      raise exception 'instalment_rule_invalid';
    end if;
  end loop;

  if p_instalment_fee is null then
    v_fee := case when v_n = 0 then 0 else least(greatest(v_sum - p_price_full, 0), v_last) end;   -- older apps: amounts are what is charged
  else
    if p_instalment_fee < 0 then raise exception 'fee_invalid'; end if;
    if v_n = 0 and p_instalment_fee > 0 then raise exception 'fee_needs_instalments'; end if;
    if v_n > 0 and v_sum <> p_price_full then raise exception 'instalments_must_add_up'; end if;  -- the parts must add up to the full price
    v_fee := p_instalment_fee;
  end if;

  if p_package_id is null then
    if v_code !~ '^[A-Z0-9_-]{2,20}$' then raise exception 'package_code_invalid'; end if;
    if exists (select 1 from public.packages where code = v_code) then raise exception 'package_code_taken'; end if;
    insert into public.packages (code, name, description, course_count, duration_weeks, price_full, is_active, instalment_fee, sort_order)
    values (v_code, btrim(p_name), nullif(btrim(coalesce(p_description, '')), ''), p_course_count, p_duration_weeks,
            p_price_full, coalesce(p_is_active, true), v_fee, coalesce((select max(sort_order) from public.packages), 0) + 1)
    returning id into v_id;
  else
    select id into v_id from public.packages where id = p_package_id for update;
    if not found then raise exception 'package_not_found'; end if;
    update public.packages
       set name = btrim(p_name), description = nullif(btrim(coalesce(p_description, '')), ''), course_count = p_course_count,
           duration_weeks = p_duration_weeks, price_full = p_price_full, instalment_fee = v_fee, is_active = coalesce(p_is_active, is_active)
     where id = v_id;
  end if;

  -- stored amounts are what the student is charged: the fee rides on the last instalment (already included when an older app sent charged amounts)
  delete from public.package_instalments where package_id = v_id;
  insert into public.package_instalments (package_id, number, label, amount, due_rule)
  select v_id, ord::smallint, btrim(x ->> 'label'),
         (x ->> 'amount')::bigint + case when p_instalment_fee is not null and ord = v_n then v_fee else 0 end,
         (x ->> 'due_rule')::public.instalment_due_rule
    from jsonb_array_elements(p_instalments) with ordinality as t(x, ord);

  return v_id;
end $function$;
revoke all on function public.save_package(uuid, text, text, text, integer, integer, bigint, boolean, jsonb, bigint) from public, anon;
grant execute on function public.save_package(uuid, text, text, text, integer, integer, bigint, boolean, jsonb, bigint) to authenticated, service_role;

-- A new instalment enrolment remembers how much of its last instalment is the extra fee.
create or replace function public.create_enrolment(p_centre_id uuid, p_package_id uuid, p_plan plan_type, p_course_ids uuid[], p_student_id uuid default null::uuid, p_cohort_id uuid default null::uuid)
 returns uuid language plpgsql security definer set search_path to '' as $function$
declare
  v_uid     uuid := (select auth.uid());
  v_student uuid;
  v_pkg     public.packages%rowtype;
  v_ids     uuid[];
  v_missing text;
  v_total   bigint;
  v_id      uuid;
  v_first   uuid;
begin
  if v_uid is null then raise exception 'not_authenticated' using errcode = '28000'; end if;
  v_student := coalesce(p_student_id, v_uid);
  if v_student <> v_uid and not (private.is_admin() or private.is_centre_staff(p_centre_id)) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if not exists (select 1 from public.students where id = v_student) then raise exception 'student_not_found'; end if;
  if private.has_open_offline_registration(v_student) then raise exception 'offline_payment_pending'; end if;
  if not exists (select 1 from public.centres where id = p_centre_id and is_active) then raise exception 'centre_not_available'; end if;

  select * into v_pkg from public.packages where id = p_package_id and is_active;
  if not found then raise exception 'package_not_available'; end if;

  select array_agg(distinct x) into v_ids from unnest(p_course_ids) as x;
  if coalesce(array_length(v_ids, 1), 0) <> v_pkg.course_count then
    raise exception 'course_count_mismatch' using hint = 'This package needs exactly ' || v_pkg.course_count || ' course(s).';
  end if;
  if exists (select 1 from unnest(v_ids) x left join public.courses c on c.id = x where c.id is null or not c.is_active) then
    raise exception 'invalid_course';
  end if;

  if exists (select 1 from public.enrolment_courses ec join public.enrolments e on e.id = ec.enrolment_id
             where e.student_id = v_student and (e.status = 'pending_payment' or (e.status = 'active' and not private.pack_ended(e.id))) and ec.course_id = any (v_ids)) then
    raise exception 'already_enrolled_in_course';
  end if;

  select string_agg(c.title, ', ') into v_missing
  from public.courses c
  where c.id = any (v_ids)
    and exists (
      select 1 from (select distinct group_no from public.course_prerequisites where course_id = c.id) g
      where not exists (
        select 1 from public.course_prerequisites p
        where p.course_id = c.id and p.group_no = g.group_no
          and (p.prerequisite_id = any (v_ids)
               or exists (select 1 from public.enrolment_courses ec join public.enrolments e on e.id = ec.enrolment_id
                          where e.student_id = v_student and ec.course_id = p.prerequisite_id and ec.status = 'completed'))));
  if v_missing is not null then
    raise exception 'prerequisites_not_met' using hint = 'Missing prerequisites for: ' || v_missing;
  end if;

  select c.id into v_first from public.courses c where c.id = any (v_ids) order by c.sort_order, c.code limit 1;
  if not exists (select 1 from public.centre_course_starts(v_first) s where s.centre_id = p_centre_id) then
    raise exception 'no_classes_scheduled';
  end if;

  if p_plan = 'full' then
    v_total := v_pkg.price_full;
  else
    select sum(amount) into v_total from public.package_instalments where package_id = p_package_id;
    if v_total is null then raise exception 'instalment_plan_unavailable'; end if;
  end if;

  insert into public.enrolments (student_id, centre_id, package_id, plan, currency, total_amount, registered_by)
  values (v_student, p_centre_id, p_package_id, p_plan, v_pkg.currency, v_total, case when v_student <> v_uid then v_uid end)
  returning id into v_id;

  insert into public.enrolment_courses (enrolment_id, course_id, sequence_no)
  select v_id, c.id, row_number() over (order by c.sort_order, c.code) from public.courses c where c.id = any (v_ids);

  if p_plan = 'full' then
    insert into public.enrolment_instalments (enrolment_id, number, label, amount, due_rule) values (v_id, 1, 'Full payment', v_total, 'before_start');
  else
    insert into public.enrolment_instalments (enrolment_id, number, label, amount, due_rule, fee_amount)
    select v_id, pi.number, pi.label, pi.amount, pi.due_rule,
           case when pi.number = (select max(x.number) from public.package_instalments x where x.package_id = p_package_id) then least(v_pkg.instalment_fee, pi.amount) else 0 end
      from public.package_instalments pi where pi.package_id = p_package_id;
  end if;
  return v_id;
end $function$;

-- Centre share: taken on the payment minus the extra fee. A refund takes back the same proportion of the share.
create or replace function private.apply_payment_effects()
 returns trigger language plpgsql security definer set search_path to '' as $function$
declare
  v_pct      numeric(5,2);
  v_earning  bigint;
  v_delta    bigint;
  v_orig_pct numeric(5,2);
  v_directors uuid[];
  v_fee      bigint;
  v_base     bigint;
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
      v_fee := private.instalment_fee_part(new.instalment_id, new.amount);      -- the extra fee is IQ Academy's, not shared
      v_base := greatest(new.amount - v_fee, 0);
      v_earning := round(v_base * v_pct / 100.0);
      if v_earning > 0 then
        insert into public.centre_ledger_entries
          (centre_id, entry_type, amount, currency, payment_id, share_pct, base_amount, description)
        values (new.centre_id, 'earning', v_earning, new.currency, new.id, v_pct, v_base,
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
    if v_orig_pct is not null then
      v_fee := private.instalment_fee_part(new.instalment_id, new.amount);
      -- only the shared part of the refunded money (everything except the fee's proportion) comes back out of the centre's share
      v_earning := round(v_delta * ((new.amount - v_fee)::numeric / nullif(new.amount, 0)) * v_orig_pct / 100.0);
      if v_earning > 0 then
        insert into public.centre_ledger_entries
          (centre_id, entry_type, amount, currency, payment_id, share_pct, base_amount, description, refund_id)
        values (new.centre_id, 'refund_reversal', -v_earning, new.currency,
                new.id, v_orig_pct, v_delta, 'Refund on payment ' || new.reference,
                nullif(current_setting('app.refund_id', true), '')::uuid);
        select array_agg(r.user_id) into v_directors from public.user_roles r
         where r.centre_id = new.centre_id and r.role = 'centre_director' and r.is_active;
        perform private.notify(v_directors, 'centre_refund', 'A refund affected your share',
               'A student refund reduced your balance by ' || private.fmt_naira(v_earning::bigint) ||
               '. It is deducted from your next payout.', jsonb_build_object('payment_id', new.id));
      end if;
    end if;
  end if;
  return new;
end $function$;

-- Cash is recognised for the centre when it is handed over; the extra fee is left out here too.
create or replace function private.recognise_cash_earning(p_payment_id uuid)
 returns void language plpgsql security definer set search_path to '' as $function$
declare v_p public.payments%rowtype; v_pct numeric(5,2); v_base bigint; v_earn bigint; v_directors uuid[];
begin
  select * into v_p from public.payments where id = p_payment_id;
  if not found then return; end if;
  v_base := greatest(v_p.amount - v_p.refunded_amount - private.instalment_fee_part(v_p.instalment_id, v_p.amount), 0);
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
end $function$;

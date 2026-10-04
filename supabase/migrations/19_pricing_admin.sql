-- 19_pricing_admin.sql
-- Admin pricing: edit a package's price and its whole instalment plan in one atomic call,
-- and make every "due before course N" instalment actually lock classes.

-- ---------------------------------------------------------------------------
-- 1) Class lock. A pending instalment locks every course from the one it is
--    "due before" onward. Before this, only before_start / before_course_2 locked
--    anything, so a 3rd instalment (before_course_3) never blocked course 3.
--    Course 1 stays open once the enrolment is active (instalment #1 activates it).
-- ---------------------------------------------------------------------------
create or replace function private.enrolment_course_access(p_enrolment_id uuid, p_course_id uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1
    from public.enrolments e
    join public.enrolment_courses ec on ec.enrolment_id = e.id
    where e.id = p_enrolment_id and ec.course_id = p_course_id
      and e.status = 'active'
      and (ec.sequence_no = 1
           or not exists (select 1 from public.enrolment_instalments i
                          where i.enrolment_id = e.id
                            and i.status = 'pending'
                            and case i.due_rule
                                  when 'before_start'    then true
                                  when 'before_course_2' then ec.sequence_no >= 2
                                  when 'before_course_3' then ec.sequence_no >= 3
                                  when 'before_course_4' then ec.sequence_no >= 4
                                  else false          -- 'custom' = reminder only, never locks classes
                                end))
  )
$$;

-- ---------------------------------------------------------------------------
-- 2) save_package: create or update a package AND replace its instalment plan, atomically.
--    Admin only. Prices are in kobo. Instalments are numbered by their position in the array.
--    p_instalments = [{"label": "...", "amount": 3000000, "due_rule": "before_start"}, ...]
--    An empty array means "pay in full only" (the app hides the instalment option).
--    Changes apply to NEW enrolments only: enrolments copy the plan when they are created.
-- ---------------------------------------------------------------------------
create or replace function public.save_package(
  p_package_id     uuid,
  p_code           text,
  p_name           text,
  p_description    text,
  p_course_count   integer,
  p_duration_weeks integer,
  p_price_full     bigint,
  p_is_active      boolean,
  p_instalments    jsonb
) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_id       uuid;
  v_code     text := upper(btrim(coalesce(p_code, '')));
  v_courses  integer;
  v_n        integer;
  v_i        integer;
  v_item     jsonb;
  v_label    text;
  v_amount   bigint;
  v_rule     text;
  v_k        integer;
  v_prev     integer := 0;
begin
  if not private.is_admin() then raise exception 'forbidden' using errcode = '42501'; end if;

  if coalesce(btrim(p_name), '') = '' then raise exception 'package_name_required'; end if;
  if p_price_full is null or p_price_full <= 0 then raise exception 'price_must_be_positive'; end if;
  if p_duration_weeks is not null and p_duration_weeks <= 0 then raise exception 'duration_invalid'; end if;

  select count(*) into v_courses from public.courses where is_active;
  if p_course_count is null or p_course_count < 1 or p_course_count > greatest(v_courses, 1) then
    raise exception 'course_count_invalid' using hint = 'Choose between 1 and ' || greatest(v_courses, 1) || ' courses.';
  end if;

  -- ---- instalment plan rules ----
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

    if v_i = 1 then
      -- paying instalment #1 is what activates the enrolment, so it is always due before classes start
      if v_rule <> 'before_start' then raise exception 'first_instalment_must_be_before_start'; end if;
    elsif v_rule = 'custom' then
      null;                                   -- reminder only, locks nothing
    elsif v_rule ~ '^before_course_[2-4]$' then
      v_k := substr(v_rule, 15)::integer;
      if v_k > p_course_count then raise exception 'instalment_rule_beyond_courses'; end if;
      if v_k < v_prev then raise exception 'instalments_out_of_order'; end if;
      v_prev := v_k;
    else
      raise exception 'instalment_rule_invalid';
    end if;
  end loop;

  -- ---- save the package ----
  if p_package_id is null then
    if v_code !~ '^[A-Z0-9_-]{2,20}$' then raise exception 'package_code_invalid'; end if;
    if exists (select 1 from public.packages where code = v_code) then raise exception 'package_code_taken'; end if;
    insert into public.packages (code, name, description, course_count, duration_weeks, price_full, is_active, sort_order)
    values (v_code, btrim(p_name), nullif(btrim(coalesce(p_description, '')), ''), p_course_count, p_duration_weeks,
            p_price_full, coalesce(p_is_active, true),
            coalesce((select max(sort_order) from public.packages), 0) + 1)
    returning id into v_id;
  else
    select id into v_id from public.packages where id = p_package_id for update;
    if not found then raise exception 'package_not_found'; end if;
    -- the code is fixed once created
    update public.packages
       set name = btrim(p_name),
           description = nullif(btrim(coalesce(p_description, '')), ''),
           course_count = p_course_count,
           duration_weeks = p_duration_weeks,
           price_full = p_price_full,
           is_active = coalesce(p_is_active, is_active)
     where id = v_id;
  end if;

  -- ---- replace the instalment plan (one transaction: never left half-written) ----
  delete from public.package_instalments where package_id = v_id;
  insert into public.package_instalments (package_id, number, label, amount, due_rule)
  select v_id, ord::smallint, btrim(x ->> 'label'), (x ->> 'amount')::bigint, (x ->> 'due_rule')::public.instalment_due_rule
    from jsonb_array_elements(p_instalments) with ordinality as t(x, ord);

  return v_id;
end $$;

revoke all on function public.save_package(uuid, text, text, text, integer, integer, bigint, boolean, jsonb) from public, anon;
grant execute on function public.save_package(uuid, text, text, text, integer, integer, bigint, boolean, jsonb) to authenticated;

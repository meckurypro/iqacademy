-- supabase/migrations/55_staff_door_pin.sql   (applied to the live DB as "staff_door_pin")
--
-- A DOOR PIN FOR STAFF. Before an instructor or coordinator can show the class code / QR, or check a student in by hand, the app asks for
-- their own 4-digit PIN. This is separate from a student's check-in PIN (student_pins): a coordinator who is also a student has two PINs.
-- Stored only as a bcrypt hash. Changing it needs the account password typed twice. Five wrong PINs pause checking for 15 minutes.
-- The PIN is checked here (verify_staff_pin); deciding WHEN to ask for it is done by the app, the same as the student PIN prompt.
-- Admins can set one too (an admin who also coordinates a centre), but the app does not ask admins for it.
--
-- verify_staff_pin / change_staff_pin return text ('ok' or a reason) instead of raising, so a wrong try is counted.

create table if not exists public.staff_pins (
  user_id            uuid primary key references public.profiles (id) on delete cascade,
  pin_hash           text not null,
  set_at             timestamptz not null default now(),
  failed_attempts    integer not null default 0,
  locked_until       timestamptz,
  pw_failed_attempts integer not null default 0,
  pw_locked_until    timestamptz
);
alter table public.staff_pins enable row level security;
revoke all on public.staff_pins from anon, authenticated;   -- no policies: only the functions below can touch it

create or replace function private.is_door_staff() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.user_roles r
                  where r.user_id = (select auth.uid()) and r.is_active and r.role in ('instructor', 'coordinator', 'admin', 'super_admin'))
$$;
revoke all on function private.is_door_staff() from public, anon;
grant execute on function private.is_door_staff() to authenticated;

create or replace function public.has_staff_pin() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.staff_pins where user_id = (select auth.uid()))
$$;
revoke all on function public.has_staff_pin() from public, anon;
grant execute on function public.has_staff_pin() to authenticated;

create or replace function public.set_staff_pin(p_pin text) returns void
language plpgsql security definer set search_path = '' as $$
declare v_uid uuid := (select auth.uid());
begin
  if v_uid is null or not private.is_door_staff() then raise exception 'forbidden' using errcode = '42501'; end if;
  if p_pin is null or p_pin !~ '^[0-9]{4}$' then raise exception 'invalid_pin'; end if;
  if exists (select 1 from public.staff_pins where user_id = v_uid) then raise exception 'pin_already_set'; end if;
  insert into public.staff_pins (user_id, pin_hash) values (v_uid, extensions.crypt(p_pin, extensions.gen_salt('bf')));
end $$;
revoke all on function public.set_staff_pin(text) from public, anon;
grant execute on function public.set_staff_pin(text) to authenticated;

-- 'ok', 'pin_incorrect', 'pin_locked' or 'pin_not_set'
create or replace function public.verify_staff_pin(p_pin text) returns text
language plpgsql security definer set search_path = '' as $$
declare v_uid uuid := (select auth.uid()); v_row public.staff_pins%rowtype;
begin
  if v_uid is null or not private.is_door_staff() then raise exception 'forbidden' using errcode = '42501'; end if;
  select * into v_row from public.staff_pins where user_id = v_uid for update;
  if not found then return 'pin_not_set'; end if;
  if v_row.locked_until is not null and v_row.locked_until > now() then return 'pin_locked'; end if;
  if p_pin is null or p_pin !~ '^[0-9]{4}$' or v_row.pin_hash <> extensions.crypt(p_pin, v_row.pin_hash) then
    update public.staff_pins
       set failed_attempts = case when failed_attempts + 1 >= 5 then 0 else failed_attempts + 1 end,
           locked_until    = case when failed_attempts + 1 >= 5 then now() + interval '15 minutes' else locked_until end
     where user_id = v_uid;
    return case when v_row.failed_attempts + 1 >= 5 then 'pin_locked' else 'pin_incorrect' end;
  end if;
  update public.staff_pins set failed_attempts = 0, locked_until = null where user_id = v_uid;
  return 'ok';
end $$;
revoke all on function public.verify_staff_pin(text) from public, anon;
grant execute on function public.verify_staff_pin(text) to authenticated;

-- Change the PIN. Needs the account password, typed twice. Returns 'ok', 'password_mismatch', 'password_incorrect' or 'pw_locked'.
create or replace function public.change_staff_pin(p_new_pin text, p_password text, p_password_confirm text) returns text
language plpgsql security definer set search_path = '' as $$
declare v_uid uuid := (select auth.uid()); v_row public.staff_pins%rowtype; v_good boolean;
begin
  if v_uid is null or not private.is_door_staff() then raise exception 'forbidden' using errcode = '42501'; end if;
  if p_new_pin is null or p_new_pin !~ '^[0-9]{4}$' then raise exception 'invalid_pin'; end if;
  select * into v_row from public.staff_pins where user_id = v_uid for update;
  if not found then raise exception 'pin_not_set'; end if;
  if p_password is null or p_password = '' or p_password is distinct from p_password_confirm then return 'password_mismatch'; end if;
  if v_row.pw_locked_until is not null and v_row.pw_locked_until > now() then return 'pw_locked'; end if;

  select (u.encrypted_password = extensions.crypt(p_password, u.encrypted_password)) into v_good from auth.users u where u.id = v_uid;
  if not coalesce(v_good, false) then
    update public.staff_pins
       set pw_failed_attempts = case when pw_failed_attempts + 1 >= 5 then 0 else pw_failed_attempts + 1 end,
           pw_locked_until    = case when pw_failed_attempts + 1 >= 5 then now() + interval '15 minutes' else pw_locked_until end
     where user_id = v_uid;
    return case when v_row.pw_failed_attempts + 1 >= 5 then 'pw_locked' else 'password_incorrect' end;
  end if;

  update public.staff_pins set pin_hash = extensions.crypt(p_new_pin, extensions.gen_salt('bf')), set_at = now(),
         failed_attempts = 0, locked_until = null, pw_failed_attempts = 0, pw_locked_until = null where user_id = v_uid;
  perform private.notify(array[v_uid], 'pin_changed', 'Your door PIN was changed', 'If this wasn''t you, change your password now.', '{}'::jsonb);
  return 'ok';
end $$;
revoke all on function public.change_staff_pin(text, text, text) from public, anon;
grant execute on function public.change_staff_pin(text, text, text) to authenticated;

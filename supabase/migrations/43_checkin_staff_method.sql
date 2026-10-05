-- (applied to the live DB as "checkin_staff_method")
-- Attendance marked by a coordinator or director at the door gets its own method.
-- (Separate migration: a new enum value can't be used in the transaction that adds it.)
alter type public.attendance_method add value if not exists 'centre_staff';

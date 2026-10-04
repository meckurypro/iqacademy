-- 27_restore_security_invoker.sql   (already applied to the live project)
-- CREATE OR REPLACE VIEW resets a view's options when no WITH clause is given, so migrations 21 and 23
-- silently dropped security_invoker from these two views. Without it a view runs with its owner's rights and
-- bypasses row-level security: every signed-in user could read every centre's sessions, and a student's
-- "Next class" card would show the next class of ANY centre. Restore it. ALTER VIEW is idempotent.
--
-- Whenever you redefine one of these views, repeat the option:  create or replace view ... with (security_invoker = true) as ...
alter view public.v_session_details set (security_invoker = true);
alter view public.v_enrolment_counts set (security_invoker = true);
-- (v_staff_directory is intentionally NOT security_invoker: it exposes only id, full_name, avatar_url.)

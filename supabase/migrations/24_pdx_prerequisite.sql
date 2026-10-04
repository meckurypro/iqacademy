-- 24_pdx_prerequisite.sql
-- Product Design & UI/UX is now a prerequisite for AI-Powered Web Development and AI-Powered Mobile App Development.
-- Prerequisite groups are ANDed (any course inside one group satisfies it), so PDX gets its own group 2 next to AI Foundations (group 1).
insert into public.course_prerequisites (course_id, prerequisite_id, group_no)
select c.id, p.id, 2 from public.courses c, public.courses p
where c.code in ('WEB','MOB') and p.code = 'PDX'
on conflict do nothing;

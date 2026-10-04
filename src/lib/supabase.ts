// src/lib/supabase.ts
import { createClient } from "@supabase/supabase-js";
const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const key = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;
// Without these, createClient throws on import and the whole app renders blank.
export const supabaseConfigured = Boolean(url && key);
export const supabase = createClient(url || "http://localhost:54321", key || "missing-anon-key", {
  auth: { persistSession: true, autoRefreshToken: true },
});
const MESSAGES: Record<string, string> = {
  invalid_code: "That code isn't right. Check it and try again.",
  code_expired: "That code has expired. Ask your instructor for a new one.",
  outside_checkin_window: "Check-in isn't open for this class right now.",
  not_enrolled: "You're not enrolled in this class.",
  payment_required: "Please pay your next instalment to attend this course.",
  session_cancelled: "This class was cancelled.",
  cohort_not_open: "Enrolment for this cohort is closed.",
  cohort_full: "This cohort is full. Pick another one.",
  prerequisites_not_met: "You need to complete the prerequisite course first.",
  already_enrolled_in_course: "You're already enrolled in one of these courses.",
  course_count_mismatch: "Choose the right number of courses for this pack.",
  timetable_no_: "That time clashes with another class for the same instructor or room.",
  pay_earlier_instalment_first: "Please pay the earlier instalment first.",
  price_must_be_positive: "Set a full price above ₦0.",
  package_name_required: "Give the package a name.",
  course_count_invalid: "Choose a valid number of courses for this pack.",
  duration_invalid: "Weeks must be at least 1.",
  too_many_instalments: "A package can have at most 6 instalments.",
  instalment_amount_invalid: "Every instalment needs an amount above ₦0.",
  instalment_label_required: "Give every instalment a name.",
  first_instalment_must_be_before_start: "The first instalment is always due before classes start.",
  instalment_rule_beyond_courses: "An instalment can't be due before a course this pack doesn't have.",
  instalments_out_of_order: "Put the instalments in the order they fall due.",
  package_code_taken: "That package code is already used.",
  package_code_invalid: "Use 2–20 letters, numbers, - or _ for the code.",
  package_not_found: "That package no longer exists.",
  instalment_plan_unavailable: "Instalments aren't available for this pack. Please pay in full.",
  package_not_available: "This pack isn't available any more.",
  course_not_found: "That course no longer exists.",
  outline_invalid: "Something is wrong with the outline. Please try again.",
  class_count_invalid: "A course needs between 1 and 40 classes.",
  topic_required: "Every class needs a topic.",
  topic_too_long: "Keep each topic under 120 characters.",
  description_too_long: "Keep each description under 1,000 characters.",
  lesson_has_materials: "A class you removed has materials attached. Delete those first, or keep the class.",
  forbidden: "You don't have permission to do that.",
  not_saved: "That didn't save. You may not have permission, or it was removed by someone else. Refresh and try again.",
  photo_upload_failed: "Photo upload failed. Use a JPG, PNG or WebP under 2 MB.",
  course_title_required: "Give the course a name.",
  course_code_invalid: "Use 2–20 letters, numbers, - or _ for the course code.",
  course_code_taken: "That course code is already used.",
  course_in_use: "Students or classes still use this course, so it can't be deleted. Hide it instead (turn off “Visible to students”).",
  prerequisite_cycle: "Those prerequisites would make two courses depend on each other.",
  prerequisite_invalid: "A prerequisite points at a course that doesn't exist.",
  centre_code_taken: "That centre code is already used.",
  centre_in_use: "This centre still has students, classes, cohorts or team members, so it can't be deleted. Hide it instead.",
  centre_not_found: "That centre no longer exists.",
  package_in_use: "Students have enrolled on this package, so it can't be deleted. Hide it instead (turn off “On sale”).",
  cohort_code_taken: "That cohort code is already used.",
  cohort_in_use: "Students are enrolled in this cohort, so it can't be deleted. Close enrolment instead.",
  cohort_not_found: "That cohort no longer exists.",
  slot_not_found: "That class slot no longer exists.",
  slot_invalid: "Check the day and times for this class slot.",
};

/** A message that is already written for people. friendly() passes it through untouched. */
export class UserMessage extends Error {}
export const friendly = (e: unknown) => {
  if (e instanceof UserMessage) return e.message;
  const x = e as { message?: string; code?: string } | null;
  const m = String(x?.message ?? e ?? "");
  const k = Object.keys(MESSAGES).find((k) => m.includes(k));
  if (k) return MESSAGES[k];
  if (x?.code === "23503" || /foreign key/i.test(m)) return "This is still in use by students, classes or payments, so it can't be deleted. Hide it instead.";
  if (x?.code === "23505" || /duplicate key/i.test(m)) return "That already exists. Use a different name or code.";
  if (x?.code === "42501" || /row-level security|permission denied/i.test(m)) return MESSAGES.forbidden;
  if (x?.code === "PGRST202" || /could not find the function/i.test(m)) return "This action isn't set up in the database yet.";
  if (/failed to fetch|networkerror|load failed/i.test(m)) return "No internet connection. Check it and try again.";
  return "Something went wrong. Please try again.";
};
/** The raw technical message, for admin screens that show details. */
export const rawMessage = (e: unknown) => String((e as { message?: string })?.message ?? e ?? "");
export const naira = (kobo: number) => "₦" + (kobo / 100).toLocaleString("en-NG", { maximumFractionDigits: 0 });

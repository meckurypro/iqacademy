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
  makeup_not_open: "Make-up classes open once your classes have ended, and last two months.",
  not_a_missed_class: "That's not a class you missed, so there's nothing to make up.",
  makeup_limit_reached: "You've used all your make-up classes.",
  not_eligible_for_solo: "You can buy a single course once you've fully paid for a course pack.",
  solo_price_not_set: "This course can't be bought on its own yet.",
  course_not_available: "That course isn't available right now.",
  prices_invalid: "Something is wrong with those prices. Please check and try again.",
  forbidden: "You don't have permission to do that.",
};
export const friendly = (e: unknown) => {
  const m = String((e as { message?: string })?.message ?? e ?? "");
  const k = Object.keys(MESSAGES).find((k) => m.includes(k));
  return k ? MESSAGES[k] : "Something went wrong. Please try again.";
};
export const naira = (kobo: number) => "₦" + (kobo / 100).toLocaleString("en-NG", { maximumFractionDigits: 0 });

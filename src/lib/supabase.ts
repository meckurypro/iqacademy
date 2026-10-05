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
  already_enrolled_in_course: "You already have one of these courses. If it's an unpaid registration, cancel it from your home screen first.",
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
  session_not_active: "You can message a class while it's in progress. Show the class code to start it.",
  message_empty: "Write a message or attach an image first.",
  message_too_long: "Keep the message under 4,000 characters.",
  invalid_media: "That image can't be sent. Use a JPG, PNG, WebP or GIF under 10 MB.",
  message_not_found: "That message was already deleted.",
  download_failed: "Couldn't download that file. Check your connection and try again.",
  copy_failed: "Couldn't copy. Select the text and copy it by hand.",
  offline_payment_pending: "You have an offline payment waiting. Cancel that registration first if you want to register again.",
  payment_not_open: "That payment isn't waiting any more. It may already have been handled.",
  payment_not_found: "We couldn't find that payment.",
  invalid_receipt: "That receipt couldn't be accepted. Use a photo or PDF under 5 MB.",
  receipt_type: "Upload a photo (JPG, PNG) or a PDF of your receipt.",
  receipt_too_large: "That file is too large. Keep it under 5 MB.",
  reason_required: "Tell the student why, in a few words.",
  reason_too_long: "Keep the reason under 300 characters.",
  instalment_already_paid: "That instalment has already been paid, so there's nothing to approve.",
  enrolment_not_payable: "This registration can't take a payment any more.",
  invalid_account_number: "Account numbers are digits only (6 to 20).",
  details_too_long: "One of those fields is too long. Please shorten it.",
  instalment_not_found: "We couldn't find that instalment.",
  instalment_not_pending: "That instalment is already paid or cancelled.",
  forbidden: "You don't have permission to do that.",
  withdraw_not_open: "Withdrawals for a month open when that month ends.",
  month_not_available: "That month isn't available.",
  withdrawal_pending: "You already have a withdrawal in progress for this month.",
  nothing_to_withdraw: "There's nothing to withdraw for this month.",
  no_payout_account: "No bank account is set up for this centre yet. Ask an admin to add it.",
  payout_not_draft: "That request has already been approved.",
  not_saved: "That didn't save. You may not have permission, or it was removed by someone else. Refresh and try again.",
  photo_upload_failed: "Photo upload failed. Use a JPG, PNG or WebP under 2 MB.",
  course_title_required: "Give the course a name.",
  course_code_invalid: "Use 2–20 letters, numbers, - or _ for the course code.",
  course_code_taken: "That course code is already used.",
  course_in_use: "Students or classes still use this course, so it can't be deleted. Hide it instead (turn off “Visible to students”).",
  course_has_content: "Lesson materials have been uploaded for this course, so it can't be deleted. Hide it instead.",
  broadcast_not_found: "That announcement was already removed.",
  invalid_title: "Give it a title (up to 120 characters).",
  body_too_long: "Keep the message under 2,000 characters.",
  no_recipients: "No one matches that audience yet.",
  course_is_prerequisite: "Other courses list this one as a prerequisite. Remove it from them first, or hide this course instead.",
  prerequisite_cycle: "Those prerequisites would make two courses depend on each other.",
  prerequisite_invalid: "A prerequisite points at a course that doesn't exist.",
  centre_code_taken: "That centre code is already used.",
  centre_has_history: "This centre has students, payments or attendance on record, so it can't be deleted. Hide it instead (turn off “Open for students”).",
  no_days: "Add at least one class day.",
  duplicate_day: "Each weekday can only appear once.",
  bad_times: "Each class day must end after it starts.",
  no_class_days: "Set this centre's class days first.",
  bad_dates: "The end date can't be before the start date.",
  start_in_past: "A run can't begin in the past.",
  too_far_ahead: "A run can start up to four months from today.",
  run_too_long: "A run can last up to four months.",
  run_overlap: "This course already has a run at this centre on those dates.",
  no_class_in_range: "No class day falls between those dates.",
  instructor_clash: "That instructor already teaches at one of those times.",
  not_an_instructor: "That person isn't an instructor.",
  run_cancelled: "That run was cancelled.",
  run_not_found: "That run no longer exists.",
  centre_not_available: "That centre isn't open.",
  centre_not_found: "That centre no longer exists.",
  package_in_use: "Students have enrolled on this package, so it can't be deleted. Hide it instead (turn off “On sale”).",
  cannot_cancel: "This registration can't be cancelled any more.",
  enrolment_not_found: "That registration no longer exists.",
  nothing_selected: "Pick at least one class first.",
  bad_scope: "Something went wrong with that selection. Please try again.",
  instructor_required: "Choose which instructor will teach it.",
  emergency_no_topic: "Choose a topic that belongs to that course.",
  emergency_bad_time: "Choose when the class starts.",
  emergency_time_passed: "That start time has already passed. Choose a time from now on.",
  emergency_too_far: "An emergency class can be set up to 30 days ahead.",
  emergency_bad_length: "A class can run from 15 minutes to 8 hours.",
  emergency_note_long: "Keep the note under 300 characters.",
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
  if (x?.code === "PGRST202" || /could not find the function/i.test(m)) return "This needs a database update that hasn't been applied yet.";
  if (/failed to fetch|networkerror|load failed/i.test(m)) return "No internet connection. Check it and try again.";
  return "Something went wrong. Please try again.";
};
/** The raw technical message, for admin screens that show details. */
export const rawMessage = (e: unknown) => String((e as { message?: string })?.message ?? e ?? "");
export const naira = (kobo: number) => "₦" + (kobo / 100).toLocaleString("en-NG", { maximumFractionDigits: 0 });

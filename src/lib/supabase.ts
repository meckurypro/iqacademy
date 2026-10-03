import { createClient } from "@supabase/supabase-js";
export const supabase = createClient(import.meta.env.VITE_SUPABASE_URL, import.meta.env.VITE_SUPABASE_ANON_KEY, {
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
};
export const friendly = (e: unknown) => {
  const m = String((e as { message?: string })?.message ?? e ?? "");
  const k = Object.keys(MESSAGES).find((k) => m.includes(k));
  return k ? MESSAGES[k] : "Something went wrong. Please try again.";
};
export const naira = (kobo: number) => "₦" + (kobo / 100).toLocaleString("en-NG", { maximumFractionDigits: 0 });

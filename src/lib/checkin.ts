// src/lib/checkin.ts
// Door check-in: the verdict check_in() returns, and the window in which door staff can open check-in.
import { fmtClock, now } from "./time";

export type Verdict = {
  ok: boolean;
  reason?: "not_enrolled" | "payment_required" | "makeup_not_open" | "not_a_missed_class" | "makeup_limit_reached";
  already_checked_in?: boolean; makeup?: boolean; emergency?: boolean;
  first_name?: string | null; course_title?: string | null; lesson_title?: string | null; centre_name?: string | null;
};

/** Red-screen wording per reason. */
export const DENIED: Record<string, { title: string; detail: string }> = {
  not_enrolled: { title: "Not on the list", detail: "You're not registered for this class at this centre." },
  payment_required: { title: "Payment due", detail: "Pay your next instalment to join this class." },
  makeup_not_open: { title: "Not yet", detail: "Make-up classes open once your own classes have ended." },
  not_a_missed_class: { title: "Not your class", detail: "This isn't a class you missed, so there's nothing to make up." },
  makeup_limit_reached: { title: "No make-ups left", detail: "You've used all your make-up classes." },
};
export const deniedText = (reason?: string) => DENIED[reason ?? ""] ?? { title: "Not allowed in", detail: "You can't join this class." };

/** Matches app_settings.checkin_opens_minutes_before. */
export const CHECKIN_OPENS_MIN = 30;
export type DoorState = "early" | "open" | "ended";
export function doorState(start: string, end: string, at = now()): DoorState {
  if (at < Date.parse(start) - CHECKIN_OPENS_MIN * 60000) return "early";
  if (at > Date.parse(end)) return "ended";
  return "open";
}
export const opensAt = (start: string) => fmtClock(Date.parse(start) - CHECKIN_OPENS_MIN * 60000);

export const REASON_LABEL: Record<string, string> = {
  not_enrolled: "Not registered", payment_required: "Payment due", makeup_not_open: "Make-up not open",
  not_a_missed_class: "Not a missed class", makeup_limit_reached: "No make-ups left",
};

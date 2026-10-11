// src/lib/cash.ts
// Cash paid in person at a centre (migration 60_cash_payments): shared types, money parsing and the receipt upload for remittances.
//
// The chain: centre staff record the cash -> the centre holds it -> it reaches IQ Academy by bank transfer + receipt (an admin approves)
// or by hand to an admin (the admin types their PIN on the coordinator's phone) -> the admin sends it on by bank transfer + receipt (a super admin approves).
import { supabase } from "./supabase";
import { prepareReceipt, type OfflineDetails, type Receipt } from "./offline";

export type CashStage = "at_centre" | "transfer_pending" | "handover_pending" | "with_admin" | "admin_transfer_pending" | "settled";
export type CashLeg = "centre_transfer" | "handover" | "admin_transfer";
export type CashStatus = "pending" | "approved" | "declined" | "cancelled";

export type CashItem = { payment_id: string; reference: string; student_name: string; amount: number; collected_at: string; stage: CashStage; collected_by: string; remittance_id: string | null };
export type CentreRemittance = {
  id: string; reference: string; leg: CashLeg; status: CashStatus; amount: number; created_at: string; decided_at: string | null; decision_note: string | null;
  to_admin_name: string | null; submitted_by_name: string; receipt: Receipt | null; items: number;
};
export type CentreCash = {
  centre: { id: string; name: string; city: string | null };
  totals: { at_centre: number; in_review: number; handover_pending: number; handed_over: number };
  collections: CashItem[]; remittances: CentreRemittance[]; bank: OfflineDetails;
};

export type FoundStudent = { id: string; full_name: string; student_number: string | null; email: string | null; phone: string | null };
export type Instalment = { id: string; number: number; label: string; amount: number; status: string };
export type PayableEnrolment = {
  id: string; status: string; plan: string; total_amount: number; amount_paid: number; package: string; courses: string[]; instalments: Instalment[];
  next: { id: string; number: number; label: string; amount: number; claim: { payment_id: string; reference: string; has_receipt: boolean } | null };
};
export type CashOptions = { student: FoundStudent; enrolments: PayableEnrolment[]; completed_course_ids: string[]; open_transfer: boolean };
export type CashDone = {
  payment_id: string; reference: string; amount: number; student_name: string; enrolment_id: string; instalment_label: string; new_registration: boolean;
  balance_left: number; next: { label: string; amount: number } | null;
};
export type FoundAdmin = { id: string; full_name: string; email: string | null; has_pin: boolean };

export type ReviewRow = {
  id: string; reference: string; leg: "centre_transfer" | "admin_transfer"; amount: number; created_at: string; receipt: Receipt | null; note: string | null;
  centre_name: string | null; centre_city: string | null; submitted_by: string; submitted_by_name: string; can_act: boolean;
  items: { reference: string; student_name: string; amount: number; collected_at: string }[];
};
export type AdminCash = {
  is_super: boolean; bank: OfflineDetails;
  totals: { at_centres: number; with_admins: number; settled: number };
  centres: { centre_id: string; name: string; city: string | null; at_centre: number; in_review: number; handover_pending: number; oldest: string | null }[];
  reviews: ReviewRow[];
  mine: {
    holding: number; in_review: number; has_pin: boolean;
    items: { payment_id: string; reference: string; student_name: string; amount: number; centre_name: string; collected_at: string }[];
    incoming: { id: string; reference: string; amount: number; centre_name: string; created_at: string }[];
  };
  holders: { admin_id: string; name: string; holding: number; in_review: number }[];
  recent: { id: string; reference: string; leg: CashLeg; status: CashStatus; amount: number; decided_at: string | null; decision_note: string | null; centre_name: string | null; submitted_by_name: string; to_admin_name: string | null }[];
};

export const STAGE_LABEL: Record<CashStage, string> = {
  at_centre: "With the centre", transfer_pending: "Transfer under review", handover_pending: "Hand-over in progress",
  with_admin: "With an admin", admin_transfer_pending: "Admin transfer under review", settled: "Received by IQ Academy",
};
export const LEG_LABEL: Record<CashLeg, string> = { centre_transfer: "Bank transfer from centre", handover: "Handed to an admin", admin_transfer: "Bank transfer from admin" };

/** "12,500.50" or "12500" -> kobo. NaN-safe: returns 0 for anything that is not a positive amount with at most 2 decimals. */
export function toKobo(s: string): number {
  const t = s.replace(/[,\s₦]/g, "");
  if (!/^\d+(\.\d{1,2})?$/.test(t)) return 0;
  return Math.round(Number(t) * 100);
}

/** A fresh id for a remittance. The receipt is uploaded under it first, and the same id makes a retry harmless on the server. */
export const newRemittanceId = () => crypto.randomUUID();

export type UploadedReceipt = { path: string; name: string; mime: string; size: number };

/** Uploads the receipt to payment-receipts/<uid>/<remittanceId>/<file>. The caller then sends the remittance and, if that fails, removes the file again. */
export async function uploadRemitReceipt(uid: string, remittanceId: string, file: File): Promise<UploadedReceipt> {
  const { blob, mime, ext } = await prepareReceipt(file);
  const path = `${uid}/${remittanceId}/${Date.now()}.${ext}`;
  const up = await supabase.storage.from("payment-receipts").upload(path, blob, { contentType: mime, upsert: false });
  if (up.error) throw up.error;
  return { path, name: file.name || `receipt.${ext}`, mime, size: blob.size };
}
export const removeReceipt = (path: string | null | undefined) => (path ? supabase.storage.from("payment-receipts").remove([path]).then(() => undefined, () => undefined) : Promise.resolve());

/** What the server answers when a PIN is typed for a hand-over. */
export const HANDOVER_REPLY: Record<string, string> = {
  pin_incorrect: "That PIN is wrong. Try again.",
  pin_locked: "Too many wrong PINs. Wait 15 minutes, then try again.",
  pin_not_set: "This admin hasn't set a hand-over PIN yet. They can set one on their Cash page.",
  handover_voided: "Too many wrong PINs. This hand-over was cancelled and the cash is back on your list. The admin has been told.",
};

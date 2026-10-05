// src/lib/offline.ts
// Offline (cash / bank transfer) payments: shared types and the receipt upload.
import { supabase, UserMessage } from "./supabase";

export type Receipt = { path: string; name: string; mime: string; size: number; uploaded_at: string };
export type OfflineDetails = { bank_name?: string; account_name?: string; account_number?: string; instructions?: string };
export type MyOffline = {
  id: string; reference: string; amount: number; created_at: string; enrolment_id: string; instalment_id: string | null;
  instalment_number: number | null; instalment_label: string | null; enrolment_status: string; package: string; courses: string[];
  receipt: Receipt | null; student_note: string | null;
};

export const MAX_RECEIPT = 5 * 1024 * 1024;
const OK_TYPES = ["image/jpeg", "image/png", "image/webp", "application/pdf"];

/** Phone photos are often 4-8 MB, so photos are shrunk to a readable size first; PDFs go up as they are. */
export async function prepareReceipt(file: File): Promise<{ blob: Blob; mime: string; ext: string }> {
  if (file.type === "application/pdf") {
    if (file.size > MAX_RECEIPT) throw new UserMessage("That PDF is over 5 MB. Upload a photo of the receipt instead.");
    return { blob: file, mime: "application/pdf", ext: "pdf" };
  }
  if (!file.type.startsWith("image/") && !OK_TYPES.includes(file.type)) throw new UserMessage("Upload a photo (JPG, PNG) or a PDF of your receipt.");
  try {
    const bmp = await createImageBitmap(file);
    const scale = Math.min(1, 1600 / Math.max(bmp.width, bmp.height));
    const c = document.createElement("canvas");
    c.width = Math.round(bmp.width * scale); c.height = Math.round(bmp.height * scale);
    c.getContext("2d")!.drawImage(bmp, 0, 0, c.width, c.height);
    const blob: Blob | null = await new Promise((r) => c.toBlob(r, "image/jpeg", 0.82));
    if (!blob) throw new Error("encode");
    if (blob.size > MAX_RECEIPT) throw new UserMessage("That photo is too large. Try a smaller one.");
    return { blob, mime: "image/jpeg", ext: "jpg" };
  } catch (e) {
    if (e instanceof UserMessage) throw e;
    // Couldn't decode it (unusual format): send as is if it is one we accept and small enough.
    if (OK_TYPES.includes(file.type) && file.size <= MAX_RECEIPT) return { blob: file, mime: file.type, ext: file.type.split("/")[1].replace("jpeg", "jpg") };
    throw new UserMessage("We couldn't read that photo. Try a screenshot or a PDF instead.");
  }
}

/** Uploads the file, then records it on the payment. If recording fails the file is removed again. */
export async function sendReceipt(paymentId: string, studentId: string, file: File, note: string) {
  const { blob, mime, ext } = await prepareReceipt(file);
  const path = `${studentId}/${paymentId}/${Date.now()}.${ext}`;
  const up = await supabase.storage.from("payment-receipts").upload(path, blob, { contentType: mime, upsert: false });
  if (up.error) throw up.error;
  const { error } = await supabase.rpc("submit_offline_receipt", {
    p_payment_id: paymentId, p_path: path, p_name: file.name || `receipt.${ext}`, p_mime: mime, p_size: blob.size, p_note: note.trim() || null });
  if (error) { await supabase.storage.from("payment-receipts").remove([path]); throw error; }
}

export async function receiptUrl(path: string): Promise<string | null> {
  const { data } = await supabase.storage.from("payment-receipts").createSignedUrl(path, 600);
  return data?.signedUrl ?? null;
}

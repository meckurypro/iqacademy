// src/lib/channels.ts
// Class channels: every class has its own one-way channel (instructor to the students who joined it).
// Types for the list RPCs, plus the little bits of wording shared by the student and instructor lists.
import { fmtClock, fmtDay, relativeDay } from "./time";

export type Channel = {
  session_id: string; course_title: string; lesson_title: string | null; session_date: string; start_at: string; end_at: string;
  status: string; centre_name: string; message_count: number; last_message_at: string | null; last_body: string | null; last_has_media: boolean;
  unread?: number; instructor_first_name?: string | null; joined?: number;
};

export const channelDate = (c: Pick<Channel, "session_date" | "start_at">) =>
  `${fmtDay(c.session_date, { weekday: "short", day: "numeric", month: "short" })} · ${fmtClock(c.start_at)}`;

export const channelPreview = (c: Pick<Channel, "message_count" | "last_body" | "last_has_media">) =>
  c.message_count === 0 ? "No messages yet" : c.last_body?.trim() ? c.last_body.trim() : c.last_has_media ? "Attachment" : "Message";

export const channelWhen = (iso: string | null) => (iso ? relativeDay(iso, { day: "numeric", month: "short" }) : "");

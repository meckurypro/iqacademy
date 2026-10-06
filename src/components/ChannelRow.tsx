// src/components/ChannelRow.tsx
// One class channel in a list: course, when it ran, the latest message, and (for students) how many are unread.
import { Link, useParams } from "react-router-dom";
import { Badge, Card } from "./ui";
import { channelDate, channelPreview, channelWhen, type Channel } from "../lib/channels";
import { fmtClock, dayOf, today } from "../lib/time";

export default function ChannelRow({ c, instructor }: { c: Channel; instructor?: boolean }) {
  const live = c.status === "in_progress";
  const open = useParams().id === c.session_id; // only set in the desktop two-pane inbox
  const stamp = c.last_message_at ? (dayOf(c.last_message_at) === today() ? fmtClock(c.last_message_at) : channelWhen(c.last_message_at)) : "";
  return (
    <Link to={`/messages/${c.session_id}`} className="block">
      <Card onClick={() => {}} className={`space-y-1.5 ${open ? "bg-accent/5 ring-accent/40" : ""}`}>
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0"><p className="truncate font-semibold">{c.course_title}</p>
            <p className="truncate text-sm text-muted">{[c.lesson_title, channelDate(c)].filter(Boolean).join(" · ")}</p></div>
          {live ? <Badge tone="ok">Live</Badge> : !!c.unread && <Badge tone="accent">{c.unread} new</Badge>}
        </div>
        <div className="flex items-center justify-between gap-3">
          <p className={`min-w-0 flex-1 truncate text-sm ${c.unread ? "font-medium text-ink" : "text-muted"}`}>{instructor ? channelPreview(c) : c.instructor_first_name ? `Instructor ${c.instructor_first_name}` : "Your instructor"}</p>
          <span className="shrink-0 text-xs text-muted">{instructor && c.joined !== undefined ? `${c.joined} joined${stamp ? " · " : ""}` : ""}{stamp}</span>
        </div>
      </Card>
    </Link>
  );
}

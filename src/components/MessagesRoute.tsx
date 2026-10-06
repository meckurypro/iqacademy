// src/components/MessagesRoute.tsx — /messages and /messages/:id.
// Phones: the channel list, then one channel per screen. Desktop: both at once (list on the left, chat on the right).
import { Navigate, useParams } from "react-router-dom";
import { useDesktop } from "../lib/useMedia";
import { Empty } from "./ui";
import Messages from "../pages/Messages";
import InstructorMessages from "../pages/InstructorMessages";
import ClassChannel from "../pages/ClassChannel";

export default function MessagesRoute({ role }: { role: string }) {
  const desktop = useDesktop();
  const { id } = useParams();
  if (role !== "student" && role !== "instructor") return <Navigate to="/" replace />;
  const List = role === "student" ? Messages : InstructorMessages;
  if (!desktop) return id ? <ClassChannel /> : <List />;
  return (
    <div className="grid grid-cols-[minmax(20rem,24rem)_minmax(0,1fr)] items-start gap-6">
      <aside aria-label="Class channels" className="sticky top-8 max-h-[calc(100dvh-4rem)] overflow-y-auto pr-1"><List /></aside>
      {/* keyed: ClassChannel keeps its messages in state, so switching channels must start it fresh */}
      <section className="min-w-0">{id ? <ClassChannel key={id} /> : <div className="sticky top-8"><Empty icon="messages" title="Pick a class channel" hint="Choose a class on the left to read its messages." /></div>}</section>
    </div>
  );
}

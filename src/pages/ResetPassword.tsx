// src/pages/ResetPassword.tsx
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { supabase } from "../lib/supabase";
import { useAuth } from "../lib/auth";
import { Button, Card, Err, Skeleton } from "../components/ui";
import { useFeedback } from "../components/feedback";
import { rawMessage } from "../lib/supabase";
import { isStrong } from "../lib/password";
import { MatchHint, PasswordCreator, PasswordField } from "../components/PasswordFields";

import Icon from "../components/Icon";
// Opened from the link in the reset email (also used for the one-time link given to new staff).
export default function ResetPassword() {
  const { session, loading } = useAuth(); const nav = useNavigate(); const { run } = useFeedback();
  const [pw, setPw] = useState(""); const [pw2, setPw2] = useState("");
  const [err, setErr] = useState(""); const [done, setDone] = useState(false);
  const linkError = /error/.test(location.hash + location.search);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault(); setErr("");
    if (!isStrong(pw)) return setErr("Your password needs to meet every item on the checklist.");
    if (pw !== pw2) return setErr("The two passwords don't match.");
    const r = await run("Updating password…", async () => { const { error } = await supabase.auth.updateUser({ password: pw }); if (error) throw error; }, { quiet: true });
    if (!r.ok) { const m = rawMessage(r.error); return setErr(m.includes("different") ? "Choose a password you haven't used before." : m); }
    setDone(true); setTimeout(() => nav("/", { replace: true }), 1600);
  };

  if (loading) return <div className="mx-auto max-w-sm space-y-3 p-6"><Skeleton className="h-10" /><Skeleton className="h-40" /></div>;
  if (!session || linkError) return (
    <div className="mx-auto grid min-h-screen max-w-sm content-center gap-4 p-6 text-center">
      <h1 className="text-2xl">This link has expired</h1>
      <p className="text-muted">Reset links work once and only for a short time. Request a new one and try again.</p>
      <Button onClick={() => { location.href = "/"; }}>Back to sign in</Button>
    </div>);
  return (
    <div className="mx-auto grid min-h-screen max-w-sm content-center gap-6 p-6">
      <div className="text-center"><img src="/icon-192.png" alt="" className="mx-auto mb-4 h-16 w-16 rounded-2xl shadow-card" /><h1 className="text-2xl">Choose a new password</h1><p className="mt-1 text-muted">Follow the checklist to keep your account safe.</p></div>
      <Card className="p-5">{done ? <div className="space-y-3 py-4 text-center"><div className="anim-pop mx-auto grid h-14 w-14 place-items-center rounded-full bg-ok/15 text-ok"><Icon name="check" size={28} strokeWidth={2.25} /></div><p className="font-medium">Password updated</p></div> :
        <form onSubmit={submit} className="space-y-4">
          <PasswordCreator label="New password" required value={pw} onValue={setPw} onGenerate={setPw2} />
          <PasswordField label="Confirm password" required autoComplete="new-password" value={pw2} onValue={setPw2} />
          <MatchHint a={pw} b={pw2} />
          <Err>{err}</Err><Button type="submit" disabled={!isStrong(pw) || pw !== pw2} className="w-full">Update password</Button></form>}</Card>
    </div>
  );
}

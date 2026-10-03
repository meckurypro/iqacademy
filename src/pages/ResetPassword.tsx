import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { supabase } from "../lib/supabase";
import { useAuth } from "../lib/auth";
import { Button, Card, Err, Field, Skeleton } from "../components/ui";

// Opened from the link in the reset email (also used for the one-time link given to new staff).
export default function ResetPassword() {
  const { session, loading } = useAuth(); const nav = useNavigate();
  const [pw, setPw] = useState(""); const [pw2, setPw2] = useState("");
  const [busy, setBusy] = useState(false); const [err, setErr] = useState(""); const [done, setDone] = useState(false);
  const linkError = /error/.test(location.hash + location.search);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault(); setErr("");
    if (pw !== pw2) return setErr("The two passwords don't match.");
    setBusy(true); const { error } = await supabase.auth.updateUser({ password: pw }); setBusy(false);
    if (error) return setErr(error.message.includes("different") ? "Choose a password you haven't used before." : error.message);
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
      <div className="text-center"><img src="/icon.svg" alt="" className="mx-auto mb-4 h-16 w-16 rounded-2xl shadow-card" /><h1 className="text-2xl">Choose a new password</h1><p className="mt-1 text-muted">At least 8 characters.</p></div>
      <Card className="p-5">{done ? <div className="space-y-3 py-4 text-center"><div className="anim-pop mx-auto grid h-14 w-14 place-items-center rounded-full bg-ok/15 text-2xl text-ok">✓</div><p className="font-medium">Password updated</p></div> :
        <form onSubmit={submit} className="space-y-4">
          <Field label="New password" type="password" required minLength={8} autoComplete="new-password" value={pw} onChange={(e) => setPw(e.target.value)} />
          <Field label="Confirm password" type="password" required minLength={8} autoComplete="new-password" value={pw2} onChange={(e) => setPw2(e.target.value)} />
          <Err>{err}</Err><Button type="submit" loading={busy} className="w-full">Update password</Button></form>}</Card>
    </div>
  );
}

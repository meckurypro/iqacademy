// src/pages/Login.tsx
import { useEffect, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { supabase } from "../lib/supabase";
import { setPending } from "../lib/verify";
import { isStrong } from "../lib/password";
import { Button, Card, Err, Field } from "../components/ui";
import { PasswordCreator, PasswordField } from "../components/PasswordFields";

type Mode = "in" | "up" | "forgot";
export default function Login() {
  const nav = useNavigate(); const loc = useLocation();
  const st = (loc.state ?? {}) as { mode?: Mode; email?: string };
  const [mode, setMode] = useState<Mode>(st.mode ?? "in");
  const [f, setF] = useState({ name: "", email: st.email ?? "", password: "" });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(""); const [note, setNote] = useState("");
  const go = (m: Mode) => { setMode(m); setErr(""); setNote(""); };

  // A confirmation link that failed or expired lands here with the error in the URL: send them to the verify page.
  useEffect(() => {
    if (/error_code=otp_expired|error=access_denied/.test(location.hash)) nav("/verify-email", { replace: true, state: { expired: true } });
  }, [nav]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault(); setErr(""); setNote("");
    const email = f.email.trim();
    if (mode === "up" && !isStrong(f.password)) return setErr("Your password needs to meet every item on the checklist.");
    setBusy(true);
    if (mode === "forgot") {
      await supabase.auth.resetPasswordForEmail(email, { redirectTo: `${location.origin}/reset-password` });
      setBusy(false);
      // Same message whether or not the account exists, so nobody can probe for registered emails.
      return setNote("If there's an account for that email, we've sent a link to reset your password. Check your inbox (and spam).");
    }
    const { data, error } = mode === "in"
      ? await supabase.auth.signInWithPassword({ email, password: f.password })
      : await supabase.auth.signUp({ email, password: f.password, options: { data: { full_name: f.name.trim() }, emailRedirectTo: location.origin } });
    setBusy(false);
    if (error) {
      if (/not confirmed/i.test(error.message)) { setPending(email); return nav("/verify-email", { state: { email } }); }
      return setErr(/Invalid login/i.test(error.message) ? "Wrong email or password." : error.message);
    }
    if (mode === "up" && !data.session) { setPending(email); nav("/verify-email", { state: { email } }); }
  };

  return (
    <div className="mx-auto grid min-h-screen max-w-sm content-center gap-6 p-6">
      <div className="text-center">
        <img src="/icon-192.png" alt="" className="mx-auto mb-4 h-16 w-16 rounded-2xl shadow-card" />
        <h1 className="text-2xl">{{ in: "Welcome back", up: "Join IQ Academy", forgot: "Reset your password" }[mode]}</h1>
        <p className="mt-1 text-muted">{mode === "forgot" ? "We'll email you a link to choose a new one." : "Understand. Design. Build. Automate."}</p>
      </div>
      <Card className="space-y-4 p-5">
        <form onSubmit={submit} className="space-y-4">
          {mode === "up" && <Field label="Full name" required value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} autoComplete="name" />}
          <Field label="Email" type="email" required value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} autoComplete="email" />
          {mode === "in" && <PasswordField label="Password" required value={f.password} onValue={(v) => setF({ ...f, password: v })} autoComplete="current-password" />}
          {mode === "up" && <PasswordCreator label="Password" required value={f.password} onValue={(v) => setF({ ...f, password: v })} />}
          {mode === "in" && <button type="button" onClick={() => go("forgot")} className="-mt-1 text-sm text-accent">Forgot password?</button>}
          <Err>{err}</Err>{note && <p className="rounded-xl bg-ok/10 px-3 py-2 text-sm text-ok">{note}</p>}
          <Button type="submit" loading={busy} disabled={mode === "up" && !isStrong(f.password)} className="w-full">{{ in: "Sign in", up: "Create account", forgot: "Send reset link" }[mode]}</Button>
        </form>
      </Card>
      <button className="text-sm text-muted" onClick={() => go(mode === "in" ? "up" : "in")}>
        {mode === "in" ? "New here? Create an account" : mode === "up" ? "Already have an account? Sign in" : "← Back to sign in"}
      </button>
    </div>
  );
}

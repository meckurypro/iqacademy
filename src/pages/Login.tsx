import { useState } from "react";
import { supabase } from "../lib/supabase";
import { Button, Card, Err, Field } from "../components/ui";

type Mode = "in" | "up" | "forgot";
export default function Login() {
  const [mode, setMode] = useState<Mode>("in");
  const [f, setF] = useState({ name: "", email: "", password: "" });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(""); const [note, setNote] = useState("");
  const go = (m: Mode) => { setMode(m); setErr(""); setNote(""); };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault(); setBusy(true); setErr(""); setNote("");
    if (mode === "forgot") {
      await supabase.auth.resetPasswordForEmail(f.email.trim(), { redirectTo: `${location.origin}/reset-password` });
      setBusy(false);
      // Same message whether or not the account exists, so nobody can probe for registered emails.
      return setNote("If there's an account for that email, we've sent a link to reset your password. Check your inbox (and spam).");
    }
    const { data, error } = mode === "in"
      ? await supabase.auth.signInWithPassword({ email: f.email.trim(), password: f.password })
      : await supabase.auth.signUp({ email: f.email.trim(), password: f.password, options: { data: { full_name: f.name }, emailRedirectTo: location.origin } });
    setBusy(false);
    if (error) return setErr(error.message.includes("Invalid login") ? "Wrong email or password." : error.message.includes("not confirmed") ? "Please confirm your email first. Check your inbox." : error.message);
    if (mode === "up" && !data.session) setNote("Check your email to confirm your account, then sign in.");
  };

  return (
    <div className="mx-auto grid min-h-screen max-w-sm content-center gap-6 p-6">
      <div className="text-center">
        <img src="/icon.svg" alt="" className="mx-auto mb-4 h-16 w-16 rounded-2xl shadow-card" />
        <h1 className="text-2xl">{{ in: "Welcome back", up: "Join IQ Academy", forgot: "Reset your password" }[mode]}</h1>
        <p className="mt-1 text-muted">{mode === "forgot" ? "We'll email you a link to choose a new one." : "Understand. Design. Build. Automate."}</p>
      </div>
      <Card className="space-y-4 p-5">
        <form onSubmit={submit} className="space-y-4">
          {mode === "up" && <Field label="Full name" required value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} autoComplete="name" />}
          <Field label="Email" type="email" required value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} autoComplete="email" />
          {mode !== "forgot" && <Field label="Password" type="password" required minLength={8} value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} autoComplete={mode === "in" ? "current-password" : "new-password"} />}
          {mode === "in" && <button type="button" onClick={() => go("forgot")} className="-mt-1 text-sm text-accent">Forgot password?</button>}
          <Err>{err}</Err>{note && <p className="rounded-xl bg-ok/10 px-3 py-2 text-sm text-ok">{note}</p>}
          <Button type="submit" loading={busy} className="w-full">{{ in: "Sign in", up: "Create account", forgot: "Send reset link" }[mode]}</Button>
        </form>
      </Card>
      <button className="text-sm text-muted" onClick={() => go(mode === "in" ? "up" : "in")}>
        {mode === "in" ? "New here? Create an account" : mode === "up" ? "Already have an account? Sign in" : "← Back to sign in"}
      </button>
    </div>
  );
}

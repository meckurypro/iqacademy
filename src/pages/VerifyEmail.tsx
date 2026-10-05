// src/pages/VerifyEmail.tsx
import { useCallback, useEffect, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { supabase } from "../lib/supabase";
import { useAuth } from "../lib/auth";
import { clearPending, getPending, inboxLink, setPending } from "../lib/verify";
import { Button, Card, Err, Field } from "../components/ui";
import { useFeedback } from "../components/feedback";

import Icon from "../components/Icon";
const COOLDOWN = 60;
const cdKey = (e: string) => `iq:resend-at:${e}`;
const remaining = (email: string) => {
  try { return Math.max(0, COOLDOWN - Math.floor((Date.now() - Number(localStorage.getItem(cdKey(email)) || 0)) / 1000)); } catch { return 0; }
};

const Mail = () => <Icon name="mail" size={30} />;

export default function VerifyEmail() {
  const { session, name } = useAuth(); const nav = useNavigate(); const loc = useLocation(); const { run } = useFeedback();
  const st = (loc.state ?? {}) as { email?: string; expired?: boolean };
  const [email, setEmail] = useState(() => (st.email || getPending()?.email || "").toLowerCase());
  const [typed, setTyped] = useState("");
  const expired = !!st.expired || /otp_expired|access_denied|error_code/.test(location.hash + location.search);
  const [left, setLeft] = useState(() => (email ? remaining(email) : 0));
  const [err, setErr] = useState(""); const [sent, setSent] = useState(false);

  // Tidy error params out of the address bar once we've read them.
  useEffect(() => { if (/error/.test(location.hash)) history.replaceState(null, "", location.pathname); }, []);

  useEffect(() => {
    if (left <= 0) return;
    const t = setTimeout(() => setLeft(email ? remaining(email) : 0), 1000);
    return () => clearTimeout(t);
  }, [left, email]);

  const resend = useCallback(async (to: string) => {
    setErr(""); setSent(false);
    const r = await run("Sending email…", async () => await supabase.auth.resend({ type: "signup", email: to, options: { emailRedirectTo: location.origin } }), { quiet: true });
    if (!r.ok) return setErr(r.message);
    const { error } = r.data;
    if (error) {
      if (/second|rate|limit|too many/i.test(error.message)) { try { localStorage.setItem(cdKey(to), String(Date.now())); } catch { /* ignore */ } setLeft(COOLDOWN); return setErr("Please wait a moment before asking for another email."); }
      return setErr("We couldn't send that just now. Check the address and try again.");
    }
    try { localStorage.setItem(cdKey(to), String(Date.now())); } catch { /* ignore */ }
    setLeft(COOLDOWN); setSent(true);
  }, [run]);

  // 1) Signed in: the link worked.
  if (session) {
    const first = (name || "").split(" ")[0];
    return (
      <Shell>
        <div className="anim-pop mx-auto grid h-16 w-16 place-items-center rounded-full bg-ok/15 text-ok"><Icon name="check" size={32} strokeWidth={2.25} /></div>
        <div className="space-y-1.5 text-center">
          <h1 className="text-[26px] leading-tight">You're verified{first ? `, ${first}` : ""}</h1>
          <p className="text-muted">Your email is confirmed and your account is ready.</p>
        </div>
        <Button className="w-full" onClick={() => { clearPending(); nav("/", { replace: true }); }}>Continue to IQ Academy</Button>
      </Shell>
    );
  }

  // 2) We don't know which address to verify (opened directly or from another device).
  if (!email) return (
    <Shell>
      <div className="space-y-1.5 text-center"><h1 className="text-[26px] leading-tight">Verify your email</h1><p className="text-muted">Enter the address you signed up with and we'll send a fresh link.</p></div>
      <Card className="p-5"><form className="space-y-4" onSubmit={(e) => { e.preventDefault(); const v = typed.trim().toLowerCase(); setPending(v); setEmail(v); setLeft(0); resend(v); }}>
        <Field label="Email" type="email" required autoComplete="email" value={typed} onChange={(e) => setTyped(e.target.value)} />
        <Button type="submit" className="w-full">Send verification link</Button>
      </form></Card>
      <button className="text-sm text-muted" onClick={() => nav("/", { replace: true })}><span className="inline-flex items-center gap-1.5"><Icon name="arrowLeft" size={16} />Back to sign in</span></button>
    </Shell>
  );

  // 3) Waiting for the click (or the link expired).
  const inbox = inboxLink(email);
  return (
    <Shell>
      <div className={`anim-pop mx-auto grid h-16 w-16 place-items-center rounded-full ${expired ? "bg-warn/15 text-warn" : "bg-accent/15 text-accent"}`}><Mail /></div>
      <div className="space-y-1.5 text-center">
        <h1 className="text-[26px] leading-tight">{expired ? "That link has expired" : "Check your email"}</h1>
        <p className="text-muted">{expired ? "Confirmation links work once and only for a short time. Send yourself a new one." : <>We sent a confirmation link to <span className="break-all font-medium text-ink">{email}</span></>}</p>
      </div>

      {!expired && (
        <Card className="space-y-3 p-5">
          {[["Open the email from IQ Academy", "It can take a minute. Check spam or promotions too."], ["Tap “Confirm your email”", "Any device works."], ["You'll be signed in automatically", "This page updates itself if you confirm on this device."]].map(([t, d], i) => (
            <div key={t} className="flex gap-3">
              <span className="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-sunken text-xs font-semibold text-muted">{i + 1}</span>
              <div className="text-sm leading-snug"><p className="font-medium">{t}</p><p className="text-muted">{d}</p></div>
            </div>))}
        </Card>)}

      <div className="space-y-3">
        {inbox && !expired && <a href={inbox.url} target="_blank" rel="noreferrer" className="inline-flex h-12 w-full items-center justify-center rounded-xl bg-accent text-[15px] font-medium text-accent-ink shadow-card transition active:scale-[.98]">Open {inbox.name}</a>}
        <Button variant={inbox && !expired ? "secondary" : "primary"} className="w-full" disabled={left > 0} onClick={() => resend(email)}>
          {left > 0 ? `Resend email in ${left}s` : expired ? "Send a new link" : "Resend email"}
        </Button>
        <Err>{err}</Err>
        {sent && <p className="anim-fade rounded-xl bg-ok/10 px-3 py-2 text-sm text-ok" role="status">Sent. Look for the newest email in your inbox.</p>}
      </div>

      <div className="flex flex-col items-center gap-2 text-sm text-muted">
        <button onClick={() => nav("/", { replace: true, state: { mode: "in", email } })} className="text-accent">I've confirmed. Sign in</button>
        <button onClick={() => { clearPending(); nav("/", { replace: true, state: { mode: "up" } }); }}>Wrong email? Start over</button>
      </div>
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="mx-auto grid min-h-screen max-w-sm content-center gap-6 p-6">
      <img src="/icon-192.png" alt="" className="mx-auto h-12 w-12 rounded-2xl shadow-card" />
      {children}
    </div>
  );
}

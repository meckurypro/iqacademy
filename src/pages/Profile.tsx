import { useEffect, useState } from "react";
import { supabase, rawMessage } from "../lib/supabase";
import { touched } from "../lib/db";
import { useFeedback } from "../components/feedback";
import { useAuth, primaryRole, roleLabel } from "../lib/auth";
import { Avatar, Button, Card, Err, Field, PageHeader, Sheet, cx } from "../components/ui";
import { isStrong } from "../lib/password";
import { useTheme, type ThemePref } from "../lib/theme";
import { MatchHint, PasswordCreator, PasswordField } from "../components/PasswordFields";

import Icon, { type IconName } from "../components/Icon";
import MyCentres from "../components/MyCentres";
import { copyText } from "../lib/messages";
import { ChangePinForm, PinSetup } from "../components/PinInput";
import { needsDoorPin } from "../lib/doorLock";
export default function Profile() {
  const { session, name, avatar, roles, refresh } = useAuth(); const { run, toast } = useFeedback();
  const uid = session!.user.id;
  const [full, setFull] = useState(name); const [phone, setPhone] = useState(""); const [phone0, setPhone0] = useState("");
  const [err, setErr] = useState("");
  const [pwOpen, setPwOpen] = useState(false);
  const [theme, setTheme] = useTheme();
  const [regNo, setRegNo] = useState(""); const [hasPin, setHasPin] = useState<boolean | null>(null); const [pinOpen, setPinOpen] = useState(false);
  // A registration number and check-in PIN belong to students. Staff have a separate door PIN (instructors and coordinators only).
  const isStudent = primaryRole(roles) === "student"; const doorStaff = needsDoorPin(roles);
  const [hasDoorPin, setHasDoorPin] = useState<boolean | null>(null); const [doorOpen, setDoorOpen] = useState(false);
  useEffect(() => { if (isStudent) supabase.from("students").select("student_number").eq("id", uid).maybeSingle().then((r) => setRegNo((r.data?.student_number as string | null) ?? "")); }, [uid, isStudent]);
  useEffect(() => { if (isStudent && regNo) supabase.rpc("has_pin").then((r) => setHasPin(r.error ? null : r.data === true)); }, [regNo, isStudent]);
  useEffect(() => { if (doorStaff) supabase.rpc("has_staff_pin").then((r) => setHasDoorPin(r.error ? null : r.data === true)); }, [doorStaff]);
  useEffect(() => { setFull(name); }, [name]);
  useEffect(() => { supabase.from("profiles").select("phone").eq("id", uid).maybeSingle().then((r) => { const p = (r.data?.phone as string | null) ?? ""; setPhone(p); setPhone0(p); }); }, [uid]);

  const upload = async (f: File) => {
    setErr("");
    const r = await run("Uploading photo…", async () => {
      const path = `${uid}/avatar-${Date.now()}.${f.name.split(".").pop()?.toLowerCase() ?? "jpg"}`;
      const up = await supabase.storage.from("avatars").upload(path, f, { upsert: true, contentType: f.type });
      if (up.error) throw new Error("photo_upload_failed");
      const url = supabase.storage.from("avatars").getPublicUrl(path).data.publicUrl;
      touched(await supabase.from("profiles").update({ avatar_url: url }).eq("id", uid).select("id"));
      await refresh();
    }, { success: "Photo updated", quiet: true });
    if (!r.ok) setErr(r.message);
  };
  const save = async () => {
    setErr("");
    const r = await run("Saving profile…", async () => {
      const patch: Record<string, unknown> = { full_name: full.trim() };
      if (phone.trim() !== phone0) patch.phone = phone.trim() || null;
      touched(await supabase.from("profiles").update(patch).eq("id", uid).select("id"));
      setPhone0(phone.trim());
      await refresh();
    }, { success: "Profile saved", quiet: true });
    if (!r.ok) setErr(r.message);
  };
  return (
    <div className="space-y-5">
      <PageHeader title="Profile" />
      <Card className="flex flex-col items-center gap-3 p-6">
        <Avatar name={name || "?"} url={avatar} size={96} />
        <label className="cursor-pointer rounded-xl bg-surface px-4 py-2 text-sm font-medium ring-1 ring-line transition hover:bg-sunken active:scale-95">Change photo
          <input type="file" accept="image/jpeg,image/png,image/webp" className="hidden" onChange={(e) => { const file = e.target.files?.[0]; e.target.value = ""; if (file) upload(file); }} /></label>
        <p className="text-sm text-muted">{roleLabel[primaryRole(roles)]} · {session!.user.email}</p>
      </Card>
      {isStudent && regNo && <Card className="flex items-center gap-3">
        <div className="min-w-0 flex-1 leading-snug"><p className="text-sm text-muted">Registration number</p><p className="num text-xl font-semibold tracking-wide">{regNo}</p>
        </div>
        <Button variant="secondary" className="h-9 px-4 text-sm" onClick={() => copyText(regNo).then(() => toast("Copied"))}>Copy</Button>
      </Card>}
      {isStudent && regNo && hasPin !== null && <Card className="flex items-center gap-3">
        <span className="grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-accent/10 text-accent"><Icon name="lock" size={22} /></span>
        <div className="min-w-0 flex-1 leading-snug"><p className="font-medium">Check-in PIN</p>
          <p className="text-sm text-muted">{hasPin ? "Set. Needed if someone has to check you in by hand." : "Not set yet. Set one so you can be checked in by hand."}</p></div>
        <Button variant="secondary" className="h-9 px-4 text-sm" onClick={() => setPinOpen(true)}>{hasPin ? "Change" : "Set PIN"}</Button>
      </Card>}
      <Sheet open={pinOpen} onClose={() => setPinOpen(false)} title={hasPin ? "Change your PIN" : "Set your PIN"}>
        {hasPin ? <ChangePinForm onDone={() => setPinOpen(false)} /> : <PinSetup onDone={() => { setHasPin(true); setPinOpen(false); }} />}
      </Sheet>
      {doorStaff && hasDoorPin !== null && <Card className="flex items-center gap-3">
        <span className="grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-accent/10 text-accent"><Icon name="lock" size={22} /></span>
        <div className="min-w-0 flex-1 leading-snug"><p className="font-medium">Door PIN</p>
          <p className="text-sm text-muted">{hasDoorPin ? "Set. Asked before the class code is shown or a student is checked in by hand." : "Not set yet. You'll be asked to choose one when you first open check-in."}</p></div>
        <Button variant="secondary" className="h-9 px-4 text-sm" onClick={() => setDoorOpen(true)}>{hasDoorPin ? "Change" : "Set PIN"}</Button>
      </Card>}
      <Sheet open={doorOpen} onClose={() => setDoorOpen(false)} title={hasDoorPin ? "Change your door PIN" : "Set your door PIN"}>
        {hasDoorPin ? <ChangePinForm staff onDone={() => setDoorOpen(false)} /> : <PinSetup staff onDone={() => { setHasDoorPin(true); setDoorOpen(false); }} />}
      </Sheet>
      <MyCentres />
      <Card className="space-y-4">
        <Field label="Full name" value={full} onChange={(e) => setFull(e.target.value)} />
        <Field label="Phone" type="tel" placeholder="Optional" value={phone} onChange={(e) => setPhone(e.target.value)} />
        <Err>{err}</Err>
        <Button className="w-full" disabled={!full.trim()} onClick={save}>Save changes</Button>
      </Card>
      <Card className="flex items-center justify-between gap-4">
        <div><h2 className="text-base">Password</h2><p className="text-sm text-muted">Keep your account secure.</p></div>
        <Button variant="secondary" onClick={() => setPwOpen(true)}>Change password</Button>
      </Card>
      <ChangePasswordSheet open={pwOpen} onClose={() => setPwOpen(false)} />
      <Card className="space-y-3">
        <h2 className="text-base">Appearance</h2>
        <div role="radiogroup" aria-label="Theme" className="grid grid-cols-3 gap-1 rounded-xl bg-sunken p-1">
          {([["light", "sun", "Light"], ["dark", "moon", "Dark"], ["system", "monitor", "System"]] as [ThemePref, IconName, string][]).map(([v, ic, l]) => (
            <button key={v} role="radio" aria-checked={theme === v} onClick={() => setTheme(v)}
              className={cx("flex h-10 items-center justify-center gap-1.5 rounded-lg text-sm font-medium transition", theme === v ? "bg-surface text-ink shadow-card" : "text-muted")}>
              <Icon name={ic} size={18} />{l}
            </button>))}
        </div>
      </Card>
      <Button variant="ghost" className="w-full text-bad hover:bg-bad/10 hover:text-bad" onClick={() => run("Signing out…", () => supabase.auth.signOut())}>Sign out</Button>
    </div>
  );
}

function ChangePasswordSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [pw, setPw] = useState(""); const [pw2, setPw2] = useState("");
  const { run } = useFeedback();
  const [err, setErr] = useState(""); const [done, setDone] = useState(false);
  const close = () => { setPw(""); setPw2(""); setErr(""); setDone(false); onClose(); };
  const submit = async (e: React.FormEvent) => {
    e.preventDefault(); setErr("");
    if (!isStrong(pw)) return setErr("Your password needs to meet every item on the checklist.");
    if (pw !== pw2) return setErr("The two passwords don't match.");
    const r = await run("Updating password…", async () => { const { error } = await supabase.auth.updateUser({ password: pw }); if (error) throw error; }, { quiet: true });
    if (!r.ok) return setErr(rawMessage(r.error));
    setDone(true); setTimeout(close, 1400);
  };
  return (
    <Sheet open={open} onClose={close} title={done ? undefined : "Change password"}>
      {done ? (
        <div className="grid justify-items-center gap-3 py-6 text-center">
          <div className="anim-pop grid h-14 w-14 place-items-center rounded-full bg-ok/15 text-ok"><Icon name="check" size={28} strokeWidth={2.25} /></div>
          <p className="text-lg font-medium">Password updated</p>
        </div>
      ) : (
        <form onSubmit={submit} className="space-y-4">
          <PasswordCreator label="New password" value={pw} onValue={setPw} onGenerate={setPw2} />
          <PasswordField label="Confirm password" autoComplete="new-password" value={pw2} onValue={setPw2} />
          <MatchHint a={pw} b={pw2} />
          <Err>{err}</Err>
          <div className="grid grid-cols-2 gap-2">
            <Button type="button" variant="secondary" onClick={close}>Cancel</Button>
            <Button type="submit" disabled={!isStrong(pw) || pw !== pw2}>Update</Button>
          </div>
        </form>)}
    </Sheet>
  );
}

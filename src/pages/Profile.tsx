import { useEffect, useState } from "react";
import { supabase, rawMessage } from "../lib/supabase";
import { touched } from "../lib/db";
import { useFeedback } from "../components/feedback";
import { useAuth, primaryRole, roleLabel } from "../lib/auth";
import { Avatar, Button, Card, Err, Field, Sheet, cx } from "../components/ui";
import { isStrong } from "../lib/password";
import { useTheme, type ThemePref } from "../lib/theme";
import { MatchHint, PasswordCreator, PasswordField } from "../components/PasswordFields";

import Icon, { type IconName } from "../components/Icon";
export default function Profile() {
  const { session, name, avatar, roles, refresh } = useAuth(); const { run } = useFeedback();
  const uid = session!.user.id;
  const [full, setFull] = useState(name); const [phone, setPhone] = useState(""); const [phone0, setPhone0] = useState("");
  const [err, setErr] = useState("");
  const [pwOpen, setPwOpen] = useState(false);
  const [theme, setTheme] = useTheme();
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
      <h1 className="text-2xl">Profile</h1>
      <Card className="flex flex-col items-center gap-3 p-6">
        <Avatar name={name || "?"} url={avatar} size={96} />
        <label className="cursor-pointer rounded-xl bg-sunken px-4 py-2 text-sm font-medium transition active:scale-95">Change photo
          <input type="file" accept="image/jpeg,image/png,image/webp" className="hidden" onChange={(e) => { const file = e.target.files?.[0]; e.target.value = ""; if (file) upload(file); }} /></label>
        <p className="text-sm text-muted">{roleLabel[primaryRole(roles)]} · {session!.user.email}</p>
      </Card>
      <Card className="space-y-4">
        <Field label="Full name" value={full} onChange={(e) => setFull(e.target.value)} />
        <Field label="Phone" type="tel" placeholder="Optional" value={phone} onChange={(e) => setPhone(e.target.value)} />
        <Err>{err}</Err>
        <Button className="w-full" disabled={!full.trim()} onClick={save}>Save changes</Button>
      </Card>
      <Card className="flex items-center justify-between gap-4">
        <div><h2 className="text-lg">Password</h2><p className="text-sm text-muted">Keep your account secure.</p></div>
        <Button variant="secondary" onClick={() => setPwOpen(true)}>Change password</Button>
      </Card>
      <ChangePasswordSheet open={pwOpen} onClose={() => setPwOpen(false)} />
      <Card className="space-y-3">
        <h2 className="text-lg">Appearance</h2>
        <div role="radiogroup" aria-label="Theme" className="grid grid-cols-3 gap-1 rounded-xl bg-sunken p-1">
          {([["light", "sun", "Light"], ["dark", "moon", "Dark"], ["system", "monitor", "System"]] as [ThemePref, IconName, string][]).map(([v, ic, l]) => (
            <button key={v} role="radio" aria-checked={theme === v} onClick={() => setTheme(v)}
              className={cx("flex h-10 items-center justify-center gap-1.5 rounded-lg text-sm font-medium transition", theme === v ? "bg-surface text-ink shadow-card" : "text-muted")}>
              <Icon name={ic} size={18} />{l}
            </button>))}
        </div>
      </Card>
      <Button variant="secondary" className="w-full text-bad" onClick={() => run("Signing out…", () => supabase.auth.signOut())}>Sign out</Button>
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

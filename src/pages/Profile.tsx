import { useState } from "react";
import { supabase } from "../lib/supabase";
import { useAuth, primaryRole, roleLabel } from "../lib/auth";
import { Avatar, Button, Card, Err, Field, Sheet, cx } from "../components/ui";
import { isStrong } from "../lib/password";
import { useTheme, type ThemePref } from "../lib/theme";
import { MatchHint, PasswordCreator, PasswordField } from "../components/PasswordFields";

export default function Profile() {
  const { session, name, avatar, roles, refresh } = useAuth();
  const [full, setFull] = useState(name); const [phone, setPhone] = useState("");
  const [busy, setBusy] = useState(""); const [err, setErr] = useState(""); const [saved, setSaved] = useState(false);
  const [pwOpen, setPwOpen] = useState(false);
  const [theme, setTheme] = useTheme();
  const uid = session!.user.id;
  const upload = async (f: File) => {
    setBusy("photo"); setErr("");
    const path = `${uid}/avatar-${Date.now()}.${f.name.split(".").pop()?.toLowerCase() ?? "jpg"}`;
    const up = await supabase.storage.from("avatars").upload(path, f, { upsert: true, contentType: f.type });
    if (up.error) { setBusy(""); return setErr("Photo upload failed. Use a JPG, PNG or WebP under 2 MB."); }
    const url = supabase.storage.from("avatars").getPublicUrl(path).data.publicUrl;
    await supabase.from("profiles").update({ avatar_url: url }).eq("id", uid);
    setBusy(""); refresh();
  };
  const save = async () => {
    setBusy("save"); setErr("");
    const { error } = await supabase.from("profiles").update({ full_name: full.trim(), ...(phone ? { phone } : {}) }).eq("id", uid);
    setBusy(""); if (error) return setErr("Couldn't save. Please try again."); setSaved(true); refresh(); setTimeout(() => setSaved(false), 1800);
  };
  return (
    <div className="space-y-5">
      <h1 className="text-2xl">Profile</h1>
      <Card className="flex flex-col items-center gap-3 p-6">
        <Avatar name={name || "?"} url={avatar} size={96} />
        <label className="cursor-pointer rounded-xl bg-sunken px-4 py-2 text-sm font-medium transition active:scale-95">{busy === "photo" ? "Uploading…" : "Change photo"}
          <input type="file" accept="image/jpeg,image/png,image/webp" className="hidden" onChange={(e) => e.target.files?.[0] && upload(e.target.files[0])} /></label>
        <p className="text-sm text-muted">{roleLabel[primaryRole(roles)]} · {session!.user.email}</p>
      </Card>
      <Card className="space-y-4">
        <Field label="Full name" value={full} onChange={(e) => setFull(e.target.value)} />
        <Field label="Phone" type="tel" placeholder="Optional" value={phone} onChange={(e) => setPhone(e.target.value)} />
        <Err>{err}</Err>
        <Button className="w-full" loading={busy === "save"} onClick={save}>{saved ? "Saved ✓" : "Save changes"}</Button>
      </Card>
      <Card className="flex items-center justify-between gap-4">
        <div><h2 className="text-lg">Password</h2><p className="text-sm text-muted">Keep your account secure.</p></div>
        <Button variant="secondary" onClick={() => setPwOpen(true)}>Change password</Button>
      </Card>
      <ChangePasswordSheet open={pwOpen} onClose={() => setPwOpen(false)} />
      <Card className="space-y-3">
        <h2 className="text-lg">Appearance</h2>
        <div role="radiogroup" aria-label="Theme" className="grid grid-cols-3 gap-1 rounded-xl bg-sunken p-1">
          {([["light", "☀️", "Light"], ["dark", "🌙", "Dark"], ["system", "💻", "System"]] as [ThemePref, string, string][]).map(([v, ic, l]) => (
            <button key={v} role="radio" aria-checked={theme === v} onClick={() => setTheme(v)}
              className={cx("flex h-10 items-center justify-center gap-1.5 rounded-lg text-sm font-medium transition", theme === v ? "bg-surface text-ink shadow-card" : "text-muted")}>
              <span aria-hidden="true">{ic}</span>{l}
            </button>))}
        </div>
      </Card>
      <Button variant="secondary" className="w-full text-bad" onClick={() => supabase.auth.signOut()}>Sign out</Button>
    </div>
  );
}

function ChangePasswordSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [pw, setPw] = useState(""); const [pw2, setPw2] = useState("");
  const [busy, setBusy] = useState(false); const [err, setErr] = useState(""); const [done, setDone] = useState(false);
  const close = () => { setPw(""); setPw2(""); setErr(""); setDone(false); onClose(); };
  const submit = async (e: React.FormEvent) => {
    e.preventDefault(); setErr("");
    if (!isStrong(pw)) return setErr("Your password needs to meet every item on the checklist.");
    if (pw !== pw2) return setErr("The two passwords don't match.");
    setBusy(true); const { error } = await supabase.auth.updateUser({ password: pw }); setBusy(false);
    if (error) return setErr(error.message);
    setDone(true); setTimeout(close, 1400);
  };
  return (
    <Sheet open={open} onClose={close} title={done ? undefined : "Change password"}>
      {done ? (
        <div className="grid justify-items-center gap-3 py-6 text-center">
          <div className="anim-pop grid h-14 w-14 place-items-center rounded-full bg-ok/15 text-2xl text-ok">✓</div>
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
            <Button type="submit" loading={busy} disabled={!isStrong(pw) || pw !== pw2}>Update</Button>
          </div>
        </form>)}
    </Sheet>
  );
}

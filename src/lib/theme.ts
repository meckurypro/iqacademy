// src/lib/theme.ts
import { useEffect, useState } from "react";

export type ThemePref = "light" | "dark" | "system";

export const getThemePref = (): ThemePref => {
  try { const t = localStorage.getItem("theme"); return t === "light" || t === "dark" ? t : "system"; } catch { return "system"; }
};

export function applyThemePref(p: ThemePref) {
  const dark = p === "dark" || (p === "system" && matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.dataset.theme = dark ? "dark" : "light";
  try { if (p === "system") localStorage.removeItem("theme"); else localStorage.setItem("theme", p); } catch { /* storage unavailable */ }
}

export function useTheme(): [ThemePref, (p: ThemePref) => void] {
  const [pref, setPref] = useState<ThemePref>(getThemePref);
  useEffect(() => {
    if (pref !== "system") return;
    const mq = matchMedia("(prefers-color-scheme: dark)");
    const on = () => applyThemePref("system");
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, [pref]);
  return [pref, (p) => { applyThemePref(p); setPref(p); }];
}

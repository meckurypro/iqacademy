// src/lib/theme.ts
import { useEffect, useState } from "react";

export type ThemePref = "light" | "dark" | "system";

export const getThemePref = (): ThemePref => {
  try { const t = localStorage.getItem("theme"); return t === "light" || t === "dark" ? t : "system"; } catch { return "system"; }
};

/** The page background (--bg) in each theme, as hex, so the phone's status bar and navigation bar can match it. Keep in step with index.css. */
export const THEME_COLOR = { light: "#faf9f6", dark: "#0d0b08" } as const;

/** Paint the phone's system bars (clock, signal and notifications at the top; the navigation area at the bottom) in the app's theme colour. */
export function syncThemeColor() {
  const dark = document.documentElement.dataset.theme === "dark";
  const color = dark ? THEME_COLOR.dark : THEME_COLOR.light;
  // A browser that finds several theme-color tags may pick by media query rather than by our choice, so keep exactly one.
  const tags = [...document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]')];
  const tag = tags[0] ?? document.head.appendChild(Object.assign(document.createElement("meta"), { name: "theme-color" }));
  tags.slice(1).forEach((t) => t.remove());
  tag.removeAttribute("media"); tag.content = color;
  document.documentElement.style.colorScheme = dark ? "dark" : "light";
}

/** Run once at start-up. Keeps the system bars in step with the theme however it changes, and follows the phone's own
 *  light/dark switch while the preference is "System" (which used to be noticed only on the Profile page). */
export function watchTheme() {
  syncThemeColor();
  new MutationObserver(syncThemeColor).observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
  matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => { if (getThemePref() === "system") applyThemePref("system"); });
}

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

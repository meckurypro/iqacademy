// src/lib/useMedia.ts — subscribe to a CSS media query.
import { useEffect, useState } from "react";

export function useMedia(query: string): boolean {
  const [match, setMatch] = useState(() => typeof matchMedia !== "undefined" && matchMedia(query).matches);
  useEffect(() => {
    const mq = matchMedia(query);
    const on = () => setMatch(mq.matches);
    on();
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, [query]);
  return match;
}

/** Same breakpoint as Tailwind's `lg`. At or above it the app swaps the bottom tabs + hamburger for a sidebar. */
export const DESKTOP_QUERY = "(min-width: 1024px)";
export const useDesktop = () => useMedia(DESKTOP_QUERY);

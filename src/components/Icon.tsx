// src/components/Icon.tsx — the app's one icon set.
//
// Every icon is drawn on a 24px grid with the same 1.75 stroke, round caps and joins, and the same corner radii,
// so they read as one family. Nothing here is an emoji or a font glyph: colour comes from `currentColor`, which
// means icons follow the theme (light, dark) and never change shape between phones.
//
// Navigation icons also have a solid form (`solid`) used for the active tab: the body fills in, the inner
// details are cut out of it. Utility icons (arrows, check, close...) are line only.
import type { ReactNode, SVGProps } from "react";

type Layers = {
  /** Closed shapes. Outlined normally, filled when `solid`. */
  body?: ReactNode;
  /** Details drawn on top of the body. Stroked in the ink colour normally, cut out of the fill when `solid`. */
  cut?: ReactNode;
  /** Small filled marks (dots). Same cut-out behaviour as `cut`. */
  dots?: ReactNode;
  /** Strokes that sit outside the body and stay in the ink colour in both forms. */
  line?: ReactNode;
};

const r = (x: number, y: number, w: number, h: number, rx: number) => <rect x={x} y={y} width={w} height={h} rx={rx} />;
const dot = (cx: number, cy: number, rad = 1) => <circle cx={cx} cy={cy} r={rad} />;

const ICONS = {
  // ───────── navigation (line + solid) ─────────
  home: {
    body: <path d="M4 10.8 12 4l8 6.8v8.4a.8.8 0 0 1-.8.8H4.8a.8.8 0 0 1-.8-.8z" />,
    cut: <path d="M10 20v-5h4v5" />,
  },
  messages: {
    body: <path d="M6 4.5h12A2 2 0 0 1 20 6.5v8a2 2 0 0 1-2 2h-6.2L8 19.8v-3.3H6a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2z" />,
    cut: <path d="M8.5 9h7M8.5 12h4.5" />,
  },
  today: {
    body: r(4, 5, 16, 15, 2.5),
    line: <path d="M8 3.5v3M16 3.5v3" />,
    cut: <path d="M4 10h16" />,
    dots: <rect x="8" y="13" width="3.5" height="3.5" rx=".8" />,
  },
  classes: {
    body: <path d="M12 6.6C10.2 5.2 7.8 4.6 4.6 4.8a.6.6 0 0 0-.6.6v11.7c0 .35.27.62.62.6 3.1-.12 5.3.4 7.38 1.9 2.08-1.5 4.28-2.02 7.38-1.9a.6.6 0 0 0 .62-.6V5.4a.6.6 0 0 0-.6-.6c-3.2-.2-5.6.4-7.4 1.8z" />,
    cut: <path d="M12 6.6V19" />,
  },
  calendarPlus: {
    body: r(4, 5, 16, 15, 2.5),
    line: <path d="M8 3.5v3M16 3.5v3" />,
    cut: <path d="M4 10h16M12 12.6v4.4M9.8 14.8h4.4" />,
  },
  schedule: {
    body: r(4, 4, 16, 16, 2.5),
    dots: <><circle cx="8" cy="9" r="1" /><circle cx="8" cy="12" r="1" /><circle cx="8" cy="15" r="1" /></>,
    cut: <path d="M11.5 9H16M11.5 12H16M11.5 15H14.5" />,
  },
  history: {
    body: <circle cx="12" cy="12" r="8" />,
    cut: <path d="M12 7.8v4.4l2.9 1.8" />,
  },
  overview: {
    body: <><rect x="4" y="12" width="4" height="8" rx="1" /><rect x="10" y="4" width="4" height="16" rx="1" /><rect x="16" y="8.5" width="4" height="11.5" rx="1" /></>,
  },
  users: {
    body: <><circle cx="9.5" cy="8.5" r="3.5" /><path d="M3 19.8v-.8a5 5 0 0 1 5-5h3a5 5 0 0 1 5 5v.8z" /></>,
    line: <path d="M15.6 5.2a3.5 3.5 0 0 1 0 6.6M18.4 14.4A5 5 0 0 1 21 19v.8" />,
  },
  userPlus: {
    body: <><circle cx="10" cy="8.5" r="3.5" /><path d="M3.5 19.8v-.8a5 5 0 0 1 5-5h3a5 5 0 0 1 5 5v.8z" /></>,
    line: <path d="M19 8v6M16 11h6" />,
  },
  announce: {
    body: <path d="M4 10.5v3a1 1 0 0 0 1 1h2.5l7.5 4a.8.8 0 0 0 1.2-.7V6.2a.8.8 0 0 0-1.2-.7l-7.5 4H5a1 1 0 0 0-1 1z" />,
    line: <path d="M19.4 9.3a4.2 4.2 0 0 1 0 5.4" />,
  },
  manage: {
    body: <><circle cx="15" cy="7" r="2" /><circle cx="9" cy="12" r="2" /><circle cx="17" cy="17" r="2" /></>,
    line: <path d="M4 7h9M17 7h3M4 12h3M11 12h9M4 17h11M19 17h1" />,
  },
  enrol: {
    body: <path d="M12 4.5 2.5 9.5 12 14.5l9.5-5z" />,
    line: <path d="M6 12.2v4.3c0 1.2 2.7 2.7 6 2.7s6-1.5 6-2.7v-4.3M21.5 9.5v5" />,
  },
  bell: {
    body: <path d="M5.5 17.5C6.5 16.5 7 15 7 12v-2a5 5 0 0 1 10 0v2c0 3 .5 4.5 1.5 5.5a.5.5 0 0 1-.4.8H5.9a.5.5 0 0 1-.4-.8z" />,
    line: <path d="M10 20.5a2.2 2.2 0 0 0 4 0" />,
  },

  // ───────── things in the Manage area ─────────
  centres: {
    body: <><path d="M5 20V6.5A1.5 1.5 0 0 1 6.5 5h6A1.5 1.5 0 0 1 14 6.5V20z" /><path d="M14 11h3.5a1.5 1.5 0 0 1 1.5 1.5V20h-5" /></>,
    cut: <path d="M8 9h3M8 12.5h3M8 16h3" />,
    line: <path d="M3.5 20h17" />,
  },
  roster: {
    body: r(4, 5, 16, 14, 2.5),
    cut: <><circle cx="9.5" cy="10.6" r="1.7" /><path d="M6.8 16c.5-1.4 1.6-2.1 2.7-2.1s2.2.7 2.7 2.1M14.5 10h3M14.5 13.5h3" /></>,
  },
  courses: {
    body: <path d="M12 3.5 3.5 8 12 12.5 20.5 8z" />,
    line: <path d="M3.5 12 12 16.5 20.5 12M3.5 16 12 20.5 20.5 16" />,
  },
  prices: {
    body: <path d="M3.5 11.2V5.5a2 2 0 0 1 2-2h5.7a2 2 0 0 1 1.4.6l8 8a2 2 0 0 1 0 2.8l-5.7 5.7a2 2 0 0 1-2.8 0l-8-8a2 2 0 0 1-.6-1.4z" />,
    dots: dot(8, 8, 1.4),
  },
  cash: {
    body: r(3, 6.5, 18, 11, 2.5),
    cut: dot(12, 12, 2.4),
    dots: <><circle cx="6.6" cy="12" r=".8" /><circle cx="17.4" cy="12" r=".8" /></>,
  },
  receipt: {
    body: <path d="M6 3.5h12a.5.5 0 0 1 .5.5v16.3a.4.4 0 0 1-.65.3L16 19l-1.85 1.4a.4.4 0 0 1-.5 0L12 19l-1.65 1.4a.4.4 0 0 1-.5 0L8 19l-1.85 1.6a.4.4 0 0 1-.65-.3V4a.5.5 0 0 1 .5-.5z" />,
    cut: <path d="M9 8.5h6M9 12h6" />,
  },
  payout: {
    body: r(3, 5, 18, 14, 2.5),
    cut: <path d="M3 10h18M7 15h3" />,
  },
  instructor: {
    body: r(3.5, 4.5, 17, 11, 2),
    cut: <path d="M7.5 9h6" />,
    line: <path d="M12 15.5V20M8.5 20h7" />,
  },

  // ───────── status, files, tools ─────────
  alert: {
    body: <path d="M10.3 4.7 3 17.4A2 2 0 0 0 4.7 20.4h14.6a2 2 0 0 0 1.7-3L13.7 4.7a2 2 0 0 0-3.4 0z" />,
    cut: <path d="M12 9.6v3.8" />,
    dots: dot(12, 16.8, 1.05),
  },
  checkCircle: {
    body: <circle cx="12" cy="12" r="8.5" />,
    cut: <path d="m8.5 12.3 2.5 2.5 4.6-5.1" />,
  },
  inbox: {
    body: <path d="M4 13 6.2 6.9A2 2 0 0 1 8.1 5.5h7.8a2 2 0 0 1 1.9 1.4L20 13v4.5a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 17.5z" />,
    cut: <path d="M4 13h4.4a1 1 0 0 1 1 .8 2.6 2.6 0 0 0 5.2 0 1 1 0 0 1 1-.8H20" />,
  },
  pin: {
    body: <path d="M12 21s-6.5-5.7-6.5-11a6.5 6.5 0 0 1 13 0c0 5.3-6.5 11-6.5 11z" />,
    cut: dot(12, 10, 2.3),
  },
  scan: {
    line: <path d="M4 8V6.5A2.5 2.5 0 0 1 6.5 4H8M16 4h1.5A2.5 2.5 0 0 1 20 6.5V8M20 16v1.5a2.5 2.5 0 0 1-2.5 2.5H16M8 20H6.5A2.5 2.5 0 0 1 4 17.5V16M4 12h16" />,
  },
  image: {
    body: r(4, 5, 16, 14, 2.5),
    cut: <path d="m4.5 16.5 4.2-4.2a1 1 0 0 1 1.4 0l2.4 2.4M13.5 14l1.3-1.3a1 1 0 0 1 1.4 0L19.5 16" />,
    dots: dot(9, 9.5, 1.3),
  },
  file: {
    body: <path d="M7.5 3.5h6L19 9v10.5a1 1 0 0 1-1 1H7.5a1 1 0 0 1-1-1v-15a1 1 0 0 1 1-1z" />,
    line: <path d="M13.5 3.5V9H19" />,
  },
  download: { line: <path d="M12 4v11m0 0-4-4m4 4 4-4M5 20h14" /> },
  key: {
    body: <circle cx="8.5" cy="15.5" r="3.5" />,
    line: <path d="M11 13 19 5M16 8l2.5 2.5M13.5 10.5 15.5 12.5" />,
  },
  mail: {
    body: r(3, 5.5, 18, 13, 2.5),
    cut: <path d="m4 8 8 5.5L20 8" />,
  },
  eye: {
    body: <path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z" />,
    cut: dot(12, 12, 2.6),
  },
  eyeOff: {
    body: <path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z" />,
    cut: dot(12, 12, 2.6),
    line: <path d="M4.5 4.5l15 15" />,
  },
  search: { line: <><circle cx="11" cy="11" r="6.5" /><path d="m16 16 4 4" /></> },
  sun: { line: <><circle cx="12" cy="12" r="3.8" /><path d="M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6 7 7M17 17l1.4 1.4M5.6 18.4 7 17M17 7l1.4-1.4" /></> },
  moon: { line: <path d="M20 14.2A8 8 0 0 1 9.8 4 8 8 0 1 0 20 14.2z" /> },
  monitor: { line: <><rect x="3" y="4.5" width="18" height="12" rx="2" /><path d="M9 20h6M12 16.5V20" /></> },

  // ───────── arrows and marks (line only) ─────────
  chevronRight: { line: <path d="m9 5.5 6.5 6.5L9 18.5" /> },
  chevronLeft: { line: <path d="M15 5.5 8.5 12l6.5 6.5" /> },
  chevronUp: { line: <path d="m5.5 15 6.5-6.5 6.5 6.5" /> },
  chevronDown: { line: <path d="m5.5 9 6.5 6.5L18.5 9" /> },
  arrowLeft: { line: <path d="M19 12H5.5m5.5-6-6 6 6 6" /> },
  close: { line: <path d="M6.5 6.5l11 11M17.5 6.5l-11 11" /> },
  check: { line: <path d="m5 12.5 4.6 4.6L19 7.5" /> },
  send: { line: <path d="M20.5 3.8 10.2 14m10.3-10.2-6.6 16.4-3.7-6.2-6.2-3.7z" /> },
} satisfies Record<string, Layers>;

export type IconName = keyof typeof ICONS;

type Props = Omit<SVGProps<SVGSVGElement>, "name"> & {
  name: IconName;
  size?: number;
  /** Filled form (the active tab). Icons with no body look the same either way. */
  solid?: boolean;
  /** What the details are cut out in when `solid`: the colour of whatever the icon sits on. */
  cutColor?: string;
};

export default function Icon({ name, size = 22, solid = false, cutColor = "rgb(var(--surface))", className, ...rest }: Props) {
  const l: Layers = ICONS[name];
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75}
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false" className={className} {...rest}>
      {l.body && <g fill={solid ? "currentColor" : "none"}>{l.body}</g>}
      {l.cut && <g stroke={solid ? cutColor : "currentColor"}>{l.cut}</g>}
      {l.dots && <g fill={solid ? cutColor : "currentColor"} stroke="none">{l.dots}</g>}
      {l.line && <g>{l.line}</g>}
    </svg>
  );
}

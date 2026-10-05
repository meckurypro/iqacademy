const c = (v) => `rgb(var(--${v}) / <alpha-value>)`;
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  darkMode: ["class", '[data-theme="dark"]'],
  theme: {
    extend: {
      fontFamily: { sans: ['"Geist Variable"', "system-ui", "sans-serif"] },
      colors: { bg: c("bg"), surface: c("surface"), sunken: c("sunken"), ink: c("ink"), muted: c("muted"),
                line: c("line"), accent: c("accent"), "accent-ink": c("accent-ink"),
                ok: c("ok"), warn: c("warn"), bad: c("bad"),
                "cd-bg": c("cd-bg"), "cd-ink": c("cd-ink"), "cd-sub": c("cd-sub"), "cd-num": c("cd-num"), "cd-label": c("cd-label"), "cd-go": c("cd-go") },
      borderRadius: { xl: "12px", "2xl": "16px", "3xl": "24px" },
      boxShadow: { card: "0 1px 2px rgb(0 0 0 / .04), 0 4px 16px rgb(0 0 0 / .05)" },
    },
  },
};

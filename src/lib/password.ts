// src/lib/password.ts
// Password rules, strength scoring and a secure generator. Pure functions, no UI.

export type Rule = { id: string; label: string; test: (p: string) => boolean };

const COMMON = ["password", "passw0rd", "12345678", "123456789", "qwertyui", "qwerty123", "iloveyou", "letmein", "welcome1", "iqacademy", "admin123"];

export const RULES: Rule[] = [
  { id: "len", label: "At least 8 characters", test: (p) => p.length >= 8 },
  { id: "lower", label: "A lowercase letter (a–z)", test: (p) => /[a-z]/.test(p) },
  { id: "upper", label: "An uppercase letter (A–Z)", test: (p) => /[A-Z]/.test(p) },
  { id: "num", label: "A number (0–9)", test: (p) => /\d/.test(p) },
  { id: "sym", label: "A symbol (e.g. ! @ # $ %)", test: (p) => /[^A-Za-z0-9]/.test(p) },
  { id: "common", label: "Not an easy-to-guess password", test: (p) => p.length > 0 && !COMMON.some((c) => p.toLowerCase().includes(c)) },
];

export const isStrong = (p: string) => RULES.every((r) => r.test(p));

// 0 = empty, 1 = weak, 2 = fair, 3 = good, 4 = strong
export function strength(p: string): { level: 0 | 1 | 2 | 3 | 4; label: string } {
  if (!p) return { level: 0, label: "" };
  const passed = RULES.filter((r) => r.test(p)).length;
  let level: 1 | 2 | 3 | 4 = passed <= 3 ? 1 : passed <= 5 ? 2 : 3;
  if (isStrong(p) && p.length >= 12) level = 4;
  return { level, label: ["", "Weak", "Fair", "Good", "Strong"][level] };
}

// Unbiased random integer in [0, max) using the Web Crypto API.
function randInt(max: number): number {
  const lim = Math.floor(0x100000000 / max) * max;
  const buf = new Uint32Array(1);
  do { crypto.getRandomValues(buf); } while (buf[0] >= lim);
  return buf[0] % max;
}

// Looks-alike characters (I, l, 1, O, 0) are left out so a generated password is easy to read and type.
const SETS = {
  lower: "abcdefghijkmnopqrstuvwxyz",
  upper: "ABCDEFGHJKLMNPQRSTUVWXYZ",
  num: "23456789",
  sym: "!@#$%^&*?-_+=",
};

export function generatePassword(length = 16): string {
  const all = Object.values(SETS).join("");
  const chars = Object.values(SETS).map((s) => s[randInt(s.length)]);
  while (chars.length < length) chars.push(all[randInt(all.length)]);
  for (let i = chars.length - 1; i > 0; i--) { const j = randInt(i + 1); [chars[i], chars[j]] = [chars[j], chars[i]]; }
  return chars.join("");
}

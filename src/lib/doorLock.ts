// src/lib/doorLock.ts
// Door tools (showing the class code / QR, checking a student in by hand) are locked behind the staff member's own door PIN.
// Unlocked state lives in memory only: it ends after DOOR_UNLOCK_MS, when the app goes to the background, on reload, and on sign-out
// (it is tied to the user id). The PIN itself is checked on the server (verify_staff_pin).
// Admins are not asked: they have their own override with a written reason. Everyone else who does door work is: coordinators, and the
// instructor teaching the class.
import { useSyncExternalStore } from "react";
import { now } from "./time";
import type { Role } from "./auth";

export const DOOR_UNLOCK_MS = 5 * 60 * 1000;

let owner = ""; let until = 0; let timer: ReturnType<typeof setTimeout> | undefined;
const subs = new Set<() => void>();
const emit = () => subs.forEach((f) => f());

export function unlockDoor(uid: string) {
  owner = uid; until = now() + DOOR_UNLOCK_MS;
  clearTimeout(timer); timer = setTimeout(lockDoor, DOOR_UNLOCK_MS + 50);
  emit();
}
export function lockDoor() { owner = ""; until = 0; clearTimeout(timer); emit(); }

if (typeof document !== "undefined") document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden") lockDoor(); });

export const useDoorUnlocked = (uid: string | undefined) => useSyncExternalStore(
  (cb) => { subs.add(cb); return () => { subs.delete(cb); }; },
  () => !!uid && owner === uid && now() < until,
);

/** True for instructors and coordinators who are not also admins: the people who must enter a door PIN. */
export const needsDoorPin = (roles: { role: Role }[]) =>
  !roles.some((r) => r.role === "admin" || r.role === "super_admin") && roles.some((r) => r.role === "instructor" || r.role === "coordinator");

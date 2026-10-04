// src/lib/db.ts
// Helpers that make sure a database write really happened.
//
// Supabase reports SUCCESS for an update or delete that matched zero rows, which is exactly what happens
// when row-level security quietly blocks it. `touched` turns that silent no-op into an error, so a save
// the database ignored is never shown to the user as saved.
type Res<T> = { data: T | null; error: { message: string; code?: string } | null };

/** Throws if the call failed, otherwise returns its data. */
export function ok<T>(r: Res<T>): T {
  if (r.error) throw r.error;
  return r.data as T;
}

/** For update/delete calls ending in `.select(col)`: throws unless at least one row really changed. */
export function touched<T>(r: Res<T[]>): T[] {
  const rows = ok(r) ?? [];
  if (!rows.length) throw new Error("not_saved");
  return rows;
}

/** Turn a unique-violation into a specific, readable message key (see MESSAGES in supabase.ts). */
export const mapDuplicate = (e: unknown, key: string) => {
  const x = e as { message?: string; code?: string } | null;
  return x?.code === "23505" || /duplicate key|duplicate/i.test(x?.message ?? "") ? new Error(key) : e;
};

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

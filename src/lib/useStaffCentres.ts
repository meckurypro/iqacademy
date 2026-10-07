// src/lib/useStaffCentres.ts
import { useEffect, useMemo, useState } from "react";
import { supabase } from "./supabase";
import { useAuth } from "./auth";

export type StaffCentre = { id: string; name: string; city: string | null; address: string | null };

/** The branches the signed-in director or coordinator works at. `sel` is one branch id, or "all". */
export function useStaffCentres() {
  const { roles } = useAuth();
  const ids = useMemo(
    () => [...new Set(roles.filter((r) => (r.role === "centre_director" || r.role === "coordinator") && r.centre_id).map((r) => r.centre_id as string))],
    [roles],
  );
  const isDirector = roles.some((r) => r.role === "centre_director");
  const [centres, setCentres] = useState<StaffCentre[]>();
  const [sel, setSel] = useState("all");
  useEffect(() => {
    if (!ids.length) { setCentres([]); return; }
    supabase.from("centres").select("id,name,city,address").in("id", ids).order("name").then((r) => setCentres((r.data as StaffCentre[]) ?? []));
  }, [ids]);
  const shown = useMemo(() => (sel === "all" ? ids : ids.filter((i) => i === sel)), [ids, sel]);
  return { ids, shown, centres, sel, setSel, isDirector };
}

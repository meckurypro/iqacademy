// src/pages/Cash.tsx — one route, two views: a centre's cash (coordinator, director) or the academy's (admin, super admin).
import { Navigate } from "react-router-dom";
import { useAuth } from "../lib/auth";
import CashCentre from "./CashCentre";
import CashAdmin from "./CashAdmin";

export default function Cash() {
  const { roles } = useAuth();
  if (roles.some((r) => r.role === "admin" || r.role === "super_admin")) return <CashAdmin />;
  if (roles.some((r) => r.role === "coordinator" || r.role === "centre_director")) return <CashCentre />;
  return <Navigate to="/" replace />;
}

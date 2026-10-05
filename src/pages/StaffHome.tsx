import { useAuth, primaryRole, roleLabel } from "../lib/auth";
import { Card } from "../components/ui";

// Placeholder: instructor, coordinator, director and admin dashboards are the next build phase.
export default function StaffHome() {
  const { name, roles } = useAuth();
  const role = primaryRole(roles);
  return (
    <Card className="anim-rise space-y-1 p-6">
      <h1 className="text-xl">Hi {name.split(" ")[0]}</h1>
      <p className="text-muted">You're signed in as <b className="text-ink">{roleLabel[role]}</b>. Your dashboard is being built next.</p>
    </Card>
  );
}

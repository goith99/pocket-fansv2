import { Clock, CheckCircle2 } from "lucide-react";

export type FixtureStatus = "upcoming" | "live" | "finished";

// Shared TxLINE status badge — identical treatment across /schedule, the team
// picker and /admin. green is reserved for the verified/finished state only.
export default function StatusBadge({ status }: { status: FixtureStatus }) {
  if (status === "live") {
    return (
      <span className="pill pill-live" aria-label="Live">
        <span className="live-dot" />
        Live
      </span>
    );
  }
  if (status === "finished") {
    return (
      <span className="pill pill-finished" aria-label="Final — oracle verified">
        <CheckCircle2 size={12} strokeWidth={2.5} />
        Final
      </span>
    );
  }
  return (
    <span className="pill pill-upcoming" aria-label="Upcoming">
      <Clock size={12} strokeWidth={2.5} />
      Upcoming
    </span>
  );
}

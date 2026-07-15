import { Goal, Info, PartyPopper } from "lucide-react";
import TeamFlag from "./TeamFlag";
import type { RuleView } from "@/lib/pf";
import type { ChallengeNote } from "@/lib/useChallengeNotes";

const noteDate = (ms: number) => new Date(ms).toLocaleDateString([], { month: "short", day: "numeric" });

export default function ChallengeCard({
  challenge: r,
  name,
  note,
  onCancel,
  onClaim,
  busy,
  nowMs,
}: {
  challenge: RuleView;
  name: string;
  note?: ChallengeNote | null;
  onCancel?: () => void;
  onClaim?: () => void;
  busy?: boolean;
  /** Current time (ms). Passed in so the card doesn't need its own clock/timer;
   * the parent re-renders periodically and/or on demand. */
  nowMs: number;
}) {
  // Once executionsDone reaches maxExecutions, the delegation is fully spent —
  // there is nothing left to claim or to cancel. Older rules created before
  // max_executions was fixed to 1 per match may have executionsDone up to 3;
  // this still correctly resolves to "Completed" once exhausted.
  const exhausted = r.executionsDone >= r.maxExecutions;
  // GoalScored rules are NOT self-claimable: they fire mid-match through
  // execute_rule_verified (keeper + Txoracle proof), and the program now
  // rejects them from execute_rule outright. So the whole time-based claim flow
  // below is TeamWin-only.
  const isGoal = r.triggerKind === "GoalScored";
  // SELF-CLAIM MODEL (TeamWin only): claimable once the fixture's match_end_ts
  // has passed and there's still capacity left. No oracle/admin decides this —
  // it's a pure client-side time check mirroring the on-chain guard in
  // execute_rule.
  const claimable = !isGoal && r.isActive && !exhausted && nowMs / 1000 >= r.matchEndTs;
  // GoalScored is still waiting for the keeper as long as it's live and unspent.
  const goalWaiting = isGoal && r.isActive && !exhausted;

  return (
    <div className="card p-3.5">
      <div className="flex items-center gap-3">
        <TeamFlag name={name} size="text-[32px]" />
        <div className="min-w-0 flex-1">
          <div className="font-display text-lg font-semibold leading-tight tracking-wide">
            {isGoal
              ? `${name} scores ${r.threshold ?? 1}+ → save $${(Number(r.amountUsdc) / 1e6).toFixed(2)}`
              : `${name} wins → save $${(Number(r.amountUsdc) / 1e6).toFixed(2)}`}
          </div>
          <div className="mt-0.5 flex items-center gap-2 text-[13px] text-muted">
            <span
              className={`inline-flex items-center gap-1 font-semibold ${
                exhausted || r.isActive ? "text-green" : "text-faint"
              }`}
            >
              <span className={`h-1.5 w-1.5 rounded-full ${exhausted || r.isActive ? "bg-green" : "bg-faint"}`} />
              {exhausted ? "Completed" : r.isActive ? "Active" : "Cancelled"}
            </span>
            <span>·</span>
            <span>saved {r.executionsDone}/{r.maxExecutions} times</span>
          </div>
        </div>
        {r.isActive && claimable && onClaim && (
          <button className="btn-primary !min-h-[40px] shrink-0 px-3 text-sm" disabled={busy} onClick={onClaim}>
            <PartyPopper size={14} /> Start Saving
          </button>
        )}
        {r.isActive && !claimable && !exhausted && onCancel && (
          <button className="btn-ghost !min-h-[40px] shrink-0 px-3 text-sm" disabled={busy} onClick={onCancel}>
            {!isGoal && note ? "End challenge" : "Cancel"}
          </button>
        )}
      </div>

      {/* GoalScored: no self-claim. A permissionless keeper submits the proof
          the moment the team hits its goal threshold — the owner does nothing. */}
      {goalWaiting && (
        <div className="mt-3 flex items-start gap-2 rounded-xl bg-black/[0.03] px-3 py-2.5 text-[13px] leading-relaxed text-muted">
          <Goal size={15} className="mt-0.5 shrink-0 text-faint" />
          <p>
            Waiting for {name} to score {r.threshold ?? 1} goal{(r.threshold ?? 1) === 1 ? "" : "s"} — a keeper
            claims this automatically the moment it happens. Nothing to tap.
          </p>
        </div>
      )}

      {/* claimable nudge — the match window has passed and this challenge is
          waiting on the owner's own tap, not an oracle or admin. */}
      {claimable && (
        <div className="mt-3 flex items-start gap-2 rounded-xl bg-green-tint px-3 py-2.5 text-[13px] leading-relaxed text-green-deep">
          <PartyPopper size={15} className="mt-0.5 shrink-0" />
          <p>Match day has passed for this challenge — tap <b>Start Saving</b> to move your savings now.</p>
        </div>
      )}

      {/* calm, informational note — team played and didn't win this match.
          Skipped once the challenge is fully claimed; it's no longer actionable. */}
      {!isGoal && r.isActive && !exhausted && !claimable && note && (
        <div className="mt-3 flex items-start gap-2 rounded-xl bg-black/[0.03] px-3 py-2.5 text-[13px] leading-relaxed text-muted">
          <Info size={15} className="mt-0.5 shrink-0 text-faint" />
          <p>
            {note.team} played {note.opponent} on {noteDate(note.date)} and didn't win{" "}
            (final: {note.team} {note.teamGoals}–{note.oppGoals} {note.opponent}).{" "}
            <span className="text-faint">Still active — cancel anytime if they're out of the tournament.</span>
          </p>
        </div>
      )}
    </div>
  );
}

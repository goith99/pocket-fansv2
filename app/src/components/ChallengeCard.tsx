import { Goal, Info, PartyPopper, Coins, Zap, Hourglass, ExternalLink } from "lucide-react";
import TeamFlag from "./TeamFlag";
import type { RuleView } from "@/lib/pf";
import type { ChallengeNote } from "@/lib/useChallengeNotes";
import { EXAMPLE_SETTLEMENT_URL } from "@/lib/constants";
import type { WinOutcome } from "@/lib/useFanApp";

const noteDate = (ms: number) => new Date(ms).toLocaleDateString([], { month: "short", day: "numeric" });

export default function ChallengeCard({
  challenge: r,
  name,
  note,
  onCancel,
  onClaim,
  onSettle,
  busy,
  nowMs,
  matchFinished,
  winOutcome,
}: {
  challenge: RuleView;
  name: string;
  note?: ChallengeNote | null;
  onCancel?: () => void;
  onClaim?: () => void;
  /** Manual fallback for a TeamWinVerified rule whose team has won but which the
   *  keeper has not settled. Optional — omit it and the card just waits. */
  onSettle?: () => void;
  busy?: boolean;
  /** Current time (ms). Passed in so the card doesn't need its own clock/timer;
   * the parent re-renders periodically and/or on demand. */
  nowMs: number;
  /** True once the fixture this rule's match_id points at is finished. Only
   * meaningful for GoalScored rules (drives the "Expired" state). */
  matchFinished?: boolean;
  /** Full-time outcome of the bound fixture from the BACKED team's side. Only
   * meaningful for TeamWinVerified rules. A bare "finished" boolean cannot
   * drive those states — a won match stays finished while the keeper is still
   * settling, and that must not read as Expired. See winOutcomeFor(). */
  winOutcome?: WinOutcome;
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
  // SwapStakeAndSave rules save into mSOL (Marinade) instead of wSOL; the copy
  // below reflects that. Claim routing (execute_rule_staked vs execute_rule) is
  // handled by the parent via r.actionKind.
  const isStake = r.actionKind === "SwapStakeAndSave";
  // SELF-CLAIM MODEL (TeamWin only): claimable once the fixture's match_end_ts
  // has passed and there's still capacity left. No oracle/admin decides this —
  // it's a pure client-side time check mirroring the on-chain guard in
  // execute_rule.
  // TeamWinVerified rules settle THEMSELVES through a keeper + Txoracle proof.
  // Like GoalScored they are NOT self-claimable — the program rejects them from
  // execute_rule with UnsupportedTrigger — so they must be excluded from the
  // time-based claim flow below or the card would offer a button that reverts.
  const isWinVerified = r.triggerKind === "TeamWinVerified";
  const claimable = !isGoal && !isWinVerified && r.isActive && !exhausted && nowMs / 1000 >= r.matchEndTs;

  // --- TeamWinVerified lifecycle -------------------------------------------
  // Four distinct states, and the scoreline (not just "is the match over") is
  // what separates them. `exhausted` already covers the settled case above via
  // the "Completed" badge.
  //
  //   pending  — match not finished yet
  //   awaiting — full time PROVES a win; the keeper's settle window is open.
  //              This must NEVER render as Expired: the payout is coming, and
  //              telling the user otherwise is worse than telling them nothing.
  //   expired  — the team lost, OR the match was level at full time. The level
  //              case includes a penalty shootout: full-time goal keys exclude
  //              shootout goals, so such a rule can structurally never fire in
  //              v1 no matter who lifted the trophy.
  const winOpen = isWinVerified && r.isActive && !exhausted;
  const winPending = winOpen && winOutcome === "pending";
  const winAwaiting = winOpen && winOutcome === "won";
  const winExpired = winOpen && (winOutcome === "lost" || winOutcome === "drawn");
  const winDrawn = winOpen && winOutcome === "drawn";
  // A GoalScored rule is EXPIRED (dead) once the specific match it is bound to
  // is finished but it never executed: the keeper only watches live fixtures, so
  // it can never fire again. Bound to this rule's match_id, independent of
  // whether the team has other/future fixtures.
  const goalExpired = isGoal && r.isActive && !exhausted && !!matchFinished;
  // GoalScored is still waiting for the keeper while its match hasn't finished.
  const goalWaiting = isGoal && r.isActive && !exhausted && !matchFinished;

  return (
    <div className="card p-3.5">
      <div className="flex items-center gap-3">
        <TeamFlag name={name} size="text-[32px]" />
        <div className="min-w-0 flex-1">
          <div className="font-display text-lg font-semibold leading-tight tracking-wide">
            {isGoal
              ? `${name} scores ${r.threshold ?? 1}+ → save $${(Number(r.amountUsdc) / 1e6).toFixed(2)}`
              : `${name} wins → ${isStake ? "stake" : "save"} $${(Number(r.amountUsdc) / 1e6).toFixed(2)}`}
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-1">
            {isStake && (
              <div className="inline-flex items-center gap-1 rounded-full bg-green-tint px-2 py-0.5 text-[11px] font-semibold uppercase tracking-[0.08em] text-green-deep">
                <Coins size={11} /> Auto Stake · mSOL
              </div>
            )}
            {isWinVerified && (
              <div className="inline-flex items-center gap-1 rounded-full bg-black/[0.05] px-2 py-0.5 text-[11px] font-semibold uppercase tracking-[0.08em] text-muted">
                <Zap size={11} /> Auto-settles
              </div>
            )}
          </div>
          <div className="mt-0.5 flex items-center gap-2 text-[13px] text-muted">
            <span
              className={`inline-flex items-center gap-1 font-semibold ${
                !goalExpired && !winExpired && (exhausted || r.isActive) ? "text-green" : "text-faint"
              }`}
            >
              <span
                className={`h-1.5 w-1.5 rounded-full ${
                  !goalExpired && !winExpired && (exhausted || r.isActive) ? "bg-green" : "bg-faint"
                }`}
              />
              {exhausted ? "Completed" : goalExpired || winExpired ? "Expired" : r.isActive ? "Active" : "Cancelled"}
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
        {winAwaiting && onSettle && (
          <button className="btn-primary !min-h-[40px] shrink-0 px-3 text-sm" disabled={busy} onClick={onSettle}>
            <PartyPopper size={14} /> Settle now
          </button>
        )}
        {r.isActive && !claimable && !winAwaiting && !exhausted && onCancel && (
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

      {/* GoalScored EXPIRED: the bound match finished without the threshold being
          reached, so this rule can never fire. Owner can still cancel to tidy up. */}
      {goalExpired && (
        <div className="mt-3 flex items-start gap-2 rounded-xl bg-black/[0.03] px-3 py-2.5 text-[13px] leading-relaxed text-muted">
          <Info size={15} className="mt-0.5 shrink-0 text-faint" />
          <p>
            Match ended — {name} didn't reach {r.threshold ?? 1} goal{(r.threshold ?? 1) === 1 ? "" : "s"} for
            this challenge. No funds were affected; you can cancel this challenge.
          </p>
        </div>
      )}

      {/* TeamWinVerified PENDING: match not played/finished yet. Nothing for the
          owner to do, ever — this is the whole point of the trigger. */}
      {winPending && (
        <div className="mt-3 rounded-xl bg-black/[0.03] px-3 py-2.5 text-[13px] leading-relaxed text-muted">
          <div className="flex items-start gap-2">
            <Hourglass size={15} className="mt-0.5 shrink-0 text-faint" />
            {/* Deliberately generic about WHEN. Fixture dates come from the data
                feed and can move or not be played; promising a specific real
                event on a specific date would be a claim we cannot stand behind. */}
            <p>
              Waiting on {name}&rsquo;s result. Once the match finishes, a keeper proves the final score
              on-chain and this {isStake ? "stakes" : "saves"} automatically — you won&rsquo;t need to tap
              anything, and you don&rsquo;t need to be online.
            </p>
          </div>
          <a
            href={EXAMPLE_SETTLEMENT_URL}
            target="_blank"
            rel="noreferrer"
            className="mt-2 inline-flex items-center gap-1 pl-[23px] text-[12px] font-semibold text-accent hover:underline"
          >
            See a challenge that already settled this way
            <ExternalLink size={12} />
          </a>
        </div>
      )}

      {/* TeamWinVerified WON, not yet settled. Deliberately NOT "Expired": the
          full-time result already proves the win, and the keeper is submitting
          the proof. Showing a dead state here would tell the user their money
          isn't coming moments before it arrives. */}
      {winAwaiting && (
        <div className="mt-3 flex items-start gap-2 rounded-xl bg-green-tint px-3 py-2.5 text-[13px] leading-relaxed text-green-deep">
          <PartyPopper size={15} className="mt-0.5 shrink-0" />
          <p>
            {name} won! Settling automatically — the {isStake ? "mSOL" : "SOL"} lands straight in your wallet.
            {onSettle ? " Taking a while? You can settle it yourself with the button above." : " Nothing to tap."}
          </p>
        </div>
      )}

      {/* TeamWinVerified EXPIRED. Two causes, worth distinguishing in the copy:
          a plain loss, or a match level at full time. The level case includes a
          penalty shootout — full-time goal stats exclude shootout goals, so the
          rule could never have fired regardless of who went through. Saying that
          plainly beats leaving the user to wonder why a "win" didn't pay. */}
      {winExpired && (
        <div className="mt-3 flex items-start gap-2 rounded-xl bg-black/[0.03] px-3 py-2.5 text-[13px] leading-relaxed text-muted">
          <Info size={15} className="mt-0.5 shrink-0 text-faint" />
          <p>
            {winDrawn
              ? `That match was level at full time, so this challenge didn't trigger — draws and penalty shootouts don't count as a win here. No funds were affected; you can cancel this challenge.`
              : `Match ended — ${name} didn't win, so nothing was saved. No funds were affected; you can cancel this challenge.`}
          </p>
        </div>
      )}

      {/* claimable nudge — the match window has passed and this challenge is
          waiting on the owner's own tap, not an oracle or admin. */}
      {claimable && (
        <div className="mt-3 flex items-start gap-2 rounded-xl bg-green-tint px-3 py-2.5 text-[13px] leading-relaxed text-green-deep">
          <PartyPopper size={15} className="mt-0.5 shrink-0" />
          <p>Match day has passed for this challenge — tap <b>Start Saving</b> to {isStake ? "stake your savings into SOL now" : "move your savings now"}.</p>
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

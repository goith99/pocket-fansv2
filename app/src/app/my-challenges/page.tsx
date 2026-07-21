"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { PiggyBank, Plus, Trophy, Coins } from "lucide-react";
import { useFanApp } from "@/lib/useFanApp";
import { useChallengeNotes } from "@/lib/useChallengeNotes";
import ChallengeCard from "@/components/ChallengeCard";
import RetryNotice from "@/components/RetryNotice";
import TransactionFlow from "@/components/TransactionFlow";

export default function MyChallengesPage() {
  const app = useFanApp();
  const notes = useChallengeNotes(app.challenges);

  // Ticks once a minute so "claimable" (match_end_ts passed) flips on without
  // a manual refresh — this is a pure client-side clock, matching the
  // on-chain Clock::unix_timestamp guard in execute_rule; nothing is decided
  // here, it only decides when to SHOW the Claim button.
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNowMs(Date.now()), 60_000);
    return () => clearInterval(id);
  }, []);

  if (!app.ready) return <div className="py-20 text-center text-muted">Loading…</div>;

  if (!app.authenticated) {
    return (
      <div className="mx-auto max-w-sm py-16 text-center">
        <h1 className="font-display text-3xl font-bold tracking-wide">My Challenges</h1>
        <p className="mt-2 text-[15px] text-muted">Log in to see the teams you’re backing and your savings.</p>
        <button className="btn-primary mt-5" onClick={app.login}>Log in with Google</button>
      </div>
    );
  }

  const hasSavings = (app.savedSol ?? 0) > 0;
  const hasStaked = (app.savedMsol ?? 0) > 0;

  return (
    <div className="space-y-4">
      <header>
        <h1 className="font-display text-3xl font-bold tracking-wide">My Challenges</h1>
        <p className="mt-0.5 text-[15px] text-muted">The teams you’re backing this season.</p>
      </header>

      {app.loadError && <RetryNotice onRetry={app.refresh} />}

      {/* Savings summary — two lines, SOL only, no dollar figures.
          Mirrors SavedCard in HomeView; kept as its own markup here because this
          page's version carries the Withdraw controls the Home card doesn't. */}
      <div className="card p-4">
        {/* Staking = the vault's live mSOL balance (execute_rule_staked ->
            Marinade). Shown as SOL: mSOL is ~1:1 and the rate isn't worth
            surfacing here. Always visible so the two lines stay a stable pair. */}
        <div className="flex items-center justify-between gap-3">
          <div>
            <div className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-[0.1em] text-faint"><Coins size={13} /> Saved · Staking</div>
            <div className="mt-1 flex items-baseline gap-1">
              <span className="font-mono text-2xl font-bold tabular-nums text-green-deep">{app.savedMsol != null ? app.savedMsol.toFixed(4) : app.loadError ? "—" : "…"}</span>
              <span className="text-sm font-semibold text-muted">SOL</span>
            </div>
          </div>
          {hasStaked && (
            <button className="btn-ghost" disabled={app.busy} onClick={() => void app.withdrawStakedSavings()}>
              Withdraw
            </button>
          )}
        </div>

        {/* DCA = lifetime ESTIMATE from rule history at today's price, not a
            balance (see savedDcaSol in useFanApp). Auto DCA claims pay straight
            to the wallet, so there is no vault figure to read. */}
        <div className="mt-3 border-t border-line pt-3">
          <div className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-[0.1em] text-faint"><PiggyBank size={13} /> Saved · DCA</div>
          <div className="mt-1 flex items-baseline gap-1">
            <span className="font-mono text-2xl font-bold tabular-nums text-green-deep">~{app.savedDcaSol != null ? app.savedDcaSol.toFixed(4) : app.loadError ? "—" : "…"}</span>
            <span className="text-sm font-semibold text-muted">SOL</span>
          </div>
          <div className="mt-0.5 text-[12px] text-muted">
            Estimated at today’s rate — paid into your wallet as each challenge landed.
          </div>

          {/* Vault wSOL, folded in UNDER the DCA line rather than given its own
              row. Two things land here: leftover dust from pre-execute_rule_direct
              claims (which chained a slippage-floor withdraw and stranded ~5%),
              and — once Goal Scored rules fire — live GoalScored savings, since
              execute_rule_verified still pays into vault_wsol_ata. Renders only
              when there's a balance, and it's the ONLY wSOL withdraw control in
              the UI, so it must stay reachable. */}
          {hasSavings && (
            <div className="mt-2 flex items-center justify-between gap-3 rounded-xl bg-green-tint px-3 py-2">
              <span className="text-[13px] leading-snug text-green-deep">
                <b className="font-mono tabular-nums">{app.savedSol != null ? app.savedSol.toFixed(4) : "…"} SOL</b>{" "}
                is waiting in your vault
              </span>
              <button className="btn-ghost shrink-0" disabled={app.busy} onClick={() => void app.withdrawSavings()}>
                Withdraw
              </button>
            </div>
          )}
        </div>

        {/* what "saving" means — plain-language note, always visible */}
        <p className="mt-3 rounded-xl bg-green-tint px-3 py-2.5 text-[13px] leading-relaxed text-green-deep">
          Your savings are <b>$SOL</b>. Each challenge swaps your own USDC into SOL — like a small,
          match-day DCA. It’s your money the whole time, and you can spend it any time.
        </p>
      </div>

      {app.challenges.length === 0 ? (
        <div className="card px-4 py-10 text-center">
          <div className="mx-auto grid h-12 w-12 place-items-center rounded-full bg-green-tint"><Trophy size={22} className="text-green" /></div>
          <div className="mt-3 font-display text-lg font-bold uppercase tracking-wide">No challenges yet</div>
          <p className="mt-1 text-[15px] text-muted">Back a team and start saving when they win.</p>
          <Link href="/" className="btn-primary mt-4 !inline-flex !w-auto px-5"><Plus size={16} /> Create a challenge</Link>
        </div>
      ) : (
        <div className="space-y-2.5">
          {app.challenges.map((r) => (
            <ChallengeCard
              key={r.pubkey}
              challenge={r}
              name={app.teamName(r.teamId ?? 0)}
              note={notes[r.teamId ?? -1]}
              onCancel={() => void app.cancelChallenge(r.ruleId)}
              onClaim={() => {
                if (r.actionKind === "SwapStakeAndSave") void app.claimStakeChallenge(r.ruleId);
                else void app.claimChallenge(r.ruleId);
              }}
              busy={app.busy}
              nowMs={nowMs}
              matchFinished={app.isMatchFinished(r.matchId)}
              winOutcome={app.winOutcomeFor(r.matchId, r.teamId)}
              onSettle={() => void app.settleChallenge(r)}
            />
          ))}
          <Link href="/" className="btn-ghost mt-1 w-full"><Plus size={16} /> Create another challenge</Link>
        </div>
      )}

      <TransactionFlow state={app.txState} onDismiss={app.resetTx} />
    </div>
  );
}

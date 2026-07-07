"use client";
// TEMPORARY preview route for 390px screenshots of the auth-gated screens.
// Renders the real presentational components with mock data (no wallet needed).
// Deleted after review.
import { useEffect, useState } from "react";
import HomeView from "@/components/HomeView";
import TeamPickerSheet from "@/components/TeamPickerSheet";
import TransactionFlow from "@/components/TransactionFlow";
import ChallengeCard from "@/components/ChallengeCard";
import { useChallengeNotes } from "@/lib/useChallengeNotes";
import { TEAM_BY_ID } from "@/lib/flags";
import type { RuleView } from "@/lib/pf";

const TEAMS = [
  { id: 1489, name: "Argentina" }, { id: 1575, name: "Belgium" }, { id: 1634, name: "Brazil" },
  { id: 1748, name: "Colombia" }, { id: 1867, name: "Egypt" }, { id: 1888, name: "England" },
  { id: 1999, name: "France" }, { id: 2545, name: "Mexico" }, { id: 2530, name: "Morocco" },
  { id: 2661, name: "Norway" }, { id: 2802, name: "Portugal" }, { id: 3021, name: "Spain" },
  { id: 3099, name: "Switzerland" }, { id: 3220, name: "USA" },
];
// Brazil (id 1634) first — exercises the ParticipantId→name fallback (this id is
// intentionally NOT in the live `teamName` list below), plus the 1-item Home limit.
const CHALLENGES: RuleView[] = [
  { pubkey: "b", vault: "v", ruleId: 1, teamId: 1634, amountUsdc: "2000000", maxSlippageBps: 1500, maxExecutions: 3, executionsDone: 0, isActive: true },
  { pubkey: "a", vault: "v", ruleId: 0, teamId: 2802, amountUsdc: "1000000", maxSlippageBps: 1500, maxExecutions: 3, executionsDone: 1, isActive: true },
  { pubkey: "c", vault: "v", ruleId: 2, teamId: 2545, amountUsdc: "1000000", maxSlippageBps: 1500, maxExecutions: 3, executionsDone: 0, isActive: true },
];

export default function Preview() {
  const [teamId, setTeamId] = useState<number | "">(2802);
  const [amount, setAmount] = useState("1.00");
  const [picker, setPicker] = useState(false);
  const [view, setView] = useState<string | null>(null);
  useEffect(() => { setView(new URLSearchParams(window.location.search).get("view")); }, []);
  const selectedTeam = teamId === "" ? null : { id: Number(teamId), name: TEAMS.find((t) => t.id === teamId)!.name };
  // mirrors the real fallback: resolves ids via the static registry, never "Team 1634"
  const teamName = (id: number) => TEAM_BY_ID[id] ?? `Team ${id}`;
  const notes = useChallengeNotes(CHALLENGES); // real fetch from /api/challenges/results

  if (view === "challenges") {
    return (
      <div className="space-y-4">
        <header>
          <h1 className="font-display text-3xl font-bold tracking-wide">My Challenges</h1>
          <p className="mt-0.5 text-[15px] text-muted">The teams you’re backing this season.</p>
        </header>
        <div className="space-y-2.5">
          {CHALLENGES.map((r) => (
            <ChallengeCard key={r.pubkey} challenge={r} name={teamName(r.teamId ?? 0)} note={notes[r.teamId ?? -1]} onCancel={() => {}} busy={false} />
          ))}
        </div>
      </div>
    );
  }
  if (view === "picker") return <TeamPickerSheet open teams={TEAMS} value={Number(teamId)} onSelect={setTeamId} onClose={() => {}} />;
  if (view === "tx-confirmed") return <TransactionFlow state={{ phase: "confirmed", label: "Portugal wins challenge", sig: "5xCEaHF99waFxLABhTR6p1EAFhGm1QAWtvGgzr" }} onDismiss={() => {}} />;
  if (view === "tx-awaiting") return <TransactionFlow state={{ phase: "awaiting", label: "Setting up your challenge" }} onDismiss={() => {}} />;

  return (
    <>
      <HomeView
        greetingName="Ari"
        balanceUsd={view === "loaderror" ? null : 12.5}
        savedSol={view === "loaderror" ? null : view === "celebrate" ? 0.0451 : 0.0448}
        selectedTeam={selectedTeam}
        amount={amount}
        onAmountChange={setAmount}
        onOpenPicker={() => setPicker(true)}
        onCreate={() => {}}
        creating={false}
        challenges={CHALLENGES}
        teamName={teamName}
        celebrate={view === "celebrate"}
        loadError={view === "loaderror"}
        onRetry={() => {}}
      />
      <TeamPickerSheet open={picker} teams={TEAMS} value={Number(teamId)} onSelect={setTeamId} onClose={() => setPicker(false)} />
    </>
  );
}

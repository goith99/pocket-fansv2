"use client";
import { useEffect, useRef, useState } from "react";
import { useFanApp } from "@/lib/useFanApp";
import HomeView, { type SaveAction, type SettleMode } from "./HomeView";
import TeamPickerSheet from "./TeamPickerSheet";
import TransactionFlow from "./TransactionFlow";
import LandingPage from "./LandingPage";

function firstName(user: any): string {
  const n = user?.google?.name as string | undefined;
  if (n) return n.split(" ")[0];
  const email = user?.google?.email ?? user?.email?.address;
  if (email) return String(email).split("@")[0];
  return "there";
}

export default function UserDashboard() {
  const app = useFanApp();
  const [teamId, setTeamId] = useState<number | "">("");
  const [amount, setAmount] = useState("1.00");
  const [saveAction, setSaveAction] = useState<SaveAction>("dca");
  // Defaults to "auto" (TeamWinVerified): sign once, never tap again.
  const [settleMode, setSettleMode] = useState<SettleMode>("auto");
  const [faucetSolAmount, setFaucetSolAmount] = useState("0.1");
  const [pickerOpen, setPickerOpen] = useState(false);
  const [celebrate, setCelebrate] = useState(false);
  const prevSaved = useRef<number | null>(null);

  // Celebration when staked savings land (savedMsol increases). Keyed to mSOL
  // rather than the vault's wSOL: Auto DCA claims now land directly in the
  // user's wallet (execute_rule_direct), so the vault wSOL balance no longer
  // moves on a DCA claim and would never fire this.
  useEffect(() => {
    const s = app.savedMsol;
    if (s == null) return;
    if (prevSaved.current != null && s > prevSaved.current + 1e-9) {
      setCelebrate(true);
      const t = setTimeout(() => setCelebrate(false), 3500);
      return () => clearTimeout(t);
    }
    prevSaved.current = s;
  }, [app.savedMsol]);

  if (!app.ready) return <div className="py-20 text-center text-muted">Loading…</div>;
  // Logged-out visitors get the full landing page (desktop + mobile responsive).
  if (!app.authenticated) return <LandingPage onLogin={app.login} />;

  const selectedTeam = teamId === "" ? null : { id: Number(teamId), name: app.teamName(Number(teamId)) };

  return (
    <>
      <HomeView
        greetingName={firstName(app.user)}
        balanceUsd={app.usdc}
        savedMsol={app.savedMsol}
        savedDcaSol={app.savedDcaSol}
        selectedTeam={selectedTeam}
        amount={amount}
        onAmountChange={setAmount}
        onOpenPicker={() => setPickerOpen(true)}
        onCreate={() => {
          if (teamId === "") return;
          // TeamWinVerified (auto) routes BOTH save actions through one builder;
          // the staked flag picks the action variant, and with it the settlement
          // ATA that must be pre-created. The manual path keeps the original
          // self-claim TeamWin builders, untouched.
          if (settleMode === "auto") void app.createWinChallenge(Number(teamId), amount, saveAction === "stake");
          else if (saveAction === "stake") void app.createStakeChallenge(Number(teamId), amount);
          else void app.createChallenge(Number(teamId), amount);
        }}
        creating={app.busy}
        saveAction={saveAction}
        onSaveActionChange={setSaveAction}
        settleMode={settleMode}
        onSettleModeChange={setSettleMode}
        challenges={app.challenges}
        teamName={app.teamName}
        celebrate={celebrate}
        loadError={app.loadError}
        onRetry={app.refresh}
        solBalance={app.sol}
        faucetSolAmount={faucetSolAmount}
        onFaucetSolAmountChange={setFaucetSolAmount}
        onGetDevUsdc={() => void app.getDevUsdc(faucetSolAmount)}
        faucetBusy={app.busy}
      />
      <TeamPickerSheet
        open={pickerOpen}
        teams={app.activeTeams}
        value={teamId === "" ? null : Number(teamId)}
        onSelect={(id) => setTeamId(id)}
        onClose={() => setPickerOpen(false)}
      />
      <TransactionFlow state={app.txState} onDismiss={app.resetTx} />
    </>
  );
}

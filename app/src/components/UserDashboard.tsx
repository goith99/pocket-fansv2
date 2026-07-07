"use client";
import { useEffect, useRef, useState } from "react";
import { useFanApp } from "@/lib/useFanApp";
import HomeView from "./HomeView";
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
  const [pickerOpen, setPickerOpen] = useState(false);
  const [celebrate, setCelebrate] = useState(false);
  const prevSaved = useRef<number | null>(null);

  // celebration when savings land (savedSol increases)
  useEffect(() => {
    const s = app.savedSol;
    if (s == null) return;
    if (prevSaved.current != null && s > prevSaved.current + 1e-9) {
      setCelebrate(true);
      const t = setTimeout(() => setCelebrate(false), 3500);
      return () => clearTimeout(t);
    }
    prevSaved.current = s;
  }, [app.savedSol]);

  if (!app.ready) return <div className="py-20 text-center text-muted">Loading…</div>;
  // Logged-out visitors get the full landing page (desktop + mobile responsive).
  if (!app.authenticated) return <LandingPage onLogin={app.login} />;

  const selectedTeam = teamId === "" ? null : { id: Number(teamId), name: app.teamName(Number(teamId)) };

  return (
    <>
      <HomeView
        greetingName={firstName(app.user)}
        balanceUsd={app.usdc}
        savedSol={app.savedSol}
        selectedTeam={selectedTeam}
        amount={amount}
        onAmountChange={setAmount}
        onOpenPicker={() => setPickerOpen(true)}
        onCreate={() => { if (teamId !== "") void app.createChallenge(Number(teamId), amount); }}
        creating={app.busy}
        challenges={app.challenges}
        teamName={app.teamName}
        celebrate={celebrate}
        loadError={app.loadError}
        onRetry={app.refresh}
      />
      <TeamPickerSheet
        open={pickerOpen}
        teams={app.teams}
        value={teamId === "" ? null : Number(teamId)}
        onSelect={(id) => setTeamId(id)}
        onClose={() => setPickerOpen(false)}
      />
      <TransactionFlow state={app.txState} onDismiss={app.resetTx} />
    </>
  );
}

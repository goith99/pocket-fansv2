"use client";
// TEMPORARY DEV TEST HARNESS — not product UI, not linked from anywhere.
//
// Purpose: create a real GoalScored rule on devnet end-to-end so the keeper path
// (execute_rule_verified) has something to fire against once the TxLINE
// stat-validation access question is resolved. Deliberately plain: no design, no
// team picker, no flags — it reuses the same createGoalChallenge() the real UI
// will eventually call, so what it exercises is the real code path.
//
// DELETE THIS ROUTE once a designed GoalScored flow exists (there was a prior
// `preview` route removed for exactly this reason — don't let it rot).
import { useMemo, useState } from "react";
import { useFanApp } from "@/lib/useFanApp";

export default function DevGoalRulePage() {
  const {
    ready, authenticated, login, address, usdc, teams, challenges,
    createGoalChallenge, cancelChallenge, busy, txState, teamName,
  } = useFanApp();

  const [teamId, setTeamId] = useState<number | "">("");
  const [amount, setAmount] = useState("1");
  const [threshold, setThreshold] = useState("1");

  const goalRules = useMemo(
    () => challenges.filter((c) => c.triggerKind === "GoalScored"),
    [challenges],
  );

  if (!ready) return <main style={S.page}>loading…</main>;

  return (
    <main style={S.page}>
      <h1 style={{ fontSize: 20, marginBottom: 4 }}>DEV: create GoalScored rule</h1>
      <p style={S.note}>
        Temporary test harness. Creates a real on-chain rule claimed by the
        permissionless keeper (execute_rule_verified), not by you on a timer.
      </p>

      {!authenticated ? (
        <button style={S.btn} onClick={() => login()}>Connect wallet</button>
      ) : (
        <>
          <div style={S.row}>
            <span style={S.dim}>wallet</span>
            <code style={{ fontSize: 12 }}>{address}</code>
          </div>
          <div style={S.row}>
            <span style={S.dim}>devUSDC</span>
            <span>{usdc ?? "—"}</span>
          </div>

          <label style={S.label}>
            Team
            <select
              style={S.input}
              value={teamId}
              onChange={(e) => setTeamId(e.target.value ? Number(e.target.value) : "")}
            >
              <option value="">— pick a team —</option>
              {teams.map((t) => (
                <option key={t.id} value={t.id}>{t.name}</option>
              ))}
            </select>
          </label>

          <label style={S.label}>
            Amount (devUSDC, swapped per execution)
            <input style={S.input} value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" />
          </label>

          <label style={S.label}>
            Goals threshold (fires when the team&apos;s proven goal count reaches this)
            <input style={S.input} value={threshold} onChange={(e) => setThreshold(e.target.value)} inputMode="numeric" />
          </label>

          <button
            style={{ ...S.btn, opacity: busy || teamId === "" ? 0.5 : 1 }}
            disabled={busy || teamId === ""}
            onClick={() => {
              if (teamId === "") return;
              void createGoalChallenge(Number(teamId), amount, Number(threshold));
            }}
          >
            {busy ? "working…" : "Create GoalScored rule"}
          </button>

          {txState.phase !== "idle" && (
            <pre style={S.pre}>{JSON.stringify(txState, null, 2)}</pre>
          )}

          <h2 style={{ fontSize: 16, marginTop: 28 }}>Your GoalScored rules</h2>
          {!goalRules.length && <p style={S.dim}>none yet</p>}
          {goalRules.map((r) => (
            <div key={r.pubkey} style={S.card}>
              <div><b>{teamName(r.teamId ?? 0)}</b> — rule #{r.ruleId}</div>
              <div style={S.dim}>
                stat_key {r.statKey} ({r.statKey === 1 ? "home" : "away"} goals) · threshold {r.threshold} ·
                {" "}fixture {r.matchId} · {r.executionsDone}/{r.maxExecutions} executed ·
                {" "}{r.isActive ? "active" : "inactive"}
              </div>
              <button style={S.btnSm} disabled={busy} onClick={() => void cancelChallenge(r.ruleId)}>
                Cancel
              </button>
            </div>
          ))}
        </>
      )}
    </main>
  );
}

const S: Record<string, React.CSSProperties> = {
  page: { maxWidth: 560, margin: "0 auto", padding: 24, fontFamily: "ui-sans-serif, system-ui" },
  note: { fontSize: 13, opacity: 0.7, marginBottom: 20, lineHeight: 1.5 },
  dim: { opacity: 0.6, fontSize: 13 },
  row: { display: "flex", justifyContent: "space-between", padding: "6px 0", borderBottom: "1px solid #8883" },
  label: { display: "block", marginTop: 16, fontSize: 13 },
  input: { display: "block", width: "100%", marginTop: 6, padding: 8, fontSize: 14 },
  btn: { marginTop: 20, padding: "10px 16px", fontSize: 14, cursor: "pointer" },
  btnSm: { marginTop: 8, padding: "4px 10px", fontSize: 12, cursor: "pointer" },
  pre: { marginTop: 16, padding: 10, background: "#8881", fontSize: 11, overflowX: "auto" },
  card: { padding: 12, border: "1px solid #8883", borderRadius: 6, marginTop: 10, fontSize: 14 },
};

"use client";
// Shared client hook: wallet + balances + challenges + the create/cancel/withdraw/
// claim actions, all wired to the transaction-flow feedback. This is the ONLY
// place the on-chain plumbing lives; screens stay presentational. The
// instruction builders, PDAs and account logic are untouched (imported from
// lib/pf) — this is the same logic the previous dashboard used, just
// centralised and given consumer labels.
//
// SELF-CLAIM MODEL: there is no more admin/oracle execute step. `claimChallenge`
// below is what used to live only in /admin's `execute` handler — now any
// challenge owner calls it themselves, once their match's match_end_ts has
// passed. See programs/pocket_fans/src/instructions/execute_rule.rs.
import { useCallback, useEffect, useMemo, useState } from "react";
import { usePrivy, useSolanaWallets } from "@privy-io/react-auth";
import { Connection, PublicKey, Transaction, TransactionInstruction, ComputeBudgetProgram } from "@solana/web3.js";
import { createAssociatedTokenAccountIdempotentInstruction, createApproveInstruction, getAssociatedTokenAddressSync } from "@solana/spl-token";
import {
  DEVUSDC_MINT, WSOL_MINT, MSOL_MINT, DEVUSDC_DECIMALS, DEFAULT_MAX_EXECUTIONS, DEFAULT_MAX_SLIPPAGE_BPS,
  MATCH_END_BUFFER_SECS, STAT_KEY_HOME_GOALS, STAT_KEY_AWAY_GOALS, GOALSCORED_CREATION_ENABLED,
} from "@/lib/constants";
import {
  vaultPda, ata, ixInitializeVault, ixCreateRule, ixRevokeRule, ixWithdrawFromVault,
  ixExecuteRuleDirect, ixExecuteRuleStakedDirect, ticksForBToA, getUserVault, getUserRules, getRule, tokenUiBalance, RuleView,
  ixWrapSol, ixSyncNative, ixSwapSolToUsdc, ticksForAToB, estimateUsdcOut,
} from "@/lib/pf";
import { TEAM_BY_ID } from "@/lib/flags";
import { useTxFlow } from "@/components/TransactionFlow";

export interface Team { id: number; name: string }
// participant1IsHome is already served by /api/schedule (see serverSupabase.ts) —
// it is what decides whether a backed team's goals are stat_key 1 (home) or 2
// (away) for THIS fixture.
interface Fixture {
  fixtureId: number; startTime: number;
  participant1: { id: number }; participant2: { id: number };
  participant1IsHome: boolean;
  status: "upcoming" | "live" | "finished";
  // Present once finished. winnerId is the ParticipantId of the winner, or 0 for
  // a true draw. The poller (oracle-service/src/poller.cjs) already folds the
  // knockout penalty result into winnerId, so a knockout decided on penalties
  // has a non-zero winnerId and a group-stage draw has winnerId 0.
  score?: { p1: number; p2: number; winnerId: number } | null;
}

export function useFanApp() {
  const { ready, authenticated, login, logout, user } = usePrivy();
  const { wallets } = useSolanaWallets();
  const wallet = wallets[0];
  const address = wallet?.address;
  const { state: txState, run, reset: resetTx } = useTxFlow();
  const busy = txState.phase === "awaiting" || txState.phase === "confirming";

  const connection = useMemo(() => {
    const origin = typeof window !== "undefined" ? window.location.origin : "http://localhost:3055";
    return new Connection(`${origin}/api/rpc`, "confirmed");
  }, []);

  const [teams, setTeams] = useState<Team[]>([]);
  const [fixtures, setFixtures] = useState<Fixture[]>([]);
  const [sol, setSol] = useState<number | null>(null);
  const [usdc, setUsdc] = useState<number | null>(null);
  const [savedSol, setSavedSol] = useState<number | null>(null);
  const [savedMsol, setSavedMsol] = useState<number | null>(null);
  const [challenges, setChallenges] = useState<RuleView[]>([]);
  const [loadError, setLoadError] = useState(false);

  useEffect(() => {
    fetch("/api/schedule").then((r) => r.json()).then((d) => {
      if (d.teams) setTeams(d.teams);
      if (d.fixtures) setFixtures(d.fixtures);
    }).catch(() => {});
  }, []);

  // Reads all degrade gracefully: a transient RPC failure (e.g. a Helius 500 or
  // rate-limit blip) sets loadError so the UI can show a small inline retry,
  // never an unhandled rejection / dev-overlay crash.
  const refresh = useCallback(async () => {
    if (!address) return;
    try {
      const owner = new PublicKey(address);
      const [lam, u, v, mv] = await Promise.all([
        connection.getBalance(owner),
        tokenUiBalance(connection, DEVUSDC_MINT, owner),
        tokenUiBalance(connection, WSOL_MINT, vaultPda(owner)),
        tokenUiBalance(connection, MSOL_MINT, vaultPda(owner)),
      ]);
      const uv = await getUserVault(connection, owner);
      const rules = await getUserRules(connection, owner, uv.totalRules);
      setSol(lam / 1e9);
      setUsdc(u?.ui ?? 0);
      setSavedSol(v?.ui ?? 0);
      setSavedMsol(mv?.ui ?? 0);
      setChallenges(rules);
      setLoadError(false);
    } catch {
      setLoadError(true);
    }
  }, [address, connection]);

  useEffect(() => { void refresh(); }, [refresh]);

  // gentle background refresh so winnings landing on-chain surface (and the
  // celebration fires) without the fan having to reload.
  useEffect(() => {
    if (!address) return;
    const id = setInterval(() => { void refresh(); }, 20000);
    return () => clearInterval(id);
  }, [address, refresh]);

  async function pollConfirm(sig: string) {
    for (let i = 0; i < 40; i++) {
      const st = (await connection.getSignatureStatuses([sig])).value[0];
      if (st?.err) throw new Error(`tx failed: ${JSON.stringify(st.err)}`);
      if (st?.confirmationStatus === "confirmed" || st?.confirmationStatus === "finalized") return;
      await new Promise((r) => setTimeout(r, 1200));
    }
    throw new Error("confirmation timed out");
  }
  async function submit(ixs: TransactionInstruction[], onSent: (sig: string) => void): Promise<string> {
    if (!wallet) throw new Error("no wallet");
    const owner = new PublicKey(wallet.address);
    const tx = new Transaction().add(...ixs);
    tx.feePayer = owner;
    tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
    // Explicit human action already occurred (button tap). Triggers the wallet
    // signing UI — no auto-approval anywhere.
    const signed = await (wallet as any).signTransaction(tx);
    const sig = await connection.sendRawTransaction(signed.serialize());
    onSent(sig);
    await pollConfirm(sig);
    return sig;
  }

  // Next fixture (by kickoff time) involving this team that hasn't finished
  // yet. This is what fixes match_id/match_end_ts on the rule — the team
  // picker itself only ever chose a team, not a specific fixture, so we resolve
  // that here rather than adding a second picker to the UI.
  function nextFixtureForTeam(teamId: number): Fixture | null {
    const now = Date.now();
    const candidates = fixtures
      .filter((f) => (f.participant1.id === teamId || f.participant2.id === teamId) && f.status !== "finished")
      .sort((a, b) => a.startTime - b.startTime);
    return candidates.find((f) => f.startTime >= now) ?? candidates[0] ?? null;
  }

  // create a challenge (program: create_rule). Also ensures the owner's + vault's
  // token accounts exist first, so it can later self-claim without any manual
  // setup. match_id + match_end_ts are fixed here from the team's next fixture.
  const createChallenge = useCallback(async (teamId: number, amountStr: string) => {
    if (!address) return null;
    const owner = new PublicKey(address);
    const amountUsdc = BigInt(Math.round(Number(amountStr) * 10 ** DEVUSDC_DECIMALS));
    const sig = await run("Setting up your challenge", async (onSent) => {
      if (amountUsdc <= 0n) throw new Error("Enter an amount greater than 0");
      const fixture = nextFixtureForTeam(teamId);
      if (!fixture) throw new Error("No scheduled match found for this team yet");
      const matchId = BigInt(fixture.fixtureId);
      const matchEndTs = BigInt(Math.floor(fixture.startTime / 1000) + MATCH_END_BUFFER_SECS);

      const ixs: TransactionInstruction[] = [];
      const uv = await getUserVault(connection, owner);
      if (!uv.exists) ixs.push(ixInitializeVault(owner));
      const usdcAta = getAssociatedTokenAddressSync(DEVUSDC_MINT, owner);
      if (!(await connection.getAccountInfo(usdcAta))) {
        ixs.push(createAssociatedTokenAccountIdempotentInstruction(owner, usdcAta, owner, DEVUSDC_MINT));
      }
      const vault = vaultPda(owner);
      // Pre-create the vault's token accounts here (this used to be the admin's
      // job, done lazily in build-execute — now there's no admin step, so it
      // must happen at creation time instead).
      for (const mint of [DEVUSDC_MINT, WSOL_MINT]) {
        const vaultAta = ata(mint, vault);
        if (!(await connection.getAccountInfo(vaultAta))) {
          ixs.push(createAssociatedTokenAccountIdempotentInstruction(owner, vaultAta, vault, mint));
        }
      }
      ixs.push(ixCreateRule({
        owner, vaultTotalRules: uv.totalRules, trigger: { kind: "TeamWin", teamId },
        amountUsdc, maxSlippageBps: DEFAULT_MAX_SLIPPAGE_BPS, maxExecutions: DEFAULT_MAX_EXECUTIONS,
        matchId, matchEndTs,
      }));
      return submit(ixs, onSent);
    });
    if (sig) await refresh();
    return sig;
  }, [address, connection, fixtures, refresh, run]);

  // AUTO STAKE (SwapStakeAndSave). A deliberate SIBLING of createChallenge, not a
  // flag on it — same TeamWin self-claim trust model and same delegated USDC
  // amount, but the rule's action is SwapStakeAndSave (claimed later by
  // execute_rule_staked -> mSOL via Marinade) instead of SwapAndSave (-> wSOL).
  // Pre-creates the vault's USDC + mSOL ATAs (execute_rule_staked deposits mSOL
  // into vault_msol_ata; it uses an ephemeral stake_wsol PDA for the swap, so no
  // vault wSOL ATA is needed here — unlike createChallenge).
  const createStakeChallenge = useCallback(async (teamId: number, amountStr: string) => {
    if (!address) return null;
    const owner = new PublicKey(address);
    const amountUsdc = BigInt(Math.round(Number(amountStr) * 10 ** DEVUSDC_DECIMALS));
    const sig = await run("Setting up your staking challenge", async (onSent) => {
      if (amountUsdc <= 0n) throw new Error("Enter an amount greater than 0");
      const fixture = nextFixtureForTeam(teamId);
      if (!fixture) throw new Error("No scheduled match found for this team yet");
      const matchId = BigInt(fixture.fixtureId);
      const matchEndTs = BigInt(Math.floor(fixture.startTime / 1000) + MATCH_END_BUFFER_SECS);

      const ixs: TransactionInstruction[] = [];
      const uv = await getUserVault(connection, owner);
      if (!uv.exists) ixs.push(ixInitializeVault(owner));
      const usdcAta = getAssociatedTokenAddressSync(DEVUSDC_MINT, owner);
      if (!(await connection.getAccountInfo(usdcAta))) {
        ixs.push(createAssociatedTokenAccountIdempotentInstruction(owner, usdcAta, owner, DEVUSDC_MINT));
      }
      const vault = vaultPda(owner);
      for (const mint of [DEVUSDC_MINT, MSOL_MINT]) {
        const vaultAta = ata(mint, vault);
        if (!(await connection.getAccountInfo(vaultAta))) {
          ixs.push(createAssociatedTokenAccountIdempotentInstruction(owner, vaultAta, vault, mint));
        }
      }
      ixs.push(ixCreateRule({
        owner, vaultTotalRules: uv.totalRules, trigger: { kind: "TeamWin", teamId },
        amountUsdc, maxSlippageBps: DEFAULT_MAX_SLIPPAGE_BPS, maxExecutions: DEFAULT_MAX_EXECUTIONS,
        matchId, matchEndTs, actionKind: "SwapStakeAndSave",
      }));
      return submit(ixs, onSent);
    });
    if (sig) await refresh();
    return sig;
  }, [address, connection, fixtures, refresh, run]);

  // GOALSCORED (keeper + oracle). A deliberate SIBLING of createChallenge rather
  // than a flag on it: the TeamWin path above stays byte-for-byte unchanged, the
  // args differ (threshold), and the resulting rule is claimed through a
  // completely different instruction (execute_rule_verified, submitted by anyone
  // with a proof — never self-claimed on a timer).
  //
  // stat_key is resolved HERE, at creation, and pinned into the rule: the
  // on-chain predicate only ever checks stat_key, so it must match the side the
  // backed team actually plays on in THIS fixture. Getting it wrong would mean
  // proving the opponent's goals.
  const createGoalChallenge = useCallback(async (teamId: number, amountStr: string, threshold: number) => {
    // HARD GUARD — see GOALSCORED_CREATION_ENABLED in constants.ts. Enforced here
    // rather than only on the UI chip so that no caller (including the
    // /dev/goal-rule harness, which invokes this directly) can create a rule the
    // keeper may never be able to claim. Throws before ANY on-chain work.
    if (!GOALSCORED_CREATION_ENABLED) {
      throw new Error(
        "Goal Scored challenges are temporarily disabled: keeper claims can fail silently while rules share one SPL delegation. Existing goal challenges are unaffected.",
      );
    }
    if (!address) return null;
    const owner = new PublicKey(address);
    const amountUsdc = BigInt(Math.round(Number(amountStr) * 10 ** DEVUSDC_DECIMALS));
    const sig = await run("Setting up your goal challenge", async (onSent) => {
      if (amountUsdc <= 0n) throw new Error("Enter an amount greater than 0");
      if (!Number.isInteger(threshold) || threshold < 1 || threshold > 255) {
        throw new Error("Goals must be a whole number between 1 and 255");
      }
      const fixture = nextFixtureForTeam(teamId);
      if (!fixture) throw new Error("No scheduled match found for this team yet");

      // Is the backed team the HOME side in this fixture?
      const isP1 = fixture.participant1.id === teamId;
      const isHome = isP1 ? fixture.participant1IsHome : !fixture.participant1IsHome;
      const statKey = isHome ? STAT_KEY_HOME_GOALS : STAT_KEY_AWAY_GOALS;

      const matchId = BigInt(fixture.fixtureId);
      // Stored but UNUSED by execute_rule_verified (that fires on the proof,
      // mid-match). Kept consistent with the TeamWin path so the field always
      // means the same thing.
      const matchEndTs = BigInt(Math.floor(fixture.startTime / 1000) + MATCH_END_BUFFER_SECS);

      const ixs: TransactionInstruction[] = [];
      const uv = await getUserVault(connection, owner);
      if (!uv.exists) ixs.push(ixInitializeVault(owner));
      const usdcAta = getAssociatedTokenAddressSync(DEVUSDC_MINT, owner);
      if (!(await connection.getAccountInfo(usdcAta))) {
        ixs.push(createAssociatedTokenAccountIdempotentInstruction(owner, usdcAta, owner, DEVUSDC_MINT));
      }
      const vault = vaultPda(owner);
      // The keeper cannot create these later — it only pays fees and has no
      // authority to open ATAs for someone else's vault. They MUST exist before
      // the rule can ever fire, so create them here as the TeamWin path does.
      for (const mint of [DEVUSDC_MINT, WSOL_MINT]) {
        const vaultAta = ata(mint, vault);
        if (!(await connection.getAccountInfo(vaultAta))) {
          ixs.push(createAssociatedTokenAccountIdempotentInstruction(owner, vaultAta, vault, mint));
        }
      }
      ixs.push(ixCreateRule({
        owner, vaultTotalRules: uv.totalRules,
        trigger: { kind: "GoalScored", teamId, statKey, threshold },
        amountUsdc, maxSlippageBps: DEFAULT_MAX_SLIPPAGE_BPS, maxExecutions: DEFAULT_MAX_EXECUTIONS,
        matchId, matchEndTs,
      }));
      return submit(ixs, onSent);
    });
    if (sig) await refresh();
    return sig;
  }, [address, connection, fixtures, refresh, run]);

  const cancelChallenge = useCallback(async (ruleId: number) => {
    if (!address) return null;
    const owner = new PublicKey(address);
    const sig = await run("Cancelling challenge", (onSent) => submit([ixRevokeRule(owner, ruleId)], onSent));
    if (sig) await refresh();
    return sig;
  }, [address, refresh, run]);

  // SELF-CLAIM: the owner executes their own rule directly, once its
  // match_end_ts has passed — no admin, no oracle. Replaces the old flow where
  // an admin wallet built + signed this from /admin.
  // SHARED-DELEGATION REPAIR (frontend-only; no program change).
  //
  // create_rule grants the vault an SPL delegation via token::approve on the
  // owner's single USDC ATA — and SPL `approve` OVERWRITES, it does not
  // accumulate. So a wallet only ever holds ONE allowance, belonging to whichever
  // rule was created last. That allowance dies three ways: a newer rule
  // overwrites it, an execution drains it to 0 (SPL then clears the delegate
  // entirely), or revoke_rule on ANY rule blanket-revokes it. Any other rule then
  // fails its delegated pull with SPL OwnerMismatch (0x4) — which is exactly what
  // broke rule #11.
  //
  // Fix: immediately before the claim instruction, in the SAME transaction,
  // re-approve exactly what THIS rule still needs. The owner is already signing,
  // so no extra prompt. Atomic with the claim, so nothing can race in between.
  //
  // Scope: the OWNER-SIGNED self-claim paths only (execute_rule,
  // execute_rule_direct, execute_rule_staked). It CANNOT help
  // execute_rule_verified — the keeper submits that transaction and cannot sign
  // an approve on the user's behalf, which is why GoalScored creation is blocked
  // outright (GOALSCORED_CREATION_ENABLED) until create_rule/revoke_rule are
  // properly fixed.
  const approveForRule = useCallback(async (owner: PublicKey, ruleId: number): Promise<TransactionInstruction> => {
    const rule = await getRule(connection, owner, ruleId);
    if (!rule) throw new Error("Challenge not found on-chain");
    if (!rule.amountUsdc) throw new Error("Challenge has no amount to save");
    const remaining = rule.maxExecutions - rule.executionsDone;
    if (remaining <= 0) throw new Error("This challenge has already been fully claimed");
    // Exactly this rule's outstanding need — never more. Bounds what the vault
    // can pull to what the user opted into for this specific challenge.
    const needed = BigInt(rule.amountUsdc) * BigInt(remaining);
    return createApproveInstruction(ata(DEVUSDC_MINT, owner), vaultPda(owner), owner, needed);
  }, [connection]);

  const claimChallenge = useCallback(async (ruleId: number) => {
    if (!address) return null;
    const owner = new PublicKey(address);
    const sig = await run("Claiming your savings", async (onSent) => {
      const { ta0, ta1, ta2, whirlpoolOracle } = await ticksForBToA(connection);
      // Bump the CU limit past the 200k default for the Orca swap CPI. Measured
      // ~50k on devnet for this instruction; 400k leaves generous headroom.
      const ixs: TransactionInstruction[] = [
        ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }),
      ];
      // The swap output goes straight to the owner's wSOL ATA — make sure it exists.
      const ownerWsol = ata(WSOL_MINT, owner);
      if (!(await connection.getAccountInfo(ownerWsol))) {
        ixs.push(createAssociatedTokenAccountIdempotentInstruction(owner, ownerWsol, owner, WSOL_MINT));
      }
      // ONE instruction: swap the owner's USDC to wSOL landing DIRECTLY in their
      // wallet. This replaces the old execute_rule + chained withdraw_from_vault
      // pair, which had to withdraw a slippage-floor amount
      // (WITHDRAW_FLOOR_BUFFER_BPS) and stranded ~5% dust in the vault on every
      // claim. Nothing transits the vault now, so there is no floor to estimate
      // and no dust to sweep. WITHDRAW_FLOOR_BUFFER_BPS / ixWithdrawFromVault are
      // still used by the staking path and the manual Withdraw control.
      // Re-establish the SPL delegation for THIS rule, immediately before the
      // instruction that consumes it. See approveForRule() above.
      ixs.push(await approveForRule(owner, ruleId));
      ixs.push(ixExecuteRuleDirect({ owner, ruleId, tickArray0: ta0, tickArray1: ta1, tickArray2: ta2, whirlpoolOracle }));
      return submit(ixs, onSent);
    });
    if (sig) await refresh();
    return sig;
  }, [address, connection, refresh, run, approveForRule]);

  // AUTO STAKE self-claim (execute_rule_staked): sibling of claimChallenge for
  // SwapStakeAndSave rules. Swaps USDC->wSOL, unwraps to SOL, deposits into
  // Marinade -> mSOL in the vault. Per cut-order #1 there is NO chained withdraw
  // here: the mSOL stays in the vault and is collected via the Withdraw control
  // (mSOL withdraw generalization is a later cut item). The 28-account wiring is
  // validated read-only against live state; the deposit-execution path is proven
  // by the live checkpoint against a real staking rule.
  const claimStakeChallenge = useCallback(async (ruleId: number) => {
    if (!address) return null;
    const owner = new PublicKey(address);
    const sig = await run("Claiming your staked savings", async (onSent) => {
      const { ta0, ta1, ta2, whirlpoolOracle } = await ticksForBToA(connection);
      // execute_rule_staked_direct runs the Orca swap CPI AND the Marinade deposit
      // CPI, plus an ephemeral account init — well past the 200k default.
      // Measured ~120k on devnet; 700k leaves generous headroom.
      const ixs: TransactionInstruction[] = [
        ComputeBudgetProgram.setComputeUnitLimit({ units: 700_000 }),
      ];
      // OWNER mSOL ATA — the Marinade `mint_to` destination. The instruction
      // declares it as a plain Account<TokenAccount> that must already exist, so
      // create it idempotently here, exactly as claimChallenge does for the
      // owner's wSOL ATA. (The VAULT's mSOL ATA is no longer needed by the claim:
      // nothing transits the vault now. Any mSOL already sitting there from
      // earlier vault-landing claims stays withdrawable via withdrawStakedSavings.)
      const ownerMsol = ata(MSOL_MINT, owner);
      if (!(await connection.getAccountInfo(ownerMsol))) {
        ixs.push(createAssociatedTokenAccountIdempotentInstruction(owner, ownerMsol, owner, MSOL_MINT));
      }
      // Same shared-delegation repair as claimChallenge — see approveForRule().
      ixs.push(await approveForRule(owner, ruleId));
      // ONE instruction: swap -> unwrap -> Marinade deposit, with the minted mSOL
      // landing DIRECTLY in the owner's wallet. Replaces the vault-landing
      // ixExecuteRuleStaked, which required a separate withdraw to collect.
      ixs.push(ixExecuteRuleStakedDirect({ owner, ruleId, tickArray0: ta0, tickArray1: ta1, tickArray2: ta2, whirlpoolOracle }));
      return submit(ixs, onSent);
    });
    if (sig) await refresh();
    return sig;
  }, [address, connection, refresh, run, approveForRule]);

  const withdrawSavings = useCallback(async () => {
    if (!address) return null;
    const owner = new PublicKey(address);
    const vault = vaultPda(owner);
    const sig = await run("Withdrawing your savings", async (onSent) => {
      const bal = await tokenUiBalance(connection, WSOL_MINT, vault);
      if (!bal || bal.raw <= 0n) throw new Error("No savings to withdraw yet");
      const ixs: TransactionInstruction[] = [];
      const ownerWsol = ata(WSOL_MINT, owner);
      if (!(await connection.getAccountInfo(ownerWsol))) {
        ixs.push(createAssociatedTokenAccountIdempotentInstruction(owner, ownerWsol, owner, WSOL_MINT));
      }
      ixs.push(ixWithdrawFromVault(owner, WSOL_MINT, bal.raw));
      return submit(ixs, onSent);
    });
    if (sig) await refresh();
    return sig;
  }, [address, connection, refresh, run]);

  // Withdraw staked mSOL (Auto Stake) from the vault to the owner's wallet.
  // Sibling of withdrawSavings; the on-chain withdraw_from_vault is mint-generic,
  // so this is the same shape with MSOL_MINT. mSOL is a normal SPL token, so it
  // lands as mSOL in the owner's wallet (no unwrap — mSOL is the yield-bearing
  // asset the user is holding).
  const withdrawStakedSavings = useCallback(async () => {
    if (!address) return null;
    const owner = new PublicKey(address);
    const vault = vaultPda(owner);
    const sig = await run("Withdrawing your staked savings", async (onSent) => {
      const bal = await tokenUiBalance(connection, MSOL_MINT, vault);
      if (!bal || bal.raw <= 0n) throw new Error("No staked savings to withdraw yet");
      const ixs: TransactionInstruction[] = [];
      const ownerMsol = ata(MSOL_MINT, owner);
      if (!(await connection.getAccountInfo(ownerMsol))) {
        ixs.push(createAssociatedTokenAccountIdempotentInstruction(owner, ownerMsol, owner, MSOL_MINT));
      }
      ixs.push(ixWithdrawFromVault(owner, MSOL_MINT, bal.raw));
      return submit(ixs, onSent);
    });
    if (sig) await refresh();
    return sig;
  }, [address, connection, refresh, run]);

  // DEVNET FAUCET HELPER: there is no public devUSDC faucet — this mint only
  // exists paired with the whirlpool this program swaps against. This wraps
  // `solAmountStr` SOL and swaps it to devUSDC via the same real Orca CPI
  // live_flow.cjs uses, just triggered from the browser and signed by the user.
  const getDevUsdc = useCallback(async (solAmountStr: string) => {
    if (!address) return null;
    const owner = new PublicKey(address);
    const lamportsIn = BigInt(Math.round(Number(solAmountStr) * 1e9));
    const sig = await run("Getting devUSDC", async (onSent) => {
      if (lamportsIn <= 0n) throw new Error("Enter an amount greater than 0");
      const ixs: TransactionInstruction[] = [];
      const ownerWsol = ata(WSOL_MINT, owner);
      const ownerUsdc = ata(DEVUSDC_MINT, owner);
      if (!(await connection.getAccountInfo(ownerWsol))) {
        ixs.push(createAssociatedTokenAccountIdempotentInstruction(owner, ownerWsol, owner, WSOL_MINT));
      }
      if (!(await connection.getAccountInfo(ownerUsdc))) {
        ixs.push(createAssociatedTokenAccountIdempotentInstruction(owner, ownerUsdc, owner, DEVUSDC_MINT));
      }
      // wrap: transfer lamports into the wSOL ATA, then sync_native so the SPL
      // balance reflects it (wSOL is "real" SOL sitting in a token account).
      ixs.push(ixWrapSol(owner, ownerWsol, lamportsIn));
      ixs.push(ixSyncNative(ownerWsol));

      const { ta0, ta1, ta2, whirlpoolOracle } = await ticksForAToB(connection);
      const minUsdcOut = await estimateUsdcOut(connection, lamportsIn); // 30% slippage floor — devnet convenience only
      ixs.push(ixSwapSolToUsdc({
        owner, ownerWsolAta: ownerWsol, ownerUsdcAta: ownerUsdc,
        lamportsIn, minUsdcOut,
        tickArray0: ta0, tickArray1: ta1, tickArray2: ta2, whirlpoolOracle,
      }));
      return submit(ixs, onSent);
    });
    if (sig) await refresh();
    return sig;
  }, [address, connection, refresh, run]);

  // resolve id → name: prefer the live snapshot, fall back to the static
  // ParticipantId registry so finished-fixture teams still resolve (never "Team 1634").
  const teamName = useCallback((id: number) => teams.find((t) => t.id === id)?.name ?? TEAM_BY_ID[id] ?? `Team ${id}`, [teams]);

  // Teams selectable in the picker. A team is selectable iff it has at least one
  // fixture that is still upcoming or live — i.e. a real NEXT match to attach a
  // new challenge to (create_rule pins match_id + match_end_ts from it). That is
  // exactly what the picker must guarantee, and it needs no elimination
  // inference: a team knocked out has no future fixture and drops off; a team
  // that lost a semifinal but has a 3rd-place playoff still has an upcoming
  // fixture and stays selectable. Works for every bracket format (incl.
  // 3rd-place playoffs) with no special-casing and no winnerId logic.
  // NOTE: only the PICKER uses this. `teams` stays the full list so teamName()
  // still resolves an already-backed team whose fixtures are all finished.
  const activeTeams = useMemo(() => {
    const hasUpcoming = new Set<number>();
    for (const f of fixtures) {
      if (f.status !== "upcoming" && f.status !== "live") continue;
      hasUpcoming.add(f.participant1.id);
      hasUpcoming.add(f.participant2.id);
    }
    return teams.filter((t) => hasUpcoming.has(t.id));
  }, [teams, fixtures]);

  // Is the fixture a rule is bound to already finished? Used to detect a DEAD
  // GoalScored rule: it fires only while its own match is live (the keeper
  // watches status='live' fixtures), so once that specific match_id is finished
  // and the rule still hasn't executed, it can never fire again. This is about
  // the RULE's bound match_id, NOT about whether the team has other fixtures —
  // a team can be freshly selectable (upcoming 3rd-place match) while an old
  // rule bound to their finished semifinal is permanently expired.
  const isMatchFinished = useCallback(
    (matchId: string) => fixtures.some((f) => f.fixtureId === Number(matchId) && f.status === "finished"),
    [fixtures],
  );

  return {
    ready, authenticated, login, logout, user, address,
    sol, usdc, savedSol, savedMsol, teams, activeTeams, challenges, teamName, isMatchFinished,
    txState, resetTx, busy, refresh, loadError,
    createChallenge, createStakeChallenge, createGoalChallenge, cancelChallenge, withdrawSavings, withdrawStakedSavings, claimChallenge, claimStakeChallenge, getDevUsdc,
  };
}

import { readFileSync } from "fs";
import { PublicKey } from "@solana/web3.js";
import { decodeRule, statKeysForTeam, encodeTrigger, STAT_KEY_HOME_GOALS, STAT_KEY_AWAY_GOALS } from "../src/lib/pf";

const T = "../programs/pocket_fans/tests/fixtures/";
let fail = 0;
const ok = (n: string, c: boolean, extra = "") => { c ? console.log(`  PASS ${n}`) : (fail++, console.log(`  FAIL ${n} ${extra}`)); };

for (const [label, action, stake] of [["swap", "SwapAndSave", false], ["stake", "SwapStakeAndSave", true]] as const) {
  console.log(`\n[${label}] real on-chain Rule bytes`);
  const data = readFileSync(`${T}rule_teamwin_verified_${label}.bin`);
  const r = decodeRule(new PublicKey("11111111111111111111111111111111"), data);
  if (!r) { fail++; console.log("  FAIL decodeRule returned null — rule would be INVISIBLE in the UI"); continue; }
  ok("triggerKind TeamWinVerified", r.triggerKind === "TeamWinVerified", r.triggerKind);
  ok(`actionKind ${action}`, r.actionKind === action, r.actionKind);
  ok("teamId 3021", r.teamId === 3021, String(r.teamId));
  ok("teamStatKey 1 (home)", r.teamStatKey === 1, String(r.teamStatKey));
  ok("opponentStatKey 2 (away)", r.opponentStatKey === 2, String(r.opponentStatKey));
  ok("amountUsdc 1000000", r.amountUsdc === "1000000", String(r.amountUsdc));
  ok("maxSlippageBps 1500", r.maxSlippageBps === 1500, String(r.maxSlippageBps));
  ok("matchId 18257739", r.matchId === "18257739", String(r.matchId));
  ok("maxExecutions 3", r.maxExecutions === 3, String(r.maxExecutions));
  ok("executionsDone 0", r.executionsDone === 0, String(r.executionsDone));
  ok("isActive", r.isActive === true, String(r.isActive));
  ok("statKey/threshold null (not GoalScored)", r.statKey === null && r.threshold === null);
}

console.log("\n[direction] statKeysForTeam");
const fixture = { participant1: { id: 3021 }, participant2: { id: 1489 }, participant1IsHome: true };
const home = statKeysForTeam(3021, fixture), away = statKeysForTeam(1489, fixture);
ok("home backer -> (1,2)", home.teamStatKey === STAT_KEY_HOME_GOALS && home.opponentStatKey === STAT_KEY_AWAY_GOALS, JSON.stringify(home));
ok("away backer -> (2,1)", away.teamStatKey === STAT_KEY_AWAY_GOALS && away.opponentStatKey === STAT_KEY_HOME_GOALS, JSON.stringify(away));
const flipped = { participant1: { id: 3021 }, participant2: { id: 1489 }, participant1IsHome: false };
const p1Away = statKeysForTeam(3021, flipped);
ok("p1 when NOT home -> (2,1)", p1Away.teamStatKey === 2 && p1Away.opponentStatKey === 1, JSON.stringify(p1Away));
let threw = false; try { statKeysForTeam(999, fixture); } catch { threw = true; }
ok("rejects a team not in the fixture", threw);

console.log("\n[encode] trigger byte layout");
const enc = encodeTrigger({ kind: "TeamWinVerified", teamId: 3021, teamStatKey: 1, opponentStatKey: 2 });
const real = readFileSync(`${T}rule_teamwin_verified_swap.bin`).subarray(42, 55);
ok("encodeTrigger === on-chain bytes 42..55", enc.equals(real), `${enc.toString("hex")} vs ${real.toString("hex")}`);

console.log(fail ? `\nFAILED (${fail})` : "\nALL PASSED");
process.exit(fail ? 1 : 0);

// Guards the create flow's ATA pre-creation against the accounts the settle
// instructions actually require.
//
// WHY: execute_rule_verified_win / _staked_ settle DIRECTLY to the owner, so the
// accounts that must pre-exist are NOT the ones createChallenge/
// createGoalChallenge create (those make the VAULT's wSOL/mSOL ATA, which the
// direct path never touches). A mismatch does not fail at creation — the rule is
// created fine and then the keeper's transaction reverts forever on a missing
// account, because a keeper has no authority to open an ATA for someone else.
// So the only place to catch it is here.
import { Keypair, PublicKey } from "@solana/web3.js";
import {
  vaultPda, ata, ixExecuteRuleVerifiedWin, ixExecuteRuleStakedVerifiedWin,
  statKeysForTeam, encodeTrigger, type StatValidationInput,
} from "../src/lib/pf";
import { DEVUSDC_MINT, WSOL_MINT, MSOL_MINT } from "../src/lib/constants";
import fs from "fs";

let fail = 0;
const ok = (n: string, c: boolean, x = "") => { c ? console.log(`  PASS ${n}`) : (fail++, console.log(`  FAIL ${n} ${x}`)); };

const owner = Keypair.generate().publicKey;
const caller = Keypair.generate().publicKey;
const vault = vaultPda(owner);
const tick = Keypair.generate().publicKey;

// Real captured payload so the instruction is built exactly as in production.
const raw = JSON.parse(fs.readFileSync(
  "../programs/pocket_fans/tests/fixtures/stat_validation_18257739_fulltime.json", "utf8"));
const node = (n: any) => ({ hash: n.hash, isRightSibling: n.isRightSibling === true });
const payload: StatValidationInput = {
  ts: BigInt(raw.ts),
  fixtureSummary: {
    fixtureId: BigInt(raw.summary.fixtureId),
    updateStats: {
      updateCount: Number(raw.summary.updateStats.updateCount),
      minTimestamp: BigInt(raw.summary.updateStats.minTimestamp),
      maxTimestamp: BigInt(raw.summary.updateStats.maxTimestamp),
    },
    eventsSubTreeRoot: raw.summary.eventStatsSubTreeRoot,
  },
  fixtureProof: (raw.subTreeProof || []).map(node),
  mainTreeProof: (raw.mainTreeProof || []).map(node),
  eventStatRoot: raw.eventStatRoot,
  stats: raw.statsToProve.map((stat: any, i: number) => ({
    stat: { key: Number(stat.key), value: Number(stat.value), period: Number(stat.period) },
    statProof: raw.statProofs[i].map(node),
  })),
};

const common = { caller, vaultOwner: owner, ruleId: 0, payload,
  tickArray0: tick, tickArray1: tick, tickArray2: tick, whirlpoolOracle: tick };

// EXACTLY what useFanApp.createWinChallenge pre-creates, per action.
const createdBy = (staked: boolean) => [
  ata(DEVUSDC_MINT, owner),
  ata(DEVUSDC_MINT, vault),
  ata(staked ? MSOL_MINT : WSOL_MINT, owner),
].map((k) => k.toBase58());

for (const [label, ix, staked, slots] of [
  ["SwapAndSave", ixExecuteRuleVerifiedWin(common), false,
    { owner_usdc: 5, vault_usdc: 6, payout: 7 }],
  ["SwapStakeAndSave", ixExecuteRuleStakedVerifiedWin(common), true,
    { owner_usdc: 6, vault_usdc: 7, payout: 10 }],
] as const) {
  console.log(`\n[${label}]`);
  const keys = ix.keys.map((k) => k.pubkey.toBase58());
  const created = createdBy(staked);
  ok("owner USDC ata is the instruction's pull source", keys[slots.owner_usdc] === ata(DEVUSDC_MINT, owner).toBase58());
  ok("vault USDC ata is the instruction's swap input", keys[slots.vault_usdc] === ata(DEVUSDC_MINT, vault).toBase58());
  const payoutMint = staked ? MSOL_MINT : WSOL_MINT;
  ok(`OWNER's ${staked ? "mSOL" : "wSOL"} ata is the settlement destination`,
     keys[slots.payout] === ata(payoutMint, owner).toBase58());
  for (const [i, name] of Object.entries(slots)) {
    ok(`create flow pre-creates ${i}`, created.includes(keys[name as number]), keys[name as number]);
  }
  // The regression this exists to prevent: creating the VAULT's payout ATA
  // (what the older flows do) instead of the owner's.
  ok(`does NOT rely on the vault's ${staked ? "mSOL" : "wSOL"} ata`,
     !keys.includes(ata(payoutMint, vault).toBase58()));
}

console.log("\n[trigger encoding round-trip]");
const fixture = { participant1: { id: 3021 }, participant2: { id: 1489 }, participant1IsHome: true };
const { teamStatKey, opponentStatKey } = statKeysForTeam(3021, fixture);
const enc = encodeTrigger({ kind: "TeamWinVerified", teamId: 3021, teamStatKey, opponentStatKey });
const real = fs.readFileSync("../programs/pocket_fans/tests/fixtures/rule_teamwin_verified_swap.bin").subarray(42, 55);
ok("create-flow trigger bytes === on-chain rule bytes", enc.equals(real), `${enc.toString("hex")} vs ${real.toString("hex")}`);

console.log(fail ? `\nFAILED (${fail})` : "\nALL PASSED — create flow pre-creates exactly the accounts the settle path needs");
process.exit(fail ? 1 : 0);

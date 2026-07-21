// End-to-end check of the MANUAL settle path, against LIVE TxLINE data.
//
// Covers the surface the other scripts don't: the browser's own route through
// the server proxy's response -> statValidationFromApi -> ix builder -> v0 tx,
// and that it lands on the same instruction the keeper would have built.
//
// What it does NOT cover (and cannot): the wallet signature and the on-chain
// result. Those are proven in
// programs/pocket_fans/tests/test_teamwin_verified_clone.rs
// (manual_owner_settlement_is_equivalent_to_keeper_settlement).
import { Connection, Keypair, PublicKey, TransactionMessage, VersionedTransaction, ComputeBudgetProgram } from "@solana/web3.js";
import { createRequire } from "module";
import fs from "fs";
import {
  statValidationFromApi, ixExecuteRuleVerifiedWin, ixExecuteRuleStakedVerifiedWin,
} from "../src/lib/pf";
import { LOOKUP_TABLE_ADDRESS, VERIFY_COMPUTE_UNITS } from "../src/lib/constants";

const require_ = createRequire(import.meta.url);
const statvalidation = require_("../../oracle-service/src/statvalidation.cjs");
const txline = require_("../../oracle-service/src/txline.cjs");

let fail = 0;
const ok = (n: string, c: boolean, x = "") => { c ? console.log(`  PASS ${n}`) : (fail++, console.log(`  FAIL ${n} ${x}`)); };
const FIXTURE = 18257739, TEAM_KEY = 1, OPP_KEY = 2, FULL_TIME_PERIOD = 100;

(async () => {
  const conn = new Connection(process.env.RPCU!, "confirmed");

  // --- replicate exactly what /api/challenges/win-proof does server-side ---
  console.log("[1] server route logic against live TxLINE");
  const events = await txline.getScoresSnapshot(FIXTURE);
  const fin = txline.finalFromSnapshot(events);
  ok("game_finalised located", !!fin);
  const seq = Number(fin.Seq);
  const raw = await txline.getStatValidation(FIXTURE, seq, [TEAM_KEY, OPP_KEY]);
  ok("proof returned", !!raw);
  const stats = raw.statsToProve;
  ok("route guard: two stats in the rule's pinned order",
     stats.length === 2 && Number(stats[0].key) === TEAM_KEY && Number(stats[1].key) === OPP_KEY);
  ok("route guard: both full time", stats.every((s: any) => Number(s.period) === FULL_TIME_PERIOD));
  ok("route guard: is a win", Number(stats[0].value) > Number(stats[1].value));

  // --- browser mapping (the shared, parity-pinned mapper) ---
  console.log("\n[2] browser mapping matches the keeper's");
  const payloadTs = statValidationFromApi(raw);
  const payloadCjs = statvalidation.buildStatValidationInput(raw);
  const encTs = require_("../src/lib/pf");
  ok("encoded payload identical to keeper's",
     encTs.encodeStatValidationInput(payloadTs).equals(statvalidation.encodeStatValidationInput(payloadCjs)));

  // --- instruction: owner-as-caller vs keeper-as-caller ---
  console.log("\n[3] owner-signed instruction vs keeper-signed");
  const owner = Keypair.generate().publicKey;
  const keeper = Keypair.generate();
  const ticks = await statvalidation.ticksForBToA(conn);
  const tickArgs = { tickArray0: ticks.ta0, tickArray1: ticks.ta1, tickArray2: ticks.ta2, whirlpoolOracle: ticks.whirlpoolOracle };

  const { value: lut } = await conn.getAddressLookupTable(LOOKUP_TABLE_ADDRESS);
  ok("live lookup table resolves", !!lut);

  for (const [label, build, cjsBuild] of [
    ["SwapAndSave", ixExecuteRuleVerifiedWin, statvalidation.ixExecuteRuleVerifiedWin],
    ["SwapStakeAndSave", ixExecuteRuleStakedVerifiedWin, statvalidation.ixExecuteRuleStakedVerifiedWin],
  ] as const) {
    const manual = build({ caller: owner, vaultOwner: owner, ruleId: 0, payload: payloadTs, ...tickArgs });
    const bykeeper = cjsBuild({ caller: keeper.publicKey, vaultOwner: owner, ruleId: 0, payload: payloadCjs, ...ticks });

    ok(`${label}: identical instruction data`, Buffer.from(manual.data).equals(Buffer.from(bykeeper.data)));
    // Slot 0 (caller) is the ONLY thing that may differ — that is the entire
    // difference between the manual fallback and the keeper.
    const diffs = manual.keys.map((k, i) => (k.pubkey.equals(bykeeper.keys[i].pubkey) ? null : i)).filter((i) => i !== null);
    ok(`${label}: ONLY the caller slot differs (got [${diffs}])`, diffs.length === 1 && diffs[0] === 0);
    ok(`${label}: caller is the owner`, manual.keys[0].pubkey.equals(owner) && manual.keys[0].isSigner);

    // The owner's wallet must be able to actually send it.
    const msg = new TransactionMessage({
      payerKey: owner,
      recentBlockhash: "11111111111111111111111111111111",
      instructions: [ComputeBudgetProgram.setComputeUnitLimit({ units: VERIFY_COMPUTE_UNITS }), manual],
    }).compileToV0Message([lut!]);
    const size = new VersionedTransaction(msg).serialize().length + 64; // +1 owner signature
    ok(`${label}: owner-signed v0 tx fits (${size} B, ${1232 - size} spare)`, size <= 1232);
  }

  console.log(fail ? `\nFAILED (${fail})` : "\nALL PASSED — manual settle path builds a valid, keeper-equivalent transaction from live data");
  process.exit(fail ? 1 : 0);
})();

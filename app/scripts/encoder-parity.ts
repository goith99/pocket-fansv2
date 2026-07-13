// Encoder parity harness. Driven by programs/pocket_fans/tests/test_encoder_parity.rs
// (so it runs as part of `anchor test` / `cargo test` and cannot silently rot).
//
// WHY THIS EXISTS: the StatValidationInput borsh encoder is implemented TWICE —
// app/src/lib/pf.ts (browser, bundled) and oracle-service/src/statvalidation.cjs
// (keeper, Node). They cannot share a module: the app can only reach
// oracle-service through a SERVER-ONLY `webpackIgnore` dynamic import (see
// app/src/lib/serverOracle.ts), which browser code cannot use. Rather than
// refactor into a shared package, the two are pinned by this test:
//
//   1. here:            pf.ts bytes === statvalidation.cjs bytes
//   2. in the Rust test: those bytes deserialize into the real on-chain struct
//
// Together that means neither encoder can drift from the other OR from the
// program. If you change one, this fails.
//
// Usage: npx tsx scripts/encoder-parity.ts <out-dir>
//   writes <out-dir>/parity_ts.bin and <out-dir>/parity_cjs.bin
import { Buffer } from "buffer";
import fs from "fs";
import path from "path";
import { createRequire } from "module";
import {
  encodeStatValidationInput, dailyScoresRootsPda, StatValidationInput,
} from "../src/lib/pf";

const require_ = createRequire(import.meta.url);
// The keeper's encoder — the OTHER implementation under test.
const statvalidation = require_("../../oracle-service/src/statvalidation.cjs");

const outDir = process.argv[2];
if (!outDir) throw new Error("usage: encoder-parity.ts <out-dir>");

// A REAL /api/scores/stat-validation response (fixture 18179759, seq 885,
// statKeys=1), captured live. Not synthetic — it carries the API's actual field
// names, which are NOT 1:1 with the on-chain struct (subTreeProof ->
// fixture_proof, summary.eventStatsSubTreeRoot -> events_sub_tree_root).
const FIXTURE = path.resolve(
  __dirname,
  "../../programs/pocket_fans/tests/fixtures/stat_validation_18179759.json",
);
const sv = JSON.parse(fs.readFileSync(FIXTURE, "utf8"));

// --- side A: the keeper's CJS module (mapping + encoding) ---
const payloadCjs = statvalidation.buildStatValidationInput(sv);
const bytesCjs: Buffer = statvalidation.encodeStatValidationInput(payloadCjs);

// --- side B: pf.ts, fed the same mapping expressed in its own types ---
const node = (n: any) => ({ hash: n.hash, isRightSibling: n.isRightSibling === true });
const payloadTs: StatValidationInput = {
  ts: BigInt(sv.ts),
  fixtureSummary: {
    fixtureId: BigInt(sv.summary.fixtureId),
    updateStats: {
      updateCount: Number(sv.summary.updateStats.updateCount),
      minTimestamp: BigInt(sv.summary.updateStats.minTimestamp),
      maxTimestamp: BigInt(sv.summary.updateStats.maxTimestamp),
    },
    eventsSubTreeRoot: sv.summary.eventStatsSubTreeRoot,
  },
  fixtureProof: (sv.subTreeProof || []).map(node),
  mainTreeProof: (sv.mainTreeProof || []).map(node),
  eventStatRoot: sv.eventStatRoot,
  stats: sv.statsToProve.map((stat: any, i: number) => ({
    stat: { key: Number(stat.key), value: Number(stat.value), period: Number(stat.period) },
    statProof: sv.statProofs[i].map(node),
  })),
};
const bytesTs = encodeStatValidationInput(payloadTs);

// --- assertion 1: the two encoders agree, byte for byte ---
if (!bytesTs.equals(bytesCjs)) {
  console.error(
    `ENCODER DRIFT: pf.ts produced ${bytesTs.length} bytes, ` +
      `statvalidation.cjs produced ${bytesCjs.length} bytes, and they differ.\n` +
      "These two MUST stay in lockstep — see the header of this file.",
  );
  process.exit(1);
}

// --- assertion 2: the daily_scores_roots PDA derivation also agrees ---
const pdaTs = dailyScoresRootsPda(payloadTs.fixtureSummary.updateStats.minTimestamp).toBase58();
const pdaCjs = statvalidation
  .dailyScoresRootsPda(payloadCjs.fixtureSummary.updateStats.minTimestamp)
  .toBase58();
if (pdaTs !== pdaCjs) {
  console.error(`PDA DRIFT: pf.ts=${pdaTs} statvalidation.cjs=${pdaCjs}`);
  process.exit(1);
}

fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, "parity_ts.bin"), bytesTs);
fs.writeFileSync(path.join(outDir, "parity_cjs.bin"), bytesCjs);

console.log(`encoder parity OK: ${bytesTs.length} bytes identical (pf.ts === statvalidation.cjs)`);
console.log(`daily_scores_roots PDA agrees: ${pdaTs}`);

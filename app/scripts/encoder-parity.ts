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
//   3. here:            the resulting transaction actually FITS in a packet
//
// Assertion 3 exists because of a real, shipped bug — see TX SIZE below.
//
// Usage: npx tsx scripts/encoder-parity.ts <out-dir>
//   writes <out-dir>/parity_{ts,cjs}_<fixtureId>.bin for each fixture
import { Buffer } from "buffer";
import fs from "fs";
import path from "path";
import { createRequire } from "module";
import {
  Keypair, PublicKey, Transaction, TransactionMessage,
  VersionedTransaction, AddressLookupTableAccount,
} from "@solana/web3.js";
import {
  encodeStatValidationInput, dailyScoresRootsPda, StatValidationInput,
  ixExecuteRuleVerifiedWin, ixExecuteRuleStakedVerifiedWin, statValidationFromApi,
} from "../src/lib/pf";

const require_ = createRequire(import.meta.url);
// The keeper's encoder — the OTHER implementation under test.
const statvalidation = require_("../../oracle-service/src/statvalidation.cjs");

const outDir = process.argv[2];
if (!outDir) throw new Error("usage: encoder-parity.ts <out-dir>");

const PACKET_LIMIT = 1232;

// ---------------------------------------------------------------------------
// TX SIZE — why there are TWO fixtures, and why one of them is "the big one".
//
// execute_rule_verified's payload is a Merkle proof whose size depends on
// TxLINE's tree shape. Measured across 54 real proofs from 9 finished World Cup
// fixtures: subTreeProof (= fixture_proof on-chain) ranges 1..8, and as a LEGACY
// transaction that puts 42 of the 54 OVER the 1232-byte packet limit — they
// throw "Transaction too large" at construction and the rule silently never
// fires.
//
// This went unnoticed for a whole feature cycle because the only committed
// fixture was 18179759 — an END-OF-MATCH, single-update proof with
// subTreeProof=1, which fits. It is an OUTLIER. A GoalScored rule fires
// MID-MATCH, which is exactly where the proof is deepest.
//
// So: 18187298 (mid-match, subTreeProof=8) is committed alongside it, and this
// harness asserts BOTH of:
//   a) it still fits once encoded as v0 + Address Lookup Table  (the fix), and
//   b) it would NOT have fit as a legacy transaction            (proof that this
//      fixture genuinely exercises the risk — so if someone "simplifies" it back
//      to a shallow proof, this fails loudly instead of going quiet again).
// ---------------------------------------------------------------------------
const FIXTURES = [
  {
    id: 18_179_759,
    file: "stat_validation_18179759.json",
    note: "end-of-match, shallow proof (subTreeProof=1) — fits even as a legacy tx",
    expectFitsLegacy: true,
  },
  {
    id: 18_187_298,
    file: "stat_validation_18187298_midmatch.json",
    note: "MID-MATCH, deep proof (subTreeProof=8) — the realistic GoalScored case",
    expectFitsLegacy: false, // must NOT fit as legacy; that is the whole point
  },
];

// ---------------------------------------------------------------------------
// TeamWinVerified fixtures — TWO stats, not one.
//
// A win predicate proves the backed team's goals AND the opponent's, so the
// payload carries two StatLeafs (each with its own Merkle branch) where
// GoalScored carries one. That roughly doubles the stat portion, which is why
// these get their own size assertions rather than riding on the fixtures above.
//
// This is a real captured full-time proof for World Cup fixture 18257739
// (1-0 home, keys [1,2] at the game_finalised seq 1385, both period 100).
// ---------------------------------------------------------------------------
const WIN_FIXTURE = {
  id: 18_257_739,
  file: "stat_validation_18257739_fulltime.json",
  note: "FULL-TIME, two-stat win proof — the TeamWinVerified case",
};

/** Encode via pf.ts. Uses the SHARED exported mapper (statValidationFromApi),
 * not a local copy — the manual-settle path in the browser uses that same
 * function, so this pins the MAPPING as well as the encoding. */
const toPfTs = (sv: any): StatValidationInput => statValidationFromApi(sv);

/**
 * Build the real execute_rule_verified tx both ways and report sizes. Fully
 * OFFLINE: the lookup table is synthesised from statvalidation.altStaticAddresses
 * rather than fetched, so this test never needs the network.
 */
function txSizes(payloadCjs: any) {
  const keeper = Keypair.generate();
  const vaultOwner = Keypair.generate().publicKey;
  // Tick arrays/oracle are price-derived at runtime; any pubkey gives the same
  // SIZE, which is all this is measuring.
  const ta0 = Keypair.generate().publicKey;
  const ta1 = Keypair.generate().publicKey;
  const whirlpoolOracle = Keypair.generate().publicKey;
  const ticks = { ta0, ta1, ta2: ta0, whirlpoolOracle };

  const ix = statvalidation.ixExecuteRuleVerified({
    caller: keeper.publicKey, vaultOwner, ruleId: 9, payload: payloadCjs, ...ticks,
  });
  const blockhash = "11111111111111111111111111111111";

  // legacy (what the keeper used to build — kept ONLY to assert it still breaks)
  const legacy = new Transaction().add(statvalidation.ixComputeBudget()).add(ix);
  legacy.feePayer = keeper.publicKey;
  legacy.recentBlockhash = blockhash;
  const legacyBytes = legacy.serializeMessage().length + 1 + 64;

  // v0 + ALT (what the keeper builds now)
  const lut = new AddressLookupTableAccount({
    key: statvalidation.LOOKUP_TABLE_ADDRESS as PublicKey,
    state: {
      deactivationSlot: 2n ** 64n - 1n,
      lastExtendedSlot: 0,
      lastExtendedSlotStartIndex: 0,
      authority: keeper.publicKey,
      addresses: statvalidation.altStaticAddresses(ticks),
    },
  });
  const msg = new TransactionMessage({
    payerKey: keeper.publicKey,
    recentBlockhash: blockhash,
    instructions: [statvalidation.ixComputeBudget(), ix],
  }).compileToV0Message([lut]);
  const v0 = new VersionedTransaction(msg);
  v0.sign([keeper]);

  return { legacyBytes, v0Bytes: v0.serialize().length, accounts: ix.keys.length };
}

fs.mkdirSync(outDir, { recursive: true });
let failed = false;

for (const fx of FIXTURES) {
  const file = path.resolve(__dirname, "../../programs/pocket_fans/tests/fixtures", fx.file);
  const sv = JSON.parse(fs.readFileSync(file, "utf8"));

  // --- side A: the keeper's CJS module (mapping + encoding) ---
  const payloadCjs = statvalidation.buildStatValidationInput(sv);
  const bytesCjs: Buffer = statvalidation.encodeStatValidationInput(payloadCjs);

  // --- side B: pf.ts, fed the same mapping expressed in its own types ---
  const bytesTs = encodeStatValidationInput(toPfTs(sv));

  console.log(`\n[${fx.id}] ${fx.note}`);

  // --- assertion 1: the two encoders agree, byte for byte ---
  if (!bytesTs.equals(bytesCjs)) {
    console.error(
      `  ENCODER DRIFT: pf.ts produced ${bytesTs.length} bytes, ` +
        `statvalidation.cjs produced ${bytesCjs.length} bytes, and they differ.\n` +
        "  These two MUST stay in lockstep — see the header of this file.",
    );
    failed = true;
    continue;
  }

  // --- assertion 2: the daily_scores_roots PDA derivation also agrees ---
  const pdaTs = dailyScoresRootsPda(BigInt(sv.summary.updateStats.minTimestamp)).toBase58();
  const pdaCjs = statvalidation
    .dailyScoresRootsPda(payloadCjs.fixtureSummary.updateStats.minTimestamp)
    .toBase58();
  if (pdaTs !== pdaCjs) {
    console.error(`  PDA DRIFT: pf.ts=${pdaTs} statvalidation.cjs=${pdaCjs}`);
    failed = true;
    continue;
  }

  // --- assertion 3: the transaction this payload produces must actually fit ---
  const { legacyBytes, v0Bytes, accounts } = txSizes(payloadCjs);
  const fitsLegacy = legacyBytes <= PACKET_LIMIT;

  console.log(`  encoders agree : ${bytesTs.length} bytes, ${accounts} accounts`);
  console.log(`  subTreeProof   : ${payloadCjs.fixtureProof.length}`);
  console.log(`  legacy tx      : ${legacyBytes} B  ${fitsLegacy ? "(fits)" : "(TOO LARGE — as expected)"}`);
  console.log(`  v0 + ALT tx    : ${v0Bytes} B  (${PACKET_LIMIT - v0Bytes} B spare)`);

  if (v0Bytes > PACKET_LIMIT) {
    console.error(
      `  TX TOO LARGE: even as v0 + ALT this is ${v0Bytes} B > ${PACKET_LIMIT}. ` +
        "The keeper cannot submit this proof. Check the lookup table contents.",
    );
    failed = true;
  }
  if (fitsLegacy !== fx.expectFitsLegacy) {
    console.error(
      fx.expectFitsLegacy
        ? `  UNEXPECTED: this fixture no longer fits as a legacy tx (${legacyBytes} B).`
        : `  FIXTURE NO LONGER EXERCISES THE SIZE RISK: it now fits as a legacy tx ` +
          `(${legacyBytes} B <= ${PACKET_LIMIT}). This fixture exists specifically to be a ` +
          `DEEP mid-match proof. Replace it with one whose subTreeProof is 5..8 — otherwise ` +
          `the transaction-size regression this guards against becomes invisible again.`,
    );
    failed = true;
  }

  fs.writeFileSync(path.join(outDir, `parity_ts_${fx.id}.bin`), bytesTs);
  fs.writeFileSync(path.join(outDir, `parity_cjs_${fx.id}.bin`), bytesCjs);
}

// ---------------------------------------------------------------------------
// TeamWinVerified: compare the FULL INSTRUCTIONS, not just the payload.
//
// Everything above pins the shared payload encoder. That is necessary but NOT
// sufficient: each side also builds its own account list, and an account order
// or writable-flag mismatch between browser and keeper is invisible to a
// payload-only comparison. It would surface as a runtime failure on one client
// and not the other — the worst kind to debug. So here both sides build the
// whole instruction and every byte and every account meta is compared.
// ---------------------------------------------------------------------------
{
  const file = path.resolve(
    __dirname, "../../programs/pocket_fans/tests/fixtures", WIN_FIXTURE.file,
  );
  const sv = JSON.parse(fs.readFileSync(file, "utf8"));
  const payloadCjs = statvalidation.buildStatValidationInput(sv);
  const payloadTs = toPfTs(sv);

  console.log(`\n[${WIN_FIXTURE.id}] ${WIN_FIXTURE.note}`);

  // The proof must actually be the two-stat, full-time shape this trigger needs,
  // or the assertions below are measuring the wrong thing.
  const stats = payloadCjs.stats;
  if (stats.length !== 2) {
    console.error(`  WRONG SHAPE: expected 2 stats, got ${stats.length}. This fixture must be a two-stat win proof.`);
    failed = true;
  } else if (!stats.every((s: any) => s.stat.period === 100)) {
    console.error(
      `  NOT FULL TIME: periods ${stats.map((s: any) => s.stat.period).join(",")} (expected 100,100). ` +
        "The on-chain full-time pin would reject this, so it cannot stand in for a real win proof.",
    );
    failed = true;
  } else {
    console.log(`  stats          : ${stats.map((s: any) => `k${s.stat.key}=${s.stat.value}@p${s.stat.period}`).join(" ")}`);
  }

  const keeper = Keypair.generate();
  const vaultOwner = Keypair.generate().publicKey;
  const ta0 = Keypair.generate().publicKey;
  const ta1 = Keypair.generate().publicKey;
  const whirlpoolOracle = Keypair.generate().publicKey;
  const ticks = { ta0, ta1, ta2: ta0, whirlpoolOracle };
  const common = { caller: keeper.publicKey, vaultOwner, ruleId: 9 };

  const PAIRS = [
    {
      name: "execute_rule_verified_win",
      cjs: statvalidation.ixExecuteRuleVerifiedWin({ ...common, payload: payloadCjs, ...ticks }),
      ts: ixExecuteRuleVerifiedWin({
        ...common, payload: payloadTs,
        tickArray0: ta0, tickArray1: ta1, tickArray2: ta0, whirlpoolOracle,
      }),
      expectAccounts: 19,
    },
    {
      name: "execute_rule_staked_verified_win",
      cjs: statvalidation.ixExecuteRuleStakedVerifiedWin({ ...common, payload: payloadCjs, ...ticks }),
      ts: ixExecuteRuleStakedVerifiedWin({
        ...common, payload: payloadTs,
        tickArray0: ta0, tickArray1: ta1, tickArray2: ta0, whirlpoolOracle,
      }),
      expectAccounts: 30,
    },
  ];

  const lut = new AddressLookupTableAccount({
    key: statvalidation.LOOKUP_TABLE_ADDRESS as PublicKey,
    state: {
      deactivationSlot: 2n ** 64n - 1n,
      lastExtendedSlot: 0,
      lastExtendedSlotStartIndex: 0,
      authority: keeper.publicKey,
      addresses: statvalidation.altStaticAddresses(ticks),
    },
  });

  for (const p of PAIRS) {
    // --- instruction data, byte for byte (includes the discriminator) ---
    if (!Buffer.from(p.ts.data).equals(Buffer.from(p.cjs.data))) {
      console.error(
        `  ${p.name}: INSTRUCTION DATA DRIFT — pf.ts ${p.ts.data.length} B vs ` +
          `statvalidation.cjs ${p.cjs.data.length} B`,
      );
      failed = true;
      continue;
    }
    // --- account list: address, order, signer AND writable ---
    if (p.ts.keys.length !== p.cjs.keys.length) {
      console.error(`  ${p.name}: ACCOUNT COUNT DRIFT — pf.ts ${p.ts.keys.length} vs cjs ${p.cjs.keys.length}`);
      failed = true;
      continue;
    }
    const drift: string[] = [];
    p.ts.keys.forEach((k, i) => {
      const o = p.cjs.keys[i];
      if (!k.pubkey.equals(o.pubkey)) drift.push(`#${i} address ${k.pubkey.toBase58()} vs ${o.pubkey.toBase58()}`);
      if (k.isSigner !== o.isSigner) drift.push(`#${i} isSigner ${k.isSigner} vs ${o.isSigner}`);
      if (k.isWritable !== o.isWritable) drift.push(`#${i} isWritable ${k.isWritable} vs ${o.isWritable}`);
    });
    if (drift.length) {
      console.error(`  ${p.name}: ACCOUNT META DRIFT — ${drift.join("; ")}`);
      failed = true;
      continue;
    }
    if (p.ts.keys.length !== p.expectAccounts) {
      console.error(`  ${p.name}: expected ${p.expectAccounts} accounts, got ${p.ts.keys.length}`);
      failed = true;
      continue;
    }

    // --- and it has to fit ---
    let legacyBytes: number | null = null;
    try {
      const legacy = new Transaction().add(statvalidation.ixComputeBudget()).add(p.cjs);
      legacy.feePayer = keeper.publicKey;
      legacy.recentBlockhash = "11111111111111111111111111111111";
      legacyBytes = legacy.serializeMessage().length + 1 + 64;
    } catch {
      legacyBytes = null; // overflows at construction — see below
    }
    const msg = new TransactionMessage({
      payerKey: keeper.publicKey,
      recentBlockhash: "11111111111111111111111111111111",
      instructions: [statvalidation.ixComputeBudget(), p.cjs],
    }).compileToV0Message([lut]);
    const v0 = new VersionedTransaction(msg);
    v0.sign([keeper]);
    const v0Bytes = v0.serialize().length;

    console.log(
      `  ${p.name}: encoders agree (${p.ts.data.length} B data, ${p.ts.keys.length} accounts) | ` +
        `legacy ${legacyBytes === null ? "THROWS" : legacyBytes + " B"} | v0+ALT ${v0Bytes} B ` +
        `(${PACKET_LIMIT - v0Bytes} B spare)`,
    );

    if (v0Bytes > PACKET_LIMIT) {
      console.error(
        `  ${p.name}: TX TOO LARGE — ${v0Bytes} B > ${PACKET_LIMIT} even as v0 + ALT. ` +
          "Check that the lookup table contains every static account this instruction uses " +
          "(the staked variant needs the 9 Marinade/mSOL/system entries added 2026-07-21).",
      );
      failed = true;
    }
  }

  fs.writeFileSync(path.join(outDir, `parity_ts_${WIN_FIXTURE.id}.bin`), encodeStatValidationInput(payloadTs));
  fs.writeFileSync(path.join(outDir, `parity_cjs_${WIN_FIXTURE.id}.bin`), statvalidation.encodeStatValidationInput(payloadCjs));
}

if (failed) process.exit(1);
console.log(
  `\nencoder parity OK across ${FIXTURES.length + 1} fixtures (pf.ts === statvalidation.cjs), ` +
    "including full-instruction parity for both TeamWinVerified instructions. All txs fit.",
);

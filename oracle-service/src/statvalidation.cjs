// StatValidationInput borsh encoding + execute_rule_verified instruction builder
// for the KEEPER (Node/Railway side).
//
// WHY THIS EXISTS SEPARATELY FROM app/src/lib/pf.ts:
// pf.ts is the same encoder for the BROWSER. The two cannot share a module:
// pf.ts is bundled for the client, and the app can only reach oracle-service via
// a server-only `webpackIgnore` dynamic import (see app/src/lib/serverOracle.ts)
// — that trick is unavailable to browser code. So instead of letting two
// encoders silently drift, they are pinned by test:
//   - both are asserted byte-identical to each other, and
//   - both are asserted to deserialize in Rust (the compiled struct)
// If you change a field here, change it in pf.ts and re-run those checks.
//
// Field order below mirrors programs/pocket_fans/src/instructions/txoracle.rs
// EXACTLY. It is the borsh wire format — do not reorder.
const {
  PublicKey, TransactionInstruction, ComputeBudgetProgram,
} = require('@solana/web3.js');

const PROGRAM_ID = new PublicKey('4f74EBY7KMe8mUP9MpNzRnPzW6LojYX8wm56ZZz3iDgB');
const TXORACLE_PROGRAM = new PublicKey('6pW64gN1s2uqjHkn1unFeEjAwJkPGHoppGvS715wyP2J');
const DEVUSDC_MINT = new PublicKey('BRjpCHtyQLNCo8gqRUr8jtdAj5AjPYQaoqbvcZiHok1k');
const WSOL_MINT = new PublicKey('So11111111111111111111111111111111111111112');
const WHIRLPOOL = new PublicKey('3KBZiL2g8C7tiJ32hTv5v3KM7aK9htpqTw4cTXz1HvPt');
const WHIRLPOOL_PROGRAM = new PublicKey('whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc');
const WHIRLPOOL_VAULT_A = new PublicKey('C9zLV5zWF66j3rZj3uuhDqvfuA8esJyWnruGzDW9qEj2');
const WHIRLPOOL_VAULT_B = new PublicKey('7DM3RMz2yzUB8yPRQM3FMZgdFrwZGMsabsfsKopWktoX');
const TOKEN_PROGRAM = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const ATA_PROGRAM = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');

// sha256("global:execute_rule_verified")[0..8] — cross-checked against the IDL.
const DISC_EXECUTE_RULE_VERIFIED = Buffer.from([109, 158, 73, 235, 69, 145, 96, 155]);

// validate_stat_v2 walks several Merkle branches; the 200k default CU limit is
// not enough (TxLINE's own examples use 1.4M).
const VERIFY_COMPUTE_UNITS = 1_400_000;

const VAULT_SEED = Buffer.from('vault');
const RULE_SEED = Buffer.from('rule');

// --- little-endian primitives ---
const u8 = (n) => Buffer.from([n]);
const u16 = (n) => { const b = Buffer.alloc(2); b.writeUInt16LE(n); return b; };
const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
const i32 = (n) => { const b = Buffer.alloc(4); b.writeInt32LE(n); return b; };
const i64 = (n) => { const b = Buffer.alloc(8); b.writeBigInt64LE(BigInt(n)); return b; };
const bool = (v) => Buffer.from([v ? 1 : 0]);
const bytes32 = (v) => {
  const b = Buffer.from(v);
  if (b.length !== 32) throw new Error(`expected 32 bytes, got ${b.length}`);
  return b;
};
/** Borsh Vec<T> = u32 LE length prefix + items. */
const vec = (items, enc) => Buffer.concat([u32(items.length), ...items.map(enc)]);

// --- StatValidationInput ---
const encProofNode = (n) => Buffer.concat([bytes32(n.hash), bool(n.isRightSibling)]);
const encScoreStat = (s) => Buffer.concat([u32(s.key), i32(s.value), i32(s.period)]);
const encStatLeaf = (l) => Buffer.concat([encScoreStat(l.stat), vec(l.statProof, encProofNode)]);
const encBatchSummary = (s) => Buffer.concat([
  i64(s.fixtureId),                  // fixture_id: i64 (signed — NOT u64)
  i32(s.updateStats.updateCount),    // update_count: i32
  i64(s.updateStats.minTimestamp),   // min_timestamp: i64
  i64(s.updateStats.maxTimestamp),   // max_timestamp: i64
  bytes32(s.eventsSubTreeRoot),      // events_sub_tree_root: [u8; 32]
]);

function encodeStatValidationInput(p) {
  return Buffer.concat([
    i64(p.ts),
    encBatchSummary(p.fixtureSummary),
    vec(p.fixtureProof, encProofNode),
    vec(p.mainTreeProof, encProofNode),
    bytes32(p.eventStatRoot),
    vec(p.stats, encStatLeaf),
  ]);
}

/**
 * Map a raw /api/scores/stat-validation response into StatValidationInput.
 *
 * The API's field names are NOT 1:1 with the on-chain struct — verified against
 * a real 200 response (fixture 18179759):
 *   response.subTreeProof              -> fixture_proof      (note the rename)
 *   response.summary.eventStatsSubTreeRoot -> events_sub_tree_root
 *   response.statsToProve[i] + response.statProofs[i] -> stats[i]
 * Same mapping the proven ShroudLine resolve path uses.
 */
function buildStatValidationInput(sv) {
  const node = (n) => ({ hash: n.hash, isRightSibling: n.isRightSibling === true });
  if (!Array.isArray(sv.statsToProve) || !Array.isArray(sv.statProofs)
      || sv.statsToProve.length !== sv.statProofs.length) {
    throw new Error('stat-validation: statsToProve/statProofs missing or length-mismatched');
  }
  return {
    // The payload's own `ts` field, as returned by the API. NOTE: at an
    // in-running seq this is NOT always equal to updateStats.minTimestamp (they
    // coincide only when the batch is a single update), so don't conflate them.
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
    stats: sv.statsToProve.map((stat, i) => ({
      stat: { key: Number(stat.key), value: Number(stat.value), period: Number(stat.period) },
      statProof: sv.statProofs[i].map(node),
    })),
  };
}

// --- PDAs ---
const vaultPda = (owner) => PublicKey.findProgramAddressSync([VAULT_SEED, owner.toBuffer()], PROGRAM_ID)[0];
const rulePda = (vault, ruleId) =>
  PublicKey.findProgramAddressSync([RULE_SEED, vault.toBuffer(), u16(ruleId)], PROGRAM_ID)[0];
/** Associated token address. Derived directly so oracle-service needn't depend on @solana/spl-token. */
const ata = (mint, owner) =>
  PublicKey.findProgramAddressSync(
    [owner.toBuffer(), TOKEN_PROGRAM.toBuffer(), mint.toBuffer()],
    ATA_PROGRAM,
  )[0];

/**
 * Txoracle's daily_scores_roots PDA: seeds ["daily_scores_roots", u16 LE epochDay].
 * epochDay comes from the batch's MIN timestamp, which TxLINE reports in
 * MILLISECONDS — same derivation as the proven ShroudLine resolve path. Do NOT
 * convert to seconds first; that silently derives the wrong PDA.
 */
function dailyScoresRootsPda(minTimestampMs) {
  const epochDay = Number(BigInt(minTimestampMs) / 86_400_000n);
  const dayLe = Buffer.alloc(2);
  dayLe.writeUInt16LE(epochDay);
  return PublicKey.findProgramAddressSync(
    [Buffer.from('daily_scores_roots'), dayLe],
    TXORACLE_PROGRAM,
  )[0];
}

// --- Orca tick arrays for the B->A (devUSDC -> wSOL) swap direction ---
// Mirrors pf.ts ticksForBToA / the proven live_flow.cjs pattern, incl. the
// "neighbor doesn't exist" fallback (a small swap never crosses into it).
const TICK_ARRAY_SIZE = 88;
const tickArrayPda = (startIndex) =>
  PublicKey.findProgramAddressSync(
    [Buffer.from('tick_array'), WHIRLPOOL.toBuffer(), Buffer.from(String(startIndex))],
    WHIRLPOOL_PROGRAM,
  )[0];

async function ticksForBToA(connection) {
  const info = await connection.getAccountInfo(WHIRLPOOL);
  if (!info) throw new Error('whirlpool account not found');
  const data = info.data;
  const tickSpacing = data.readUInt16LE(41);
  const tickCurrent = data.readInt32LE(81);
  const span = tickSpacing * TICK_ARRAY_SIZE;
  const ta0Start = Math.floor(tickCurrent / span) * span;
  const ta0 = tickArrayPda(ta0Start);
  const taUp = tickArrayPda(ta0Start + span);
  const taUpOk = !!(await connection.getAccountInfo(taUp));
  const whirlpoolOracle = PublicKey.findProgramAddressSync(
    [Buffer.from('oracle'), WHIRLPOOL.toBuffer()],
    WHIRLPOOL_PROGRAM,
  )[0];
  return { ta0, ta1: taUpOk ? taUp : ta0, ta2: ta0, whirlpoolOracle };
}

/**
 * execute_rule_verified. 19 accounts, in the EXACT order of ExecuteRuleVerified
 * in programs/pocket_fans/src/instructions/execute_rule_verified.rs. Note
 * token_program is LAST (index 18), after the two oracle accounts.
 *
 * `caller` is the keeper: signer + fee payer, but NOT trusted by the program.
 * `vaultOwner` is the rule's owner — the USDC is pulled from THEIR ata, not the
 * keeper's.
 */
function ixExecuteRuleVerified(args) {
  const { caller, vaultOwner, ruleId, payload, ta0, ta1, ta2, whirlpoolOracle } = args;
  const vault = vaultPda(vaultOwner);
  const rule = rulePda(vault, ruleId);
  const dailyScoresRoots =
    args.dailyScoresRoots || dailyScoresRootsPda(payload.fixtureSummary.updateStats.minTimestamp);

  const data = Buffer.concat([
    DISC_EXECUTE_RULE_VERIFIED,
    u16(ruleId),
    encodeStatValidationInput(payload),
  ]);

  const m = (pubkey, isSigner, isWritable) => ({ pubkey, isSigner, isWritable });
  return new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      m(caller, true, true),                    //  0 caller (signer, untrusted)
      m(vault, false, false),                   //  1 vault
      m(rule, false, true),                     //  2 rule
      m(DEVUSDC_MINT, false, false),            //  3 usdc_mint
      m(WSOL_MINT, false, false),               //  4 wsol_mint
      m(ata(DEVUSDC_MINT, vaultOwner), false, true), // 5 owner_usdc_ata (OWNER's, not caller's)
      m(ata(DEVUSDC_MINT, vault), false, true), //  6 vault_usdc_ata
      m(ata(WSOL_MINT, vault), false, true),    //  7 vault_wsol_ata
      m(WHIRLPOOL, false, true),                //  8 whirlpool
      m(WHIRLPOOL_VAULT_A, false, true),        //  9 whirlpool_token_vault_a
      m(WHIRLPOOL_VAULT_B, false, true),        // 10 whirlpool_token_vault_b
      m(ta0, false, true),                      // 11 tick_array_0
      m(ta1, false, true),                      // 12 tick_array_1
      m(ta2, false, true),                      // 13 tick_array_2
      m(whirlpoolOracle, false, true),          // 14 whirlpool_oracle
      m(WHIRLPOOL_PROGRAM, false, false),       // 15 whirlpool_program
      m(dailyScoresRoots, false, false),        // 16 daily_scores_roots
      m(TXORACLE_PROGRAM, false, false),        // 17 txoracle_program
      m(TOKEN_PROGRAM, false, false),           // 18 token_program
    ],
    data,
  });
}

/** Compute-budget instruction to prepend — validate_stat_v2 exceeds the 200k default. */
const ixComputeBudget = () =>
  ComputeBudgetProgram.setComputeUnitLimit({ units: VERIFY_COMPUTE_UNITS });

module.exports = {
  encodeStatValidationInput,
  buildStatValidationInput,
  ixExecuteRuleVerified,
  ixComputeBudget,
  dailyScoresRootsPda,
  ticksForBToA,
  vaultPda,
  rulePda,
  ata,
  VERIFY_COMPUTE_UNITS,
  PROGRAM_ID,
  TXORACLE_PROGRAM,
};

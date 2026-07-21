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
  TransactionMessage, VersionedTransaction,
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
// TeamWinVerified pair. Both cross-checked against target/idl/pocket_fans.json
// AND recomputed independently as sha256("global:<name>")[0..8].
const DISC_EXECUTE_RULE_VERIFIED_WIN = Buffer.from([39, 23, 107, 54, 149, 187, 137, 248]);
const DISC_EXECUTE_RULE_STAKED_VERIFIED_WIN = Buffer.from([129, 136, 80, 142, 182, 77, 143, 238]);

// Marinade (devnet == mainnet addresses). Mirrors programs/pocket_fans/src/constants.rs.
const MSOL_MINT = new PublicKey('mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So');
const MARINADE_PROGRAM = new PublicKey('MarBmsSgKXdrN1egZf5sqe1TMai9K1rChYNDJgjq7aD');
const MARINADE_STATE = new PublicKey('8szGkuLTAux9XMgZ2vtY39jVSowEcpBfFfD8hXSEqdGC');
const MARINADE_LIQ_POOL_SOL_LEG = new PublicKey('UefNb6z6yvArqe4cJHTXCqStRsKmWhGxnZzuHbikP5Q');
const MARINADE_LIQ_POOL_MSOL_LEG = new PublicKey('7GgPYjS5Dza89wV6FpZ23kUJRG5vbQ1GM25ezspYFSoE');
const MARINADE_LIQ_POOL_MSOL_LEG_AUTHORITY = new PublicKey('EyaSjUtSgo9aRD1f8LWXwdvkpDTmXAW54yoSHZRF14WL');
const MARINADE_RESERVE = new PublicKey('Du3Ysj1wKbxPKkuPPnvzQLQh8oMSVifs3jGZjJWXFmHN');
const MARINADE_MSOL_MINT_AUTHORITY = new PublicKey('3JLPCS1qM2zRw3Dp6V4hZnYHd4toMNPkNesXdX9tg6KM');
const SYSTEM_PROGRAM = new PublicKey('11111111111111111111111111111111');

const VAULT_SOL_SEED = Buffer.from('vault_sol');
const STAKE_WSOL_SEED = Buffer.from('stake_wsol');

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

const vaultSolPda = (owner) =>
  PublicKey.findProgramAddressSync([VAULT_SOL_SEED, owner.toBuffer()], PROGRAM_ID)[0];
const stakeWsolPda = (owner, ruleId) =>
  PublicKey.findProgramAddressSync([STAKE_WSOL_SEED, owner.toBuffer(), u16(ruleId)], PROGRAM_ID)[0];

/**
 * execute_rule_verified_win — TeamWinVerified + SwapAndSave, settled DIRECTLY
 * to the owner's wSOL ATA. 19 accounts, in the EXACT order of
 * ExecuteRuleVerifiedWin in the program.
 *
 * Differs from ixExecuteRuleVerified in exactly one account slot: index 7 is the
 * OWNER's wSOL ATA, not the vault's. Everything else — including the two oracle
 * accounts at 16/17 and token_program last — is identical.
 *
 * `payload` MUST carry exactly two stats, in the rule's pinned order
 * [backed team, opponent], both at the full-time seq (period 100). The keeper
 * gets that by requesting the keys in that order from /scores/stat-validation,
 * which preserves request order (verified against the live API 2026-07-21).
 */
function ixExecuteRuleVerifiedWin(args) {
  const { caller, vaultOwner, ruleId, payload, ta0, ta1, ta2, whirlpoolOracle } = args;
  const vault = vaultPda(vaultOwner);
  const rule = rulePda(vault, ruleId);
  const dailyScoresRoots =
    args.dailyScoresRoots || dailyScoresRootsPda(payload.fixtureSummary.updateStats.minTimestamp);

  const data = Buffer.concat([
    DISC_EXECUTE_RULE_VERIFIED_WIN,
    u16(ruleId),
    encodeStatValidationInput(payload),
  ]);

  const m = (pubkey, isSigner, isWritable) => ({ pubkey, isSigner, isWritable });
  return new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      m(caller, true, true),                         //  0 caller (signer, untrusted)
      m(vault, false, false),                        //  1 vault
      m(rule, false, true),                          //  2 rule
      m(DEVUSDC_MINT, false, false),                 //  3 usdc_mint
      m(WSOL_MINT, false, false),                    //  4 wsol_mint
      m(ata(DEVUSDC_MINT, vaultOwner), false, true), //  5 owner_usdc_ata
      m(ata(DEVUSDC_MINT, vault), false, true),      //  6 vault_usdc_ata
      m(ata(WSOL_MINT, vaultOwner), false, true),    //  7 owner_wsol_ata  <- direct settlement
      m(WHIRLPOOL, false, true),                     //  8 whirlpool
      m(WHIRLPOOL_VAULT_A, false, true),             //  9 whirlpool_token_vault_a
      m(WHIRLPOOL_VAULT_B, false, true),             // 10 whirlpool_token_vault_b
      m(ta0, false, true),                           // 11 tick_array_0
      m(ta1, false, true),                           // 12 tick_array_1
      m(ta2, false, true),                           // 13 tick_array_2
      m(whirlpoolOracle, false, true),               // 14 whirlpool_oracle
      m(WHIRLPOOL_PROGRAM, false, false),            // 15 whirlpool_program
      m(dailyScoresRoots, false, false),             // 16 daily_scores_roots
      m(TXORACLE_PROGRAM, false, false),             // 17 txoracle_program
      m(TOKEN_PROGRAM, false, false),                // 18 token_program
    ],
    data,
  });
}

/**
 * execute_rule_staked_verified_win — TeamWinVerified + SwapStakeAndSave, mSOL
 * settled DIRECTLY to the owner's mSOL ATA. 30 accounts, in the EXACT order of
 * ExecuteRuleStakedVerifiedWin in the program.
 *
 * CANNOT be sent as a legacy transaction, and cannot be sent as a v0 tx without
 * the lookup table either — it throws at construction (measured). See the ALT
 * block comment below; the table must contain all 21 statics this uses.
 *
 * NOTE the PDA seeds use the VAULT OWNER, never the caller: stake_wsol and
 * vault_sol are the owner's accounts, so any keeper derives the same addresses.
 */
function ixExecuteRuleStakedVerifiedWin(args) {
  const { caller, vaultOwner, ruleId, payload, ta0, ta1, ta2, whirlpoolOracle } = args;
  const vault = vaultPda(vaultOwner);
  const rule = rulePda(vault, ruleId);
  const dailyScoresRoots =
    args.dailyScoresRoots || dailyScoresRootsPda(payload.fixtureSummary.updateStats.minTimestamp);

  const data = Buffer.concat([
    DISC_EXECUTE_RULE_STAKED_VERIFIED_WIN,
    u16(ruleId),
    encodeStatValidationInput(payload),
  ]);

  const m = (pubkey, isSigner, isWritable) => ({ pubkey, isSigner, isWritable });
  return new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      m(caller, true, true),                              //  0 caller
      m(vault, false, false),                             //  1 vault
      m(rule, false, true),                               //  2 rule
      m(DEVUSDC_MINT, false, false),                      //  3 usdc_mint
      m(WSOL_MINT, false, false),                         //  4 wsol_mint
      m(MSOL_MINT, false, true),                          //  5 msol_mint (w — Marinade mints)
      m(ata(DEVUSDC_MINT, vaultOwner), false, true),      //  6 owner_usdc_ata
      m(ata(DEVUSDC_MINT, vault), false, true),           //  7 vault_usdc_ata
      m(stakeWsolPda(vaultOwner, ruleId), false, true),   //  8 stake_wsol (init'd here)
      m(vaultSolPda(vaultOwner), false, true),            //  9 vault_sol
      m(ata(MSOL_MINT, vaultOwner), false, true),         // 10 owner_msol_ata <- direct settlement
      m(WHIRLPOOL, false, true),                          // 11 whirlpool
      m(WHIRLPOOL_VAULT_A, false, true),                  // 12 whirlpool_token_vault_a
      m(WHIRLPOOL_VAULT_B, false, true),                  // 13 whirlpool_token_vault_b
      m(ta0, false, true),                                // 14 tick_array_0
      m(ta1, false, true),                                // 15 tick_array_1
      m(ta2, false, true),                                // 16 tick_array_2
      m(whirlpoolOracle, false, true),                    // 17 whirlpool_oracle
      m(WHIRLPOOL_PROGRAM, false, false),                 // 18 whirlpool_program
      m(MARINADE_STATE, false, true),                     // 19 marinade_state
      m(MARINADE_LIQ_POOL_SOL_LEG, false, true),          // 20 liq_pool_sol_leg
      m(MARINADE_LIQ_POOL_MSOL_LEG, false, true),         // 21 liq_pool_msol_leg
      m(MARINADE_LIQ_POOL_MSOL_LEG_AUTHORITY, false, false), // 22 liq_pool_msol_leg_authority
      m(MARINADE_RESERVE, false, true),                   // 23 marinade_reserve
      m(MARINADE_MSOL_MINT_AUTHORITY, false, false),      // 24 msol_mint_authority
      m(MARINADE_PROGRAM, false, false),                  // 25 marinade_program
      m(dailyScoresRoots, false, false),                  // 26 daily_scores_roots
      m(TXORACLE_PROGRAM, false, false),                  // 27 txoracle_program
      m(TOKEN_PROGRAM, false, false),                     // 28 token_program
      m(SYSTEM_PROGRAM, false, false),                    // 29 system_program
    ],
    data,
  });
}

/** Compute-budget instruction to prepend — validate_stat_v2 exceeds the 200k default. */
const ixComputeBudget = () =>
  ComputeBudgetProgram.setComputeUnitLimit({ units: VERIFY_COMPUTE_UNITS });

// ---------------------------------------------------------------------------
// v0 transaction + Address Lookup Table.
//
// WHY THIS IS NOT OPTIONAL — a legacy Transaction CANNOT carry this instruction.
//
// execute_rule_verified takes 19 accounts, and its `payload` arg is a Merkle
// proof whose size varies with TxLINE's tree shape. Measured against REAL
// /scores/stat-validation responses from 9 finished World Cup fixtures:
//
//   subTreeProof (= fixture_proof on-chain) depth:  1..8   <- the size driver
//   mainTreeProof depth:                            1..2   <- NOT the driver
//   legacy serialized tx:                    1075..1372 B  (hard limit 1232)
//   => 44 of 54 real proofs EXCEED the limit and throw "Transaction too large"
//      at construction time, before ever reaching the network.
//
// Crucially, the SHALLOW proofs (subTree=1, which fit) only occur at the
// final-whistle event. A GoalScored rule fires MID-MATCH, which is exactly
// where subTreeProof is 5..8. So the legacy path is not "usually fine" — it is
// broken for essentially every real trigger. It went unnoticed because the one
// committed test fixture (stat_validation_18179759.json) happens to be an
// end-of-match, single-update proof with subTree=1 — an outlier.
//
// Moving the 11 STATIC accounts (mints, whirlpool + vaults + oracle + tick
// arrays, and the whirlpool/txoracle/token program ids) into a lookup table
// drops them from 32 bytes each to a 1-byte index:
//
//   worst real proof (fixture 18187298 seq 64, subTree=8):
//     legacy: 1274 B -> REJECTED      v0+ALT: 969 B -> fits, 263 B spare
//
// The program is NOT changed by this: the instruction still carries the same
// 19 accounts in the same order. An ALT only changes how the *transaction*
// encodes those account keys, not what execute_rule_verified receives.
// ---------------------------------------------------------------------------

/** Devnet ALT holding the 14 static accounts. Authority: the deploy wallet. */
const LOOKUP_TABLE_ADDRESS = new PublicKey(
  process.env.LOOKUP_TABLE_ADDRESS || 'Dm3LvzUA7u9GeMDzD7TTrUKqbPFo7uYVzJMjbWRMy6pf',
);

/**
 * The accounts of execute_rule_verified that are STATIC (not per-user, not
 * per-rule) and therefore live in the lookup table. Everything else — the
 * keeper, the vault/rule PDAs, the token accounts, daily_scores_roots — must
 * stay in the transaction's static key list.
 *
 * Tick arrays are derived from the live pool price, so they're passed in. The
 * on-chain table holds the current array plus two neighbours either side, so
 * ordinary price drift doesn't push one out of the table.
 *
 * Exported so the offline size test in app/scripts/encoder-parity.ts can build
 * the same table shape without hitting the network.
 */
function altStaticAddresses({ ta0, ta1, ta2, whirlpoolOracle }) {
  const fixed = [
    DEVUSDC_MINT, WSOL_MINT, WHIRLPOOL, WHIRLPOOL_VAULT_A, WHIRLPOOL_VAULT_B,
    new PublicKey(whirlpoolOracle), WHIRLPOOL_PROGRAM, TXORACLE_PROGRAM, TOKEN_PROGRAM,
    new PublicKey(ta0), new PublicKey(ta1), new PublicKey(ta2),
    // Added for execute_rule_staked_verified_win (30 accounts, 21 of them
    // static). That instruction CANNOT be built at all without these in the
    // table — it overflows 1232 B at construction, not at send. The live devnet
    // table was extended with exactly these on 2026-07-21 (sig 5sVpFrhf…,
    // slot 477779777), taking it from 14 to 23 entries.
    MSOL_MINT, MARINADE_STATE, MARINADE_LIQ_POOL_SOL_LEG, MARINADE_LIQ_POOL_MSOL_LEG,
    MARINADE_LIQ_POOL_MSOL_LEG_AUTHORITY, MARINADE_RESERVE, MARINADE_MSOL_MINT_AUTHORITY,
    MARINADE_PROGRAM, SYSTEM_PROGRAM,
  ];
  const seen = new Set();
  return fixed.filter((pk) => {
    const k = pk.toBase58();
    if (seen.has(k)) return false; // ta2 === ta0 in the common case
    seen.add(k);
    return true;
  });
}

let _lut = null; // the table is immutable in practice; fetch once per process
async function getLookupTable(connection) {
  if (_lut) return _lut;
  const { value } = await connection.getAddressLookupTable(LOOKUP_TABLE_ADDRESS);
  if (!value) {
    throw new Error(
      `address lookup table ${LOOKUP_TABLE_ADDRESS.toBase58()} not found. ` +
        'execute_rule_verified cannot be sent as a legacy tx (see the comment above ' +
        'LOOKUP_TABLE_ADDRESS) — refusing to fall back to one.',
    );
  }
  _lut = value;
  return _lut;
}

/**
 * Build the signed v0 transaction for execute_rule_verified.
 *
 * Deliberately throws rather than falling back to a legacy Transaction if the
 * table is missing: a silent fallback would just resurface as
 * "Transaction too large" for any real mid-match proof.
 */
async function buildExecuteRuleVerifiedTx({ connection, keeper, ix, blockhash }) {
  const lut = await getLookupTable(connection);
  const bh = blockhash || (await connection.getLatestBlockhash()).blockhash;

  const msg = new TransactionMessage({
    payerKey: keeper.publicKey,
    recentBlockhash: bh,
    instructions: [ixComputeBudget(), ix],
  }).compileToV0Message([lut]);

  const vtx = new VersionedTransaction(msg);
  vtx.sign([keeper]);

  const size = vtx.serialize().length;
  if (size > 1232) {
    throw new Error(`v0 tx still ${size} B > 1232 — lookup table may be missing entries`);
  }
  return { vtx, size };
}

module.exports = {
  encodeStatValidationInput,
  buildStatValidationInput,
  ixExecuteRuleVerified,
  ixExecuteRuleVerifiedWin,
  ixExecuteRuleStakedVerifiedWin,
  ixComputeBudget,
  buildExecuteRuleVerifiedTx,
  vaultSolPda,
  stakeWsolPda,
  getLookupTable,
  altStaticAddresses,
  dailyScoresRootsPda,
  ticksForBToA,
  vaultPda,
  rulePda,
  ata,
  VERIFY_COMPUTE_UNITS,
  LOOKUP_TABLE_ADDRESS,
  PROGRAM_ID,
  TXORACLE_PROGRAM,
};

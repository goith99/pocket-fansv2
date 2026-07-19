// Pocket Fans on-chain helpers: PDA derivation, hand-built instructions (matching
// target/idl/pocket_fans.json), and read helpers. Works in browser and Node.
import { Buffer } from "buffer";
import {
  Connection, PublicKey, TransactionInstruction, AccountMeta, SystemProgram,
} from "@solana/web3.js";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import {
  PROGRAM_ID, DEVUSDC_MINT, WSOL_MINT, TOKEN_PROGRAM, SYSTEM_PROGRAM,
  WHIRLPOOL, WHIRLPOOL_PROGRAM, WHIRLPOOL_VAULT_A, WHIRLPOOL_VAULT_B,
  DISC, ACCT_DISC, MIN_SQRT_PRICE, TXORACLE_PROGRAM,
  MSOL_MINT, MARINADE_PROGRAM, MARINADE_STATE, MARINADE_MSOL_MINT_AUTHORITY,
  MARINADE_RESERVE, MARINADE_LIQ_POOL_SOL_LEG, MARINADE_LIQ_POOL_MSOL_LEG,
  MARINADE_LIQ_POOL_MSOL_LEG_AUTHORITY,
} from "./constants";

// --- little-endian encoders ---
const u16 = (n: number) => { const b = Buffer.alloc(2); b.writeUInt16LE(n); return b; };
const u32 = (n: number) => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
const u64 = (n: bigint) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(n); return b; };
const u128 = (n: bigint) => { const b = Buffer.alloc(16); b.writeBigUInt64LE(n & 0xffffffffffffffffn, 0); b.writeBigUInt64LE(n >> 64n, 8); return b; };
const i64 = (n: bigint) => { const b = Buffer.alloc(8); b.writeBigInt64LE(n); return b; };
const i32 = (n: number) => { const b = Buffer.alloc(4); b.writeInt32LE(n); return b; };
const u8 = (n: number) => Buffer.from([n]);
const bool = (v: boolean) => Buffer.from([v ? 1 : 0]);
/** Borsh fixed [u8; 32]. Accepts a hex string, number[], or raw bytes. */
const bytes32 = (v: Uint8Array | number[] | string): Buffer => {
  const b = typeof v === "string"
    ? Buffer.from(v.replace(/^0x/, ""), "hex")
    : Buffer.from(v as Uint8Array);
  if (b.length !== 32) throw new Error(`expected 32 bytes, got ${b.length}`);
  return b;
};
/** Borsh Vec<T> = u32 LE length prefix + concatenated items. */
const vec = <T,>(items: readonly T[], enc: (t: T) => Buffer) =>
  Buffer.concat([u32(items.length), ...items.map(enc)]);
const disc = (d: readonly number[]) => Buffer.from(d);
const m = (pubkey: PublicKey, isSigner: boolean, isWritable: boolean): AccountMeta => ({ pubkey, isSigner, isWritable });

// --- trigger encoding (TriggerType, a borsh-tagged enum) ---
// Tags come from the variant ORDER in programs/pocket_fans/src/state.rs:
//   0 = TeamWin { team_id }
//   1 = GoalScored { team_id, stat_key, threshold }
export type RuleTrigger =
  | { kind: "TeamWin"; teamId: number }
  | { kind: "GoalScored"; teamId: number; statKey: number; threshold: number };

export function encodeTrigger(t: RuleTrigger): Buffer {
  switch (t.kind) {
    case "TeamWin":
      return Buffer.concat([u8(0), u32(t.teamId)]);
    case "GoalScored":
      return Buffer.concat([u8(1), u32(t.teamId), u32(t.statKey), u8(t.threshold)]);
  }
}

// --- PDAs ---
export const vaultPda = (owner: PublicKey) =>
  PublicKey.findProgramAddressSync([Buffer.from("vault"), owner.toBuffer()], PROGRAM_ID)[0];
export const rulePda = (vault: PublicKey, ruleId: number) =>
  PublicKey.findProgramAddressSync([Buffer.from("rule"), vault.toBuffer(), u16(ruleId)], PROGRAM_ID)[0];
export const ata = (mint: PublicKey, owner: PublicKey) => getAssociatedTokenAddressSync(mint, owner, true);
// execute_rule_staked PDAs (mirror constants.rs seeds). vault_sol holds native
// SOL transiently between the wSOL unwrap and the Marinade deposit; stake_wsol is
// the ephemeral wSOL account init'd+closed within each staked claim.
export const vaultSolPda = (owner: PublicKey) =>
  PublicKey.findProgramAddressSync([Buffer.from("vault_sol"), owner.toBuffer()], PROGRAM_ID)[0];
export const stakeWsolPda = (owner: PublicKey, ruleId: number) =>
  PublicKey.findProgramAddressSync([Buffer.from("stake_wsol"), owner.toBuffer(), u16(ruleId)], PROGRAM_ID)[0];

// --- instructions (user-side) ---
export function ixInitializeVault(owner: PublicKey): TransactionInstruction {
  return new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [m(owner, true, true), m(vaultPda(owner), false, true), m(SYSTEM_PROGRAM, false, false)],
    data: disc(DISC.initialize_vault),
  });
}

// create_rule: <trigger> + SwapAndSave{amount_usdc, wSOL, slippage} + matchId
// (TxLINE fixture id) + matchEndTs (unix seconds). rule PDA seed uses the
// CURRENT vault.total_rules, which the caller passes in.
//
// `trigger` decides which EXECUTION path the rule is later claimed through, and
// the two are not interchangeable:
//   TeamWin    -> execute_rule          (owner signs, time-guarded on matchEndTs)
//   GoalScored -> execute_rule_verified (anyone submits, gated by a Txoracle proof)
// matchEndTs is still required for both: it is a stored field on Rule, and for a
// GoalScored rule it is simply unused by the execution path (that rule fires
// mid-match on the proof, not on the clock).
export function ixCreateRule(args: {
  owner: PublicKey; vaultTotalRules: number; trigger: RuleTrigger;
  amountUsdc: bigint; maxSlippageBps: number; maxExecutions: number;
  matchId: bigint; matchEndTs: bigint;
  // Which ActionType to store. Defaults to SwapAndSave (Auto DCA -> wSOL) for
  // backward compatibility; "SwapStakeAndSave" (Auto Stake -> mSOL via Marinade)
  // is claimed later by execute_rule_staked. Same delegated USDC amount either
  // way — they differ only in what the claim does with the swapped SOL.
  actionKind?: "SwapAndSave" | "SwapStakeAndSave";
}): TransactionInstruction {
  const vault = vaultPda(args.owner);
  const rule = rulePda(vault, args.vaultTotalRules);
  const trigger = encodeTrigger(args.trigger);
  // ActionType borsh (tag = variant index in state.rs): 0 = SwapAndSave
  // {amount_usdc, target_mint, max_slippage_bps}; 1 = SwapStakeAndSave
  // {amount_usdc, max_slippage_bps} — NOTE: variant 1 has NO target_mint.
  const action = (args.actionKind ?? "SwapAndSave") === "SwapStakeAndSave"
    ? Buffer.concat([u8(1), u64(args.amountUsdc), u16(args.maxSlippageBps)])
    : Buffer.concat([u8(0), u64(args.amountUsdc), WSOL_MINT.toBuffer(), u16(args.maxSlippageBps)]);
  const data = Buffer.concat([
    disc(DISC.create_rule), trigger, action, u16(args.maxExecutions),
    u64(args.matchId), i64(args.matchEndTs),
  ]);
  return new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      m(args.owner, true, true), m(vault, false, true), m(rule, false, true),
      m(DEVUSDC_MINT, false, false), m(ata(DEVUSDC_MINT, args.owner), false, true),
      m(TOKEN_PROGRAM, false, false), m(SYSTEM_PROGRAM, false, false),
    ],
    data,
  });
}

export function ixRevokeRule(owner: PublicKey, ruleId: number): TransactionInstruction {
  const vault = vaultPda(owner);
  return new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      m(owner, true, false), m(vault, false, false), m(rulePda(vault, ruleId), false, true),
      m(DEVUSDC_MINT, false, false), m(ata(DEVUSDC_MINT, owner), false, true), m(TOKEN_PROGRAM, false, false),
    ],
    data: Buffer.concat([disc(DISC.revoke_rule), u16(ruleId)]),
  });
}

// Withdraw saved tokens of any `mint` from the vault's ATA back to the owner's
// ATA. The on-chain withdraw_from_vault is generic over token_mint, so this
// serves both wSOL (Auto DCA) and mSOL (Auto Stake) — pass the mint. No unwrap.
export function ixWithdrawFromVault(owner: PublicKey, mint: PublicKey, amount: bigint): TransactionInstruction {
  const vault = vaultPda(owner);
  return new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      m(owner, true, true), m(vault, false, false), m(mint, false, false),
      m(ata(mint, vault), false, true), m(ata(mint, owner), false, true), m(TOKEN_PROGRAM, false, false),
    ],
    data: Buffer.concat([disc(DISC.withdraw_from_vault), u64(amount)]),
  });
}

// SELF-CLAIM execute_rule: the RULE OWNER signs this directly — no oracle
// signer, no admin key. The program enforces only a time guard
// (Clock::unix_timestamp >= rule.match_end_ts, fixed at create_rule). Needs the
// live Orca tick-array PDAs, which depend on the pool's current tick — callers
// should derive these fresh right before sending (see ticksForBToA below),
// mirroring the logic previously in app/src/lib/serverOracle.ts.
export function ixExecuteRuleSelfClaim(args: {
  owner: PublicKey; ruleId: number;
  tickArray0: PublicKey; tickArray1: PublicKey; tickArray2: PublicKey;
  whirlpoolOracle: PublicKey;
}): TransactionInstruction {
  const vault = vaultPda(args.owner);
  const rule = rulePda(vault, args.ruleId);
  const data = Buffer.concat([disc(DISC.execute_rule), u16(args.ruleId)]);
  return new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      m(args.owner, true, true),               // owner (signer, was oracle_signer)
      m(vault, false, false),
      m(rule, false, true),
      m(DEVUSDC_MINT, false, false),
      m(WSOL_MINT, false, false),
      m(ata(DEVUSDC_MINT, args.owner), false, true),
      m(ata(DEVUSDC_MINT, vault), false, true),
      m(ata(WSOL_MINT, vault), false, true),
      m(WHIRLPOOL, false, true),
      m(WHIRLPOOL_VAULT_A, false, true),
      m(WHIRLPOOL_VAULT_B, false, true),
      m(args.tickArray0, false, true),
      m(args.tickArray1, false, true),
      m(args.tickArray2, false, true),
      m(args.whirlpoolOracle, false, true),
      m(WHIRLPOOL_PROGRAM, false, false),
      m(TOKEN_PROGRAM, false, false),
    ],
    data,
  });
}

// ===========================================================================
// execute_rule_direct — SwapAndSave (TeamWin self-claim, Auto DCA -> wSOL)
// ===========================================================================
// Direct-to-owner variant of ixExecuteRuleSelfClaim above. IDENTICAL account
// list except slot 8: the swap OUTPUT is the OWNER's wSOL ATA instead of the
// vault's, so the full swap output lands in the wallet in ONE instruction with
// no chained withdraw and no dust. The vault PDA is still the swap's
// token_authority (it signs via invoke_signed inside the program) — verified on
// devnet that Orca does not require the output account to be owned by that
// authority. Order mirrors ExecuteRuleDirect in
// programs/pocket_fans/src/instructions/execute_rule_direct.rs exactly.
export function ixExecuteRuleDirect(args: {
  owner: PublicKey; ruleId: number;
  tickArray0: PublicKey; tickArray1: PublicKey; tickArray2: PublicKey;
  whirlpoolOracle: PublicKey;
}): TransactionInstruction {
  const vault = vaultPda(args.owner);
  const rule = rulePda(vault, args.ruleId);
  const data = Buffer.concat([disc(DISC.execute_rule_direct), u16(args.ruleId)]);
  return new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      m(args.owner, true, true),
      m(vault, false, false),
      m(rule, false, true),
      m(DEVUSDC_MINT, false, false),
      m(WSOL_MINT, false, false),
      m(ata(DEVUSDC_MINT, args.owner), false, true),
      m(ata(DEVUSDC_MINT, vault), false, true),
      m(ata(WSOL_MINT, args.owner), false, true), // <-- OWNER's wSOL, not the vault's
      m(WHIRLPOOL, false, true),
      m(WHIRLPOOL_VAULT_A, false, true),
      m(WHIRLPOOL_VAULT_B, false, true),
      m(args.tickArray0, false, true),
      m(args.tickArray1, false, true),
      m(args.tickArray2, false, true),
      m(args.whirlpoolOracle, false, true),
      m(WHIRLPOOL_PROGRAM, false, false),
      m(TOKEN_PROGRAM, false, false),
    ],
    data,
  });
}

// ===========================================================================
// execute_rule_staked — SwapStakeAndSave (TeamWin self-claim, Auto Stake -> mSOL)
// ===========================================================================
// Owner-signed self-claim (same trust model as ixExecuteRuleSelfClaim): pulls
// the owner's USDC via delegation, swaps to wSOL, unwraps to native SOL, and
// deposits into Marinade so the vault receives mSOL. 28 accounts, order mirrors
// ExecuteRuleStaked in programs/pocket_fans/src/instructions/execute_rule_staked.rs
// EXACTLY (re-verified against target/idl/pocket_fans.json). Marinade addresses
// come from constants.ts and are re-asserted on-chain.
// ===========================================================================
// execute_rule_staked_direct — SwapStakeAndSave, DIRECT-TO-OWNER
// ===========================================================================
// Direct-to-owner variant of ixExecuteRuleStaked below. IDENTICAL 28-account
// list except slot 10: the Marinade deposit's `mint_to` is the OWNER's mSOL ATA
// instead of the vault's, so the minted mSOL lands in the wallet in ONE
// instruction with no chained withdraw. The vault_sol PDA is still the deposit's
// `transfer_from` authority (it signs via invoke_signed inside the program) —
// verified on devnet that Marinade does not require `mint_to` to be owned by
// that authority. Order mirrors ExecuteRuleStakedDirect in
// programs/pocket_fans/src/instructions/execute_rule_staked_direct.rs exactly
// (cross-checked against target/idl/pocket_fans.json).
//
// NOTE: owner_msol_ata must already exist — the instruction declares it as a
// plain Account<TokenAccount>. claimStakeChallenge creates it idempotently in
// the same transaction.
export function ixExecuteRuleStakedDirect(args: {
  owner: PublicKey; ruleId: number;
  tickArray0: PublicKey; tickArray1: PublicKey; tickArray2: PublicKey;
  whirlpoolOracle: PublicKey;
}): TransactionInstruction {
  const vault = vaultPda(args.owner);
  const rule = rulePda(vault, args.ruleId);
  const data = Buffer.concat([disc(DISC.execute_rule_staked_direct), u16(args.ruleId)]);
  return new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      m(args.owner, true, true),                          //  0 owner (signer)
      m(vault, false, false),                             //  1 vault
      m(rule, false, true),                               //  2 rule
      m(DEVUSDC_MINT, false, false),                      //  3 usdc_mint
      m(WSOL_MINT, false, false),                         //  4 wsol_mint
      m(MSOL_MINT, false, true),                          //  5 msol_mint
      m(ata(DEVUSDC_MINT, args.owner), false, true),      //  6 owner_usdc_ata
      m(ata(DEVUSDC_MINT, vault), false, true),           //  7 vault_usdc_ata
      m(stakeWsolPda(args.owner, args.ruleId), false, true), // 8 stake_wsol (PDA, init'd)
      m(vaultSolPda(args.owner), false, true),            //  9 vault_sol (PDA)
      m(ata(MSOL_MINT, args.owner), false, true),         // 10 owner_msol_ata <-- OWNER's, not the vault's
      m(WHIRLPOOL, false, true),                          // 11 whirlpool
      m(WHIRLPOOL_VAULT_A, false, true),                  // 12 whirlpool_token_vault_a
      m(WHIRLPOOL_VAULT_B, false, true),                  // 13 whirlpool_token_vault_b
      m(args.tickArray0, false, true),                    // 14 tick_array_0
      m(args.tickArray1, false, true),                    // 15 tick_array_1
      m(args.tickArray2, false, true),                    // 16 tick_array_2
      m(args.whirlpoolOracle, false, true),               // 17 whirlpool_oracle
      m(WHIRLPOOL_PROGRAM, false, false),                 // 18 whirlpool_program
      m(MARINADE_STATE, false, true),                     // 19 marinade_state
      m(MARINADE_LIQ_POOL_SOL_LEG, false, true),          // 20 marinade_liq_pool_sol_leg
      m(MARINADE_LIQ_POOL_MSOL_LEG, false, true),         // 21 marinade_liq_pool_msol_leg
      m(MARINADE_LIQ_POOL_MSOL_LEG_AUTHORITY, false, false), // 22 ..._authority
      m(MARINADE_RESERVE, false, true),                   // 23 marinade_reserve
      m(MARINADE_MSOL_MINT_AUTHORITY, false, false),      // 24 marinade_msol_mint_authority
      m(MARINADE_PROGRAM, false, false),                  // 25 marinade_program
      m(TOKEN_PROGRAM, false, false),                     // 26 token_program
      m(SYSTEM_PROGRAM, false, false),                    // 27 system_program
    ],
    data,
  });
}

export function ixExecuteRuleStaked(args: {
  owner: PublicKey; ruleId: number;
  tickArray0: PublicKey; tickArray1: PublicKey; tickArray2: PublicKey;
  whirlpoolOracle: PublicKey;
}): TransactionInstruction {
  const vault = vaultPda(args.owner);
  const rule = rulePda(vault, args.ruleId);
  const data = Buffer.concat([disc(DISC.execute_rule_staked), u16(args.ruleId)]);
  return new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      m(args.owner, true, true),                          //  0 owner (signer)
      m(vault, false, false),                             //  1 vault
      m(rule, false, true),                               //  2 rule
      m(DEVUSDC_MINT, false, false),                      //  3 usdc_mint
      m(WSOL_MINT, false, false),                         //  4 wsol_mint
      m(MSOL_MINT, false, true),                          //  5 msol_mint
      m(ata(DEVUSDC_MINT, args.owner), false, true),      //  6 owner_usdc_ata
      m(ata(DEVUSDC_MINT, vault), false, true),           //  7 vault_usdc_ata
      m(stakeWsolPda(args.owner, args.ruleId), false, true), // 8 stake_wsol (PDA, init'd)
      m(vaultSolPda(args.owner), false, true),            //  9 vault_sol (PDA)
      m(ata(MSOL_MINT, vault), false, true),              // 10 vault_msol_ata
      m(WHIRLPOOL, false, true),                          // 11 whirlpool
      m(WHIRLPOOL_VAULT_A, false, true),                  // 12 whirlpool_token_vault_a
      m(WHIRLPOOL_VAULT_B, false, true),                  // 13 whirlpool_token_vault_b
      m(args.tickArray0, false, true),                    // 14 tick_array_0
      m(args.tickArray1, false, true),                    // 15 tick_array_1
      m(args.tickArray2, false, true),                    // 16 tick_array_2
      m(args.whirlpoolOracle, false, true),               // 17 whirlpool_oracle
      m(WHIRLPOOL_PROGRAM, false, false),                 // 18 whirlpool_program
      m(MARINADE_STATE, false, true),                     // 19 marinade_state
      m(MARINADE_LIQ_POOL_SOL_LEG, false, true),          // 20 marinade_liq_pool_sol_leg
      m(MARINADE_LIQ_POOL_MSOL_LEG, false, true),         // 21 marinade_liq_pool_msol_leg
      m(MARINADE_LIQ_POOL_MSOL_LEG_AUTHORITY, false, false), // 22 ..._authority
      m(MARINADE_RESERVE, false, true),                   // 23 marinade_reserve
      m(MARINADE_MSOL_MINT_AUTHORITY, false, false),      // 24 marinade_msol_mint_authority
      m(MARINADE_PROGRAM, false, false),                  // 25 marinade_program
      m(TOKEN_PROGRAM, false, false),                     // 26 token_program
      m(SYSTEM_PROGRAM, false, false),                    // 27 system_program
    ],
    data,
  });
}

// ===========================================================================
// execute_rule_verified — GoalScored trigger (permissionless keeper + oracle)
// ===========================================================================
// PERMISSIONLESS: `caller` is the only signer and is NOT trusted by the program
// — it just pays the fee. A keeper bot normally submits this; the rule's owner
// can also submit it themselves as a manual fallback. The gate is the Txoracle
// validate_stat_v2 CPI verdict, nothing else.
//
// Borsh types below mirror programs/pocket_fans/src/instructions/txoracle.rs
// EXACTLY — field order is the wire format and must not be reordered. Verified
// against target/idl/pocket_fans.json (StatValidationInput).

export interface ProofNode { hash: Uint8Array | number[] | string; isRightSibling: boolean }
export interface ScoreStat { key: number; value: number; period: number }
export interface StatLeaf { stat: ScoreStat; statProof: ProofNode[] }
export interface ScoresUpdateStats { updateCount: number; minTimestamp: bigint; maxTimestamp: bigint }
export interface ScoresBatchSummary {
  fixtureId: bigint;
  updateStats: ScoresUpdateStats;
  eventsSubTreeRoot: Uint8Array | number[] | string;
}
/** The `payload` arg of execute_rule_verified. */
export interface StatValidationInput {
  ts: bigint;
  fixtureSummary: ScoresBatchSummary;
  fixtureProof: ProofNode[];
  mainTreeProof: ProofNode[];
  eventStatRoot: Uint8Array | number[] | string;
  stats: StatLeaf[];
}

const encProofNode = (n: ProofNode) => Buffer.concat([bytes32(n.hash), bool(n.isRightSibling)]);
const encScoreStat = (s: ScoreStat) => Buffer.concat([u32(s.key), i32(s.value), i32(s.period)]);
const encStatLeaf = (l: StatLeaf) => Buffer.concat([encScoreStat(l.stat), vec(l.statProof, encProofNode)]);
const encBatchSummary = (s: ScoresBatchSummary) => Buffer.concat([
  i64(s.fixtureId),                       // fixture_id: i64 (NOT u64)
  i32(s.updateStats.updateCount),         // update_stats.update_count: i32
  i64(s.updateStats.minTimestamp),        // update_stats.min_timestamp: i64
  i64(s.updateStats.maxTimestamp),        // update_stats.max_timestamp: i64
  bytes32(s.eventsSubTreeRoot),           // events_sub_tree_root: [u8; 32]
]);

export function encodeStatValidationInput(p: StatValidationInput): Buffer {
  return Buffer.concat([
    i64(p.ts),
    encBatchSummary(p.fixtureSummary),
    vec(p.fixtureProof, encProofNode),
    vec(p.mainTreeProof, encProofNode),
    bytes32(p.eventStatRoot),
    vec(p.stats, encStatLeaf),
  ]);
}

// Txoracle's `daily_scores_roots` PDA: seeds ["daily_scores_roots", u16 LE
// epochDay], owned by the Txoracle program. The epoch day is derived from the
// batch's MIN timestamp, which TxLINE reports in MILLISECONDS — same derivation
// the proven ShroudLine resolve path uses. Pass `minTimestamp` straight through
// from the stat-validation payload; do NOT pre-convert it to seconds.
export function dailyScoresRootsPda(minTimestampMs: bigint): PublicKey {
  const epochDay = Number(minTimestampMs / 86_400_000n);
  const dayLe = Buffer.alloc(2);
  dayLe.writeUInt16LE(epochDay);
  return PublicKey.findProgramAddressSync(
    [Buffer.from("daily_scores_roots"), dayLe],
    TXORACLE_PROGRAM,
  )[0];
}

// Account order mirrors ExecuteRuleVerified in
// programs/pocket_fans/src/instructions/execute_rule_verified.rs exactly (19
// accounts). Note token_program is LAST (index 18), after the two oracle
// accounts — it is NOT grouped with the token accounts.
export function ixExecuteRuleVerified(args: {
  caller: PublicKey;          // fee payer / signer — keeper bot OR the owner
  vaultOwner: PublicKey;      // whose vault+rule this is (need not equal caller)
  ruleId: number;
  payload: StatValidationInput;
  tickArray0: PublicKey; tickArray1: PublicKey; tickArray2: PublicKey;
  whirlpoolOracle: PublicKey;
  dailyScoresRoots?: PublicKey; // defaults to the PDA for payload's epoch day
}): TransactionInstruction {
  const vault = vaultPda(args.vaultOwner);
  const rule = rulePda(vault, args.ruleId);
  const dailyScoresRoots =
    args.dailyScoresRoots ?? dailyScoresRootsPda(args.payload.fixtureSummary.updateStats.minTimestamp);

  const data = Buffer.concat([
    disc(DISC.execute_rule_verified),
    u16(args.ruleId),
    encodeStatValidationInput(args.payload),
  ]);

  return new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      m(args.caller, true, true),                       //  0 caller (signer, untrusted)
      m(vault, false, false),                           //  1 vault
      m(rule, false, true),                             //  2 rule
      m(DEVUSDC_MINT, false, false),                    //  3 usdc_mint
      m(WSOL_MINT, false, false),                       //  4 wsol_mint
      m(ata(DEVUSDC_MINT, args.vaultOwner), false, true), // 5 owner_usdc_ata (owner's, not caller's)
      m(ata(DEVUSDC_MINT, vault), false, true),         //  6 vault_usdc_ata
      m(ata(WSOL_MINT, vault), false, true),            //  7 vault_wsol_ata
      m(WHIRLPOOL, false, true),                        //  8 whirlpool
      m(WHIRLPOOL_VAULT_A, false, true),                //  9 whirlpool_token_vault_a
      m(WHIRLPOOL_VAULT_B, false, true),                // 10 whirlpool_token_vault_b
      m(args.tickArray0, false, true),                  // 11 tick_array_0
      m(args.tickArray1, false, true),                  // 12 tick_array_1
      m(args.tickArray2, false, true),                  // 13 tick_array_2
      m(args.whirlpoolOracle, false, true),             // 14 whirlpool_oracle
      m(WHIRLPOOL_PROGRAM, false, false),               // 15 whirlpool_program
      m(dailyScoresRoots, false, false),                // 16 daily_scores_roots
      m(TXORACLE_PROGRAM, false, false),                // 17 txoracle_program
      m(TOKEN_PROGRAM, false, false),                   // 18 token_program
    ],
    data,
  });
}

// --- decoders / reads ---
export interface RuleView {
  pubkey: string; vault: string; ruleId: number; teamId: number | null;
  amountUsdc: string | null; maxSlippageBps: number | null;
  matchId: string; matchEndTs: number;
  maxExecutions: number; executionsDone: number; isActive: boolean;
  /** "TeamWin" (self-claim) or "GoalScored" (keeper + oracle). */
  triggerKind: "TeamWin" | "GoalScored";
  /** "SwapAndSave" (Auto DCA -> wSOL) or "SwapStakeAndSave" (Auto Stake -> mSOL,
   *  claimed via execute_rule_staked). Decides claim path AND the byte layout of
   *  every field after the action (SwapStakeAndSave has no target_mint). */
  actionKind: "SwapAndSave" | "SwapStakeAndSave";
  /** GoalScored only — the proven stat and the value it must reach. */
  statKey: number | null; threshold: number | null;
}

// Layout — see programs/pocket_fans/src/state.rs Rule.
//
// BOTH trigger_type AND action_type are BORSH-TAGGED ENUMS = VARIABLE LENGTH, so
// every field after them shifts by variant. Offsets must be computed from the
// two tags, not hard-coded — a static table for one combo misreads the others
// (this bit us: a SwapStakeAndSave rule is 32 bytes shorter than SwapAndSave
// because it has no target_mint, so its match_id/end_ts/counters all sit earlier).
//
//   TriggerType size:  TeamWin{team_id}=5   GoalScored{team_id,stat_key,threshold}=10
//   ActionType  size:  SwapAndSave{amount,target_mint,slippage}=43
//                      SwapStakeAndSave{amount,slippage}=11   (NO target_mint)
//
//   fixed head:  disc 0..8 | vault 8..40 | rule_id 40..42
//   trigger tag at 42; team_id at 43..47 (both); stat_key 47..51 + threshold 51 (GoalScored)
//   action tag at (42 + triggerSize); amount_usdc right after it; slippage after
//     the optional 32-byte target_mint; then match_id, match_end_ts,
//     max_executions, executions_done, is_active follow the action.
//
// DO NOT check for an exact byte length: Anchor allocates every Rule at the MAX
// combined size (141 B), so shorter variants leave trailing zeros; older
// TeamWin-only rules on devnet are still 136 B. Validate against the computed
// layout end instead.
export function decodeRule(pubkey: PublicKey, data: Buffer): RuleView | null {
  if (data.length < 136 || !data.subarray(0, 8).equals(Buffer.from(ACCT_DISC.Rule))) return null;

  const triggerTag = data[42];
  if (triggerTag !== 0 && triggerTag !== 1) return null; // unknown/newer trigger — don't misread it
  const isGoal = triggerTag === 1;
  const triggerSize = isGoal ? 10 : 5;

  const actionTagOff = 42 + triggerSize; // 47 (TeamWin) or 52 (GoalScored)
  const actionTag = data[actionTagOff];
  if (actionTag !== 0 && actionTag !== 1) return null; // unknown/newer action — don't misread it
  const isStake = actionTag === 1;
  const actionSize = isStake ? 11 : 43; // SwapStakeAndSave has no 32-byte target_mint

  const amtOff = actionTagOff + 1;
  const slipOff = amtOff + 8 + (isStake ? 0 : 32); // skip target_mint only for SwapAndSave
  const afterAction = actionTagOff + actionSize; // first byte after action_type
  const midOff = afterAction, endTsOff = afterAction + 8;
  const maxOff = afterAction + 16, doneOff = afterAction + 18, actOff = afterAction + 20;
  if (data.length < actOff + 1) return null; // truncated for this variant

  return {
    pubkey: pubkey.toBase58(),
    vault: new PublicKey(data.subarray(8, 40)).toBase58(),
    ruleId: data.readUInt16LE(40),
    triggerKind: isGoal ? "GoalScored" : "TeamWin",
    actionKind: isStake ? "SwapStakeAndSave" : "SwapAndSave",
    teamId: data.readUInt32LE(43), // same offset in both triggers
    statKey: isGoal ? data.readUInt32LE(47) : null,
    threshold: isGoal ? data[51] : null,
    amountUsdc: data.readBigUInt64LE(amtOff).toString(), // present in both actions
    maxSlippageBps: data.readUInt16LE(slipOff),          // present in both actions
    matchId: data.readBigUInt64LE(midOff).toString(),
    matchEndTs: Number(data.readBigInt64LE(endTsOff)),
    maxExecutions: data.readUInt16LE(maxOff),
    executionsDone: data.readUInt16LE(doneOff),
    isActive: data[actOff] === 1,
  };
}

// UserVault: exists? + total_rules (for deriving the next rule + listing rules).
export async function getUserVault(conn: Connection, owner: PublicKey): Promise<{ exists: boolean; totalRules: number }> {
  const info = await conn.getAccountInfo(vaultPda(owner));
  if (!info || !Buffer.from(info.data).subarray(0, 8).equals(Buffer.from(ACCT_DISC.UserVault))) return { exists: false, totalRules: 0 };
  return { exists: true, totalRules: Buffer.from(info.data).readUInt16LE(40) };
}

// All of a user's rules by deriving rule PDAs 0..totalRules-1 (no getProgramAccounts).
export async function getUserRules(conn: Connection, owner: PublicKey, totalRules: number): Promise<RuleView[]> {
  if (!totalRules) return [];
  const vault = vaultPda(owner);
  const pdas = Array.from({ length: totalRules }, (_, i) => rulePda(vault, i));
  const infos = await conn.getMultipleAccountsInfo(pdas);
  const out: RuleView[] = [];
  infos.forEach((info, i) => { if (info) { const r = decodeRule(pdas[i], Buffer.from(info.data)); if (r) out.push(r); } });
  return out;
}

// A SINGLE rule, read fresh from chain. Used by the claim paths to size the
// prepended SPL approve: the delegation must cover exactly what this rule is
// about to pull, and computing that from cached UI state risks a stale
// executions_done (which would under-approve and fail the claim).
export async function getRule(conn: Connection, owner: PublicKey, ruleId: number): Promise<RuleView | null> {
  const pda = rulePda(vaultPda(owner), ruleId);
  const info = await conn.getAccountInfo(pda);
  if (!info) return null;
  return decodeRule(pda, Buffer.from(info.data));
}

export async function tokenUiBalance(conn: Connection, mint: PublicKey, owner: PublicKey): Promise<{ raw: bigint; ui: number } | null> {
  try {
    const bal = await conn.getTokenAccountBalance(ata(mint, owner));
    return { raw: BigInt(bal.value.amount), ui: bal.value.uiAmount ?? 0 };
  } catch { return null; }
}

// --- Orca tick-array derivation for the B->A (USDC->SOL) swap direction ---
// Mirrors the math in app/src/lib/serverOracle.ts (tickArraysForBtoA), now
// needed client-side since the browser builds execute_rule itself.
const TICK_ARRAY_SIZE = 88;
const tickArrayPda = (startIndex: number) =>
  PublicKey.findProgramAddressSync(
    [Buffer.from("tick_array"), WHIRLPOOL.toBuffer(), Buffer.from(String(startIndex))],
    WHIRLPOOL_PROGRAM,
  )[0];

export async function ticksForBToA(conn: Connection): Promise<{ ta0: PublicKey; ta1: PublicKey; ta2: PublicKey; whirlpoolOracle: PublicKey }> {
  const info = await conn.getAccountInfo(WHIRLPOOL);
  if (!info) throw new Error("whirlpool account not found");
  const data = Buffer.from(info.data);
  const tickSpacing = data.readUInt16LE(41);
  const tickCurrent = data.readInt32LE(81);
  const span = tickSpacing * TICK_ARRAY_SIZE;
  const ta0Start = Math.floor(tickCurrent / span) * span;
  const ta0 = tickArrayPda(ta0Start);
  const taUp = tickArrayPda(ta0Start + span);
  // Fall back to ta0 if the neighbor tick-array account doesn't exist (mirrors
  // the proven live_flow.cjs pattern) — a tiny swap never crosses into it anyway.
  const taUpOk = !!(await conn.getAccountInfo(taUp));
  const whirlpoolOracle = PublicKey.findProgramAddressSync([Buffer.from("oracle"), WHIRLPOOL.toBuffer()], WHIRLPOOL_PROGRAM)[0];
  return { ta0, ta1: taUpOk ? taUp : ta0, ta2: ta0, whirlpoolOracle }; // verified real b_to_a pattern: [ta0, next-up, ta0]
}

// --- devUSDC faucet: wrap SOL -> Orca swap A(wSOL)->B(devUSDC) ---
// There is no public devUSDC faucet — this mint only exists paired with the
// devnet whirlpool this program swaps against. Getting some means doing the
// same SOL->USDC swap `live_flow.cjs` does, just from the browser instead.
// Mirrors the on-chain `read_whirlpool_sqrt_price` / `compute_min_out` math in
// programs/pocket_fans/src/instructions/execute_rule.rs, but for the opposite
// direction (A->B instead of B->A).

const SYNC_NATIVE_DISC = Buffer.from([17]); // SPL Token `SyncNative` instruction tag (single byte, no args)
const ORCA_SWAP_DISC = Buffer.from([248, 198, 158, 145, 225, 117, 135, 200]); // sha256("global:swap")[0..8]

export function ixSyncNative(ownerWsolAta: PublicKey): TransactionInstruction {
  return new TransactionInstruction({
    programId: TOKEN_PROGRAM,
    keys: [m(ownerWsolAta, false, true)],
    data: SYNC_NATIVE_DISC,
  });
}

export function ixWrapSol(owner: PublicKey, ownerWsolAta: PublicKey, lamports: bigint): TransactionInstruction {
  return SystemProgram.transfer({ fromPubkey: owner, toPubkey: ownerWsolAta, lamports });
}

// Live pool tick arrays for the A->B (SOL->USDC) direction — opposite neighbor
// from ticksForBToA, matching the pattern proven in live_flow.cjs Stage A.
export async function ticksForAToB(conn: Connection): Promise<{ ta0: PublicKey; ta1: PublicKey; ta2: PublicKey; whirlpoolOracle: PublicKey }> {
  const info = await conn.getAccountInfo(WHIRLPOOL);
  if (!info) throw new Error("whirlpool account not found");
  const data = Buffer.from(info.data);
  const tickSpacing = data.readUInt16LE(41);
  const tickCurrent = data.readInt32LE(81);
  const span = tickSpacing * TICK_ARRAY_SIZE;
  const ta0Start = Math.floor(tickCurrent / span) * span;
  const ta0 = tickArrayPda(ta0Start);
  const taDown = tickArrayPda(ta0Start - span);
  // Same existence fallback as ticksForBToA / live_flow.cjs.
  const taDownOk = !!(await conn.getAccountInfo(taDown));
  const whirlpoolOracle = PublicKey.findProgramAddressSync([Buffer.from("oracle"), WHIRLPOOL.toBuffer()], WHIRLPOOL_PROGRAM)[0];
  return { ta0, ta1: taDownOk ? taDown : ta0, ta2: ta0, whirlpoolOracle };
}

// Reads the pool's live sqrt_price and estimates devUSDC out for a given SOL
// (raw lamports) input — for display only (e.g. "≈ $2.74"); the actual min_out
// sent on-chain is computed the same way with slippage applied.
export async function estimateUsdcOut(conn: Connection, lamportsIn: bigint, slippageBps = 3000): Promise<bigint> {
  const info = await conn.getAccountInfo(WHIRLPOOL);
  if (!info) throw new Error("whirlpool account not found");
  const sqrtPrice = Buffer.from(info.data).readBigUInt64LE(65) | (Buffer.from(info.data).readBigUInt64LE(73) << 64n);
  const Q64 = 1n << 64n;
  // price (raw B per raw A) = (sqrt_price / 2^64)^2 -> expected_B = amount_A * sqrt_price^2 / 2^128
  const t = (lamportsIn * sqrtPrice) / Q64;
  const expected = (t * sqrtPrice) / Q64;
  return (expected * BigInt(10_000 - slippageBps)) / 10_000n;
}

// Reads the pool's live sqrt_price and returns the expected wSOL output for
// swapping `amountInRaw` devUSDC (token B) -> wSOL (token A), minus a `bufferBps`
// haircut. Byte-for-byte the same two-step Q64 math as the on-chain
// `compute_min_out` in programs/pocket_fans/src/instructions/execute_rule.rs
// (same sqrt_price offset 65..81, same integer-division order) — so passing the
// rule's own slippage reproduces the exact on-chain min_out.
//
// Callers sizing a withdraw chained after execute_rule pass a SMALLER,
// independent buffer (WITHDRAW_FLOOR_BUFFER_BPS, ~5%), NOT the swap's slippage:
// the withdraw only needs to sit safely below the ACTUAL swap output, not match
// the swap's own protection. Reusing the swap's ~15% would strand that whole
// gap in the vault (a tiny swap's real price impact is ~0, so actual output
// lands near `expected`). With the tighter buffer the withdraw can, in the rare
// case that real drift+impact exceeds it, revert — which just reverts the whole
// claim for a retry; no funds at risk, swap protection unchanged.
export async function estimateWsolOut(conn: Connection, amountInRaw: bigint, bufferBps: number): Promise<bigint> {
  const info = await conn.getAccountInfo(WHIRLPOOL);
  if (!info) throw new Error("whirlpool account not found");
  const d = Buffer.from(info.data);
  const sqrtPrice = d.readBigUInt64LE(65) | (d.readBigUInt64LE(73) << 64n);
  if (sqrtPrice <= 0n) throw new Error("whirlpool sqrt_price unreadable");
  const Q64 = 1n << 64n;
  const t = (amountInRaw * Q64) / sqrtPrice;
  const expected = (t * Q64) / sqrtPrice;
  return (expected * BigInt(10_000 - bufferBps)) / 10_000n;
}

// Wrap `lamportsIn` SOL and swap it to devUSDC via a real Orca CPI (A->B,
// a_to_b=true). Generous default slippage (30%) since this is a devnet
// convenience faucet, not a real-value trade — protects against a stale-price
// revert without needing the caller to tune it. Returns the instructions to
// bundle into one transaction alongside any needed ATA-creation instructions.
export function ixSwapSolToUsdc(args: {
  owner: PublicKey; ownerWsolAta: PublicKey; ownerUsdcAta: PublicKey;
  lamportsIn: bigint; minUsdcOut: bigint;
  tickArray0: PublicKey; tickArray1: PublicKey; tickArray2: PublicKey; whirlpoolOracle: PublicKey;
}): TransactionInstruction {
  const sqrtPriceLimit = MIN_SQRT_PRICE; // a_to_b pushes price down; MIN = no artificial floor beyond pool's own bound
  const data = Buffer.concat([
    ORCA_SWAP_DISC,
    u64(args.lamportsIn),
    u64(args.minUsdcOut),
    u128(sqrtPriceLimit),
    Buffer.from([1]), // amount_specified_is_input = true
    Buffer.from([1]), // a_to_b = true (wSOL -> devUSDC)
  ]);
  return new TransactionInstruction({
    programId: WHIRLPOOL_PROGRAM,
    keys: [
      m(TOKEN_PROGRAM, false, false),
      m(args.owner, true, false),
      m(WHIRLPOOL, false, true),
      m(args.ownerWsolAta, false, true),   // token_owner_account_a
      m(WHIRLPOOL_VAULT_A, false, true),
      m(args.ownerUsdcAta, false, true),   // token_owner_account_b
      m(WHIRLPOOL_VAULT_B, false, true),
      m(args.tickArray0, false, true),
      m(args.tickArray1, false, true),
      m(args.tickArray2, false, true),
      m(args.whirlpoolOracle, false, true),
    ],
    data,
  });
}

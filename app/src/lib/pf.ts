// Pocket Fans on-chain helpers: PDA derivation, hand-built instructions (matching
// target/idl/pocket_fans.json), and read helpers. Works in browser and Node.
import { Buffer } from "buffer";
import {
  Connection, PublicKey, TransactionInstruction, AccountMeta,
} from "@solana/web3.js";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import {
  PROGRAM_ID, DEVUSDC_MINT, WSOL_MINT, TOKEN_PROGRAM, SYSTEM_PROGRAM,
  WHIRLPOOL, WHIRLPOOL_PROGRAM, WHIRLPOOL_VAULT_A, WHIRLPOOL_VAULT_B,
  DISC, ACCT_DISC,
} from "./constants";

// --- little-endian encoders ---
const u16 = (n: number) => { const b = Buffer.alloc(2); b.writeUInt16LE(n); return b; };
const u32 = (n: number) => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
const u64 = (n: bigint) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(n); return b; };
const i64 = (n: bigint) => { const b = Buffer.alloc(8); b.writeBigInt64LE(n); return b; };
const disc = (d: readonly number[]) => Buffer.from(d);
const m = (pubkey: PublicKey, isSigner: boolean, isWritable: boolean): AccountMeta => ({ pubkey, isSigner, isWritable });

// --- PDAs ---
export const vaultPda = (owner: PublicKey) =>
  PublicKey.findProgramAddressSync([Buffer.from("vault"), owner.toBuffer()], PROGRAM_ID)[0];
export const rulePda = (vault: PublicKey, ruleId: number) =>
  PublicKey.findProgramAddressSync([Buffer.from("rule"), vault.toBuffer(), u16(ruleId)], PROGRAM_ID)[0];
export const ata = (mint: PublicKey, owner: PublicKey) => getAssociatedTokenAddressSync(mint, owner, true);

// --- instructions (user-side) ---
export function ixInitializeVault(owner: PublicKey): TransactionInstruction {
  return new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [m(owner, true, true), m(vaultPda(owner), false, true), m(SYSTEM_PROGRAM, false, false)],
    data: disc(DISC.initialize_vault),
  });
}

// create_rule: TeamWin{team_id} + SwapAndSave{amount_usdc, wSOL, slippage} +
// SELF-CLAIM fields matchId (TxLINE fixture id) + matchEndTs (unix seconds,
// the point after which execute_rule becomes callable). rule PDA seed uses the
// CURRENT vault.total_rules, which the caller passes in.
export function ixCreateRule(args: {
  owner: PublicKey; vaultTotalRules: number; teamId: number;
  amountUsdc: bigint; maxSlippageBps: number; maxExecutions: number;
  matchId: bigint; matchEndTs: bigint;
}): TransactionInstruction {
  const vault = vaultPda(args.owner);
  const rule = rulePda(vault, args.vaultTotalRules);
  const trigger = Buffer.concat([Buffer.from([0]), u32(args.teamId)]);               // TeamWin variant 0
  const action = Buffer.concat([Buffer.from([0]), u64(args.amountUsdc), WSOL_MINT.toBuffer(), u16(args.maxSlippageBps)]); // SwapAndSave variant 0
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

// withdraw saved wSOL from vault back to the owner's wSOL ATA (no unwrap yet).
export function ixWithdrawWsol(owner: PublicKey, amount: bigint): TransactionInstruction {
  const vault = vaultPda(owner);
  return new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      m(owner, true, true), m(vault, false, false), m(WSOL_MINT, false, false),
      m(ata(WSOL_MINT, vault), false, true), m(ata(WSOL_MINT, owner), false, true), m(TOKEN_PROGRAM, false, false),
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

// --- decoders / reads ---
export interface RuleView {
  pubkey: string; vault: string; ruleId: number; teamId: number | null;
  amountUsdc: string | null; maxSlippageBps: number | null;
  matchId: string; matchEndTs: number;
  maxExecutions: number; executionsDone: number; isActive: boolean;
}

// Layout (self-claim model — see programs/pocket_fans/src/state.rs Rule):
//   0..8    disc
//   8..40   vault (32)
//   40..42  rule_id (u16)
//   42      trigger tag (u8)
//   43..47  team_id (u32)                [TeamWin]
//   47      action tag (u8)
//   48..56  amount_usdc (u64)            [SwapAndSave]
//   56..88  target_mint (32)
//   88..90  max_slippage_bps (u16)
//   90..98  match_id (u64)
//   98..106 match_end_ts (i64)
//   106..108 max_executions (u16)
//   108..110 executions_done (u16)
//   110     is_active (bool)
//   111     bump (u8)
//   112..136 reserved (24)
// total = 136 bytes
export function decodeRule(pubkey: PublicKey, data: Buffer): RuleView | null {
  if (data.length !== 136 || !data.subarray(0, 8).equals(Buffer.from(ACCT_DISC.Rule))) return null;
  const triggerTag = data[42];
  const actionTag = data[47];
  return {
    pubkey: pubkey.toBase58(),
    vault: new PublicKey(data.subarray(8, 40)).toBase58(),
    ruleId: data.readUInt16LE(40),
    teamId: triggerTag === 0 ? data.readUInt32LE(43) : null,
    amountUsdc: actionTag === 0 ? data.readBigUInt64LE(48).toString() : null,
    maxSlippageBps: actionTag === 0 ? data.readUInt16LE(88) : null,
    matchId: data.readBigUInt64LE(90).toString(),
    matchEndTs: Number(data.readBigInt64LE(98)),
    maxExecutions: data.readUInt16LE(106),
    executionsDone: data.readUInt16LE(108),
    isActive: data[110] === 1,
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
  const whirlpoolOracle = PublicKey.findProgramAddressSync([Buffer.from("oracle"), WHIRLPOOL.toBuffer()], WHIRLPOOL_PROGRAM)[0];
  return { ta0, ta1: taUp, ta2: ta0, whirlpoolOracle }; // verified real b_to_a pattern: [ta0, next-up, ta0]
}

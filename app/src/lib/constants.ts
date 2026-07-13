import { PublicKey } from "@solana/web3.js";

// Deployed program + fixed devnet addresses (from target/idl/pocket_fans.json).
export const PROGRAM_ID = new PublicKey("4f74EBY7KMe8mUP9MpNzRnPzW6LojYX8wm56ZZz3iDgB");
export const DEVUSDC_MINT = new PublicKey("BRjpCHtyQLNCo8gqRUr8jtdAj5AjPYQaoqbvcZiHok1k"); // 6 dp
export const WSOL_MINT = new PublicKey("So11111111111111111111111111111111111111112"); // 9 dp
export const WHIRLPOOL = new PublicKey("3KBZiL2g8C7tiJ32hTv5v3KM7aK9htpqTw4cTXz1HvPt");
export const WHIRLPOOL_PROGRAM = new PublicKey("whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc");
export const WHIRLPOOL_VAULT_A = new PublicKey("C9zLV5zWF66j3rZj3uuhDqvfuA8esJyWnruGzDW9qEj2"); // wSOL
export const WHIRLPOOL_VAULT_B = new PublicKey("7DM3RMz2yzUB8yPRQM3FMZgdFrwZGMsabsfsKopWktoX"); // devUSDC
export const TOKEN_PROGRAM = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
export const ATA_PROGRAM = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
export const SYSTEM_PROGRAM = new PublicKey("11111111111111111111111111111111");

export const DEVUSDC_DECIMALS = 6;
export const WSOL_DECIMALS = 9;

// Self-claim model: how long after a fixture's kickoff (TxLINE `StartTime`,
// milliseconds) we assume the match has plausibly finished. Used to compute
// match_end_ts passed into create_rule. 3h covers regulation + ET + penalties
// for knockout matches with margin; adjust per-fixture in the UI if needed.
export const MATCH_END_BUFFER_SECS = 3 * 60 * 60;

// Instruction discriminators (copied verbatim from the IDL; each is
// sha256("global:<name>")[0..8] — re-derived and cross-checked against
// target/idl/pocket_fans.json, not hand-written).
export const DISC = {
  initialize_vault: [48, 191, 163, 44, 71, 129, 63, 164],
  create_rule: [225, 163, 1, 6, 230, 91, 203, 199],
  revoke_rule: [41, 239, 224, 254, 61, 31, 56, 1],
  withdraw_from_vault: [180, 34, 37, 46, 156, 0, 211, 238],
  execute_rule: [143, 36, 13, 104, 240, 240, 207, 192],
  execute_rule_verified: [109, 158, 73, 235, 69, 145, 96, 155],
} as const;

// --- TxODDS Txoracle (devnet) — CPI target for the GoalScored trigger ---
// Mirrors programs/pocket_fans/src/constants.rs TXORACLE_PROGRAM_ID.
export const TXORACLE_PROGRAM = new PublicKey("6pW64gN1s2uqjHkn1unFeEjAwJkPGHoppGvS715wyP2J");

// TxLINE soccer stat keys: 1 = home goals, 2 = away goals (period offset 0 =
// full-match total). WHICH of the two a rule pins depends on the side the
// backed team plays on in that specific fixture — resolved at create_rule time.
export const STAT_KEY_HOME_GOALS = 1;
export const STAT_KEY_AWAY_GOALS = 2;

// validate_stat_v2 walks several Merkle branches; TxLINE's own examples raise
// the CU limit to 1.4M for multi-stat proofs (the 200k default is not enough).
export const VERIFY_COMPUTE_UNITS = 1_400_000;

// Account discriminators.
export const ACCT_DISC = {
  Rule: [82, 10, 53, 40, 250, 61, 143, 130],
  UserVault: [23, 76, 96, 159, 210, 10, 5, 22],
} as const;

// Whirlpool swap constants.
export const MAX_SQRT_PRICE = 79226673515401279992447579055n; // upper bound, used for B->A (USDC->SOL, execute_rule)
export const MIN_SQRT_PRICE = 4295048016n; // lower bound, used for A->B (SOL->USDC, devUSDC faucet swap)

// This phase's rule defaults.
export const DEFAULT_MAX_SLIPPAGE_BPS = 1500;
// FIXED at 1 (not a tunable "default"): each rule is pinned to exactly one
// match (match_id + match_end_ts fixed at create_rule) — a single match only
// ever finishes once, so it can only ever be legitimately claimed once.
export const DEFAULT_MAX_EXECUTIONS = 1;

// Browser talks to the same-origin RPC proxy (keeps the Helius key server-side).
export const BROWSER_RPC = "/api/rpc";

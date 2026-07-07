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

// Instruction discriminators (copied verbatim from the IDL).
export const DISC = {
  initialize_vault: [48, 191, 163, 44, 71, 129, 63, 164],
  create_rule: [225, 163, 1, 6, 230, 91, 203, 199],
  revoke_rule: [41, 239, 224, 254, 61, 31, 56, 1],
  withdraw_from_vault: [180, 34, 37, 46, 156, 0, 211, 238],
  execute_rule: [143, 36, 13, 104, 240, 240, 207, 192],
} as const;

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
export const DEFAULT_MAX_EXECUTIONS = 3;

// Browser talks to the same-origin RPC proxy (keeps the Helius key server-side).
export const BROWSER_RPC = "/api/rpc";

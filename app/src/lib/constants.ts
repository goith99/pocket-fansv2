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

// MIRRORS programs/pocket_fans/src/constants.rs MAX_MATCH_END_TS_HORIZON_SECS.
// create_rule REJECTS a rule whose match_end_ts is further out than this
// (InvalidMatchEndTs), so a fixture beyond the horizon cannot be turned into a
// challenge no matter what the UI offers.
//
// The horizon ROLLS FORWARD daily, so a fixture that is creatable today can stop
// being creatable tomorrow. Without filtering on it, the picker keeps offering a
// team whose only fixture has drifted out of range and the user gets an opaque
// on-chain rejection. Observed 2026-07-21: two Friendlies fixtures had 5.0 and
// 2.0 days of margin left.
//
// scripts/horizon-pin-check.ts asserts this stays equal to the Rust constant.
export const MAX_MATCH_END_TS_HORIZON_SECS = 120 * 24 * 60 * 60;

// Instruction discriminators (copied verbatim from the IDL; each is
// sha256("global:<name>")[0..8] — re-derived and cross-checked against
// target/idl/pocket_fans.json, not hand-written).
export const DISC = {
  initialize_vault: [48, 191, 163, 44, 71, 129, 63, 164],
  create_rule: [225, 163, 1, 6, 230, 91, 203, 199],
  revoke_rule: [41, 239, 224, 254, 61, 31, 56, 1],
  withdraw_from_vault: [180, 34, 37, 46, 156, 0, 211, 238],
  execute_rule: [143, 36, 13, 104, 240, 240, 207, 192],
  execute_rule_direct: [156, 227, 233, 110, 247, 23, 64, 62],
  execute_rule_verified: [109, 158, 73, 235, 69, 145, 96, 155],
  execute_rule_staked: [230, 120, 146, 64, 213, 216, 43, 197],
  execute_rule_staked_direct: [135, 212, 228, 85, 247, 150, 62, 206],
  // TeamWinVerified pair — keeper-settled, direct to the owner's wallet.
  execute_rule_verified_win: [39, 23, 107, 54, 149, 187, 137, 248],
  execute_rule_staked_verified_win: [129, 136, 80, 142, 182, 77, 143, 238],
} as const;

// --- Marinade liquid staking (DEVNET) — accounts forwarded to execute_rule_staked ---
// Mirrors programs/pocket_fans/src/constants.rs EXACTLY (values cross-checked
// against a live devnet read there). The program re-asserts every one of these
// with address = / require_keys_eq! in-instruction, so a wrong value here fails
// loudly on-chain rather than misrouting funds. Marinade uses the same addresses
// on devnet and mainnet.
export const MSOL_MINT = new PublicKey("mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So"); // 9 dp
export const MSOL_DECIMALS = 9;
export const MARINADE_PROGRAM = new PublicKey("MarBmsSgKXdrN1egZf5sqe1TMai9K1rChYNDJgjq7aD");
export const MARINADE_STATE = new PublicKey("8szGkuLTAux9XMgZ2vtY39jVSowEcpBfFfD8hXSEqdGC");
export const MARINADE_MSOL_MINT_AUTHORITY = new PublicKey("3JLPCS1qM2zRw3Dp6V4hZnYHd4toMNPkNesXdX9tg6KM");
export const MARINADE_RESERVE = new PublicKey("Du3Ysj1wKbxPKkuPPnvzQLQh8oMSVifs3jGZjJWXFmHN");
export const MARINADE_LIQ_POOL_SOL_LEG = new PublicKey("UefNb6z6yvArqe4cJHTXCqStRsKmWhGxnZzuHbikP5Q");
export const MARINADE_LIQ_POOL_MSOL_LEG = new PublicKey("7GgPYjS5Dza89wV6FpZ23kUJRG5vbQ1GM25ezspYFSoE");
export const MARINADE_LIQ_POOL_MSOL_LEG_AUTHORITY = new PublicKey("EyaSjUtSgo9aRD1f8LWXwdvkpDTmXAW54yoSHZRF14WL");

// --- TxODDS Txoracle (devnet) — CPI target for the GoalScored trigger ---
// Mirrors programs/pocket_fans/src/constants.rs TXORACLE_PROGRAM_ID.
export const TXORACLE_PROGRAM = new PublicKey("6pW64gN1s2uqjHkn1unFeEjAwJkPGHoppGvS715wyP2J");

// KILL SWITCH — creating new GoalScored rules is DISABLED.
//
// GoalScored rules are claimed by the permissionless keeper
// (execute_rule_verified), which pulls the user's USDC through the same single
// shared SPL delegation every rule uses. create_rule's token::approve OVERWRITES
// rather than accumulates, so that delegation is routinely destroyed by a newer
// rule, by an execution draining it to zero, or by revoke_rule on any rule. The
// self-claim paths repair this by prepending an approve in the claim transaction
// (see approveForRule in useFanApp.ts) — but the keeper CANNOT: it submits the
// transaction itself and cannot sign an approve on the user's behalf. A
// GoalScored rule whose delegation has died therefore fails silently, with no
// user-facing signal that their savings never happened.
//
// Enforced inside createGoalChallenge itself, NOT only in the UI, so no page
// (including the /dev/goal-rule harness) can create one by calling it directly.
// Existing on-chain GoalScored rules are unaffected.
//
// Flip to true ONLY once create_rule/revoke_rule's shared-delegation model has a
// real per-rule fix.
export const GOALSCORED_CREATION_ENABLED = false;

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
// Safety haircut applied ONLY to the withdraw chained after a self-claim (see
// claimChallenge in useFanApp.ts) — deliberately INDEPENDENT of the swap's own
// DEFAULT_MAX_SLIPPAGE_BPS. The swap protects itself at ~15%; the chained
// withdraw just needs to sit safely below the actual swap output, so we withdraw
// expected_output x (1 - 5%). ~95% auto-lands in the wallet; the 5% absorbs
// build->broadcast price drift on the (thinner, more erratic) devnet pool. If
// drift ever exceeds it, only the withdraw reverts and the claim is retried — no
// funds at risk, and the swap's 15% protection is untouched.
export const WITHDRAW_FLOOR_BUFFER_BPS = 500;
// FIXED at 1 (not a tunable "default"): each rule is pinned to exactly one
// match (match_id + match_end_ts fixed at create_rule) — a single match only
// ever finishes once, so it can only ever be legitimately claimed once.
export const DEFAULT_MAX_EXECUTIONS = 1;

// Browser talks to the same-origin RPC proxy (keeps the Helius key server-side).
export const BROWSER_RPC = "/api/rpc";

// --- v0 + Address Lookup Table (manual settle / keeper parity) ---
// The TeamWinVerified settle instructions carry a Merkle proof and up to 30
// accounts. execute_rule_staked_verified_win does not merely exceed the 1232-byte
// packet limit as a legacy transaction — it THROWS at construction. The table
// below holds their static accounts; it was extended on 2026-07-21 to 23 entries
// to cover the Marinade/mSOL/system set the staked variant needs.
// Same table the keeper uses (oracle-service/src/statvalidation.cjs).
export const LOOKUP_TABLE_ADDRESS = new PublicKey(
  process.env.NEXT_PUBLIC_LOOKUP_TABLE_ADDRESS || "Dm3LvzUA7u9GeMDzD7TTrUKqbPFo7uYVzJMjbWRMy6pf",
);

// A REAL, already-settled TeamWinVerified challenge on devnet: a permissionless
// keeper proved the full-time result via the Txoracle CPI and the payout landed
// in the owner's wallet, with no user interaction. Linked from the UI as
// evidence the automation genuinely works, which matters when the challenge a
// visitor just created cannot settle until its match is actually played.
export const EXAMPLE_SETTLEMENT_TX =
  "p9fYgNTTRcTcNm1JKvBm1Te2jnk6vzS47xz1SuEbFDwNQTaJzLwYqRKCmgMsXVU25tWQXHUMHzqR2eZryfCtJtj";
export const EXAMPLE_SETTLEMENT_URL =
  `https://solscan.io/tx/${EXAMPLE_SETTLEMENT_TX}?cluster=devnet`;

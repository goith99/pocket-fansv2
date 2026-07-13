use anchor_lang::prelude::*;

// ---------------------------------------------------------------------------
// PDA seeds
// ---------------------------------------------------------------------------
pub const VAULT_SEED: &[u8] = b"vault";
pub const RULE_SEED: &[u8] = b"rule";

// ---------------------------------------------------------------------------
// Rule limits
// ---------------------------------------------------------------------------
/// Default cap on how many times a rule may execute. Bounds delegation exposure:
/// the SPL `approve` in `create_rule` delegates `amount_usdc * max_executions`.
pub const DEFAULT_MAX_EXECUTIONS: u16 = 5;
/// Hard ceiling so a caller can never request an unbounded delegation.
pub const HARD_MAX_EXECUTIONS: u16 = 50;
/// Sanity ceiling on slippage tolerance (100% = 10_000 bps).
pub const MAX_SLIPPAGE_BPS: u16 = 10_000;

// ---------------------------------------------------------------------------
// Orca Whirlpools (DEVNET) — all values RE-VERIFIED from live devnet RPC on 2026-07-05.
//   whirlpool liquidity 817_020_788_109 (non-zero), tick -38039 (~22.3 devUSDC/SOL).
// The program does NOT hardcode-trust these for the swap itself: the whirlpool,
// tick arrays and vault accounts are passed in and forwarded to the CPI. These
// constants exist so instruction handlers can assert the caller wired the
// intended devnet pool/mints (defense-in-depth), and for the TS client/tests.
// ---------------------------------------------------------------------------
/// Orca Whirlpools program id (same on devnet & mainnet).
pub const WHIRLPOOL_PROGRAM_ID: Pubkey =
    Pubkey::from_str_const("whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc");
/// SOL/devUSDC whirlpool (devnet).
pub const SOL_DEVUSDC_WHIRLPOOL: Pubkey =
    Pubkey::from_str_const("3KBZiL2g8C7tiJ32hTv5v3KM7aK9htpqTw4cTXz1HvPt");
/// Wrapped SOL mint — whirlpool token A. Decimals = 9 (verified on devnet).
pub const WSOL_MINT: Pubkey =
    Pubkey::from_str_const("So11111111111111111111111111111111111111112");
/// devUSDC mint — whirlpool token B. Decimals = 6 (verified on devnet).
pub const DEVUSDC_MINT: Pubkey =
    Pubkey::from_str_const("BRjpCHtyQLNCo8gqRUr8jtdAj5AjPYQaoqbvcZiHok1k");

/// Verified mint decimals (queried directly from the mint accounts on 2026-07-05).
pub const WSOL_DECIMALS: u8 = 9;
pub const DEVUSDC_DECIMALS: u8 = 6;

// ---------------------------------------------------------------------------
// Whirlpool `swap` CPI constants
// ---------------------------------------------------------------------------
/// Anchor sighash of the whirlpool `swap` instruction = sha256("global:swap")[..8].
pub const WHIRLPOOL_SWAP_DISCRIMINATOR: [u8; 8] = [248, 198, 158, 145, 225, 117, 135, 200];
/// Whirlpool tick math bounds. For a B->A swap (USDC->SOL, a_to_b = false) the price
/// rises, so the sqrt-price limit is the MAX bound (no artificial limit).
pub const MIN_SQRT_PRICE: u128 = 4_295_048_016;
pub const MAX_SQRT_PRICE: u128 = 79_226_673_515_401_279_992_447_579_055;

/// Fixed-point shift used by whirlpool sqrt-price (Q64.64).
pub const Q64: u128 = 1u128 << 64;

// ---------------------------------------------------------------------------
// Self-claim time guard
// ---------------------------------------------------------------------------
/// Sanity ceiling so `create_rule` cannot accept a `match_end_ts` absurdly far
/// in the future (defense-in-depth against a fat-fingered/malicious client).
/// 120 days is comfortably beyond the World Cup 2026 tournament window.
pub const MAX_MATCH_END_TS_HORIZON_SECS: i64 = 120 * 24 * 60 * 60;

// ---------------------------------------------------------------------------
// TxODDS Txoracle program (DEVNET) — CPI target for the GoalScored trigger.
// Used ONLY by execute_rule_verified; the TeamWin/self-claim path never touches
// an oracle. Mainnet id (for the later mainnet phase):
//   9ExbZjAapQww1vfcisDmrngPinHTEfpjYRWMunJgcKaA
// ---------------------------------------------------------------------------
pub const TXORACLE_PROGRAM_ID: Pubkey =
    Pubkey::from_str_const("6pW64gN1s2uqjHkn1unFeEjAwJkPGHoppGvS715wyP2J");

/// Anchor sighash of Txoracle's `validate_stat_v2` = sha256("global:validate_stat_v2")[..8].
pub const VALIDATE_STAT_V2_DISCRIMINATOR: [u8; 8] = [208, 215, 194, 214, 241, 71, 246, 178];

// ---------------------------------------------------------------------------
// TxLINE soccer score stat keys (base key + period offset).
// key = base (1/2 = home/away goals) + period offset (0 = full-match total).
// Which of the two applies to a given rule depends on whether that rule's team
// is the home or away side in that specific fixture — resolved off-chain at
// create_rule time and pinned into TriggerType::GoalScored.stat_key.
// ---------------------------------------------------------------------------
pub const STAT_KEY_HOME_GOALS: u32 = 1;
pub const STAT_KEY_AWAY_GOALS: u32 = 2;

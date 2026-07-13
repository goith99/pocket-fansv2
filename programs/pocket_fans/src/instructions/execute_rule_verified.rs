//! GoalScored trigger execution — permissionless keeper + on-chain oracle
//! verification. This is a SEPARATE instruction from execute_rule.rs
//! (TeamWin, self-claim, time-guard only) — that instruction is untouched by
//! this feature, still requires the owner as signer, still has no oracle
//! involved. This one is the opposite: NO signer identity is trusted at all;
//! every claim must carry a Txoracle-verified Merkle proof.
//!
//! Callable by ANYONE — a Railway keeper bot watching live matches, or the
//! rule's own owner manually as a fallback if the keeper is late or down.
//! There is no privileged caller: the Txoracle CPI verdict is the only gate.
//!
//! Flow:
//!   1. rule must be active, under its execution cap, and trigger_type must be
//!      GoalScored (TeamWin rules use execute_rule instead, not this).
//!   2. the proof's fixture_id must match rule.match_id, and the single
//!      requested stat's key must match rule.trigger_type's pinned stat_key —
//!      both checked ON-CHAIN so a caller cannot substitute a different
//!      match's or a different stat's proof (mirrors ShroudLine's key-pinning).
//!   3. CPI into Txoracle::validate_stat_v2 with a strategy this program
//!      builds itself (never trusting a caller-supplied strategy):
//!      stats[0].value > (threshold - 1), i.e. value >= threshold.
//!   4. only if the oracle returns true: pull the owner's USDC via the
//!      existing delegation and swap to wSOL via Orca — identical settlement
//!      logic to execute_rule.rs, just gated differently upstream.
use anchor_lang::prelude::*;
use anchor_lang::solana_program::{
    instruction::{AccountMeta, Instruction},
    program::invoke_signed,
};
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer};

use crate::constants::{
    DEVUSDC_MINT, MAX_SQRT_PRICE, Q64, RULE_SEED, SOL_DEVUSDC_WHIRLPOOL, VAULT_SEED,
    WHIRLPOOL_PROGRAM_ID, WHIRLPOOL_SWAP_DISCRIMINATOR, WSOL_MINT,
};
use crate::error::PocketFansError;
use crate::instructions::txoracle::{
    validate_stat_v2_cpi, Comparison, NDimensionalStrategy, StatPredicate, StatValidationInput,
    TraderPredicate,
};
use crate::state::{ActionType, Rule, TriggerType, UserVault};

#[derive(Accounts)]
#[instruction(rule_id: u16)]
pub struct ExecuteRuleVerified<'info> {
    /// Anyone — pays the tx fee, gets no special trust. Could be a keeper bot
    /// or the owner themself.
    #[account(mut)]
    pub caller: Signer<'info>,

    /// CHECK: read-only; owner's pubkey is read from this account's own data
    /// (has_one relationships below), not from a signer.
    pub vault: Box<Account<'info, UserVault>>,

    #[account(
        mut,
        seeds = [RULE_SEED, vault.key().as_ref(), &rule_id.to_le_bytes()],
        bump = rule.bump,
        has_one = vault,
    )]
    pub rule: Box<Account<'info, Rule>>,

    // --- token accounts (identical shape to execute_rule.rs) ---
    #[account(address = DEVUSDC_MINT @ PocketFansError::WrongMint)]
    pub usdc_mint: Box<Account<'info, Mint>>,
    #[account(address = WSOL_MINT @ PocketFansError::WrongMint)]
    pub wsol_mint: Box<Account<'info, Mint>>,

    /// Owner's USDC account — the delegated pull source. `token::authority`
    /// is read from vault.owner at runtime (no owner signer needed here).
    #[account(mut, token::mint = usdc_mint, token::authority = vault.owner)]
    pub owner_usdc_ata: Box<Account<'info, TokenAccount>>,
    #[account(mut, token::mint = usdc_mint, token::authority = vault)]
    pub vault_usdc_ata: Box<Account<'info, TokenAccount>>,
    #[account(mut, token::mint = wsol_mint, token::authority = vault)]
    pub vault_wsol_ata: Box<Account<'info, TokenAccount>>,

    // --- Orca Whirlpool accounts (identical to execute_rule.rs) ---
    /// CHECK: verified devnet SOL/devUSDC whirlpool.
    #[account(
        mut,
        address = SOL_DEVUSDC_WHIRLPOOL @ PocketFansError::WrongWhirlpool,
        owner = WHIRLPOOL_PROGRAM_ID @ PocketFansError::WrongWhirlpoolProgram,
    )]
    pub whirlpool: UncheckedAccount<'info>,
    /// CHECK: validated by the whirlpool program in-CPI.
    #[account(mut)]
    pub whirlpool_token_vault_a: UncheckedAccount<'info>,
    /// CHECK: validated by the whirlpool program in-CPI.
    #[account(mut)]
    pub whirlpool_token_vault_b: UncheckedAccount<'info>,
    /// CHECK: validated by the whirlpool program in-CPI.
    #[account(mut)]
    pub tick_array_0: UncheckedAccount<'info>,
    /// CHECK: validated by the whirlpool program in-CPI.
    #[account(mut)]
    pub tick_array_1: UncheckedAccount<'info>,
    /// CHECK: validated by the whirlpool program in-CPI.
    #[account(mut)]
    pub tick_array_2: UncheckedAccount<'info>,
    /// CHECK: whirlpool's own oracle PDA — unrelated to Txoracle, just Orca's
    /// internal TWAP account.
    #[account(mut)]
    pub whirlpool_oracle: UncheckedAccount<'info>,
    /// CHECK: the Orca Whirlpools program.
    #[account(address = WHIRLPOOL_PROGRAM_ID @ PocketFansError::WrongWhirlpoolProgram)]
    pub whirlpool_program: UncheckedAccount<'info>,

    // --- Txoracle CPI accounts ---
    /// CHECK: the `daily_scores_roots` PDA for the epoch day this proof's
    /// timestamp falls on. Owned and validated by the Txoracle program itself;
    /// this program only forwards it.
    pub daily_scores_roots: UncheckedAccount<'info>,
    /// CHECK: address-constrained to TXORACLE_PROGRAM_ID in the CPI helper.
    pub txoracle_program: UncheckedAccount<'info>,

    pub token_program: Program<'info, Token>,
}

pub fn handler(
    ctx: Context<ExecuteRuleVerified>,
    _rule_id: u16,
    payload: StatValidationInput,
) -> Result<()> {
    let rule = &ctx.accounts.rule;
    require!(rule.is_active, PocketFansError::RuleInactive);
    require!(
        rule.executions_done < rule.max_executions,
        PocketFansError::MaxExecutionsReached
    );

    let (pinned_stat_key, threshold) = match &rule.trigger_type {
        TriggerType::GoalScored { stat_key, threshold, .. } => (*stat_key, *threshold),
        _ => return err!(PocketFansError::UnsupportedTrigger), // TeamWin -> use execute_rule instead
    };

    // Key-pinning (mirrors ShroudLine): the proof must be for THIS rule's
    // match and THIS rule's stat — a caller cannot substitute a different
    // match's or different stat's proof to fake a trigger.
    require!(
        payload.fixture_summary.fixture_id as u64 == rule.match_id,
        PocketFansError::WrongFixture
    );
    require!(payload.stats.len() == 1, PocketFansError::InvalidStatLayout);
    require!(
        payload.stats[0].stat.key == pinned_stat_key,
        PocketFansError::InvalidStatLayout
    );

    // Build the predicate ON-CHAIN — never trust a caller-supplied strategy.
    // "value >= threshold" expressed as "value > (threshold - 1)" since the
    // oracle's Comparison enum has no GreaterThanOrEqual variant.
    let strategy = NDimensionalStrategy {
        geometric_targets: vec![],
        distance_predicate: None,
        discrete_predicates: vec![StatPredicate::Single {
            index: 0,
            predicate: TraderPredicate {
                threshold: (threshold as i32).saturating_sub(1),
                comparison: Comparison::GreaterThan,
            },
        }],
    };

    let verdict = validate_stat_v2_cpi(
        &ctx.accounts.daily_scores_roots.to_account_info(),
        &ctx.accounts.txoracle_program.to_account_info(),
        payload,
        strategy,
    )?;
    require!(verdict, PocketFansError::OracleRejected);

    // action params (this phase: only SwapAndSave, identical to execute_rule.rs)
    let (amount_usdc, target_mint, max_slippage_bps) = match &rule.action_type {
        ActionType::SwapAndSave { amount_usdc, target_mint, max_slippage_bps } => {
            (*amount_usdc, *target_mint, *max_slippage_bps)
        }
    };
    require!(target_mint == WSOL_MINT, PocketFansError::WrongMint);

    let sqrt_price = read_whirlpool_sqrt_price(&ctx.accounts.whirlpool)?;
    let min_out = compute_min_out(sqrt_price, amount_usdc, max_slippage_bps)?;

    let owner_key = ctx.accounts.vault.owner;
    let vault_bump = ctx.accounts.vault.bump;
    let seeds: &[&[u8]] = &[VAULT_SEED, owner_key.as_ref(), std::slice::from_ref(&vault_bump)];
    let signer_seeds: &[&[&[u8]]] = &[seeds];

    token::transfer(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.key(),
            Transfer {
                from: ctx.accounts.owner_usdc_ata.to_account_info(),
                to: ctx.accounts.vault_usdc_ata.to_account_info(),
                authority: ctx.accounts.vault.to_account_info(),
            },
            signer_seeds,
        ),
        amount_usdc,
    )?;

    swap_usdc_to_wsol(&ctx, amount_usdc, min_out, signer_seeds)?;

    let rule = &mut ctx.accounts.rule;
    rule.executions_done = rule
        .executions_done
        .checked_add(1)
        .ok_or(PocketFansError::MathOverflow)?;

    msg!(
        "Rule {} verified-claimed (GoalScored, stat_key={}, threshold={}): swapped {} raw devUSDC (min_out {} raw wSOL). caller={}",
        rule.rule_id,
        pinned_stat_key,
        threshold,
        amount_usdc,
        min_out,
        ctx.accounts.caller.key()
    );
    Ok(())
}

// --- identical helper functions to execute_rule.rs (kept local to avoid a
// cross-module dependency for two small pure functions; if this duplication
// becomes annoying once a third caller shows up, promote both to a shared
// `swap_math.rs` module) ---

fn read_whirlpool_sqrt_price(whirlpool: &UncheckedAccount) -> Result<u128> {
    let data = whirlpool.try_borrow_data()?;
    let bytes: [u8; 16] = data
        .get(65..81)
        .and_then(|s| <[u8; 16]>::try_from(s).ok())
        .ok_or(PocketFansError::WhirlpoolDecodeFailed)?;
    let sqrt_price = u128::from_le_bytes(bytes);
    require!(sqrt_price > 0, PocketFansError::WhirlpoolDecodeFailed);
    Ok(sqrt_price)
}

fn compute_min_out(sqrt_price: u128, amount_in: u64, slippage_bps: u16) -> Result<u64> {
    let t = (amount_in as u128)
        .checked_mul(Q64)
        .ok_or(PocketFansError::MathOverflow)?
        .checked_div(sqrt_price)
        .ok_or(PocketFansError::MathOverflow)?;
    let expected = t
        .checked_mul(Q64)
        .ok_or(PocketFansError::MathOverflow)?
        .checked_div(sqrt_price)
        .ok_or(PocketFansError::MathOverflow)?;
    let bps_keep = (10_000u128)
        .checked_sub(slippage_bps as u128)
        .ok_or(PocketFansError::InvalidSlippage)?;
    let min_out = expected
        .checked_mul(bps_keep)
        .ok_or(PocketFansError::MathOverflow)?
        .checked_div(10_000)
        .ok_or(PocketFansError::MathOverflow)?;
    u64::try_from(min_out).map_err(|_| PocketFansError::MathOverflow.into())
}

#[cfg(feature = "stub-swap")]
fn swap_usdc_to_wsol(
    _ctx: &Context<ExecuteRuleVerified>,
    _amount_in: u64,
    _min_out: u64,
    _signer_seeds: &[&[&[u8]]],
) -> Result<()> {
    msg!("[stub-swap] Orca swap CPI skipped (test-only build)");
    Ok(())
}

#[cfg(not(feature = "stub-swap"))]
fn swap_usdc_to_wsol(
    ctx: &Context<ExecuteRuleVerified>,
    amount_in: u64,
    min_out: u64,
    signer_seeds: &[&[&[u8]]],
) -> Result<()> {
    let mut data = Vec::with_capacity(8 + 8 + 8 + 16 + 1 + 1);
    data.extend_from_slice(&WHIRLPOOL_SWAP_DISCRIMINATOR);
    data.extend_from_slice(&amount_in.to_le_bytes());
    data.extend_from_slice(&min_out.to_le_bytes());
    data.extend_from_slice(&MAX_SQRT_PRICE.to_le_bytes());
    data.push(1u8); // amount_specified_is_input = true
    data.push(0u8); // a_to_b = false (B=USDC -> A=wSOL)

    let accounts = vec![
        AccountMeta::new_readonly(ctx.accounts.token_program.key(), false),
        AccountMeta::new_readonly(ctx.accounts.vault.key(), true), // token_authority (PDA signer)
        AccountMeta::new(ctx.accounts.whirlpool.key(), false),
        AccountMeta::new(ctx.accounts.vault_wsol_ata.key(), false),
        AccountMeta::new(ctx.accounts.whirlpool_token_vault_a.key(), false),
        AccountMeta::new(ctx.accounts.vault_usdc_ata.key(), false),
        AccountMeta::new(ctx.accounts.whirlpool_token_vault_b.key(), false),
        AccountMeta::new(ctx.accounts.tick_array_0.key(), false),
        AccountMeta::new(ctx.accounts.tick_array_1.key(), false),
        AccountMeta::new(ctx.accounts.tick_array_2.key(), false),
        AccountMeta::new(ctx.accounts.whirlpool_oracle.key(), false),
    ];

    let ix = Instruction { program_id: ctx.accounts.whirlpool_program.key(), accounts, data };

    let infos = [
        ctx.accounts.token_program.to_account_info(),
        ctx.accounts.vault.to_account_info(),
        ctx.accounts.whirlpool.to_account_info(),
        ctx.accounts.vault_wsol_ata.to_account_info(),
        ctx.accounts.whirlpool_token_vault_a.to_account_info(),
        ctx.accounts.vault_usdc_ata.to_account_info(),
        ctx.accounts.whirlpool_token_vault_b.to_account_info(),
        ctx.accounts.tick_array_0.to_account_info(),
        ctx.accounts.tick_array_1.to_account_info(),
        ctx.accounts.tick_array_2.to_account_info(),
        ctx.accounts.whirlpool_oracle.to_account_info(),
        ctx.accounts.whirlpool_program.to_account_info(),
    ];

    invoke_signed(&ix, &infos, signer_seeds)?;
    Ok(())
}

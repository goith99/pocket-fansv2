//! `TeamWinVerified` + `SwapAndSave` — permissionless keeper, oracle-verified,
//! settled DIRECTLY to the owner's wallet.
//!
//! This is the intersection of two existing patterns, and deliberately changes
//! neither of them:
//!   - trust model from execute_rule_verified.rs: ANY caller, no signer
//!     identity trusted, the Txoracle CPI verdict is the only gate
//!   - settlement from execute_rule_direct.rs: the Orca swap output goes to the
//!     OWNER's wSOL ATA, not the vault's, so there is no second withdraw
//!     instruction and no slippage dust left behind
//!
//! Net effect for the user: after creating the rule they click nothing ever
//! again. The keeper fires it once, at full time, and the SOL lands in their
//! wallet.
//!
//! WHEN IT FIRES: once, at the final whistle — not on a mid-match polling loop
//! like GoalScored. The keeper drives it off the poller's existing match-finality
//! detection (fixtures_cache flipping to 'finished'), so a live match with an
//! open win rule costs no extra TxLINE traffic beyond what the poller already
//! does.
//!
//! SECURITY: the full-time pin (`period == 100`) in winverify.rs is what makes
//! this sound. A mid-match proof is just as cryptographically valid but proves a
//! scoreline that can still change — verified on real data, where fixture
//! 18257739 proves 2-0 during extra time and 1-0 at full time after a VAR
//! disallowal. Read winverify.rs before touching any of this.
//!
//! KNOWN v1 LIMITATION — penalty shootouts are out of scope. The pinned stat
//! keys are full-time goals (which DO include extra-time goals but NOT shootout
//! goals), so a match level after extra time and decided on penalties proves a
//! draw and never fires. The rule simply stays open until the owner revokes it;
//! nothing is lost and no delegation is consumed. Surfaced in the UI as an
//! "Expired" state.

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
use crate::instructions::txoracle::StatValidationInput;
use crate::instructions::winverify::verify_team_win;
use crate::state::{ActionType, Rule, UserVault};

#[derive(Accounts)]
#[instruction(rule_id: u16)]
pub struct ExecuteRuleVerifiedWin<'info> {
    /// Anyone — pays the tx fee, gets no special trust. Keeper bot or the owner
    /// themself as a manual fallback.
    #[account(mut)]
    pub caller: Signer<'info>,

    /// The owner's pubkey is read from this account's data, never from a signer.
    pub vault: Box<Account<'info, UserVault>>,

    #[account(
        mut,
        seeds = [RULE_SEED, vault.key().as_ref(), &rule_id.to_le_bytes()],
        bump = rule.bump,
        has_one = vault,
    )]
    pub rule: Box<Account<'info, Rule>>,

    // --- token accounts ---
    #[account(address = DEVUSDC_MINT @ PocketFansError::WrongMint)]
    pub usdc_mint: Box<Account<'info, Mint>>,
    #[account(address = WSOL_MINT @ PocketFansError::WrongMint)]
    pub wsol_mint: Box<Account<'info, Mint>>,

    /// Owner's USDC account — the delegated pull source.
    #[account(mut, token::mint = usdc_mint, token::authority = vault.owner)]
    pub owner_usdc_ata: Box<Account<'info, TokenAccount>>,
    /// Vault's USDC account — pull destination and swap input (token B).
    #[account(mut, token::mint = usdc_mint, token::authority = vault)]
    pub vault_usdc_ata: Box<Account<'info, TokenAccount>>,
    /// OWNER's wSOL account — swap output. The direct-settlement difference from
    /// execute_rule_verified, where this slot is the vault's wSOL ATA.
    #[account(mut, token::mint = wsol_mint, token::authority = vault.owner)]
    pub owner_wsol_ata: Box<Account<'info, TokenAccount>>,

    // --- Orca Whirlpool accounts ---
    /// CHECK: verified devnet SOL/devUSDC whirlpool; sqrt_price read from data.
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
    /// CHECK: whirlpool's own oracle PDA — unrelated to Txoracle.
    #[account(mut)]
    pub whirlpool_oracle: UncheckedAccount<'info>,
    /// CHECK: the Orca Whirlpools program.
    #[account(address = WHIRLPOOL_PROGRAM_ID @ PocketFansError::WrongWhirlpoolProgram)]
    pub whirlpool_program: UncheckedAccount<'info>,

    // --- Txoracle CPI accounts ---
    /// CHECK: `daily_scores_roots` PDA for the proof's epoch day; owned and
    /// validated by the Txoracle program, forwarded untouched.
    pub daily_scores_roots: UncheckedAccount<'info>,
    /// CHECK: address-constrained to TXORACLE_PROGRAM_ID in the CPI helper.
    pub txoracle_program: UncheckedAccount<'info>,

    pub token_program: Program<'info, Token>,
}

pub fn handler(
    ctx: Context<ExecuteRuleVerifiedWin>,
    _rule_id: u16,
    payload: StatValidationInput,
) -> Result<()> {
    let rule = &ctx.accounts.rule;
    require!(rule.is_active, PocketFansError::RuleInactive);
    require!(
        rule.executions_done < rule.max_executions,
        PocketFansError::MaxExecutionsReached
    );

    // Trigger guard + fixture/stat/full-time pinning + oracle CPI. Everything
    // that decides WHETHER this may settle lives in winverify.rs.
    let proven = verify_team_win(
        rule,
        payload,
        &ctx.accounts.daily_scores_roots.to_account_info(),
        &ctx.accounts.txoracle_program.to_account_info(),
    )?;

    // action params — SwapAndSave only; staked wins use the _staked_ variant.
    let (amount_usdc, target_mint, max_slippage_bps) = match &rule.action_type {
        ActionType::SwapAndSave {
            amount_usdc,
            target_mint,
            max_slippage_bps,
        } => (*amount_usdc, *target_mint, *max_slippage_bps),
        ActionType::SwapStakeAndSave { .. } => return err!(PocketFansError::UnsupportedAction),
    };
    require!(target_mint == WSOL_MINT, PocketFansError::WrongMint);

    let sqrt_price = read_whirlpool_sqrt_price(&ctx.accounts.whirlpool)?;
    let min_out = compute_min_out(sqrt_price, amount_usdc, max_slippage_bps)?;

    let owner_key = ctx.accounts.vault.owner;
    let vault_bump = ctx.accounts.vault.bump;
    let seeds: &[&[u8]] = &[
        VAULT_SEED,
        owner_key.as_ref(),
        std::slice::from_ref(&vault_bump),
    ];
    let signer_seeds: &[&[&[u8]]] = &[seeds];

    // pull USDC owner -> vault via the vault PDA's delegation
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

    // swap vault USDC (B) -> OWNER wSOL (A): straight to the wallet, no dust
    swap_usdc_to_wsol(&ctx, amount_usdc, min_out, signer_seeds)?;

    let rule = &mut ctx.accounts.rule;
    rule.executions_done = rule
        .executions_done
        .checked_add(1)
        .ok_or(PocketFansError::MathOverflow)?;

    msg!(
        "Rule {} auto-settled (TeamWinVerified, full-time {}:{} on keys {}/{}): swapped {} raw devUSDC (min_out {} raw wSOL) straight to owner. executions_done = {}/{}. caller={}",
        rule.rule_id,
        proven.team_goals,
        proven.opponent_goals,
        proven.team_stat_key,
        proven.opponent_stat_key,
        amount_usdc,
        min_out,
        rule.executions_done,
        rule.max_executions,
        ctx.accounts.caller.key()
    );
    Ok(())
}

// --- helpers: same shape as execute_rule_direct.rs, duplicated to keep that
// file untouched (existing house style for these two pure functions) ---

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
    _ctx: &Context<ExecuteRuleVerifiedWin>,
    _amount_in: u64,
    _min_out: u64,
    _signer_seeds: &[&[&[u8]]],
) -> Result<()> {
    msg!("[stub-swap] Orca swap CPI skipped (test-only build)");
    Ok(())
}

#[cfg(not(feature = "stub-swap"))]
fn swap_usdc_to_wsol(
    ctx: &Context<ExecuteRuleVerifiedWin>,
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
        AccountMeta::new(ctx.accounts.owner_wsol_ata.key(), false), // token_owner_account_a (OWNER's wSOL)
        AccountMeta::new(ctx.accounts.whirlpool_token_vault_a.key(), false),
        AccountMeta::new(ctx.accounts.vault_usdc_ata.key(), false),
        AccountMeta::new(ctx.accounts.whirlpool_token_vault_b.key(), false),
        AccountMeta::new(ctx.accounts.tick_array_0.key(), false),
        AccountMeta::new(ctx.accounts.tick_array_1.key(), false),
        AccountMeta::new(ctx.accounts.tick_array_2.key(), false),
        AccountMeta::new(ctx.accounts.whirlpool_oracle.key(), false),
    ];

    let ix = Instruction {
        program_id: ctx.accounts.whirlpool_program.key(),
        accounts,
        data,
    };

    let infos = [
        ctx.accounts.token_program.to_account_info(),
        ctx.accounts.vault.to_account_info(),
        ctx.accounts.whirlpool.to_account_info(),
        ctx.accounts.owner_wsol_ata.to_account_info(),
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

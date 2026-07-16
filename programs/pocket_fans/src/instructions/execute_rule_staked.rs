//! SwapStakeAndSave execution — TeamWin self-claim, Victory DCA **into mSOL**.
//!
//! Sibling of execute_rule.rs (which stays untouched). Same trust model: OWNER
//! self-claims after `match_end_ts`, moving only their OWN funds into their OWN
//! vault — no oracle, no counterparty, no possibility of loss. The only
//! difference from SwapAndSave is what happens to the swapped SOL:
//!
//!   1. guards: rule active, under cap, trigger_type == TeamWin, and
//!      Clock::unix_timestamp >= match_end_ts (identical to execute_rule)
//!   2. pull `amount_usdc` from the owner's USDC ATA into the vault's USDC ATA
//!      via the vault PDA's SPL delegation (identical to execute_rule)
//!   3. Orca Whirlpool swap USDC -> wSOL, output into an EPHEMERAL `stake_wsol`
//!      token account (created this instruction), min-out slippage-protected
//!   4. close `stake_wsol` -> the swapped wSOL is unwrapped to native SOL and
//!      lands (with the account's rent) in the `vault_sol` system PDA
//!   5. Marinade `deposit(swapped_lamports)` from `vault_sol` (signing as
//!      Marinade's `transfer_from`) -> mints mSOL into the vault's mSOL ATA
//!   6. refund the residual `vault_sol` balance (the stake_wsol rent, originally
//!      paid by the owner) back to the owner, so nothing is stranded in the PDA
//!   7. executions_done += 1
//!
//! Net: the owner stakes exactly the swap output; the token-account rent is
//! round-tripped. All amounts are raw base units (devUSDC 6dp, SOL/wSOL/mSOL 9dp).

use anchor_lang::prelude::*;
use anchor_lang::solana_program::{
    instruction::{AccountMeta, Instruction},
    program::{invoke_signed},
    system_instruction,
};
use anchor_spl::token::{self, CloseAccount, Mint, Token, TokenAccount, Transfer};

use crate::constants::{
    DEVUSDC_MINT, MARINADE_DEPOSIT_DISCRIMINATOR, MARINADE_LIQ_POOL_MSOL_LEG,
    MARINADE_LIQ_POOL_MSOL_LEG_AUTHORITY, MARINADE_LIQ_POOL_SOL_LEG, MARINADE_MSOL_MINT_AUTHORITY,
    MARINADE_PROGRAM_ID, MARINADE_RESERVE, MARINADE_STATE, MAX_SQRT_PRICE, MSOL_MINT, Q64,
    RULE_SEED, SOL_DEVUSDC_WHIRLPOOL, STAKE_WSOL_SEED, VAULT_SEED, VAULT_SOL_SEED,
    WHIRLPOOL_PROGRAM_ID, WHIRLPOOL_SWAP_DISCRIMINATOR, WSOL_MINT,
};
use crate::error::PocketFansError;
use crate::state::{ActionType, Rule, TriggerType, UserVault};

#[derive(Accounts)]
#[instruction(rule_id: u16)]
pub struct ExecuteRuleStaked<'info> {
    /// The vault owner — self-claim signer (same as execute_rule).
    #[account(mut)]
    pub owner: Signer<'info>,

    #[account(
        seeds = [VAULT_SEED, owner.key().as_ref()],
        bump = vault.bump,
        has_one = owner @ PocketFansError::NotRuleOwner,
    )]
    pub vault: Box<Account<'info, UserVault>>,

    #[account(
        mut,
        seeds = [RULE_SEED, vault.key().as_ref(), &rule_id.to_le_bytes()],
        bump = rule.bump,
        has_one = vault,
    )]
    pub rule: Box<Account<'info, Rule>>,

    // --- mints ---
    #[account(address = DEVUSDC_MINT @ PocketFansError::WrongMint)]
    pub usdc_mint: Box<Account<'info, Mint>>,
    #[account(address = WSOL_MINT @ PocketFansError::WrongMint)]
    pub wsol_mint: Box<Account<'info, Mint>>,
    /// mSOL mint — Marinade's output. Marinade mints into `vault_msol_ata`;
    /// writable and forwarded as deposit account #2.
    #[account(mut, address = MSOL_MINT @ PocketFansError::WrongMint)]
    pub msol_mint: Box<Account<'info, Mint>>,

    // --- token accounts (owner + vault side) ---
    /// User's USDC account — the delegated pull source.
    #[account(mut, token::mint = usdc_mint, token::authority = owner)]
    pub owner_usdc_ata: Box<Account<'info, TokenAccount>>,
    /// Vault's USDC account — pull destination and swap input (token B).
    #[account(mut, token::mint = usdc_mint, token::authority = vault)]
    pub vault_usdc_ata: Box<Account<'info, TokenAccount>>,
    /// EPHEMERAL wSOL account — created here to receive the swap output (token A),
    /// then closed to unwrap it to native SOL. PDA so it is deterministic and can
    /// be re-created every execution. Rent paid by the owner and refunded (step 6).
    #[account(
        init,
        payer = owner,
        seeds = [STAKE_WSOL_SEED, owner.key().as_ref(), &rule_id.to_le_bytes()],
        bump,
        token::mint = wsol_mint,
        token::authority = vault,
    )]
    pub stake_wsol: Box<Account<'info, TokenAccount>>,
    /// System-owned PDA holding native SOL between the unwrap and the Marinade
    /// deposit; signs the deposit as Marinade's `transfer_from`.
    /// CHECK: constrained by seeds; must be system-owned (SystemAccount).
    #[account(mut, seeds = [VAULT_SOL_SEED, owner.key().as_ref()], bump)]
    pub vault_sol: SystemAccount<'info>,
    /// Vault's mSOL account — Marinade deposit `mint_to` destination (the saved
    /// funds). Must already exist (created by the client at challenge creation).
    #[account(mut, token::mint = msol_mint, token::authority = vault)]
    pub vault_msol_ata: Box<Account<'info, TokenAccount>>,

    // --- Orca Whirlpool accounts (forwarded to the swap CPI) ---
    /// CHECK: verified devnet SOL/devUSDC whirlpool; sqrt_price read from data.
    #[account(
        mut,
        address = SOL_DEVUSDC_WHIRLPOOL @ PocketFansError::WrongWhirlpool,
        owner = WHIRLPOOL_PROGRAM_ID @ PocketFansError::WrongWhirlpoolProgram,
    )]
    pub whirlpool: UncheckedAccount<'info>,
    /// CHECK: whirlpool token vault A (wSOL); validated by the whirlpool program in-CPI.
    #[account(mut)]
    pub whirlpool_token_vault_a: UncheckedAccount<'info>,
    /// CHECK: whirlpool token vault B (devUSDC); validated by the whirlpool program in-CPI.
    #[account(mut)]
    pub whirlpool_token_vault_b: UncheckedAccount<'info>,
    /// CHECK: tick array; validated by the whirlpool program in-CPI.
    #[account(mut)]
    pub tick_array_0: UncheckedAccount<'info>,
    /// CHECK: tick array; validated by the whirlpool program in-CPI.
    #[account(mut)]
    pub tick_array_1: UncheckedAccount<'info>,
    /// CHECK: tick array; validated by the whirlpool program in-CPI.
    #[account(mut)]
    pub tick_array_2: UncheckedAccount<'info>,
    /// CHECK: whirlpool's own oracle PDA; validated by the whirlpool program in-CPI.
    #[account(mut)]
    pub whirlpool_oracle: UncheckedAccount<'info>,
    /// CHECK: the Orca Whirlpools program.
    #[account(address = WHIRLPOOL_PROGRAM_ID @ PocketFansError::WrongWhirlpoolProgram)]
    pub whirlpool_program: UncheckedAccount<'info>,

    // --- Marinade deposit accounts (forwarded to the deposit CPI) ---
    // Order/writability mirror the Marinade `Deposit` accounts struct exactly.
    // Their addresses are asserted in the handler via require_keys_eq! (not with
    // `address =` here) to keep the try_accounts stack frame under the 4KB SBF
    // limit — this many constrained accounts otherwise overflows it. Marinade
    // also validates every one of these internally during the deposit CPI.
    /// CHECK: Marinade State; address asserted in handler + validated by the CPI.
    #[account(mut)]
    pub marinade_state: UncheckedAccount<'info>,
    /// CHECK: liq_pool_sol_leg_pda; address asserted in handler + validated by the CPI.
    #[account(mut)]
    pub marinade_liq_pool_sol_leg: UncheckedAccount<'info>,
    /// CHECK: liq_pool_msol_leg; address asserted in handler + validated by the CPI.
    #[account(mut)]
    pub marinade_liq_pool_msol_leg: UncheckedAccount<'info>,
    /// CHECK: liq_pool_msol_leg_authority; address asserted in handler + validated by the CPI.
    pub marinade_liq_pool_msol_leg_authority: UncheckedAccount<'info>,
    /// CHECK: reserve_pda; address asserted in handler + validated by the CPI.
    #[account(mut)]
    pub marinade_reserve: UncheckedAccount<'info>,
    /// CHECK: msol_mint_authority PDA; address asserted in handler + validated by the CPI.
    pub marinade_msol_mint_authority: UncheckedAccount<'info>,
    /// CHECK: the Marinade liquid-staking program; address asserted in handler.
    pub marinade_program: UncheckedAccount<'info>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<ExecuteRuleStaked>, rule_id: u16) -> Result<()> {
    // 1) guards — identical to execute_rule (active, cap, trigger, time).
    let rule = &ctx.accounts.rule;
    require!(rule.is_active, PocketFansError::RuleInactive);
    require!(
        rule.executions_done < rule.max_executions,
        PocketFansError::MaxExecutionsReached
    );
    match &rule.trigger_type {
        TriggerType::TeamWin { .. } => {}
        _ => return err!(PocketFansError::UnsupportedTrigger),
    }
    let now = Clock::get()?.unix_timestamp;
    require!(now >= rule.match_end_ts, PocketFansError::MatchNotFinished);

    // Assert the Marinade accounts (moved out of the accounts struct to stay under
    // the SBF stack limit — see the struct comment). Defense-in-depth; Marinade
    // re-validates all of these in the deposit CPI regardless.
    let a = &ctx.accounts;
    require_keys_eq!(a.marinade_program.key(), MARINADE_PROGRAM_ID, PocketFansError::WrongMarinadeProgram);
    require_keys_eq!(a.marinade_state.key(), MARINADE_STATE, PocketFansError::WrongMarinadeAccount);
    require_keys_eq!(a.marinade_liq_pool_sol_leg.key(), MARINADE_LIQ_POOL_SOL_LEG, PocketFansError::WrongMarinadeAccount);
    require_keys_eq!(a.marinade_liq_pool_msol_leg.key(), MARINADE_LIQ_POOL_MSOL_LEG, PocketFansError::WrongMarinadeAccount);
    require_keys_eq!(a.marinade_liq_pool_msol_leg_authority.key(), MARINADE_LIQ_POOL_MSOL_LEG_AUTHORITY, PocketFansError::WrongMarinadeAccount);
    require_keys_eq!(a.marinade_reserve.key(), MARINADE_RESERVE, PocketFansError::WrongMarinadeAccount);
    require_keys_eq!(a.marinade_msol_mint_authority.key(), MARINADE_MSOL_MINT_AUTHORITY, PocketFansError::WrongMarinadeAccount);

    // action params — must be SwapStakeAndSave.
    let (amount_usdc, max_slippage_bps) = match &rule.action_type {
        ActionType::SwapStakeAndSave {
            amount_usdc,
            max_slippage_bps,
        } => (*amount_usdc, *max_slippage_bps),
        _ => return err!(PocketFansError::UnsupportedAction),
    };

    // slippage-protected min wSOL out for the USDC->wSOL swap.
    let sqrt_price = read_whirlpool_sqrt_price(&ctx.accounts.whirlpool)?;
    let min_out = compute_min_out(sqrt_price, amount_usdc, max_slippage_bps)?;

    // vault PDA signer seeds (authority over the token accounts).
    let owner_key = ctx.accounts.owner.key();
    let vault_bump = ctx.accounts.vault.bump;
    let vault_seeds: &[&[u8]] = &[VAULT_SEED, owner_key.as_ref(), std::slice::from_ref(&vault_bump)];
    let vault_signer: &[&[&[u8]]] = &[vault_seeds];

    // 2) pull USDC owner -> vault via delegation.
    token::transfer(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.key(),
            Transfer {
                from: ctx.accounts.owner_usdc_ata.to_account_info(),
                to: ctx.accounts.vault_usdc_ata.to_account_info(),
                authority: ctx.accounts.vault.to_account_info(),
            },
            vault_signer,
        ),
        amount_usdc,
    )?;

    // 3) Orca swap USDC (B) -> wSOL (A), output into the ephemeral stake_wsol.
    swap_usdc_to_wsol(&ctx, amount_usdc, min_out, vault_signer)?;

    // read exactly how much wSOL we received (the amount to stake).
    ctx.accounts.stake_wsol.reload()?;
    let staked_lamports = ctx.accounts.stake_wsol.amount;
    require!(staked_lamports > 0, PocketFansError::NothingToStake);

    // 4) close stake_wsol -> unwrap to native SOL into vault_sol (also carries the
    //    account's rent lamports; refunded in step 6).
    token::close_account(CpiContext::new_with_signer(
        ctx.accounts.token_program.key(),
        CloseAccount {
            account: ctx.accounts.stake_wsol.to_account_info(),
            destination: ctx.accounts.vault_sol.to_account_info(),
            authority: ctx.accounts.vault.to_account_info(),
        },
        vault_signer,
    ))?;

    // 5) Marinade deposit(staked_lamports) from vault_sol -> mSOL to vault_msol_ata.
    let vault_sol_bump = ctx.bumps.vault_sol;
    let vault_sol_seeds: &[&[u8]] =
        &[VAULT_SOL_SEED, owner_key.as_ref(), std::slice::from_ref(&vault_sol_bump)];
    marinade_deposit(&ctx, staked_lamports, &[vault_sol_seeds])?;

    // 6) refund the residual vault_sol balance (the stake_wsol rent) to the owner,
    //    so nothing is stranded in the PDA across executions.
    let residual = ctx.accounts.vault_sol.lamports();
    if residual > 0 {
        invoke_signed(
            &system_instruction::transfer(
                &ctx.accounts.vault_sol.key(),
                &owner_key,
                residual,
            ),
            &[
                ctx.accounts.vault_sol.to_account_info(),
                ctx.accounts.owner.to_account_info(),
                ctx.accounts.system_program.to_account_info(),
            ],
            &[vault_sol_seeds],
        )?;
    }

    // 7) count the execution.
    let rule = &mut ctx.accounts.rule;
    rule.executions_done = rule
        .executions_done
        .checked_add(1)
        .ok_or(PocketFansError::MathOverflow)?;

    msg!(
        "Rule {} self-claimed (SwapStakeAndSave): swapped {} raw devUSDC, staked {} lamports into Marinade -> mSOL. executions_done = {}/{}",
        rule_id,
        amount_usdc,
        staked_lamports,
        rule.executions_done,
        rule.max_executions
    );
    Ok(())
}

// --- Marinade deposit CPI (hand-rolled; account order mirrors the Deposit
// accounts struct in liquid-staking-program deposit.rs, re-verified this
// session against the raw source and the official contract-addresses page) ---
fn marinade_deposit(
    ctx: &Context<ExecuteRuleStaked>,
    lamports: u64,
    signer_seeds: &[&[&[u8]]],
) -> Result<()> {
    let mut data = Vec::with_capacity(8 + 8);
    data.extend_from_slice(&MARINADE_DEPOSIT_DISCRIMINATOR);
    data.extend_from_slice(&lamports.to_le_bytes());

    // 11 accounts, exact order/writability from Marinade's Deposit struct.
    let accounts = vec![
        AccountMeta::new(ctx.accounts.marinade_state.key(), false), //  1 state (w)
        AccountMeta::new(ctx.accounts.msol_mint.key(), false),      //  2 msol_mint (w)
        AccountMeta::new(ctx.accounts.marinade_liq_pool_sol_leg.key(), false), //  3 liq_pool_sol_leg_pda (w)
        AccountMeta::new(ctx.accounts.marinade_liq_pool_msol_leg.key(), false), //  4 liq_pool_msol_leg (w)
        AccountMeta::new_readonly(ctx.accounts.marinade_liq_pool_msol_leg_authority.key(), false), //  5 liq_pool_msol_leg_authority
        AccountMeta::new(ctx.accounts.marinade_reserve.key(), false), //  6 reserve_pda (w)
        AccountMeta::new(ctx.accounts.vault_sol.key(), true),         //  7 transfer_from (w, signer = our PDA)
        AccountMeta::new(ctx.accounts.vault_msol_ata.key(), false),   //  8 mint_to (w)
        AccountMeta::new_readonly(ctx.accounts.marinade_msol_mint_authority.key(), false), //  9 msol_mint_authority
        AccountMeta::new_readonly(ctx.accounts.system_program.key(), false), // 10 system_program
        AccountMeta::new_readonly(ctx.accounts.token_program.key(), false),  // 11 token_program
    ];

    let ix = Instruction {
        program_id: ctx.accounts.marinade_program.key(),
        accounts,
        data,
    };

    let infos = [
        ctx.accounts.marinade_state.to_account_info(),
        ctx.accounts.msol_mint.to_account_info(),
        ctx.accounts.marinade_liq_pool_sol_leg.to_account_info(),
        ctx.accounts.marinade_liq_pool_msol_leg.to_account_info(),
        ctx.accounts.marinade_liq_pool_msol_leg_authority.to_account_info(),
        ctx.accounts.marinade_reserve.to_account_info(),
        ctx.accounts.vault_sol.to_account_info(),
        ctx.accounts.vault_msol_ata.to_account_info(),
        ctx.accounts.marinade_msol_mint_authority.to_account_info(),
        ctx.accounts.system_program.to_account_info(),
        ctx.accounts.token_program.to_account_info(),
        ctx.accounts.marinade_program.to_account_info(),
    ];

    invoke_signed(&ix, &infos, signer_seeds)?;
    Ok(())
}

// --- Orca swap: identical shape to execute_rule.rs::swap_usdc_to_wsol, but the
// wSOL output account is the ephemeral `stake_wsol` (token_owner_account_a). The
// helper is duplicated here rather than shared so execute_rule.rs stays untouched.
#[cfg(feature = "stub-swap")]
fn swap_usdc_to_wsol(
    _ctx: &Context<ExecuteRuleStaked>,
    _amount_in: u64,
    _min_out: u64,
    _signer_seeds: &[&[&[u8]]],
) -> Result<()> {
    msg!("[stub-swap] Orca swap CPI skipped (test-only build)");
    Ok(())
}

#[cfg(not(feature = "stub-swap"))]
fn swap_usdc_to_wsol(
    ctx: &Context<ExecuteRuleStaked>,
    amount_in: u64,
    min_out: u64,
    signer_seeds: &[&[&[u8]]],
) -> Result<()> {
    let mut data = Vec::with_capacity(8 + 8 + 8 + 16 + 1 + 1);
    data.extend_from_slice(&WHIRLPOOL_SWAP_DISCRIMINATOR);
    data.extend_from_slice(&amount_in.to_le_bytes());
    data.extend_from_slice(&min_out.to_le_bytes());
    data.extend_from_slice(&MAX_SQRT_PRICE.to_le_bytes()); // b_to_a upper price bound
    data.push(1u8); // amount_specified_is_input = true
    data.push(0u8); // a_to_b = false (B=USDC -> A=wSOL)

    let accounts = vec![
        AccountMeta::new_readonly(ctx.accounts.token_program.key(), false),
        AccountMeta::new_readonly(ctx.accounts.vault.key(), true), // token_authority (PDA signer)
        AccountMeta::new(ctx.accounts.whirlpool.key(), false),
        AccountMeta::new(ctx.accounts.stake_wsol.key(), false), // token_owner_account_a (wSOL out)
        AccountMeta::new(ctx.accounts.whirlpool_token_vault_a.key(), false),
        AccountMeta::new(ctx.accounts.vault_usdc_ata.key(), false), // token_owner_account_b (USDC in)
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
        ctx.accounts.stake_wsol.to_account_info(),
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

/// Read the whirlpool's current sqrt_price (Q64.64, u128 LE). Duplicated from
/// execute_rule.rs (same layout offset 65..81) to keep that file untouched.
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

/// Minimum wSOL out for `amount_in` raw devUSDC (token B) -> wSOL (token A).
/// Duplicated from execute_rule.rs (same two-step Q64 math).
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

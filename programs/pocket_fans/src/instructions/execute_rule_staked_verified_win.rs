//! `TeamWinVerified` + `SwapStakeAndSave` — permissionless keeper,
//! oracle-verified, mSOL settled DIRECTLY to the owner's wallet.
//!
//! The Auto Stake twin of execute_rule_verified_win.rs. Same trust model (any
//! caller, Txoracle CPI verdict is the only gate, full-time pin in winverify.rs),
//! same direct settlement principle, but the swapped SOL is deposited into
//! Marinade and the minted mSOL lands in the OWNER's mSOL ATA.
//!
//! Mechanically it is execute_rule_staked_direct.rs with the owner-signer guard
//! replaced by oracle verification, plus one deliberate difference:
//!
//! RENT REFUND GOES TO THE CALLER, NOT THE OWNER. The ephemeral `stake_wsol`
//! account's rent is paid by whoever sends the transaction. In the self-claim
//! variant that is the owner, so refunding the owner is right. Here it is an
//! unrelated keeper, and refunding the owner would make every execution cost the
//! keeper ~0.002 SOL of someone else's savings — a slow bleed that eventually
//! stops the keeper. Refunding the payer keeps it exactly whole. The owner is
//! unaffected either way: their funds are the swapped amount, not the rent.
//!
//! KNOWN v1 LIMITATION — penalty shootouts are out of scope; see the same note
//! on execute_rule_verified_win.rs.

use anchor_lang::prelude::*;
use anchor_lang::solana_program::{
    instruction::{AccountMeta, Instruction},
    program::invoke_signed,
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
use crate::instructions::txoracle::StatValidationInput;
use crate::instructions::winverify::verify_team_win;
use crate::state::{ActionType, Rule, UserVault};

#[derive(Accounts)]
#[instruction(rule_id: u16)]
pub struct ExecuteRuleStakedVerifiedWin<'info> {
    /// Anyone — fee payer AND `stake_wsol` rent payer (refunded in step 7).
    /// Gets no special trust.
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

    // --- mints ---
    #[account(address = DEVUSDC_MINT @ PocketFansError::WrongMint)]
    pub usdc_mint: Box<Account<'info, Mint>>,
    #[account(address = WSOL_MINT @ PocketFansError::WrongMint)]
    pub wsol_mint: Box<Account<'info, Mint>>,
    #[account(mut, address = MSOL_MINT @ PocketFansError::WrongMint)]
    pub msol_mint: Box<Account<'info, Mint>>,

    // --- token accounts ---
    #[account(mut, token::mint = usdc_mint, token::authority = vault.owner)]
    pub owner_usdc_ata: Box<Account<'info, TokenAccount>>,
    #[account(mut, token::mint = usdc_mint, token::authority = vault)]
    pub vault_usdc_ata: Box<Account<'info, TokenAccount>>,
    /// EPHEMERAL wSOL account receiving the swap output, then closed to unwrap.
    /// Seeds keyed on the VAULT OWNER (not the caller), so the address is the
    /// same regardless of which keeper fires it — two keepers racing the same
    /// rule collide on this account and one simply fails, which is the desired
    /// outcome (the rule's `executions_done` guard is the real dedup).
    #[account(
        init,
        payer = caller,
        seeds = [STAKE_WSOL_SEED, vault.owner.as_ref(), &rule_id.to_le_bytes()],
        bump,
        token::mint = wsol_mint,
        token::authority = vault,
    )]
    pub stake_wsol: Box<Account<'info, TokenAccount>>,
    /// System-owned PDA holding native SOL between unwrap and Marinade deposit;
    /// signs the deposit as Marinade's `transfer_from`.
    #[account(mut, seeds = [VAULT_SOL_SEED, vault.owner.as_ref()], bump)]
    pub vault_sol: SystemAccount<'info>,
    /// OWNER's mSOL account — Marinade `mint_to` destination.
    #[account(mut, token::mint = msol_mint, token::authority = vault.owner)]
    pub owner_msol_ata: Box<Account<'info, TokenAccount>>,

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
    /// CHECK: whirlpool's own oracle PDA; validated by the whirlpool program in-CPI.
    #[account(mut)]
    pub whirlpool_oracle: UncheckedAccount<'info>,
    /// CHECK: the Orca Whirlpools program.
    #[account(address = WHIRLPOOL_PROGRAM_ID @ PocketFansError::WrongWhirlpoolProgram)]
    pub whirlpool_program: UncheckedAccount<'info>,

    // --- Marinade deposit accounts ---
    // Addresses asserted in the handler rather than with `address =` here, to
    // keep the try_accounts stack frame under the 4KB SBF limit (same reason as
    // execute_rule_staked_direct). Marinade re-validates all of them in-CPI.
    /// CHECK: Marinade State; asserted in handler.
    #[account(mut)]
    pub marinade_state: UncheckedAccount<'info>,
    /// CHECK: liq_pool_sol_leg_pda; asserted in handler.
    #[account(mut)]
    pub marinade_liq_pool_sol_leg: UncheckedAccount<'info>,
    /// CHECK: liq_pool_msol_leg; asserted in handler.
    #[account(mut)]
    pub marinade_liq_pool_msol_leg: UncheckedAccount<'info>,
    /// CHECK: liq_pool_msol_leg_authority; asserted in handler.
    pub marinade_liq_pool_msol_leg_authority: UncheckedAccount<'info>,
    /// CHECK: reserve_pda; asserted in handler.
    #[account(mut)]
    pub marinade_reserve: UncheckedAccount<'info>,
    /// CHECK: msol_mint_authority PDA; asserted in handler.
    pub marinade_msol_mint_authority: UncheckedAccount<'info>,
    /// CHECK: the Marinade liquid-staking program; asserted in handler.
    pub marinade_program: UncheckedAccount<'info>,

    // --- Txoracle CPI accounts ---
    /// CHECK: `daily_scores_roots` PDA for the proof's epoch day; owned and
    /// validated by the Txoracle program, forwarded untouched.
    pub daily_scores_roots: UncheckedAccount<'info>,
    /// CHECK: address-constrained to TXORACLE_PROGRAM_ID in the CPI helper.
    pub txoracle_program: UncheckedAccount<'info>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

pub fn handler(
    ctx: Context<ExecuteRuleStakedVerifiedWin>,
    rule_id: u16,
    payload: StatValidationInput,
) -> Result<()> {
    let rule = &ctx.accounts.rule;
    require!(rule.is_active, PocketFansError::RuleInactive);
    require!(
        rule.executions_done < rule.max_executions,
        PocketFansError::MaxExecutionsReached
    );

    // Marinade address assertions (defense-in-depth; re-validated in-CPI).
    let a = &ctx.accounts;
    require_keys_eq!(
        a.marinade_program.key(),
        MARINADE_PROGRAM_ID,
        PocketFansError::WrongMarinadeProgram
    );
    require_keys_eq!(
        a.marinade_state.key(),
        MARINADE_STATE,
        PocketFansError::WrongMarinadeAccount
    );
    require_keys_eq!(
        a.marinade_liq_pool_sol_leg.key(),
        MARINADE_LIQ_POOL_SOL_LEG,
        PocketFansError::WrongMarinadeAccount
    );
    require_keys_eq!(
        a.marinade_liq_pool_msol_leg.key(),
        MARINADE_LIQ_POOL_MSOL_LEG,
        PocketFansError::WrongMarinadeAccount
    );
    require_keys_eq!(
        a.marinade_liq_pool_msol_leg_authority.key(),
        MARINADE_LIQ_POOL_MSOL_LEG_AUTHORITY,
        PocketFansError::WrongMarinadeAccount
    );
    require_keys_eq!(
        a.marinade_reserve.key(),
        MARINADE_RESERVE,
        PocketFansError::WrongMarinadeAccount
    );
    require_keys_eq!(
        a.marinade_msol_mint_authority.key(),
        MARINADE_MSOL_MINT_AUTHORITY,
        PocketFansError::WrongMarinadeAccount
    );

    // Trigger guard + fixture/stat/full-time pinning + oracle CPI.
    let proven = verify_team_win(
        rule,
        payload,
        &ctx.accounts.daily_scores_roots.to_account_info(),
        &ctx.accounts.txoracle_program.to_account_info(),
    )?;

    // action params — SwapStakeAndSave only.
    let (amount_usdc, max_slippage_bps) = match &rule.action_type {
        ActionType::SwapStakeAndSave {
            amount_usdc,
            max_slippage_bps,
        } => (*amount_usdc, *max_slippage_bps),
        _ => return err!(PocketFansError::UnsupportedAction),
    };

    let sqrt_price = read_whirlpool_sqrt_price(&ctx.accounts.whirlpool)?;
    let min_out = compute_min_out(sqrt_price, amount_usdc, max_slippage_bps)?;

    let owner_key = ctx.accounts.vault.owner;
    let vault_bump = ctx.accounts.vault.bump;
    let vault_seeds: &[&[u8]] = &[
        VAULT_SEED,
        owner_key.as_ref(),
        std::slice::from_ref(&vault_bump),
    ];
    let vault_signer: &[&[&[u8]]] = &[vault_seeds];

    // pull USDC owner -> vault via delegation
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

    // swap USDC (B) -> wSOL (A) into the ephemeral stake_wsol
    swap_usdc_to_wsol(&ctx, amount_usdc, min_out, vault_signer)?;

    ctx.accounts.stake_wsol.reload()?;
    let staked_lamports = ctx.accounts.stake_wsol.amount;
    require!(staked_lamports > 0, PocketFansError::NothingToStake);

    // close stake_wsol -> native SOL into vault_sol (carries the rent too)
    token::close_account(CpiContext::new_with_signer(
        ctx.accounts.token_program.key(),
        CloseAccount {
            account: ctx.accounts.stake_wsol.to_account_info(),
            destination: ctx.accounts.vault_sol.to_account_info(),
            authority: ctx.accounts.vault.to_account_info(),
        },
        vault_signer,
    ))?;

    // Marinade deposit -> mSOL straight to the OWNER's ATA
    let vault_sol_bump = ctx.bumps.vault_sol;
    let vault_sol_seeds: &[&[u8]] = &[
        VAULT_SOL_SEED,
        owner_key.as_ref(),
        std::slice::from_ref(&vault_sol_bump),
    ];
    marinade_deposit(&ctx, staked_lamports, &[vault_sol_seeds])?;

    // refund the residual vault_sol balance (the stake_wsol rent) to the CALLER,
    // who paid it — see the module header. Nothing is stranded in the PDA.
    let residual = ctx.accounts.vault_sol.lamports();
    if residual > 0 {
        invoke_signed(
            &system_instruction::transfer(
                &ctx.accounts.vault_sol.key(),
                &ctx.accounts.caller.key(),
                residual,
            ),
            &[
                ctx.accounts.vault_sol.to_account_info(),
                ctx.accounts.caller.to_account_info(),
                ctx.accounts.system_program.to_account_info(),
            ],
            &[vault_sol_seeds],
        )?;
    }

    let rule = &mut ctx.accounts.rule;
    rule.executions_done = rule
        .executions_done
        .checked_add(1)
        .ok_or(PocketFansError::MathOverflow)?;

    msg!(
        "Rule {} auto-settled (TeamWinVerified + stake, full-time {}:{} on keys {}/{}): swapped {} raw devUSDC, staked {} lamports -> mSOL straight to owner. executions_done = {}/{}. caller={}",
        rule_id,
        proven.team_goals,
        proven.opponent_goals,
        proven.team_stat_key,
        proven.opponent_stat_key,
        amount_usdc,
        staked_lamports,
        rule.executions_done,
        rule.max_executions,
        ctx.accounts.caller.key()
    );
    Ok(())
}

// --- Marinade deposit CPI (account order mirrors Marinade's Deposit struct;
// identical to execute_rule_staked_direct.rs) ---
fn marinade_deposit(
    ctx: &Context<ExecuteRuleStakedVerifiedWin>,
    lamports: u64,
    signer_seeds: &[&[&[u8]]],
) -> Result<()> {
    let mut data = Vec::with_capacity(8 + 8);
    data.extend_from_slice(&MARINADE_DEPOSIT_DISCRIMINATOR);
    data.extend_from_slice(&lamports.to_le_bytes());

    let accounts = vec![
        AccountMeta::new(ctx.accounts.marinade_state.key(), false), //  1 state (w)
        AccountMeta::new(ctx.accounts.msol_mint.key(), false),      //  2 msol_mint (w)
        AccountMeta::new(ctx.accounts.marinade_liq_pool_sol_leg.key(), false), //  3 liq_pool_sol_leg_pda (w)
        AccountMeta::new(ctx.accounts.marinade_liq_pool_msol_leg.key(), false), //  4 liq_pool_msol_leg (w)
        AccountMeta::new_readonly(ctx.accounts.marinade_liq_pool_msol_leg_authority.key(), false), //  5
        AccountMeta::new(ctx.accounts.marinade_reserve.key(), false), //  6 reserve_pda (w)
        AccountMeta::new(ctx.accounts.vault_sol.key(), true), //  7 transfer_from (w, PDA signer)
        AccountMeta::new(ctx.accounts.owner_msol_ata.key(), false), //  8 mint_to (w)
        AccountMeta::new_readonly(ctx.accounts.marinade_msol_mint_authority.key(), false), //  9
        AccountMeta::new_readonly(ctx.accounts.system_program.key(), false), // 10
        AccountMeta::new_readonly(ctx.accounts.token_program.key(), false),  // 11
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
        ctx.accounts
            .marinade_liq_pool_msol_leg_authority
            .to_account_info(),
        ctx.accounts.marinade_reserve.to_account_info(),
        ctx.accounts.vault_sol.to_account_info(),
        ctx.accounts.owner_msol_ata.to_account_info(),
        ctx.accounts.marinade_msol_mint_authority.to_account_info(),
        ctx.accounts.system_program.to_account_info(),
        ctx.accounts.token_program.to_account_info(),
        ctx.accounts.marinade_program.to_account_info(),
    ];

    invoke_signed(&ix, &infos, signer_seeds)?;
    Ok(())
}

#[cfg(feature = "stub-swap")]
fn swap_usdc_to_wsol(
    _ctx: &Context<ExecuteRuleStakedVerifiedWin>,
    _amount_in: u64,
    _min_out: u64,
    _signer_seeds: &[&[&[u8]]],
) -> Result<()> {
    msg!("[stub-swap] Orca swap CPI skipped (test-only build)");
    Ok(())
}

#[cfg(not(feature = "stub-swap"))]
fn swap_usdc_to_wsol(
    ctx: &Context<ExecuteRuleStakedVerifiedWin>,
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
        AccountMeta::new(ctx.accounts.stake_wsol.key(), false), // token_owner_account_a (wSOL out)
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

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
use crate::state::{ActionType, Rule, TriggerType, UserVault};

/// Execute a rule — SELF-CLAIM MODEL, DIRECT-TO-OWNER output variant.
///
/// Byte-for-byte identical to `execute_rule` (TeamWin self-claim, delegated USDC
/// pull, vault PDA signs the Orca swap) EXCEPT for ONE thing: the swap OUTPUT
/// account is the OWNER's own wSOL ATA instead of the vault's. Orca does not
/// check the output account's owner against the swap `token_authority` (only the
/// INPUT must be owned/delegated by it — verified live on devnet), so the vault
/// still signs the swap while the wSOL lands straight in the owner's wallet.
///
/// Why this exists: `execute_rule` lands wSOL in the vault, requiring a separate
/// `withdraw_from_vault` to move it to the owner (the app chained the two, which
/// meant withdrawing a slippage-floor amount and leaving ~5% dust behind). This
/// variant collapses that to a SINGLE instruction with the full swap output in
/// the owner's wallet — zero dust, no second instruction. `execute_rule` is left
/// completely untouched; this is purely additive.
///
/// Flow (identical to execute_rule except step 5's destination):
///   1. signer must be the rule's vault owner
///   2. rule must be active, under its cap, and trigger_type == TeamWin
///   3. Clock::unix_timestamp must be >= rule.match_end_ts (time guard only)
///   4. pull `amount_usdc` from owner's USDC account into the VAULT's USDC
///      account, using the vault PDA's SPL delegation (unchanged)
///   5. CPI Orca Whirlpool swap: vault USDC -> **owner's wSOL ATA** (a_to_b =
///      false), min-out enforced from the rule's max_slippage_bps
///   6. executions_done += 1
///
/// All token amounts are in raw base units (devUSDC 6dp, wSOL 9dp) — no scaling.
#[derive(Accounts)]
#[instruction(rule_id: u16)]
pub struct ExecuteRuleDirect<'info> {
    /// The vault owner. MUST sign. Anyone else's signature is rejected by
    /// `has_one` below.
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

    // --- token accounts ---
    // NOTE: the typed accounts here are Box'd so they live on the heap rather
    // than the try_accounts stack frame — this many-account context otherwise
    // exceeds the SBF 4KB stack frame limit (runtime access violation).
    #[account(address = DEVUSDC_MINT @ PocketFansError::WrongMint)]
    pub usdc_mint: Box<Account<'info, Mint>>,
    #[account(address = WSOL_MINT @ PocketFansError::WrongMint)]
    pub wsol_mint: Box<Account<'info, Mint>>,

    /// User's USDC account — the delegated pull source.
    #[account(mut, token::mint = usdc_mint, token::authority = owner)]
    pub owner_usdc_ata: Box<Account<'info, TokenAccount>>,
    /// Vault's USDC account — pull destination and swap input (unchanged).
    #[account(mut, token::mint = usdc_mint, token::authority = vault)]
    pub vault_usdc_ata: Box<Account<'info, TokenAccount>>,
    /// OWNER's wSOL account — swap output (the saved funds land directly here).
    /// THIS is the only account constraint that differs from execute_rule, where
    /// this slot is the vault's wSOL ATA (token::authority = vault).
    #[account(mut, token::mint = wsol_mint, token::authority = owner)]
    pub owner_wsol_ata: Box<Account<'info, TokenAccount>>,

    // --- Orca Whirlpool accounts (forwarded to the swap CPI) ---
    /// CHECK: must be the verified devnet SOL/devUSDC whirlpool, owned by the
    /// whirlpool program. sqrt_price is read from its data for slippage math.
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
    /// CHECK: the whirlpool's own oracle PDA (unrelated to match results);
    /// validated by the whirlpool program in-CPI.
    #[account(mut)]
    pub whirlpool_oracle: UncheckedAccount<'info>,
    /// CHECK: the Orca Whirlpools program.
    #[account(address = WHIRLPOOL_PROGRAM_ID @ PocketFansError::WrongWhirlpoolProgram)]
    pub whirlpool_program: UncheckedAccount<'info>,

    pub token_program: Program<'info, Token>,
}

pub fn handler(ctx: Context<ExecuteRuleDirect>, _rule_id: u16) -> Result<()> {
    // 1) rule must be active and under its cap
    let rule = &ctx.accounts.rule;
    require!(rule.is_active, PocketFansError::RuleInactive);
    require!(
        rule.executions_done < rule.max_executions,
        PocketFansError::MaxExecutionsReached
    );

    // 2) trigger guard: TeamWin self-claim path ONLY (mirror of execute_rule).
    match &rule.trigger_type {
        TriggerType::TeamWin { .. } => {}
        _ => return err!(PocketFansError::UnsupportedTrigger),
    }

    // 3) time guard ONLY — no result verification.
    let now = Clock::get()?.unix_timestamp;
    require!(now >= rule.match_end_ts, PocketFansError::MatchNotFinished);

    // action params (this phase: only SwapAndSave)
    let (amount_usdc, target_mint, max_slippage_bps) = match &rule.action_type {
        ActionType::SwapAndSave {
            amount_usdc,
            target_mint,
            max_slippage_bps,
        } => (*amount_usdc, *target_mint, *max_slippage_bps),
        // SwapStakeAndSave rules stake into Marinade via execute_rule_staked only.
        ActionType::SwapStakeAndSave { .. } => return err!(PocketFansError::UnsupportedAction),
    };
    require!(target_mint == WSOL_MINT, PocketFansError::WrongMint);

    // slippage-protected minimum output, derived from the pool's live sqrt_price
    let sqrt_price = read_whirlpool_sqrt_price(&ctx.accounts.whirlpool)?;
    let min_out = compute_min_out(sqrt_price, amount_usdc, max_slippage_bps)?;

    // vault PDA signer seeds
    let owner_key = ctx.accounts.owner.key();
    let vault_bump = ctx.accounts.vault.bump;
    let seeds: &[&[u8]] = &[VAULT_SEED, owner_key.as_ref(), std::slice::from_ref(&vault_bump)];
    let signer_seeds: &[&[&[u8]]] = &[seeds];

    // 4) pull USDC from user -> vault via the vault PDA's delegation (unchanged)
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

    // 5) CPI Orca Whirlpool swap: vault USDC (token B) -> OWNER wSOL (token A).
    //    a_to_b = false, amount_specified_is_input = true. Output lands in the
    //    owner's wallet directly — no vault hop, no withdraw.
    swap_usdc_to_wsol(&ctx, amount_usdc, min_out, signer_seeds)?;

    // 6) count the execution
    let rule = &mut ctx.accounts.rule;
    rule.executions_done = rule
        .executions_done
        .checked_add(1)
        .ok_or(PocketFansError::MathOverflow)?;

    msg!(
        "Rule {} self-claimed (direct): swapped {} raw devUSDC (min_out {} raw wSOL) straight to owner. executions_done = {}/{}",
        rule.rule_id,
        amount_usdc,
        min_out,
        rule.executions_done,
        rule.max_executions
    );
    Ok(())
}

/// Read the whirlpool's current sqrt_price (Q64.64, u128 LE) from raw account
/// data. Layout offset 65..81. Duplicated from execute_rule.rs to keep that file
/// untouched.
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

/// Minimum acceptable wSOL output for swapping `amount_in` raw devUSDC (token B)
/// to wSOL (token A). Same two-step Q64 math as execute_rule.rs.
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

/// TEST-ONLY stub (cargo feature `stub-swap`). Mirrors execute_rule.rs.
#[cfg(feature = "stub-swap")]
fn swap_usdc_to_wsol(
    _ctx: &Context<ExecuteRuleDirect>,
    _amount_in: u64,
    _min_out: u64,
    _signer_seeds: &[&[&[u8]]],
) -> Result<()> {
    msg!("[stub-swap] Orca swap CPI skipped (test-only build)");
    Ok(())
}

/// Build and invoke the Orca Whirlpool `swap` instruction manually. Signed by the
/// vault PDA as `token_authority` (UNCHANGED from execute_rule) — only the
/// token_owner_account_a (output) is the OWNER's wSOL ATA instead of the vault's.
#[cfg(not(feature = "stub-swap"))]
fn swap_usdc_to_wsol(
    ctx: &Context<ExecuteRuleDirect>,
    amount_in: u64,
    min_out: u64,
    signer_seeds: &[&[&[u8]]],
) -> Result<()> {
    // args: swap(amount, other_amount_threshold, sqrt_price_limit, amount_specified_is_input, a_to_b)
    let mut data = Vec::with_capacity(8 + 8 + 8 + 16 + 1 + 1);
    data.extend_from_slice(&WHIRLPOOL_SWAP_DISCRIMINATOR);
    data.extend_from_slice(&amount_in.to_le_bytes());
    data.extend_from_slice(&min_out.to_le_bytes());
    data.extend_from_slice(&MAX_SQRT_PRICE.to_le_bytes()); // b_to_a: upper price bound
    data.push(1u8); // amount_specified_is_input = true
    data.push(0u8); // a_to_b = false (B=USDC -> A=wSOL)

    let accounts = vec![
        AccountMeta::new_readonly(ctx.accounts.token_program.key(), false),
        AccountMeta::new_readonly(ctx.accounts.vault.key(), true), // token_authority (PDA signer) — UNCHANGED
        AccountMeta::new(ctx.accounts.whirlpool.key(), false),
        AccountMeta::new(ctx.accounts.owner_wsol_ata.key(), false), // token_owner_account_a (OWNER's wSOL — the one change)
        AccountMeta::new(ctx.accounts.whirlpool_token_vault_a.key(), false),
        AccountMeta::new(ctx.accounts.vault_usdc_ata.key(), false), // token_owner_account_b (USDC in) — UNCHANGED
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

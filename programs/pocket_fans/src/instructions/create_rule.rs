use anchor_lang::prelude::*;
use anchor_lang::solana_program::program_option::COption;
use anchor_spl::token::{self, Approve, Mint, Token, TokenAccount};

use crate::constants::{
    DEVUSDC_MINT, HARD_MAX_EXECUTIONS, MAX_MATCH_END_TS_HORIZON_SECS, MAX_SLIPPAGE_BPS, RULE_SEED,
    VAULT_SEED, WSOL_MINT,
};
use crate::error::PocketFansError;
use crate::state::{ActionType, Rule, TriggerType, UserVault};

/// Create a Rule under the caller's vault AND grant an SPL token delegation so
/// the vault PDA can later pull USDC on the user's behalf when the rule fires.
///
/// SELF-CLAIM MODEL: the caller also fixes `match_id` (TxLINE fixture id, for
/// display/dedup only) and `match_end_ts` (unix seconds) at creation time.
/// `execute_rule` later requires the CALLER (this same owner) to sign, gated
/// only by `Clock::unix_timestamp >= match_end_ts` — no oracle, no admin key.
///
/// Delegation is bounded and CUMULATIVE: this rule's own need is
/// `amount_usdc * max_executions`, and we approve the running total across all of
/// the owner's active rules — never more. SPL `approve` overwrites rather than
/// adds, so approving only this rule's need would wipe out every other active
/// rule's allowance; see the accumulation comment in the handler.
/// `revoke_rule` subtracts this rule's share back out again.
#[derive(Accounts)]
pub struct CreateRule<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,

    #[account(
        mut,
        seeds = [VAULT_SEED, owner.key().as_ref()],
        bump = vault.bump,
        has_one = owner,
    )]
    pub vault: Account<'info, UserVault>,

    #[account(
        init,
        payer = owner,
        space = 8 + Rule::INIT_SPACE,
        seeds = [RULE_SEED, vault.key().as_ref(), &vault.total_rules.to_le_bytes()],
        bump,
    )]
    pub rule: Account<'info, Rule>,

    /// devUSDC mint — the token being delegated/pulled.
    #[account(address = DEVUSDC_MINT @ PocketFansError::WrongMint)]
    pub usdc_mint: Account<'info, Mint>,

    /// The user's USDC token account. Delegation is granted on THIS account to
    /// the vault PDA.
    #[account(
        mut,
        token::mint = usdc_mint,
        token::authority = owner,
    )]
    pub owner_usdc_ata: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

pub fn handler(
    ctx: Context<CreateRule>,
    trigger_type: TriggerType,
    action_type: ActionType,
    max_executions: u16,
    match_id: u64,
    match_end_ts: i64,
) -> Result<()> {
    // --- validate ---
    require!(
        max_executions >= 1 && max_executions <= HARD_MAX_EXECUTIONS,
        PocketFansError::InvalidMaxExecutions
    );

    // match_end_ts must be a plausible future timestamp — not in the past, and
    // not absurdly far out (defense-in-depth; this is a UX guard, not a result
    // check, so we keep it permissive).
    let now = Clock::get()?.unix_timestamp;
    require!(match_end_ts > now, PocketFansError::InvalidMatchEndTs);
    require!(
        match_end_ts <= now + MAX_MATCH_END_TS_HORIZON_SECS,
        PocketFansError::InvalidMatchEndTs
    );

    // Validate the action's fields and compute the per-execution amount used for
    // the delegation. Both actions delegate USDC identically; they differ only in
    // what the later execute step does with the swapped SOL (plain wSOL vs. staked
    // mSOL), which is not decided here.
    let amount_usdc: u64 = match &action_type {
        ActionType::SwapAndSave {
            amount_usdc,
            target_mint,
            max_slippage_bps,
        } => {
            require!(*amount_usdc > 0, PocketFansError::InvalidAmount);
            require!(
                *max_slippage_bps <= MAX_SLIPPAGE_BPS,
                PocketFansError::InvalidSlippage
            );
            // MVP: output must be wSOL.
            require!(*target_mint == WSOL_MINT, PocketFansError::WrongMint);
            *amount_usdc
        }
        // Auto-stake variant: no target_mint (output is always Marinade mSOL).
        ActionType::SwapStakeAndSave {
            amount_usdc,
            max_slippage_bps,
        } => {
            require!(*amount_usdc > 0, PocketFansError::InvalidAmount);
            require!(
                *max_slippage_bps <= MAX_SLIPPAGE_BPS,
                PocketFansError::InvalidSlippage
            );
            *amount_usdc
        }
    };

    // This rule's own bounded need = per-execution amount * max_executions.
    let this_rule_need = amount_usdc
        .checked_mul(max_executions as u64)
        .ok_or(PocketFansError::MathOverflow)?;

    // ACCUMULATE, never overwrite.
    //
    // SPL `approve` REPLACES the delegation rather than adding to it, and a token
    // account holds exactly one delegate with one amount. Approving only this
    // rule's need therefore silently destroyed every other active rule's
    // allowance on the same wallet — they'd later fail their delegated pull with
    // SPL OwnerMismatch. The self-claim paths could paper over it (the owner is
    // signing, so the client can re-approve in the same transaction), but the
    // permissionless keeper path CANNOT: it never holds the owner's signature.
    //
    // So we read the CURRENT delegation off the token account and add to it. The
    // token account is the single source of truth that actually governs the pull,
    // and this keeps `delegated_amount` equal to the sum of what every active rule
    // still needs.
    //
    // Only accumulate when the existing delegate is already OUR vault. If it is
    // unset, or points anywhere else, we start from zero rather than inheriting an
    // unrelated allowance.
    //
    // Race-safety: Anchor deserializes accounts at instruction entry and Solana
    // executes transactions sequentially per account, so this read-modify-write is
    // atomic against concurrent transactions. Two creates in flight cannot lose an
    // update — the second observes the first's result. An execution in between is
    // also safe: it decrements `delegated_amount` by exactly the `amount_usdc` it
    // pulled while incrementing that rule's `executions_done`, so the invariant
    // "delegated_amount == sum(remaining need across active rules)" is preserved
    // on both sides.
    let vault_key = ctx.accounts.vault.key();
    let existing_delegation = if ctx.accounts.owner_usdc_ata.delegate == COption::Some(vault_key) {
        ctx.accounts.owner_usdc_ata.delegated_amount
    } else {
        0
    };
    let new_total_delegation = existing_delegation
        .checked_add(this_rule_need)
        .ok_or(PocketFansError::MathOverflow)?;

    // --- persist the rule ---
    let vault = &mut ctx.accounts.vault;
    let rule_id = vault.total_rules;

    let rule = &mut ctx.accounts.rule;
    rule.vault = vault.key();
    rule.rule_id = rule_id;
    rule.trigger_type = trigger_type;
    rule.action_type = action_type;
    rule.match_id = match_id;
    rule.match_end_ts = match_end_ts;
    rule.max_executions = max_executions;
    rule.executions_done = 0;
    rule.is_active = true;
    rule.bump = ctx.bumps.rule;
    rule.reserved = [0u8; 24];

    vault.total_rules = vault
        .total_rules
        .checked_add(1)
        .ok_or(PocketFansError::MathOverflow)?;

    // --- grant SPL delegation to the vault PDA (delegate = vault) ---
    // Signed by the owner (they own the USDC account). Approves the ACCUMULATED
    // total computed above, not just this rule's need — see the comment there.
    let cpi_ctx = CpiContext::new(
        ctx.accounts.token_program.key(),
        Approve {
            to: ctx.accounts.owner_usdc_ata.to_account_info(),
            delegate: vault.to_account_info(),
            authority: ctx.accounts.owner.to_account_info(),
        },
    );
    token::approve(cpi_ctx, new_total_delegation)?;

    msg!(
        "Rule {} created (match {}, claimable after unix_ts {}); delegation to vault {} raised {} -> {} raw devUSDC units (this rule needs {})",
        rule_id,
        match_id,
        match_end_ts,
        vault.key(),
        existing_delegation,
        new_total_delegation,
        this_rule_need
    );
    Ok(())
}

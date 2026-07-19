use anchor_lang::prelude::*;
use anchor_lang::solana_program::program_option::COption;
use anchor_spl::token::{self, Approve, Mint, Revoke, Token, TokenAccount};

use crate::constants::{DEVUSDC_MINT, RULE_SEED, VAULT_SEED};
use crate::error::PocketFansError;
use crate::state::{ActionType, Rule, UserVault};

/// User deactivates their own rule and releases exactly that rule's share of the
/// delegation.
///
/// This used to call SPL `revoke`, clearing the delegation OUTRIGHT. Because a
/// token account holds a single delegation shared by every rule on the wallet,
/// cancelling one challenge silently disarmed all the others — they'd later fail
/// their delegated pull with SPL OwnerMismatch. Now we SUBTRACT this rule's
/// outstanding need from the running total and re-approve the remainder, so the
/// owner's other active rules keep working. `revoke` is still used when the
/// remainder reaches zero, which both clears the delegate and leaves the wallet
/// in a clean state.
#[derive(Accounts)]
#[instruction(rule_id: u16)]
pub struct RevokeRule<'info> {
    pub owner: Signer<'info>,

    #[account(
        seeds = [VAULT_SEED, owner.key().as_ref()],
        bump = vault.bump,
        has_one = owner,
    )]
    pub vault: Account<'info, UserVault>,

    #[account(
        mut,
        seeds = [RULE_SEED, vault.key().as_ref(), &rule_id.to_le_bytes()],
        bump = rule.bump,
        has_one = vault,
    )]
    pub rule: Account<'info, Rule>,

    #[account(address = DEVUSDC_MINT @ PocketFansError::WrongMint)]
    pub usdc_mint: Account<'info, Mint>,

    #[account(
        mut,
        token::mint = usdc_mint,
        token::authority = owner,
    )]
    pub owner_usdc_ata: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
}

pub fn handler(ctx: Context<RevokeRule>, rule_id: u16) -> Result<()> {
    // What this rule still had reserved: per-execution amount * executions left.
    // Both action variants carry amount_usdc; only SwapAndSave also carries a
    // target_mint, which is irrelevant here.
    let rule_amount_usdc = match &ctx.accounts.rule.action_type {
        ActionType::SwapAndSave { amount_usdc, .. } => *amount_usdc,
        ActionType::SwapStakeAndSave { amount_usdc, .. } => *amount_usdc,
    };
    let remaining_executions = ctx
        .accounts
        .rule
        .max_executions
        .saturating_sub(ctx.accounts.rule.executions_done) as u64;
    // saturating: an over-large product can only mean "release everything", and
    // the subtraction below saturates at zero anyway.
    let this_rule_reserved = rule_amount_usdc.saturating_mul(remaining_executions);

    // Current delegation, but only if it is OURS — if the delegate is unset or
    // points elsewhere, there is nothing of ours to subtract from.
    let vault_key = ctx.accounts.vault.key();
    let existing_delegation = if ctx.accounts.owner_usdc_ata.delegate == COption::Some(vault_key) {
        ctx.accounts.owner_usdc_ata.delegated_amount
    } else {
        0
    };
    // saturating_sub: if the delegation has already been drawn down below this
    // rule's nominal share (e.g. it was partially executed), release what's left
    // rather than underflowing.
    let new_total_delegation = existing_delegation.saturating_sub(this_rule_reserved);

    let rule = &mut ctx.accounts.rule;
    rule.is_active = false;

    if new_total_delegation == 0 {
        // Nothing left reserved for any rule — clear the delegate entirely, which
        // is the cleanest end state for the wallet.
        token::revoke(CpiContext::new(
            ctx.accounts.token_program.key(),
            Revoke {
                source: ctx.accounts.owner_usdc_ata.to_account_info(),
                authority: ctx.accounts.owner.to_account_info(),
            },
        ))?;
        msg!(
            "Rule {} revoked; released {} raw devUSDC units, delegation now cleared",
            rule_id,
            this_rule_reserved
        );
    } else {
        // Other active rules still need their share — re-approve the remainder
        // instead of wiping it out.
        token::approve(
            CpiContext::new(
                ctx.accounts.token_program.key(),
                Approve {
                    to: ctx.accounts.owner_usdc_ata.to_account_info(),
                    delegate: ctx.accounts.vault.to_account_info(),
                    authority: ctx.accounts.owner.to_account_info(),
                },
            ),
            new_total_delegation,
        )?;
        msg!(
            "Rule {} revoked; released {} raw devUSDC units, delegation to vault {} lowered {} -> {}",
            rule_id,
            this_rule_reserved,
            vault_key,
            existing_delegation,
            new_total_delegation
        );
    }
    Ok(())
}

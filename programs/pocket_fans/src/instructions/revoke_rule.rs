use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, Revoke, Token, TokenAccount};

use crate::constants::{DEVUSDC_MINT, RULE_SEED, VAULT_SEED};
use crate::error::PocketFansError;
use crate::state::{Rule, UserVault};

/// User deactivates their own rule. We set `is_active = false` AND call SPL
/// `revoke` to drop the delegation entirely — so even if some other code path
/// tried to pull tokens, there is no longer any delegated authority to do so.
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
    let rule = &mut ctx.accounts.rule;
    rule.is_active = false;

    // Drop the SPL delegation on the user's USDC account (signed by the owner).
    let cpi_ctx = CpiContext::new(
        ctx.accounts.token_program.key(),
        Revoke {
            source: ctx.accounts.owner_usdc_ata.to_account_info(),
            authority: ctx.accounts.owner.to_account_info(),
        },
    );
    token::revoke(cpi_ctx)?;

    msg!("Rule {} revoked; delegation cleared", rule_id);
    Ok(())
}

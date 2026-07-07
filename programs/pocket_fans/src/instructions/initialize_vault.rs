use anchor_lang::prelude::*;

use crate::constants::VAULT_SEED;
use crate::state::UserVault;

/// Create the caller's UserVault PDA. Idempotent per user (one vault per owner).
#[derive(Accounts)]
pub struct InitializeVault<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,

    #[account(
        init,
        payer = owner,
        space = 8 + UserVault::INIT_SPACE,
        seeds = [VAULT_SEED, owner.key().as_ref()],
        bump,
    )]
    pub vault: Account<'info, UserVault>,

    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<InitializeVault>) -> Result<()> {
    let vault = &mut ctx.accounts.vault;
    vault.owner = ctx.accounts.owner.key();
    vault.total_rules = 0;
    vault.bump = ctx.bumps.vault;
    vault.reserved = [0u8; 64];

    msg!("UserVault initialized for owner {}", vault.owner);
    Ok(())
}

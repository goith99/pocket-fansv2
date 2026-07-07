use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer};

use crate::constants::VAULT_SEED;
use crate::error::PocketFansError;
use crate::state::UserVault;

/// User withdraws saved funds from a vault-owned token account back to their own
/// wallet. Generic over mint (this phase the saved token is wSOL, but the vault
/// may hold others as new actions ship). The vault PDA signs the transfer.
#[derive(Accounts)]
pub struct WithdrawFromVault<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,

    #[account(
        seeds = [VAULT_SEED, owner.key().as_ref()],
        bump = vault.bump,
        has_one = owner,
    )]
    pub vault: Account<'info, UserVault>,

    pub token_mint: Account<'info, Mint>,

    /// Vault-owned token account funds are withdrawn FROM.
    #[account(
        mut,
        token::mint = token_mint,
        token::authority = vault,
    )]
    pub vault_token_ata: Account<'info, TokenAccount>,

    /// User-owned token account funds are withdrawn TO.
    #[account(
        mut,
        token::mint = token_mint,
        token::authority = owner,
    )]
    pub owner_token_ata: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
}

pub fn handler(ctx: Context<WithdrawFromVault>, amount: u64) -> Result<()> {
    require!(
        ctx.accounts.vault_token_ata.amount >= amount,
        PocketFansError::InsufficientVaultBalance
    );

    let owner_key = ctx.accounts.owner.key();
    let signer_seeds: &[&[&[u8]]] = &[&[VAULT_SEED, owner_key.as_ref(), &[ctx.accounts.vault.bump]]];

    let cpi_ctx = CpiContext::new_with_signer(
        ctx.accounts.token_program.key(),
        Transfer {
            from: ctx.accounts.vault_token_ata.to_account_info(),
            to: ctx.accounts.owner_token_ata.to_account_info(),
            authority: ctx.accounts.vault.to_account_info(),
        },
        signer_seeds,
    );
    token::transfer(cpi_ctx, amount)?;

    msg!("Withdrew {} (raw units) from vault to owner {}", amount, owner_key);
    Ok(())
}

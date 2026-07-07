pub mod constants;
pub mod error;
pub mod instructions;
pub mod state;

use anchor_lang::prelude::*;

pub use constants::*;
pub use instructions::*;
pub use state::*;

declare_id!("4f74EBY7KMe8mUP9MpNzRnPzW6LojYX8wm56ZZz3iDgB");

// SELF-CLAIM MODEL — no oracle, no admin, anywhere in this program.
// Every instruction below is signed by the USER themselves (the vault owner).
// "Saving" here means Victory DCA: the user's own devUSDC is swapped into
// $SOL (wSOL) via Orca Whirlpools and held in a vault PDA only the user can
// withdraw from. There are no odds, no counterparty, no house, and no way to
// lose funds — the only conditional is WHEN the user chooses to move their own
// money, gated on-chain by a per-rule time guard (match_end_ts).
#[program]
pub mod pocket_fans {
    use super::*;

    /// User: create your vault (one per wallet).
    pub fn initialize_vault(ctx: Context<InitializeVault>) -> Result<()> {
        instructions::initialize_vault::handler(ctx)
    }

    /// User: create a rule and grant the bounded SPL delegation to the vault.
    /// `match_id` (TxLINE fixture id) and `match_end_ts` (unix seconds) fix
    /// which match this rule is tied to and when it becomes claimable.
    pub fn create_rule(
        ctx: Context<CreateRule>,
        trigger_type: TriggerType,
        action_type: ActionType,
        max_executions: u16,
        match_id: u64,
        match_end_ts: i64,
    ) -> Result<()> {
        instructions::create_rule::handler(
            ctx,
            trigger_type,
            action_type,
            max_executions,
            match_id,
            match_end_ts,
        )
    }

    /// Rule OWNER ONLY (self-claim): after `rule.match_end_ts` has passed,
    /// pulls the user's own USDC via delegation and swaps it to wSOL into the
    /// user's own vault (Victory DCA into $SOL). See
    /// instructions/execute_rule.rs for the full trust-model rationale.
    pub fn execute_rule(ctx: Context<ExecuteRule>, rule_id: u16) -> Result<()> {
        instructions::execute_rule::handler(ctx, rule_id)
    }

    /// User: deactivate a rule and clear its SPL delegation.
    pub fn revoke_rule(ctx: Context<RevokeRule>, rule_id: u16) -> Result<()> {
        instructions::revoke_rule::handler(ctx, rule_id)
    }

    /// User: withdraw saved funds from the vault back to your wallet.
    pub fn withdraw_from_vault(ctx: Context<WithdrawFromVault>, amount: u64) -> Result<()> {
        instructions::withdraw_from_vault::handler(ctx, amount)
    }
}

pub mod constants;
pub mod error;
pub mod instructions;
pub mod state;

use anchor_lang::prelude::*;

pub use constants::*;
pub use instructions::*;
pub use state::*;

// txoracle is deliberately not glob re-exported from instructions.rs, but the
// #[program] module below needs this type by name for the execute_rule_verified
// instruction argument (and for IDL generation).
pub use instructions::txoracle::StatValidationInput;

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

    /// Rule OWNER ONLY (self-claim), DIRECT-TO-OWNER variant of execute_rule:
    /// identical delegated USDC pull + vault-signed Orca swap, but the swapped
    /// wSOL lands straight in the owner's own wSOL ATA instead of the vault's —
    /// one instruction, no withdraw, no dust. execute_rule is untouched. See
    /// instructions/execute_rule_direct.rs.
    pub fn execute_rule_direct(ctx: Context<ExecuteRuleDirect>, rule_id: u16) -> Result<()> {
        instructions::execute_rule_direct::handler(ctx, rule_id)
    }

    /// GoalScored trigger — callable by ANYONE (a permissionless keeper bot, or
    /// the owner themself as a manual fallback). No signer identity is trusted;
    /// the Txoracle `validate_stat_v2` CPI verdict is the only gate. Entirely
    /// separate from `execute_rule` above, which stays owner-signed and
    /// time-guarded. See instructions/execute_rule_verified.rs for the rationale.
    pub fn execute_rule_verified(
        ctx: Context<ExecuteRuleVerified>,
        rule_id: u16,
        payload: StatValidationInput,
    ) -> Result<()> {
        instructions::execute_rule_verified::handler(ctx, rule_id, payload)
    }

    /// Rule OWNER ONLY (self-claim), SwapStakeAndSave action: like execute_rule,
    /// but the swapped SOL is deposited into Marinade liquid staking so the vault
    /// receives mSOL instead of wSOL. TeamWin trigger only; entirely separate from
    /// execute_rule / execute_rule_verified (both untouched). See
    /// instructions/execute_rule_staked.rs.
    pub fn execute_rule_staked(ctx: Context<ExecuteRuleStaked>, rule_id: u16) -> Result<()> {
        instructions::execute_rule_staked::handler(ctx, rule_id)
    }

    /// Rule OWNER ONLY (self-claim), DIRECT-TO-OWNER variant of
    /// execute_rule_staked: identical delegated USDC pull, Orca swap, unwrap and
    /// vault-signed Marinade deposit, but the minted mSOL lands straight in the
    /// owner's own mSOL ATA instead of the vault's — one instruction, no
    /// withdraw. execute_rule_staked is untouched. See
    /// instructions/execute_rule_staked_direct.rs.
    pub fn execute_rule_staked_direct(
        ctx: Context<ExecuteRuleStakedDirect>,
        rule_id: u16,
    ) -> Result<()> {
        instructions::execute_rule_staked_direct::handler(ctx, rule_id)
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

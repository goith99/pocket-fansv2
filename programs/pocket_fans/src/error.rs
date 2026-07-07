use anchor_lang::prelude::*;

#[error_code]
pub enum PocketFansError {
    #[msg("max_executions must be >= 1 and <= HARD_MAX_EXECUTIONS")]
    InvalidMaxExecutions,
    #[msg("Slippage tolerance out of range (0..=10000 bps)")]
    InvalidSlippage,
    #[msg("amount_usdc must be greater than zero")]
    InvalidAmount,
    #[msg("Rule is not active")]
    RuleInactive,
    #[msg("Rule has reached its max executions")]
    MaxExecutionsReached,
    #[msg("Match result does not satisfy this rule's trigger")]
    TriggerNotSatisfied,
    #[msg("Signer is not the configured oracle authority")]
    UnauthorizedOracle,
    #[msg("Provided whirlpool does not match the expected devnet SOL/devUSDC pool")]
    WrongWhirlpool,
    #[msg("Provided token mint does not match the rule's configuration")]
    WrongMint,
    #[msg("Whirlpool program id mismatch")]
    WrongWhirlpoolProgram,
    #[msg("Action type is not supported by this instruction")]
    UnsupportedAction,
    #[msg("Arithmetic overflow")]
    MathOverflow,
    #[msg("Failed to read whirlpool sqrt_price from account data")]
    WhirlpoolDecodeFailed,
    #[msg("Requested withdrawal exceeds vault token balance")]
    InsufficientVaultBalance,
    #[msg("match_end_ts must be in the future at rule creation time")]
    InvalidMatchEndTs,
    #[msg("This match has not finished yet (match_end_ts not reached)")]
    MatchNotFinished,
    #[msg("Only the rule's owner may execute it")]
    NotRuleOwner,
}

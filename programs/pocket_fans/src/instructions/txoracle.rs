//! Cross-program interface for TxODDS's on-chain `Txoracle` program.
//!
//! Ported verbatim (struct/enum layouts, discriminator, CPI shape) from the
//! author's own ShroudLine program (programs/shroudline/src/instructions/
//! txoracle.rs), which has this CPI proven working against real devnet fixture
//! data. Do not change field order — it defines the borsh wire format the
//! oracle expects.
//!
//! Used by execute_rule_verified.rs (GoalScored trigger) — NOT by execute_rule.rs
//! (TeamWin trigger, which stays on the pure time-guard self-claim model; no
//! oracle involved there, unchanged and untouched by this feature).

use crate::constants::{TXORACLE_PROGRAM_ID, VALIDATE_STAT_V2_DISCRIMINATOR};
use crate::error::PocketFansError;
use anchor_lang::prelude::*;
use anchor_lang::solana_program::instruction::{AccountMeta, Instruction};
use anchor_lang::solana_program::program::{get_return_data, invoke};

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct ProofNode {
    pub hash: [u8; 32],
    pub is_right_sibling: bool,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct ScoresUpdateStats {
    pub update_count: i32,
    pub min_timestamp: i64,
    pub max_timestamp: i64,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct ScoresBatchSummary {
    pub fixture_id: i64,
    pub update_stats: ScoresUpdateStats,
    pub events_sub_tree_root: [u8; 32],
}

/// A single provable key-value statistic — the leaf of the inner-most tree.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct ScoreStat {
    /// Stat key (base + period offset), e.g. 1 = home goals, 2 = away goals.
    /// See documentation/scores/soccer-feed for the full key scheme.
    pub key: u32,
    pub value: i32,
    pub period: i32,
}

/// One stat to prove plus the Merkle branch that commits it.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct StatLeaf {
    pub stat: ScoreStat,
    pub stat_proof: Vec<ProofNode>,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct TraderPredicate {
    pub threshold: i32,
    pub comparison: Comparison,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, PartialEq, Eq)]
pub enum Comparison {
    GreaterThan,
    LessThan,
    EqualTo,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, PartialEq, Eq)]
pub enum BinaryExpression {
    Add,
    Subtract,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct GeometricTarget {
    pub stat_index: u8,
    pub prediction: i32,
}

/// A single predicate leg over the proven `stats` array. `discrete_predicates`
/// are ANDed together by the oracle.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub enum StatPredicate {
    Single {
        index: u8,
        predicate: TraderPredicate,
    },
    Binary {
        index_a: u8,
        index_b: u8,
        op: BinaryExpression,
        predicate: TraderPredicate,
    },
}

/// N-stat validation payload: one witness snapshot, one shared `event_stat_root`,
/// and a list of `(stat, proof)` leaves proven against it.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct StatValidationInput {
    pub ts: i64,
    pub fixture_summary: ScoresBatchSummary,
    pub fixture_proof: Vec<ProofNode>,
    pub main_tree_proof: Vec<ProofNode>,
    pub event_stat_root: [u8; 32],
    pub stats: Vec<StatLeaf>,
}

/// The strategy evaluated over the proven `stats`. Pocket Fans only ever uses
/// a single `Single` discrete predicate (one stat, one threshold) — the
/// geometric/distance machinery is included only for wire-compatibility.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct NDimensionalStrategy {
    pub geometric_targets: Vec<GeometricTarget>,
    pub distance_predicate: Option<TraderPredicate>,
    pub discrete_predicates: Vec<StatPredicate>,
}

/// Borsh payload for `validate_stat_v2`, in the exact IDL argument order.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
struct ValidateStatV2Args {
    payload: StatValidationInput,
    strategy: NDimensionalStrategy,
}

/// CPI into `Txoracle::validate_stat_v2` and return the oracle's boolean verdict.
pub fn validate_stat_v2_cpi<'info>(
    daily_scores_roots: &AccountInfo<'info>,
    txoracle_program: &AccountInfo<'info>,
    payload: StatValidationInput,
    strategy: NDimensionalStrategy,
) -> Result<bool> {
    require_keys_eq!(
        *txoracle_program.key,
        TXORACLE_PROGRAM_ID,
        PocketFansError::InvalidOracleProgram
    );

    let mut data = VALIDATE_STAT_V2_DISCRIMINATOR.to_vec();
    ValidateStatV2Args { payload, strategy }.serialize(&mut data)?;

    let ix = Instruction {
        program_id: TXORACLE_PROGRAM_ID,
        accounts: vec![AccountMeta::new_readonly(*daily_scores_roots.key, false)],
        data,
    };

    invoke(&ix, &[daily_scores_roots.clone(), txoracle_program.clone()])?;

    let (program_id, ret) = get_return_data().ok_or(PocketFansError::OracleNoReturnData)?;
    require_keys_eq!(
        program_id,
        TXORACLE_PROGRAM_ID,
        PocketFansError::InvalidOracleProgram
    );
    let verdict = *ret.first().ok_or(PocketFansError::OracleNoReturnData)? != 0;
    Ok(verdict)
}

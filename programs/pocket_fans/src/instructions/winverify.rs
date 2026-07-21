//! Shared verification core for the `TeamWinVerified` trigger.
//!
//! Used by BOTH keeper-settled win instructions (`execute_rule_verified_win`,
//! `execute_rule_staked_verified_win`). It exists as one function rather than
//! two copies because this is the security boundary of the whole feature — a
//! drift between two hand-copied versions is exactly the bug that must never
//! happen here. (The swap/stake helpers below those instructions ARE duplicated,
//! matching the existing house style; those are settlement mechanics, not trust.)
//!
//! What it enforces, in order:
//!   1. the proof is for THIS rule's fixture (`fixture_id == rule.match_id`)
//!   2. exactly two stats, in the pinned order: [team, opponent]
//!   3. both stats carry `period == FULL_TIME_PERIOD` — the full-time pin
//!   4. the Txoracle `validate_stat_v2` CPI returns true for a strategy this
//!      program builds itself: `stats[0] - stats[1] > 0`
//!   5. the oracle's verdict AGREES with our own arithmetic over the same
//!      proven values (see the cross-check note below)
//!
//! Trust model is identical to execute_rule_verified.rs: no signer is trusted,
//! the CPI verdict is the gate, and the caller can supply neither the strategy
//! nor the stat keys.

use anchor_lang::prelude::*;

use crate::constants::FULL_TIME_PERIOD;
use crate::error::PocketFansError;
use crate::instructions::txoracle::{
    validate_stat_v2_cpi, BinaryExpression, Comparison, NDimensionalStrategy, StatPredicate,
    StatValidationInput, TraderPredicate,
};
use crate::state::{Rule, TriggerType};

/// The proven full-time scoreline, returned for logging by the callers.
pub struct ProvenWin {
    pub team_stat_key: u32,
    pub opponent_stat_key: u32,
    pub team_goals: i32,
    pub opponent_goals: i32,
}

pub fn verify_team_win<'info>(
    rule: &Rule,
    payload: StatValidationInput,
    daily_scores_roots: &AccountInfo<'info>,
    txoracle_program: &AccountInfo<'info>,
) -> Result<ProvenWin> {
    let (team_stat_key, opponent_stat_key) = match &rule.trigger_type {
        TriggerType::TeamWinVerified {
            team_stat_key,
            opponent_stat_key,
            ..
        } => (*team_stat_key, *opponent_stat_key),
        // TeamWin -> execute_rule / execute_rule_direct (self-claim, time-guarded)
        // GoalScored -> execute_rule_verified
        _ => return err!(PocketFansError::UnsupportedTrigger),
    };

    // 1) fixture pinning — a caller cannot substitute another match's proof.
    require!(
        payload.fixture_summary.fixture_id as u64 == rule.match_id,
        PocketFansError::WrongFixture
    );

    // 2) exactly two stats, in the pinned order [team, opponent]. The ORDER is
    //    what encodes home/away direction, so it is pinned as strictly as the
    //    keys themselves — swapping the two would invert the predicate.
    require!(payload.stats.len() == 2, PocketFansError::InvalidStatLayout);
    require!(
        payload.stats[0].stat.key == team_stat_key,
        PocketFansError::InvalidStatLayout
    );
    require!(
        payload.stats[1].stat.key == opponent_stat_key,
        PocketFansError::InvalidStatLayout
    );

    // 3) FULL-TIME PIN. Without this the trigger is unsound: a mid-match proof
    //    is equally valid cryptographically but proves a scoreline that can
    //    still change (verified on real data — see FULL_TIME_PERIOD's docs).
    require!(
        payload.stats[0].stat.period == FULL_TIME_PERIOD
            && payload.stats[1].stat.period == FULL_TIME_PERIOD,
        PocketFansError::NotFullTime
    );

    // Capture the proven values BEFORE the payload is moved into the CPI, so we
    // can cross-check the oracle's verdict against them below.
    let team_goals = payload.stats[0].stat.value;
    let opponent_goals = payload.stats[1].stat.value;

    // 4) Build the predicate ON-CHAIN — never trust a caller-supplied strategy.
    //    "team beat opponent" = stats[0] - stats[1] > 0. A draw gives 0 and a
    //    loss gives a negative, both of which fail GreaterThan(0).
    //
    //    NOTE ON SCOPE (v1): these are full-time goal stats, which include
    //    extra-time goals but NOT penalty-shootout goals. A tie broken only on
    //    penalties therefore proves 0 here and never fires — see the v1
    //    limitation documented on the instruction modules.
    let strategy = NDimensionalStrategy {
        geometric_targets: vec![],
        distance_predicate: None,
        discrete_predicates: vec![StatPredicate::Binary {
            index_a: 0,
            index_b: 1,
            op: BinaryExpression::Subtract,
            predicate: TraderPredicate {
                threshold: 0,
                comparison: Comparison::GreaterThan,
            },
        }],
    };

    let verdict = validate_stat_v2_cpi(daily_scores_roots, txoracle_program, payload, strategy)?;

    // 5) CROSS-CHECK. The oracle proved these exact values are committed to the
    //    on-chain Merkle root; we can therefore also compare them ourselves. If
    //    our arithmetic and the oracle's verdict ever disagree, our model of the
    //    oracle's Binary/Subtract semantics is wrong and we must NOT settle —
    //    fail closed with a distinctive error rather than move user funds on a
    //    predicate we do not actually understand. Costs two comparisons.
    let ours = team_goals > opponent_goals;
    require!(verdict == ours, PocketFansError::PredicateDisagreement);
    require!(ours, PocketFansError::NotAWin);

    Ok(ProvenWin {
        team_stat_key,
        opponent_stat_key,
        team_goals,
        opponent_goals,
    })
}

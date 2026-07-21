use anchor_lang::prelude::*;

// ===========================================================================
// UserVault
// ===========================================================================
/// One per user. Owns the token accounts (ATAs) that saved funds land in, and
/// is the SPL *delegate* that rules use to pull tokens from the user's wallet.
/// PDA seeds: ["vault", owner].
#[account]
#[derive(InitSpace)]
pub struct UserVault {
    /// The user's main wallet. The vault and everything it holds belong to them.
    pub owner: Pubkey,
    /// Monotonic counter used to derive the next rule_id. Ids are never reused,
    /// even after a rule is revoked.
    pub total_rules: u16,
    pub bump: u8,
    /// Forward-compat headroom (e.g. lifetime saved totals) so new fields can be
    /// added later without resizing existing vault accounts.
    pub reserved: [u8; 64],
}

// ===========================================================================
// Rule
// ===========================================================================
/// A user-defined automation: "when <trigger> happens, do <action>". Generic by
/// construction — new trigger/action variants can be added to the enums below
/// without migrating existing Rule accounts, because a Rule's trigger/action are
/// immutable after creation (only the counters/flag below change).
/// PDA seeds: ["rule", vault, rule_id.to_le_bytes()].
///
/// SELF-CLAIM MODEL (no oracle / no admin trigger): the match this rule is tied
/// to, and the timestamp after which it may be claimed, are fixed at creation
/// time (`create_rule`) from data the user picks in the UI (a specific TxLINE
/// fixture). `execute_rule` is later called by the rule's OWNER ONLY, gated by
/// a time guard (`match_end_ts`) — not by any oracle signature or admin key.
/// The match outcome itself is informational (shown in the UI); there is no
/// on-chain verification of who won, because there is no counterparty and no
/// possibility of loss — the user only ever moves their own USDC into their
/// own SOL vault.
#[account]
#[derive(InitSpace)]
pub struct Rule {
    /// The UserVault this rule belongs to.
    pub vault: Pubkey,
    /// Id used in the PDA seed; stored for convenient indexing.
    pub rule_id: u16,
    pub trigger_type: TriggerType,
    pub action_type: ActionType,
    /// TxLINE fixture id this rule is tied to. Fixed at create_rule; informational
    /// (shown in the UI) and used for the off-chain dedup/display layer only —
    /// NOT verified on-chain (see module doc above).
    pub match_id: u64,
    /// Unix timestamp (seconds). `execute_rule` requires
    /// Clock::unix_timestamp >= match_end_ts. Fixed at create_rule from the
    /// fixture's kickoff time + a buffer (see app/src/lib/constants.ts
    /// MATCH_END_BUFFER_SECS). Prevents claiming before the match has plausibly
    /// finished; it is NOT a result check.
    pub match_end_ts: i64,
    /// Max times this rule may execute. Bounds delegated exposure.
    pub max_executions: u16,
    pub executions_done: u16,
    pub is_active: bool,
    pub bump: u8,
    /// Forward-compat headroom.
    pub reserved: [u8; 24],
}

/// What match condition arms a rule.
///
/// GENERIC ENUM — add new variants below as new phases ship. Adding a variant
/// only affects newly created Rule accounts (they allocate for the larger enum);
/// existing rules keep their original size and content, so no data migration.
///
/// NOTE: the two variants below use DIFFERENT trust models, and each is executed
/// by its own dedicated instruction. Do not add a variant without deciding which
/// instruction claims it.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, PartialEq, Eq, Debug, InitSpace)]
pub enum TriggerType {
    /// SELF-CLAIM path (`execute_rule`): display/UX intent "claim after this
    /// team wins", gated purely by the on-chain time guard (`match_end_ts`) —
    /// no oracle involved. Unchanged since the self-claim migration.
    TeamWin { team_id: u32 },

    /// KEEPER + ORACLE path (`execute_rule_verified`): claimable by ANYONE
    /// (a permissionless keeper bot, or the owner themself as a manual
    /// fallback) the moment `stat_key`'s proven value reaches `threshold` —
    /// typically mid-match, not gated by any time window. Trust comes entirely
    /// from the Txoracle `validate_stat_v2` CPI verdict, never from the
    /// caller's identity. `stat_key` is resolved off-chain at create_rule time
    /// (1 = home goals, 2 = away goals, matching whichever side `team_id` plays
    /// for this specific match). `team_id` is kept only for display/audit; the
    /// on-chain predicate only ever checks `stat_key`, which is what is
    /// cryptographically proven.
    GoalScored {
        team_id: u32,
        stat_key: u32,
        threshold: u8,
    },
    /// KEEPER + ORACLE path (`execute_rule_verified_win` /
    /// `execute_rule_staked_verified_win`): "my team won at full time", proven
    /// rather than self-claimed. Same permissionless-caller + CPI-verdict trust
    /// model as GoalScored, but with a TWO-stat predicate and a full-time pin.
    ///
    /// Distinct from `TeamWin` above on purpose. TeamWin is the time-guarded
    /// self-claim variant and is untouched; a rule is one or the other for life.
    ///
    /// The two stat keys are resolved OFF-CHAIN at create_rule time from the
    /// fixture's home/away assignment (1 = home goals, 2 = away goals) and
    /// pinned here, so the on-chain predicate needs no notion of home/away:
    ///   `team_stat_key` value  -  `opponent_stat_key` value  >  0
    /// Direction is carried entirely by WHICH key sits in WHICH slot, so backing
    /// the away side is just the two keys swapped. `team_id` is display/audit
    /// only — never evaluated on-chain (same discipline as GoalScored).
    ///
    /// FULL-TIME PIN: both proven stats must carry `period == FULL_TIME_PERIOD`
    /// (100, the `game_finalised` status id). This is load-bearing security, not
    /// cosmetic — see the module docs on execute_rule_verified_win.rs.
    TeamWinVerified {
        team_id: u32,
        team_stat_key: u32,
        opponent_stat_key: u32,
    },
    // --- reserved for later phases ---
    // CornerKick { team_id: u32, stat_key: u32, threshold: u8 },
    // YellowCard { team_id: u32, stat_key: u32, threshold: u8 },
}

/// What the rule does when its trigger fires.
///
/// GENERIC ENUM — same forward-compat property as TriggerType.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, PartialEq, Eq, Debug, InitSpace)]
pub enum ActionType {
    /// Victory DCA: pull USDC from the user and swap it to `target_mint` (SOL),
    /// saving the result in the user's own vault. ONLY variant this phase.
    SwapAndSave {
        /// Amount pulled and swapped **per execution**, expressed in the **raw
        /// base units (smallest denomination) of the devUSDC mint** — i.e. this
        /// is NOT a human-readable USD amount. devUSDC has 6 decimals (verified
        /// on devnet), so 1_000_000 here == 1.00 devUSDC. The SPL `approve` in
        /// `create_rule` (= amount_usdc * max_executions), the delegated token
        /// pull in `execute_rule`, and the whirlpool swap input amount all use
        /// this exact same raw-unit value — no scaling/conversion anywhere.
        amount_usdc: u64,
        /// Output mint the USDC is swapped into (this phase: wSOL).
        target_mint: Pubkey,
        /// Max acceptable slippage in basis points (devnet default 1000-2000).
        max_slippage_bps: u16,
    },

    /// Victory DCA + auto-stake: same delegated USDC pull and Orca swap to wSOL
    /// as SwapAndSave, but the wSOL is then unwrapped to native SOL and deposited
    /// into Marinade liquid staking, so the vault receives mSOL (a yield-bearing
    /// SOL derivative) instead of plain wSOL. Executed ONLY by
    /// `execute_rule_staked` (TeamWin self-claim path). Output mint is always the
    /// Marinade mSOL mint, so there is no `target_mint` field.
    SwapStakeAndSave {
        /// Per-execution devUSDC pulled + swapped, in raw base units — identical
        /// semantics to SwapAndSave.amount_usdc.
        amount_usdc: u64,
        /// Max acceptable slippage in basis points for the USDC->wSOL swap.
        max_slippage_bps: u16,
    },
    // --- reserved for later phases ---
    // Stake { amount: u64, validator: Pubkey },
}

impl TriggerType {
    /// Human-readable team id this trigger targets — used by the UI only.
    /// (Never evaluated against an oracle-reported result on-chain: TeamWin is
    /// time-guarded, GoalScored is proven via `stat_key`, not via `team_id`.)
    pub fn team_id(&self) -> u32 {
        match self {
            TriggerType::TeamWin { team_id } => *team_id,
            TriggerType::GoalScored { team_id, .. } => *team_id,
            TriggerType::TeamWinVerified { team_id, .. } => *team_id,
        }
    }
}

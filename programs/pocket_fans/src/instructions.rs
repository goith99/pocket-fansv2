// Glob re-exports bring both the #[derive(Accounts)] context structs AND the
// anchor-generated `__client_accounts_*` / `__cpi_client_accounts_*` helper
// modules into scope, which `#[program]` in lib.rs requires. The only overlap
// is the per-module `handler` fn name; we call handlers via full module path,
// so the ambiguity is harmless and silenced here.
#![allow(ambiguous_glob_reexports)]

pub mod create_rule;
pub mod execute_rule;
pub mod execute_rule_direct;
pub mod execute_rule_staked;
pub mod execute_rule_staked_direct;
pub mod execute_rule_staked_verified_win;
pub mod execute_rule_verified;
pub mod execute_rule_verified_win;
pub mod initialize_vault;
pub mod revoke_rule;
/// Shared TeamWinVerified verification core (fixture/stat/full-time pinning +
/// the Txoracle CPI). Not glob re-exported: no #[derive(Accounts)] of its own,
/// consumed via `crate::instructions::winverify::verify_team_win`.
pub mod winverify;
/// Txoracle CPI interface. Not glob re-exported: it has no #[derive(Accounts)]
/// context of its own, and its types are consumed via the full path
/// `crate::instructions::txoracle::...`.
pub mod txoracle;
pub mod withdraw_from_vault;

pub use create_rule::*;
pub use execute_rule::*;
pub use execute_rule_direct::*;
pub use execute_rule_staked::*;
pub use execute_rule_staked_direct::*;
pub use execute_rule_staked_verified_win::*;
pub use execute_rule_verified::*;
pub use execute_rule_verified_win::*;
pub use initialize_vault::*;
pub use revoke_rule::*;
pub use withdraw_from_vault::*;

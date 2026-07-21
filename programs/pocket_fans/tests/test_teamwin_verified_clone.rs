//! TeamWinVerified end-to-end against the REAL Txoracle program cloned from
//! devnet, with REAL captured full-time proofs — plus the real Orca Whirlpool
//! and (for the staked variant) the real Marinade program.
//!
//! WHY THIS TEST IS THE POINT OF THE FEATURE, not a formality:
//!
//! The on-chain predicate is built from `StatPredicate::Binary { index_a,
//! index_b, op: Subtract, .. }`, and NOTHING in this repo defines what the
//! oracle actually computes for that — whether `Subtract` means
//! `stats[index_a] - stats[index_b]` or the reverse. Guessing wrong would make
//! every legitimate win fail closed (or, far worse, make a LOSS evaluate true).
//! The only way to know is to run the real program over a real proof, which is
//! exactly what this does.
//!
//! Fixtures are all from World Cup fixture 18257739 (captured 2026-07-21), which
//! finished 1-0 to the home side (participant 3021) after an extra-time goal:
//!   sv_18257739_win_home_ft.bin   keys [1,2] at the game_finalised seq 1385 ->
//!                                 k1=1 k2=0, period 100  (home backer: A WIN)
//!   sv_18257739_loss_away_ft.bin  keys [2,1] at the same seq -> k2=0 k1=1,
//!                                 period 100              (away backer: A LOSS)
//!   sv_18257739_midmatch_et.bin   keys [1,2] at seq 1261 -> k1=2 k2=0,
//!                                 period 9 (extra time)
//!
//! That mid-match fixture is deliberately the nastiest real case available: at
//! seq 1261 the proof says 2-0, but the match ENDED 1-0 because a goal was
//! disallowed by VAR. It is a perfectly valid Merkle proof of a scoreline that
//! never became final. If the full-time pin (`period == 100`) ever regresses,
//! this fixture settles a rule on a score that did not happen — which is why it
//! is committed rather than synthesised.
//!
//! Runs only in the NON-stub build (real CPIs).
#![cfg(not(feature = "stub-swap"))]

use anchor_lang::prelude::Pubkey;
use anchor_lang::solana_program::clock::Clock;
use anchor_lang::{
    solana_program::instruction::Instruction, solana_program::system_program, AccountDeserialize,
    AnchorDeserialize, InstructionData, ToAccountMetas,
};
use base64::Engine;
use litesvm::LiteSVM;
use solana_account::Account;
use solana_keypair::Keypair;
use solana_message::{Message, VersionedMessage};
use solana_signer::Signer;
use solana_transaction::versioned::VersionedTransaction;

use pocket_fans::instructions::txoracle::StatValidationInput;
use pocket_fans::{
    accounts as pf_accounts, instruction as pf_ix, ActionType, Rule, TriggerType, DEVUSDC_MINT,
    MARINADE_LIQ_POOL_MSOL_LEG, MARINADE_LIQ_POOL_MSOL_LEG_AUTHORITY, MARINADE_LIQ_POOL_SOL_LEG,
    MARINADE_MSOL_MINT_AUTHORITY, MARINADE_PROGRAM_ID, MARINADE_RESERVE, MARINADE_STATE, MSOL_MINT,
    RULE_SEED, SOL_DEVUSDC_WHIRLPOOL, STAKE_WSOL_SEED, TXORACLE_PROGRAM_ID, VAULT_SEED,
    VAULT_SOL_SEED, WHIRLPOOL_PROGRAM_ID, WSOL_MINT,
};

const TOKEN_ID: Pubkey = Pubkey::from_str_const("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");

// Real devnet Orca pool accounts (same fixtures as test_orca_clone).
const VAULT_A: Pubkey = Pubkey::from_str_const("C9zLV5zWF66j3rZj3uuhDqvfuA8esJyWnruGzDW9qEj2");
const VAULT_B: Pubkey = Pubkey::from_str_const("7DM3RMz2yzUB8yPRQM3FMZgdFrwZGMsabsfsKopWktoX");
const TICK0: Pubkey = Pubkey::from_str_const("7knZZ461yySGbSEHeBUwEpg3VtAkQy8B9tp78RGgyUHE");
const TICK1: Pubkey = Pubkey::from_str_const("CpoSFo3ajrizueggtJr2ZjvYgdtkgugXtvhqcwkyCkKP");
const POOL_ORACLE: Pubkey = Pubkey::from_str_const("2KEWNc3b6EfqoWQpfKQMHh4mhRyKXYRdPbtGRTJX3Cip");

/// Txoracle's `daily_scores_roots` PDA for the epoch day of these proofs
/// (min_timestamp 1784498864700 ms -> epoch day 20653). Cloned from devnet.
const DAILY_SCORES_ROOTS: Pubkey =
    Pubkey::from_str_const("9yjDecy1xmHSuP3fq4isJxLNrJjk7bigBySxPoYsox8c");

/// The fixture these proofs belong to; pinned into the rule as `match_id`.
const FIXTURE_ID: u64 = 18_257_739;
/// Home participant (won 1-0) and away participant, for readable rule team_ids.
const TEAM_HOME: u32 = 3021;
const TEAM_AWAY: u32 = 1489;
const KEY_HOME_GOALS: u32 = 1;
const KEY_AWAY_GOALS: u32 = 2;

/// Fixed secret-key seed for the fixture-dump owner. Any constant works; this
/// one only has to never change, or the committed fixtures shift.
const DUMP_OWNER_SEED: [u8; 32] = [7u8; 32];

const AMOUNT: u64 = 1_000_000; // 1.00 devUSDC
const MAX_EXEC: u16 = 3;
const START_USDC: u64 = 5_000_000;

/// Wall clock for the run. Later than the cloned whirlpool's
/// reward_last_updated_timestamp (Orca requires that) and after the match's
/// final whistle.
const NOW: i64 = 1_784_498_864 + 60;

fn fx(name: &str) -> String {
    format!("{}/tests/fixtures/{}", env!("CARGO_MANIFEST_DIR"), name)
}

fn load_fixture(svm: &mut LiteSVM, address: Pubkey, name: &str) {
    let s = std::fs::read_to_string(fx(name)).unwrap_or_else(|_| panic!("missing fixture {name}"));
    let j: serde_json::Value = serde_json::from_str(&s).unwrap();
    let acc = j.get("account").cloned().unwrap_or(j);
    let data = base64::engine::general_purpose::STANDARD
        .decode(acc["data"][0].as_str().unwrap())
        .unwrap();
    let owner: Pubkey = acc["owner"].as_str().unwrap().parse().unwrap();
    let lamports = acc["lamports"].as_u64().unwrap();
    svm.set_account(
        address,
        Account { lamports, data, owner, executable: false, rent_epoch: 0 },
    )
    .unwrap();
}

/// Load a borsh-encoded StatValidationInput fixture. These are produced from
/// live /api/scores/stat-validation responses by the same encoder the keeper
/// uses (oracle-service/src/statvalidation.cjs), so the bytes exercised here are
/// byte-identical to what the keeper will actually submit.
fn load_payload(name: &str) -> StatValidationInput {
    let bytes = std::fs::read(fx(name)).unwrap_or_else(|_| panic!("missing fixture {name}"));
    StatValidationInput::deserialize(&mut bytes.as_slice())
        .unwrap_or_else(|e| panic!("{name} failed to deserialize into StatValidationInput: {e:?}"))
}

fn pack_token(mint: &Pubkey, owner: &Pubkey, amount: u64, native_reserve: Option<u64>) -> Vec<u8> {
    let mut d = vec![0u8; 165];
    d[0..32].copy_from_slice(mint.as_ref());
    d[32..64].copy_from_slice(owner.as_ref());
    d[64..72].copy_from_slice(&amount.to_le_bytes());
    d[108] = 1; // Initialized
    if let Some(r) = native_reserve {
        d[109..113].copy_from_slice(&1u32.to_le_bytes());
        d[113..121].copy_from_slice(&r.to_le_bytes());
    }
    d
}

const RENT_165: u64 = 2_039_280;
fn set_token(
    svm: &mut LiteSVM,
    addr: Pubkey,
    mint: &Pubkey,
    owner: &Pubkey,
    amount: u64,
    native: Option<u64>,
) {
    let lamports = RENT_165 + native.unwrap_or(0);
    svm.set_account(
        addr,
        Account {
            lamports,
            data: pack_token(mint, owner, amount, native),
            owner: TOKEN_ID,
            executable: false,
            rent_epoch: 0,
        },
    )
    .unwrap();
}

fn ta_amount(svm: &LiteSVM, addr: &Pubkey) -> u64 {
    let a = svm.get_account(addr).unwrap();
    u64::from_le_bytes(a.data[64..72].try_into().unwrap())
}
fn lamports(svm: &LiteSVM, addr: &Pubkey) -> u64 {
    svm.get_account(addr).map(|a| a.lamports).unwrap_or(0)
}
fn load_rule(svm: &LiteSVM, addr: &Pubkey) -> Rule {
    let a = svm.get_account(addr).unwrap();
    Rule::try_deserialize(&mut a.data.as_slice()).unwrap()
}
fn send(
    svm: &mut LiteSVM,
    ix: Instruction,
    payer: &Keypair,
    signers: &[&Keypair],
) -> Result<(), String> {
    let bh = svm.latest_blockhash();
    let msg = Message::new_with_blockhash(&[ix], Some(&payer.pubkey()), &bh);
    let tx = VersionedTransaction::try_new(VersionedMessage::Legacy(msg), signers).unwrap();
    svm.send_transaction(tx)
        .map(|_| ())
        .map_err(|e| format!("{:?}", e.err))
}

/// ComputeBudget::SetComputeUnitLimit. Hand-rolled (discriminant 2 + u32 LE) so
/// this test needs no extra dependency.
///
/// NOT optional: `validate_stat_v2` walks several Merkle branches and blows
/// straight through the 200k default — the first run of this test failed with
/// ComputationalBudgetExceeded. The keeper prepends the same instruction
/// (VERIFY_COMPUTE_UNITS in oracle-service/src/statvalidation.cjs), so budgeting
/// here keeps the test faithful to what actually gets submitted.
const COMPUTE_BUDGET_ID: Pubkey =
    Pubkey::from_str_const("ComputeBudget111111111111111111111111111111");
const VERIFY_COMPUTE_UNITS: u32 = 1_400_000;

fn ix_compute_budget(units: u32) -> Instruction {
    let mut data = vec![2u8];
    data.extend_from_slice(&units.to_le_bytes());
    Instruction { program_id: COMPUTE_BUDGET_ID, accounts: vec![], data }
}

/// Send an oracle-verified instruction with the compute budget raised, exactly
/// as the keeper does.
fn send_verified(
    svm: &mut LiteSVM,
    ix: Instruction,
    payer: &Keypair,
    signers: &[&Keypair],
) -> Result<(), String> {
    let bh = svm.latest_blockhash();
    let msg = Message::new_with_blockhash(
        &[ix_compute_budget(VERIFY_COMPUTE_UNITS), ix],
        Some(&payer.pubkey()),
        &bh,
    );
    let tx = VersionedTransaction::try_new(VersionedMessage::Legacy(msg), signers).unwrap();
    svm.send_transaction(tx)
        .map(|_| ())
        .map_err(|e| format!("{:?}", e.err))
}

/// Everything a test needs after setup. `keeper` is deliberately NOT the owner —
/// the whole feature is that an unrelated permissionless caller can settle.
struct Ctx {
    svm: LiteSVM,
    program_id: Pubkey,
    owner: Keypair,
    keeper: Keypair,
    vault_pda: Pubkey,
    rule_pda: Pubkey,
    vault_sol_pda: Pubkey,
    stake_wsol_pda: Pubkey,
    owner_usdc: Pubkey,
    vault_usdc: Pubkey,
    owner_wsol: Pubkey,
    owner_msol: Pubkey,
}

/// Boot LiteSVM with all three real programs + a rule pinned to `trigger`.
/// Random owner: each test gets an isolated, independent wallet.
fn setup(trigger: TriggerType, action: ActionType, match_id: u64) -> Ctx {
    setup_with_owner(trigger, action, match_id, Keypair::new())
}

/// As `setup`, but with a caller-chosen owner.
///
/// Exists for the fixture dump below, which MUST be deterministic: a Rule's
/// bytes embed the vault PDA (offset 8..40) and its bump, both derived from the
/// owner. With a random owner every `cargo test` rewrote the committed fixtures
/// and left the working tree dirty, which also destroys their value as a drift
/// signal — real layout changes would be lost in the noise.
fn setup_with_owner(
    trigger: TriggerType,
    action: ActionType,
    match_id: u64,
    owner: Keypair,
) -> Ctx {
    let mut svm = LiteSVM::new().with_blockhash_check(false);
    svm.set_sysvar(&Clock {
        slot: 1,
        epoch_start_timestamp: NOW,
        epoch: 0,
        leader_schedule_epoch: 0,
        unix_timestamp: NOW,
    });

    // Real Orca program + cloned pool accounts.
    let orca = std::fs::read(fx("whirlpool_program.so")).unwrap();
    svm.add_program(WHIRLPOOL_PROGRAM_ID, &orca).unwrap();
    load_fixture(&mut svm, SOL_DEVUSDC_WHIRLPOOL, "whirlpool.json");
    load_fixture(&mut svm, VAULT_A, "vault_a.json");
    load_fixture(&mut svm, VAULT_B, "vault_b.json");
    load_fixture(&mut svm, TICK0, "tick_array_0.json");
    load_fixture(&mut svm, TICK1, "tick_array_1.json");
    load_fixture(&mut svm, WSOL_MINT, "wsol_mint.json");
    load_fixture(&mut svm, DEVUSDC_MINT, "devusdc_mint.json");

    // Real Marinade program + cloned accounts (only used by the staked test, but
    // loading them unconditionally keeps one setup path).
    let mar = std::fs::read(fx("marinade_program.so")).unwrap();
    svm.add_program(MARINADE_PROGRAM_ID, &mar).unwrap();
    load_fixture(&mut svm, MARINADE_STATE, "marinade_state.json");
    load_fixture(&mut svm, MSOL_MINT, "msol_mint.json");
    load_fixture(&mut svm, MARINADE_RESERVE, "marinade_reserve.json");
    load_fixture(&mut svm, MARINADE_LIQ_POOL_SOL_LEG, "marinade_liq_sol_leg.json");
    load_fixture(&mut svm, MARINADE_LIQ_POOL_MSOL_LEG, "marinade_liq_msol_leg.json");
    load_fixture(
        &mut svm,
        MARINADE_LIQ_POOL_MSOL_LEG_AUTHORITY,
        "marinade_liq_msol_leg_authority.json",
    );
    load_fixture(
        &mut svm,
        MARINADE_MSOL_MINT_AUTHORITY,
        "marinade_msol_mint_authority.json",
    );

    // REAL Txoracle program + the REAL daily_scores_roots account these proofs
    // are committed to. Nothing about the oracle is mocked.
    let txo = std::fs::read(fx("txoracle_program.so")).unwrap();
    svm.add_program(TXORACLE_PROGRAM_ID, &txo).unwrap();
    load_fixture(&mut svm, DAILY_SCORES_ROOTS, "daily_scores_roots.json");

    // Our program (NON-stub build).
    let program_id = pocket_fans::id();
    let so = std::fs::read(format!(
        "{}/../../target/deploy/pocket_fans.so",
        env!("CARGO_MANIFEST_DIR")
    ))
    .unwrap();
    svm.add_program(program_id, &so).unwrap();

    let keeper = Keypair::new();
    svm.airdrop(&owner.pubkey(), 10_000_000_000).unwrap();
    svm.airdrop(&keeper.pubkey(), 10_000_000_000).unwrap();

    let (vault_pda, _) =
        Pubkey::find_program_address(&[VAULT_SEED, owner.pubkey().as_ref()], &program_id);
    let (rule_pda, _) = Pubkey::find_program_address(
        &[RULE_SEED, vault_pda.as_ref(), &0u16.to_le_bytes()],
        &program_id,
    );
    let (vault_sol_pda, _) =
        Pubkey::find_program_address(&[VAULT_SOL_SEED, owner.pubkey().as_ref()], &program_id);
    let (stake_wsol_pda, _) = Pubkey::find_program_address(
        &[STAKE_WSOL_SEED, owner.pubkey().as_ref(), &0u16.to_le_bytes()],
        &program_id,
    );

    let owner_usdc = Keypair::new().pubkey();
    let vault_usdc = Keypair::new().pubkey();
    let owner_wsol = Keypair::new().pubkey();
    let owner_msol = Keypair::new().pubkey();
    set_token(&mut svm, owner_usdc, &DEVUSDC_MINT, &owner.pubkey(), START_USDC, None);
    set_token(&mut svm, vault_usdc, &DEVUSDC_MINT, &vault_pda, 0, None);
    set_token(&mut svm, owner_wsol, &WSOL_MINT, &owner.pubkey(), 0, Some(0));
    set_token(&mut svm, owner_msol, &MSOL_MINT, &owner.pubkey(), 0, None);

    let ix = Instruction {
        program_id,
        accounts: pf_accounts::InitializeVault {
            owner: owner.pubkey(),
            vault: vault_pda,
            system_program: system_program::ID,
        }
        .to_account_metas(None),
        data: pf_ix::InitializeVault {}.data(),
    };
    send(&mut svm, ix, &owner, &[&owner]).expect("init vault");

    let ix = Instruction {
        program_id,
        accounts: pf_accounts::CreateRule {
            owner: owner.pubkey(),
            vault: vault_pda,
            rule: rule_pda,
            usdc_mint: DEVUSDC_MINT,
            owner_usdc_ata: owner_usdc,
            token_program: TOKEN_ID,
            system_program: system_program::ID,
        }
        .to_account_metas(None),
        data: pf_ix::CreateRule {
            trigger_type: trigger,
            action_type: action,
            max_executions: MAX_EXEC,
            match_id,
            // Deliberately in the FUTURE. The verified-win path has no time
            // guard by design — the proven full-time period is a stronger and
            // more precise signal than a wall-clock buffer — so a rule whose
            // match_end_ts has not yet passed must still settle. If someone
            // later adds a time guard, this test fails and says so.
            match_end_ts: NOW + 3600,
        }
        .data(),
    };
    send(&mut svm, ix, &owner, &[&owner]).expect("create rule");

    Ctx {
        svm,
        program_id,
        owner,
        keeper,
        vault_pda,
        rule_pda,
        vault_sol_pda,
        stake_wsol_pda,
        owner_usdc,
        vault_usdc,
        owner_wsol,
        owner_msol,
    }
}

fn win_trigger() -> TriggerType {
    TriggerType::TeamWinVerified {
        team_id: TEAM_HOME,
        team_stat_key: KEY_HOME_GOALS,
        opponent_stat_key: KEY_AWAY_GOALS,
    }
}
fn swap_action() -> ActionType {
    ActionType::SwapAndSave {
        amount_usdc: AMOUNT,
        target_mint: WSOL_MINT,
        max_slippage_bps: 1500,
    }
}

/// Build the execute_rule_verified_win instruction for a given payload.
fn ix_win(c: &Ctx, payload: StatValidationInput) -> Instruction {
    Instruction {
        program_id: c.program_id,
        accounts: pf_accounts::ExecuteRuleVerifiedWin {
            caller: c.keeper.pubkey(),
            vault: c.vault_pda,
            rule: c.rule_pda,
            usdc_mint: DEVUSDC_MINT,
            wsol_mint: WSOL_MINT,
            owner_usdc_ata: c.owner_usdc,
            vault_usdc_ata: c.vault_usdc,
            owner_wsol_ata: c.owner_wsol,
            whirlpool: SOL_DEVUSDC_WHIRLPOOL,
            whirlpool_token_vault_a: VAULT_A,
            whirlpool_token_vault_b: VAULT_B,
            tick_array_0: TICK0,
            tick_array_1: TICK1,
            tick_array_2: TICK0,
            whirlpool_oracle: POOL_ORACLE,
            whirlpool_program: WHIRLPOOL_PROGRAM_ID,
            daily_scores_roots: DAILY_SCORES_ROOTS,
            txoracle_program: TXORACLE_PROGRAM_ID,
            token_program: TOKEN_ID,
        }
        .to_account_metas(None),
        data: pf_ix::ExecuteRuleVerifiedWin { rule_id: 0, payload }.data(),
    }
}

// ===========================================================================
// 1. THE ONE THAT SETTLES THE SEMANTICS: a real win, settled by a stranger.
// ===========================================================================
#[test]
fn teamwin_verified_settles_a_real_win_direct_to_owner() {
    let mut c = setup(win_trigger(), swap_action(), FIXTURE_ID);

    // Sanity-check the fixture is what we claim before relying on the result.
    let p = load_payload("sv_18257739_win_home_ft.bin");
    assert_eq!(p.fixture_summary.fixture_id as u64, FIXTURE_ID);
    assert_eq!(p.stats.len(), 2);
    assert_eq!(p.stats[0].stat.key, KEY_HOME_GOALS);
    assert_eq!(p.stats[1].stat.key, KEY_AWAY_GOALS);
    assert_eq!(p.stats[0].stat.value, 1, "home scored 1");
    assert_eq!(p.stats[1].stat.value, 0, "away scored 0");
    assert_eq!(p.stats[0].stat.period, 100, "full-time period");

    let ix = ix_win(&c, p);
    let res = send_verified(&mut c.svm, ix, &c.keeper, &[&c.keeper]);
    assert!(
        res.is_ok(),
        "a proven full-time WIN must settle via the real Txoracle CPI. \
         If this fails with PredicateDisagreement, the oracle's Binary/Subtract \
         semantics are the reverse of what winverify.rs assumes. Got: {res:?}"
    );

    let owner_usdc_after = ta_amount(&c.svm, &c.owner_usdc);
    let vault_usdc_after = ta_amount(&c.svm, &c.vault_usdc);
    let owner_wsol_after = ta_amount(&c.svm, &c.owner_wsol);

    println!("owner_usdc: {START_USDC} -> {owner_usdc_after}");
    println!("vault_usdc (post-swap): {vault_usdc_after}");
    println!("owner wSOL received DIRECTLY: {owner_wsol_after}");

    assert_eq!(owner_usdc_after, START_USDC - AMOUNT, "AMOUNT pulled from owner");
    assert_eq!(vault_usdc_after, 0, "all pulled devUSDC swapped out of the vault");
    assert!(
        owner_wsol_after > 0,
        "swap output must land in the OWNER's wSOL ATA (zero-dust direct settlement)"
    );
    assert_eq!(load_rule(&c.svm, &c.rule_pda).executions_done, 1);

    println!(
        "WIN OK: keeper {} settled {} raw wSOL (~{} SOL) straight into the owner's wallet — \
         owner signed nothing.",
        c.keeper.pubkey(),
        owner_wsol_after,
        owner_wsol_after as f64 / 1e9
    );
}

// ===========================================================================
// 2. A LOSS must not settle. Same match, same seq — the away backer.
// ===========================================================================
#[test]
fn teamwin_verified_rejects_a_loss() {
    let mut c = setup(
        TriggerType::TeamWinVerified {
            team_id: TEAM_AWAY,
            team_stat_key: KEY_AWAY_GOALS,
            opponent_stat_key: KEY_HOME_GOALS,
        },
        swap_action(),
        FIXTURE_ID,
    );

    let p = load_payload("sv_18257739_loss_away_ft.bin");
    // The keeper requests keys in the rule's pinned order, so the away side is
    // stats[0]. It lost 0-1.
    assert_eq!(p.stats[0].stat.key, KEY_AWAY_GOALS);
    assert_eq!(p.stats[0].stat.value, 0);
    assert_eq!(p.stats[1].stat.value, 1);

    let ix = ix_win(&c, p);
    let res = send_verified(&mut c.svm, ix, &c.keeper, &[&c.keeper]);
    assert!(res.is_err(), "a proven LOSS must never settle, got Ok");
    println!("LOSS correctly rejected: {}", res.unwrap_err());

    assert_eq!(ta_amount(&c.svm, &c.owner_usdc), START_USDC, "no USDC moved");
    assert_eq!(ta_amount(&c.svm, &c.owner_wsol), 0, "no wSOL settled");
    assert_eq!(load_rule(&c.svm, &c.rule_pda).executions_done, 0);
}

// ===========================================================================
// 3. THE CRITICAL GUARD: a valid MID-MATCH proof of a score that never became
//    final must be refused.
// ===========================================================================
#[test]
fn teamwin_verified_rejects_a_valid_midmatch_proof() {
    let mut c = setup(win_trigger(), swap_action(), FIXTURE_ID);

    let p = load_payload("sv_18257739_midmatch_et.bin");
    // This proof is cryptographically fine and shows the backed team AHEAD by
    // two — a bigger lead than the final score. It is simply not full time.
    assert_eq!(p.stats[0].stat.value, 2, "mid-match proof claims 2 goals");
    assert_eq!(p.stats[1].stat.value, 0);
    assert_eq!(p.stats[0].stat.period, 9, "extra time, NOT full time");

    let ix = ix_win(&c, p);
    let res = send_verified(&mut c.svm, ix, &c.keeper, &[&c.keeper]);
    assert!(
        res.is_err(),
        "a mid-match proof must be refused even though the backed team is ahead \
         in it — the score can still change (this one did: 2-0 became 1-0 on VAR)"
    );
    let e = res.unwrap_err();
    assert!(
        e.contains("NotFullTime") || e.contains("6026"),
        "expected NotFullTime, got: {e}"
    );
    println!("MID-MATCH correctly rejected: {e}");
    assert_eq!(ta_amount(&c.svm, &c.owner_usdc), START_USDC, "no USDC moved");
    assert_eq!(load_rule(&c.svm, &c.rule_pda).executions_done, 0);
}

// ===========================================================================
// 4. Fixture pinning: a valid proof for a DIFFERENT match must be refused.
// ===========================================================================
#[test]
fn teamwin_verified_rejects_another_fixtures_proof() {
    // Rule is pinned to a different match than the proof belongs to.
    let mut c = setup(win_trigger(), swap_action(), FIXTURE_ID + 1);

    let ix = ix_win(&c, load_payload("sv_18257739_win_home_ft.bin"));
    let res = send_verified(&mut c.svm, ix, &c.keeper, &[&c.keeper]);
    assert!(res.is_err(), "proof for another fixture must be refused");
    println!("WRONG FIXTURE correctly rejected: {}", res.unwrap_err());
    assert_eq!(load_rule(&c.svm, &c.rule_pda).executions_done, 0);
}

// ===========================================================================
// 5. Stat ORDER is what encodes home/away direction, so it is pinned too.
//    Feeding the away-first proof to a home-backing rule must be refused.
// ===========================================================================
#[test]
fn teamwin_verified_rejects_swapped_stat_order() {
    let mut c = setup(win_trigger(), swap_action(), FIXTURE_ID);

    // Home-backing rule, but the payload has away goals in slot 0. Were the
    // order not pinned, this would evaluate 0 - 1 and simply fail; pinning makes
    // it an explicit, diagnosable rejection instead.
    let ix = ix_win(&c, load_payload("sv_18257739_loss_away_ft.bin"));
    let res = send_verified(&mut c.svm, ix, &c.keeper, &[&c.keeper]);
    assert!(res.is_err(), "swapped stat order must be refused");
    println!("SWAPPED ORDER correctly rejected: {}", res.unwrap_err());
    assert_eq!(load_rule(&c.svm, &c.rule_pda).executions_done, 0);
}

// ===========================================================================
// 6. The Auto Stake twin: mSOL settles to the owner, rent refunds to the keeper.
// ===========================================================================
#[test]
fn teamwin_verified_staked_settles_msol_to_owner_and_refunds_keeper() {
    let mut c = setup(
        win_trigger(),
        ActionType::SwapStakeAndSave { amount_usdc: AMOUNT, max_slippage_bps: 1500 },
        FIXTURE_ID,
    );

    let keeper_before = lamports(&c.svm, &c.keeper.pubkey());
    let owner_before = lamports(&c.svm, &c.owner.pubkey());

    let ix = Instruction {
        program_id: c.program_id,
        accounts: pf_accounts::ExecuteRuleStakedVerifiedWin {
            caller: c.keeper.pubkey(),
            vault: c.vault_pda,
            rule: c.rule_pda,
            usdc_mint: DEVUSDC_MINT,
            wsol_mint: WSOL_MINT,
            msol_mint: MSOL_MINT,
            owner_usdc_ata: c.owner_usdc,
            vault_usdc_ata: c.vault_usdc,
            stake_wsol: c.stake_wsol_pda,
            vault_sol: c.vault_sol_pda,
            owner_msol_ata: c.owner_msol,
            whirlpool: SOL_DEVUSDC_WHIRLPOOL,
            whirlpool_token_vault_a: VAULT_A,
            whirlpool_token_vault_b: VAULT_B,
            tick_array_0: TICK0,
            tick_array_1: TICK1,
            tick_array_2: TICK0,
            whirlpool_oracle: POOL_ORACLE,
            whirlpool_program: WHIRLPOOL_PROGRAM_ID,
            marinade_state: MARINADE_STATE,
            marinade_liq_pool_sol_leg: MARINADE_LIQ_POOL_SOL_LEG,
            marinade_liq_pool_msol_leg: MARINADE_LIQ_POOL_MSOL_LEG,
            marinade_liq_pool_msol_leg_authority: MARINADE_LIQ_POOL_MSOL_LEG_AUTHORITY,
            marinade_reserve: MARINADE_RESERVE,
            marinade_msol_mint_authority: MARINADE_MSOL_MINT_AUTHORITY,
            marinade_program: MARINADE_PROGRAM_ID,
            daily_scores_roots: DAILY_SCORES_ROOTS,
            txoracle_program: TXORACLE_PROGRAM_ID,
            token_program: TOKEN_ID,
            system_program: system_program::ID,
        }
        .to_account_metas(None),
        data: pf_ix::ExecuteRuleStakedVerifiedWin {
            rule_id: 0,
            payload: load_payload("sv_18257739_win_home_ft.bin"),
        }
        .data(),
    };

    let res = send_verified(&mut c.svm, ix, &c.keeper, &[&c.keeper]);
    assert!(res.is_ok(), "staked verified win must settle, got: {res:?}");

    let owner_msol_after = ta_amount(&c.svm, &c.owner_msol);
    let keeper_after = lamports(&c.svm, &c.keeper.pubkey());
    let owner_after = lamports(&c.svm, &c.owner.pubkey());
    let stake_wsol_exists = c
        .svm
        .get_account(&c.stake_wsol_pda)
        .map(|a| !a.data.is_empty() && a.lamports > 0)
        .unwrap_or(false);

    println!("owner mSOL received DIRECTLY: {owner_msol_after}");
    println!("keeper lamports: {keeper_before} -> {keeper_after}");
    println!("owner  lamports: {owner_before} -> {owner_after}");

    assert!(owner_msol_after > 0, "owner must receive mSOL directly");
    assert!(!stake_wsol_exists, "ephemeral stake_wsol must be closed");
    assert_eq!(lamports(&c.svm, &c.vault_sol_pda), 0, "vault_sol drained");
    assert_eq!(
        owner_after, owner_before,
        "owner pays NOTHING — no fee, no rent; they signed nothing"
    );
    // The keeper pays the tx fee but must get the stake_wsol rent back, or every
    // execution would bleed it ~0.002 SOL of someone else's money.
    assert!(
        keeper_before - keeper_after < RENT_165,
        "keeper must be refunded the stake_wsol rent (net cost {} lamports should be tx fee only)",
        keeper_before - keeper_after
    );
    assert_eq!(load_rule(&c.svm, &c.rule_pda).executions_done, 1);

    println!(
        "STAKED WIN OK: keeper settled {} raw mSOL (~{} mSOL) into the owner's wallet, \
         net keeper cost {} lamports (tx fee only).",
        owner_msol_after,
        owner_msol_after as f64 / 1e9,
        keeper_before - keeper_after
    );
}

// ===========================================================================
// 7. Dump real on-chain Rule bytes for BOTH action variants so the browser
//    decoder can be checked against them.
//
//    decodeRule() in app/src/lib/pf.ts walks variable-length borsh enums by
//    hand, and adding a third TriggerType shifts every field after it. It also
//    hard-rejects unknown trigger tags, so getting this wrong makes the rule
//    INVISIBLE in the UI rather than merely mis-rendered. These dumps give the
//    JS side real bytes to assert against instead of a hand-built buffer.
// ===========================================================================
#[test]
fn dump_teamwin_verified_rule_bytes_for_the_browser_decoder() {
    for (label, action) in [
        ("swap", swap_action()),
        (
            "stake",
            ActionType::SwapStakeAndSave { amount_usdc: AMOUNT, max_slippage_bps: 1500 },
        ),
    ] {
        // Fixed owner => byte-identical fixtures on every run.
        let c = setup_with_owner(
            win_trigger(),
            action,
            FIXTURE_ID,
            Keypair::new_from_array(DUMP_OWNER_SEED),
        );
        let data = c.svm.get_account(&c.rule_pda).unwrap().data;
        // Written into tests/fixtures/ (committed) rather than target/, so the
        // keeper-wiring check can read them without depending on which test
        // binary ran first. Regenerated on every run, so drift shows up in git.
        let path = format!(
            "{}/tests/fixtures/rule_teamwin_verified_{label}.bin",
            env!("CARGO_MANIFEST_DIR")
        );
        std::fs::write(&path, &data).unwrap();
        println!("{label}: {} bytes -> {path}", data.len());
        // Sanity: tag 2 at offset 42, then team_id, team_stat_key, opponent_stat_key.
        assert_eq!(data[42], 2, "TeamWinVerified tag");
        assert_eq!(u32::from_le_bytes(data[43..47].try_into().unwrap()), TEAM_HOME);
        assert_eq!(u32::from_le_bytes(data[47..51].try_into().unwrap()), KEY_HOME_GOALS);
        assert_eq!(u32::from_le_bytes(data[51..55].try_into().unwrap()), KEY_AWAY_GOALS);
        assert_eq!(data[55], if label == "stake" { 1 } else { 0 }, "action tag at 55");
    }
}

// ===========================================================================
// 8. MANUAL FALLBACK — the OWNER settles their own rule, and the result is
//    indistinguishable from the keeper doing it.
//
//    This is what makes the "Settle now" button in the app safe to offer: the
//    program trusts NO signer identity, so `caller` being the owner rather than
//    an unrelated keeper changes nothing about the verification or the payout.
//    Asserted by running the SAME settlement two ways and comparing the
//    resulting on-chain state field by field, rather than by assuming it.
// ===========================================================================
#[test]
fn manual_owner_settlement_is_equivalent_to_keeper_settlement() {
    // Returns the observable end state of a settlement.
    fn settle(as_owner: bool) -> (u64, u64, u64, u16) {
        let mut c = setup(win_trigger(), swap_action(), FIXTURE_ID);
        let caller = if as_owner { c.owner.insecure_clone() } else { c.keeper.insecure_clone() };

        let mut ix = ix_win(&c, load_payload("sv_18257739_win_home_ft.bin"));
        // Slot 0 is `caller`. Swapping it is the ONLY difference between the
        // keeper path and the manual path.
        ix.accounts[0].pubkey = caller.pubkey();

        let res = send_verified(&mut c.svm, ix, &caller, &[&caller]);
        assert!(
            res.is_ok(),
            "settlement must succeed with caller = {} — got {res:?}",
            if as_owner { "OWNER (manual fallback)" } else { "keeper" },
        );
        (
            ta_amount(&c.svm, &c.owner_usdc),
            ta_amount(&c.svm, &c.vault_usdc),
            ta_amount(&c.svm, &c.owner_wsol),
            load_rule(&c.svm, &c.rule_pda).executions_done,
        )
    }

    let by_keeper = settle(false);
    let by_owner = settle(true);

    println!("keeper-signed: owner_usdc={} vault_usdc={} owner_wsol={} executions={}", by_keeper.0, by_keeper.1, by_keeper.2, by_keeper.3);
    println!("owner-signed : owner_usdc={} vault_usdc={} owner_wsol={} executions={}", by_owner.0, by_owner.1, by_owner.2, by_owner.3);

    assert_eq!(by_owner, by_keeper, "manual and keeper settlement must leave IDENTICAL on-chain state");
    assert!(by_owner.2 > 0, "owner received the swap output in both cases");
    assert_eq!(by_owner.3, 1, "executions_done incremented exactly once");
    println!("EQUIVALENT: owner-signed settlement == keeper-signed settlement, byte for byte");
}

// ===========================================================================
// 9. The manual path's server route is UNTRUSTED — prove it.
//
//    The browser derives `daily_scores_roots` from the payload the server
//    returned. If that account could be substituted, a malicious server could
//    point verification at a root it controls and forge a win. It cannot: the
//    account is consumed by the Txoracle program, which owns and validates it.
//    Asserted here by handing the instruction an attacker-created account in
//    that slot and confirming settlement fails.
// ===========================================================================
#[test]
fn settlement_rejects_a_substituted_oracle_roots_account() {
    let mut c = setup(win_trigger(), swap_action(), FIXTURE_ID);

    // An account the "server" fully controls: right size, wrong owner.
    let forged = Pubkey::new_unique();
    let real = c.svm.get_account(&DAILY_SCORES_ROOTS).unwrap();
    c.svm
        .set_account(
            forged,
            Account {
                lamports: real.lamports,
                data: real.data.clone(), // even with the REAL bytes copied in
                owner: Pubkey::new_unique(), // but not owned by Txoracle
                executable: false,
                rent_epoch: 0,
            },
        )
        .unwrap();

    let mut ix = ix_win(&c, load_payload("sv_18257739_win_home_ft.bin"));
    // Slot 16 is daily_scores_roots (see ExecuteRuleVerifiedWin's account order).
    assert_eq!(ix.accounts[16].pubkey, DAILY_SCORES_ROOTS, "slot 16 must be daily_scores_roots");
    ix.accounts[16].pubkey = forged;

    let res = send_verified(&mut c.svm, ix, &c.keeper, &[&c.keeper]);
    assert!(
        res.is_err(),
        "a substituted daily_scores_roots must NOT settle — if this passes, the oracle root is not \
         actually anchoring verification and the manual path's server WOULD be trust-bearing",
    );
    println!("SUBSTITUTED ROOTS correctly rejected: {}", res.unwrap_err());
    assert_eq!(ta_amount(&c.svm, &c.owner_usdc), START_USDC, "no USDC moved");
    assert_eq!(load_rule(&c.svm, &c.rule_pda).executions_done, 0);
}

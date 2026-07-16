//! Approach (a) for SwapStakeAndSave: run execute_rule_staked end-to-end against
//! the REAL Orca Whirlpool program AND the REAL Marinade liquid-staking program,
//! both cloned from devnet (2026-07-15), in LiteSVM. This exercises the actual
//! Marinade `deposit` CPI at runtime — account order, discriminator, arg layout,
//! the wSOL unwrap, and that mSOL actually settles into the user's vault — not
//! just compile/shape checks.
//!
//! Flow proven: init_vault -> create_rule(SwapStakeAndSave, TeamWin) -> advance
//! clock past match_end_ts -> execute_rule_staked: delegated USDC pull -> real
//! Orca swap USDC->wSOL into the ephemeral stake_wsol -> close/unwrap to native
//! SOL in vault_sol -> real Marinade deposit -> mSOL minted into vault_msol_ata.
//!
//! Runs only in the NON-stub build (real CPIs). Marinade + Orca accounts and both
//! programs are dumped into tests/fixtures/.
#![cfg(not(feature = "stub-swap"))]

use anchor_lang::prelude::Pubkey;
use anchor_lang::solana_program::clock::Clock;
use anchor_lang::{
    solana_program::instruction::Instruction, solana_program::system_program, AccountDeserialize,
    InstructionData, ToAccountMetas,
};
use base64::Engine;
use litesvm::LiteSVM;
use solana_account::Account;
use solana_keypair::Keypair;
use solana_message::{Message, VersionedMessage};
use solana_signer::Signer;
use solana_transaction::versioned::VersionedTransaction;

use pocket_fans::{
    accounts as pf_accounts, instruction as pf_ix, ActionType, Rule, TriggerType, DEVUSDC_MINT,
    MARINADE_LIQ_POOL_MSOL_LEG, MARINADE_LIQ_POOL_MSOL_LEG_AUTHORITY, MARINADE_LIQ_POOL_SOL_LEG,
    MARINADE_MSOL_MINT_AUTHORITY, MARINADE_PROGRAM_ID, MARINADE_RESERVE, MARINADE_STATE, MSOL_MINT,
    RULE_SEED, SOL_DEVUSDC_WHIRLPOOL, STAKE_WSOL_SEED, VAULT_SEED, VAULT_SOL_SEED,
    WHIRLPOOL_PROGRAM_ID, WSOL_MINT,
};

const TOKEN_ID: Pubkey = Pubkey::from_str_const("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");

// Real devnet Orca pool accounts (cloned into fixtures; same as test_orca_clone).
const VAULT_A: Pubkey = Pubkey::from_str_const("C9zLV5zWF66j3rZj3uuhDqvfuA8esJyWnruGzDW9qEj2");
const VAULT_B: Pubkey = Pubkey::from_str_const("7DM3RMz2yzUB8yPRQM3FMZgdFrwZGMsabsfsKopWktoX");
const TICK0: Pubkey = Pubkey::from_str_const("7knZZ461yySGbSEHeBUwEpg3VtAkQy8B9tp78RGgyUHE");
const TICK1: Pubkey = Pubkey::from_str_const("CpoSFo3ajrizueggtJr2ZjvYgdtkgugXtvhqcwkyCkKP");
const POOL_ORACLE: Pubkey = Pubkey::from_str_const("2KEWNc3b6EfqoWQpfKQMHh4mhRyKXYRdPbtGRTJX3Cip");

const AMOUNT: u64 = 1_000_000; // 1.00 devUSDC
const MAX_EXEC: u16 = 3;

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
    svm.set_account(address, Account { lamports, data, owner, executable: false, rent_epoch: 0 })
        .unwrap();
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
fn set_token(svm: &mut LiteSVM, addr: Pubkey, mint: &Pubkey, owner: &Pubkey, amount: u64, native: Option<u64>) {
    let lamports = RENT_165 + native.unwrap_or(0);
    svm.set_account(
        addr,
        Account { lamports, data: pack_token(mint, owner, amount, native), owner: TOKEN_ID, executable: false, rent_epoch: 0 },
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
fn send(svm: &mut LiteSVM, ix: Instruction, payer: &Keypair, signers: &[&Keypair]) -> Result<(), String> {
    let bh = svm.latest_blockhash();
    let msg = Message::new_with_blockhash(&[ix], Some(&payer.pubkey()), &bh);
    let tx = VersionedTransaction::try_new(VersionedMessage::Legacy(msg), signers).unwrap();
    svm.send_transaction(tx).map(|_| ()).map_err(|e| format!("{:?}", e.err))
}

#[test]
fn test_swap_stake_and_save_against_cloned_marinade() {
    let mut svm = LiteSVM::new().with_blockhash_check(false);

    // Same clock constraint as test_orca_clone (the cloned whirlpool's
    // reward_last_updated_timestamp). Marinade deposit tolerates this timestamp.
    let ts: i64 = 1_783_241_318 + 30;
    let match_end_ts: i64 = ts - 10;
    svm.set_sysvar(&Clock {
        slot: 1,
        epoch_start_timestamp: ts,
        epoch: 0,
        leader_schedule_epoch: 0,
        unix_timestamp: match_end_ts - 3600,
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

    // Real Marinade program + cloned accounts.
    let mar = std::fs::read(fx("marinade_program.so")).unwrap();
    svm.add_program(MARINADE_PROGRAM_ID, &mar).unwrap();
    load_fixture(&mut svm, MARINADE_STATE, "marinade_state.json");
    load_fixture(&mut svm, MSOL_MINT, "msol_mint.json");
    load_fixture(&mut svm, MARINADE_RESERVE, "marinade_reserve.json");
    load_fixture(&mut svm, MARINADE_LIQ_POOL_SOL_LEG, "marinade_liq_sol_leg.json");
    load_fixture(&mut svm, MARINADE_LIQ_POOL_MSOL_LEG, "marinade_liq_msol_leg.json");
    load_fixture(&mut svm, MARINADE_LIQ_POOL_MSOL_LEG_AUTHORITY, "marinade_liq_msol_leg_authority.json");
    load_fixture(&mut svm, MARINADE_MSOL_MINT_AUTHORITY, "marinade_msol_mint_authority.json");

    // Our program (NON-stub build).
    let program_id = pocket_fans::id();
    let so = std::fs::read(format!("{}/../../target/deploy/pocket_fans.so", env!("CARGO_MANIFEST_DIR"))).unwrap();
    svm.add_program(program_id, &so).unwrap();

    let owner = Keypair::new();
    svm.airdrop(&owner.pubkey(), 10_000_000_000).unwrap();

    let (vault_pda, _) = Pubkey::find_program_address(&[VAULT_SEED, owner.pubkey().as_ref()], &program_id);
    let (rule_pda, _) = Pubkey::find_program_address(&[RULE_SEED, vault_pda.as_ref(), &0u16.to_le_bytes()], &program_id);
    let (vault_sol_pda, _) = Pubkey::find_program_address(&[VAULT_SOL_SEED, owner.pubkey().as_ref()], &program_id);
    let (stake_wsol_pda, _) =
        Pubkey::find_program_address(&[STAKE_WSOL_SEED, owner.pubkey().as_ref(), &0u16.to_le_bytes()], &program_id);

    // token accounts: owner USDC funded; vault USDC empty; vault mSOL empty.
    let owner_usdc = Keypair::new().pubkey();
    let vault_usdc = Keypair::new().pubkey();
    let vault_msol = Keypair::new().pubkey();
    set_token(&mut svm, owner_usdc, &DEVUSDC_MINT, &owner.pubkey(), 5_000_000, None);
    set_token(&mut svm, vault_usdc, &DEVUSDC_MINT, &vault_pda, 0, None);
    set_token(&mut svm, vault_msol, &MSOL_MINT, &vault_pda, 0, None);

    // init vault + rule (SwapStakeAndSave / TeamWin).
    let ix = Instruction {
        program_id,
        accounts: pf_accounts::InitializeVault { owner: owner.pubkey(), vault: vault_pda, system_program: system_program::ID }.to_account_metas(None),
        data: pf_ix::InitializeVault {}.data(),
    };
    send(&mut svm, ix, &owner, &[&owner]).expect("init vault");

    let ix = Instruction {
        program_id,
        accounts: pf_accounts::CreateRule {
            owner: owner.pubkey(), vault: vault_pda, rule: rule_pda, usdc_mint: DEVUSDC_MINT,
            owner_usdc_ata: owner_usdc, token_program: TOKEN_ID, system_program: system_program::ID,
        }.to_account_metas(None),
        data: pf_ix::CreateRule {
            trigger_type: TriggerType::TeamWin { team_id: 42 },
            action_type: ActionType::SwapStakeAndSave { amount_usdc: AMOUNT, max_slippage_bps: 1500 },
            max_executions: MAX_EXEC,
            match_id: 7,
            match_end_ts,
        }.data(),
    };
    send(&mut svm, ix, &owner, &[&owner]).expect("create rule");

    // advance clock past match_end_ts (also the ts the whirlpool needs).
    svm.set_sysvar(&Clock { slot: 2, epoch_start_timestamp: ts, epoch: 0, leader_schedule_epoch: 0, unix_timestamp: ts });

    let owner_lamports_before = lamports(&svm, &owner.pubkey());

    let accounts = pf_accounts::ExecuteRuleStaked {
        owner: owner.pubkey(),
        vault: vault_pda,
        rule: rule_pda,
        usdc_mint: DEVUSDC_MINT,
        wsol_mint: WSOL_MINT,
        msol_mint: MSOL_MINT,
        owner_usdc_ata: owner_usdc,
        vault_usdc_ata: vault_usdc,
        stake_wsol: stake_wsol_pda,
        vault_sol: vault_sol_pda,
        vault_msol_ata: vault_msol,
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
        token_program: TOKEN_ID,
        system_program: system_program::ID,
    };

    let ix = Instruction { program_id, accounts: accounts.to_account_metas(None), data: pf_ix::ExecuteRuleStaked { rule_id: 0 }.data() };
    let res = send(&mut svm, ix, &owner, &[&owner]);
    assert!(res.is_ok(), "execute_rule_staked (real Marinade deposit) must succeed, got: {:?}", res);

    // assertions
    let owner_usdc_after = ta_amount(&svm, &owner_usdc);
    let vault_usdc_after = ta_amount(&svm, &vault_usdc);
    let vault_msol_after = ta_amount(&svm, &vault_msol);
    let stake_wsol_exists = svm.get_account(&stake_wsol_pda).map(|a| !a.data.is_empty() && a.lamports > 0).unwrap_or(false);
    let vault_sol_after = lamports(&svm, &vault_sol_pda);
    let owner_lamports_after = lamports(&svm, &owner.pubkey());

    println!("owner_usdc: 5_000_000 -> {owner_usdc_after}");
    println!("vault_usdc (post-swap): {vault_usdc_after}");
    println!("vault_mSOL received: {vault_msol_after}");
    println!("stake_wsol still exists? {stake_wsol_exists}");
    println!("vault_sol residual lamports: {vault_sol_after}");
    println!("owner lamports: {owner_lamports_before} -> {owner_lamports_after}");

    assert_eq!(owner_usdc_after, 5_000_000 - AMOUNT, "AMOUNT devUSDC pulled from owner");
    assert_eq!(vault_usdc_after, 0, "all pulled devUSDC swapped out of vault");
    assert!(vault_msol_after > 0, "vault must have received mSOL from Marinade (got {vault_msol_after})");
    assert!(!stake_wsol_exists, "ephemeral stake_wsol must be closed after unwrap");
    assert_eq!(vault_sol_after, 0, "vault_sol must be drained (deposited + rent refunded)");
    assert_eq!(load_rule(&svm, &rule_pda).executions_done, 1, "executions_done incremented");

    println!("STAKE OK: saved {vault_msol_after} raw mSOL (~{} mSOL) into the user vault", vault_msol_after as f64 / 1e9);
}

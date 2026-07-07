//! Approach (a): execute the REAL Orca Whirlpool `swap` via our program's
//! manual `invoke_signed` CPI, against the actual Orca program bytecode and pool
//! accounts CLONED from devnet (2026-07-05). This verifies the CPI at runtime —
//! account order, discriminator, arg layout, tick arrays, direction, and that
//! wSOL actually settles into the user's vault — not just compile/shape checks.
//!
//! SELF-CLAIM MODEL: `execute_rule` is called by the rule OWNER directly (no
//! oracle signer, no admin key). The only on-chain gate is a time guard —
//! `Clock::unix_timestamp >= rule.match_end_ts`, fixed at create_rule time.
//!
//! Fixtures were dumped from devnet into tests/fixtures/ (Orca program .so + the
//! whirlpool, both pool token vaults, two tick arrays, and both mints). The pool
//! `oracle` account (2KEWNc..) does not exist on devnet and is a vestigial
//! placeholder in classic `swap`, so it is passed as an empty account.
//!
//! Runs only in the NON-stub build (real CPI). See test_logic_stub.rs for (b).
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
    accounts as pf_accounts, instruction as pf_ix, ActionType, Rule, TriggerType,
    DEVUSDC_MINT, RULE_SEED, SOL_DEVUSDC_WHIRLPOOL, VAULT_SEED,
    WHIRLPOOL_PROGRAM_ID, WSOL_MINT,
};

const TOKEN_ID: Pubkey = Pubkey::from_str_const("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");

// Real devnet Orca accounts (cloned into fixtures).
const VAULT_A: Pubkey = Pubkey::from_str_const("C9zLV5zWF66j3rZj3uuhDqvfuA8esJyWnruGzDW9qEj2"); // wSOL
const VAULT_B: Pubkey = Pubkey::from_str_const("7DM3RMz2yzUB8yPRQM3FMZgdFrwZGMsabsfsKopWktoX"); // devUSDC
const TICK0: Pubkey = Pubkey::from_str_const("7knZZ461yySGbSEHeBUwEpg3VtAkQy8B9tp78RGgyUHE");
const TICK1: Pubkey = Pubkey::from_str_const("CpoSFo3ajrizueggtJr2ZjvYgdtkgugXtvhqcwkyCkKP");
const POOL_ORACLE: Pubkey = Pubkey::from_str_const("2KEWNc3b6EfqoWQpfKQMHh4mhRyKXYRdPbtGRTJX3Cip");

const RENT_165: u64 = 2_039_280; // rent-exempt reserve for a 165-byte token account
const AMOUNT: u64 = 1_000_000; // 1.00 devUSDC (6dp) — tiny vs pool, negligible impact
const MAX_EXEC: u16 = 3;
const OWNER_START: u64 = 5_000_000;

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

fn pack_token(
    mint: &Pubkey,
    owner: &Pubkey,
    amount: u64,
    native_reserve: Option<u64>,
) -> Vec<u8> {
    let mut d = vec![0u8; 165];
    d[0..32].copy_from_slice(mint.as_ref());
    d[32..64].copy_from_slice(owner.as_ref());
    d[64..72].copy_from_slice(&amount.to_le_bytes());
    d[108] = 1; // state = Initialized
    if let Some(r) = native_reserve {
        d[109..113].copy_from_slice(&1u32.to_le_bytes()); // is_native = Some
        d[113..121].copy_from_slice(&r.to_le_bytes());
    }
    d
}

fn set_token(svm: &mut LiteSVM, addr: Pubkey, mint: &Pubkey, owner: &Pubkey, amount: u64, native: Option<u64>) {
    let lamports = RENT_165 + native.unwrap_or(0).saturating_sub(RENT_165).max(0);
    svm.set_account(
        addr,
        Account { lamports: lamports.max(RENT_165), data: pack_token(mint, owner, amount, native), owner: TOKEN_ID, executable: false, rent_epoch: 0 },
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
fn test_real_orca_swap_against_cloned_devnet() {
    let mut svm = LiteSVM::new().with_blockhash_check(false);

    // The cloned whirlpool stores reward_last_updated_timestamp = 1783241318.
    // LiteSVM's default Clock is at timestamp 0, which Orca reads as time moving
    // backwards -> Custom(6022) InvalidTimestamp. Set the clock just past it
    // (small delta to avoid large reward accrual math). This same `ts` also
    // stands in for "match finished" in the self-claim time guard below —
    // match_end_ts is set a bit earlier so create_rule sees a plausible window.
    let ts: i64 = 1_783_241_318 + 30;
    let match_end_ts: i64 = ts - 10; // already elapsed by the time we execute
    svm.set_sysvar(&Clock {
        slot: 1,
        epoch_start_timestamp: ts,
        epoch: 0,
        leader_schedule_epoch: 0,
        unix_timestamp: match_end_ts - 3600, // "now" at rule-creation time, 1h before match_end_ts
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
    // POOL_ORACLE intentionally left absent (does not exist on devnet).

    // Our program (must be the NON-stub build).
    let program_id = pocket_fans::id();
    let so = std::fs::read(format!("{}/../../target/deploy/pocket_fans.so", env!("CARGO_MANIFEST_DIR"))).unwrap();
    svm.add_program(program_id, &so).unwrap();

    let owner = Keypair::new();
    let other = Keypair::new();
    for kp in [&owner, &other] {
        svm.airdrop(&kp.pubkey(), 10_000_000_000).unwrap();
    }

    let (vault_pda, _) = Pubkey::find_program_address(&[VAULT_SEED, owner.pubkey().as_ref()], &program_id);
    let (rule_pda, _) = Pubkey::find_program_address(&[RULE_SEED, vault_pda.as_ref(), &0u16.to_le_bytes()], &program_id);

    // User + vault token accounts. owner_usdc funded; vault_wsol is native.
    let owner_usdc = Keypair::new().pubkey();
    let vault_usdc = Keypair::new().pubkey();
    let vault_wsol = Keypair::new().pubkey();
    let owner_wsol = Keypair::new().pubkey(); // withdrawal destination
    set_token(&mut svm, owner_usdc, &DEVUSDC_MINT, &owner.pubkey(), OWNER_START, None);
    set_token(&mut svm, vault_usdc, &DEVUSDC_MINT, &vault_pda, 0, None);
    set_token(&mut svm, vault_wsol, &WSOL_MINT, &vault_pda, 0, Some(RENT_165));
    set_token(&mut svm, owner_wsol, &WSOL_MINT, &owner.pubkey(), 0, Some(RENT_165));

    // init vault + rule (grants delegation; fixes match_id + match_end_ts).
    // No oracle authority account/instruction anywhere in this flow anymore.
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
            action_type: ActionType::SwapAndSave { amount_usdc: AMOUNT, target_mint: WSOL_MINT, max_slippage_bps: 1500 },
            max_executions: MAX_EXEC,
            match_id: 7,
            match_end_ts,
        }.data(),
    };
    send(&mut svm, ix, &owner, &[&owner]).expect("create rule");

    // NEG: the non-owner cannot claim this rule (checked before the swap CPI
    // even runs, so no fixture/clock setup is needed for this to be meaningful).
    let ix_wrong_signer = Instruction {
        program_id,
        accounts: pf_accounts::ExecuteRule {
            owner: other.pubkey(),
            vault: vault_pda,
            rule: rule_pda,
            usdc_mint: DEVUSDC_MINT,
            wsol_mint: WSOL_MINT,
            owner_usdc_ata: owner_usdc,
            vault_usdc_ata: vault_usdc,
            vault_wsol_ata: vault_wsol,
            whirlpool: SOL_DEVUSDC_WHIRLPOOL,
            whirlpool_token_vault_a: VAULT_A,
            whirlpool_token_vault_b: VAULT_B,
            tick_array_0: TICK0,
            tick_array_1: TICK1,
            tick_array_2: TICK0,
            whirlpool_oracle: POOL_ORACLE,
            whirlpool_program: WHIRLPOOL_PROGRAM_ID,
            token_program: TOKEN_ID,
        }.to_account_metas(None),
        data: pf_ix::ExecuteRule { rule_id: 0 }.data(),
    };
    assert!(
        send(&mut svm, ix_wrong_signer, &other, &[&other]).is_err(),
        "a non-owner must never be able to execute this rule"
    );

    // Now advance the clock to `ts` (past match_end_ts) — the same timestamp
    // the cloned whirlpool needs to accept the swap — and self-claim as owner.
    svm.set_sysvar(&Clock {
        slot: 2,
        epoch_start_timestamp: ts,
        epoch: 0,
        leader_schedule_epoch: 0,
        unix_timestamp: ts,
    });

    let wsol_before_amt = ta_amount(&svm, &vault_wsol);
    let wsol_before_lp = lamports(&svm, &vault_wsol);

    // execute_rule -> REAL Orca swap, self-claimed by the owner (no oracle).
    let ix = Instruction {
        program_id,
        accounts: pf_accounts::ExecuteRule {
            owner: owner.pubkey(),
            vault: vault_pda,
            rule: rule_pda,
            usdc_mint: DEVUSDC_MINT,
            wsol_mint: WSOL_MINT,
            owner_usdc_ata: owner_usdc,
            vault_usdc_ata: vault_usdc,
            vault_wsol_ata: vault_wsol,
            whirlpool: SOL_DEVUSDC_WHIRLPOOL,
            whirlpool_token_vault_a: VAULT_A,
            whirlpool_token_vault_b: VAULT_B,
            tick_array_0: TICK0,
            tick_array_1: TICK1,
            tick_array_2: TICK0, // reused (real successful swap did the same)
            whirlpool_oracle: POOL_ORACLE,
            whirlpool_program: WHIRLPOOL_PROGRAM_ID,
            token_program: TOKEN_ID,
        }.to_account_metas(None),
        data: pf_ix::ExecuteRule { rule_id: 0 }.data(),
    };
    let res = send(&mut svm, ix, &owner, &[&owner]);
    assert!(res.is_ok(), "real Orca swap CPI must succeed, got: {:?}", res);

    // assertions: USDC pulled + swapped out, wSOL saved into vault, counter++.
    let owner_usdc_after = ta_amount(&svm, &owner_usdc);
    let vault_usdc_after = ta_amount(&svm, &vault_usdc);
    let wsol_after_amt = ta_amount(&svm, &vault_wsol);
    let wsol_after_lp = lamports(&svm, &vault_wsol);

    println!("owner_usdc: {OWNER_START} -> {owner_usdc_after}");
    println!("vault_usdc (post-swap): {vault_usdc_after}");
    println!("vault_wsol amount: {wsol_before_amt} -> {wsol_after_amt}");
    println!("vault_wsol lamports: {wsol_before_lp} -> {wsol_after_lp}");

    assert_eq!(owner_usdc_after, OWNER_START - AMOUNT, "AMOUNT devUSDC pulled from owner");
    assert_eq!(vault_usdc_after, 0, "all pulled devUSDC swapped out of vault");
    let wsol_gained = wsol_after_amt.saturating_sub(wsol_before_amt);
    assert!(wsol_gained > 0, "vault must have received wSOL from the swap (got {wsol_gained})");
    assert_eq!(load_rule(&svm, &rule_pda).executions_done, 1, "executions_done incremented");

    println!("SWAP OK: saved {wsol_gained} raw wSOL (~{} SOL) into the user vault", wsol_gained as f64 / 1e9);

    // ---- withdraw_from_vault round-trip: the ONLY path for the user to get
    // their saved funds back out. Vault PDA signs the transfer to owner's wallet.
    let ix = Instruction {
        program_id,
        accounts: pf_accounts::WithdrawFromVault {
            owner: owner.pubkey(),
            vault: vault_pda,
            token_mint: WSOL_MINT,
            vault_token_ata: vault_wsol,
            owner_token_ata: owner_wsol,
            token_program: TOKEN_ID,
        }
        .to_account_metas(None),
        data: pf_ix::WithdrawFromVault { amount: wsol_gained }.data(),
    };
    send(&mut svm, ix, &owner, &[&owner]).expect("withdraw_from_vault must succeed");

    assert_eq!(ta_amount(&svm, &owner_wsol), wsol_gained, "owner wallet received the withdrawn wSOL");
    assert_eq!(ta_amount(&svm, &vault_wsol), 0, "vault emptied after full withdrawal");
    println!("WITHDRAW OK: {wsol_gained} raw wSOL returned to the owner wallet");
}

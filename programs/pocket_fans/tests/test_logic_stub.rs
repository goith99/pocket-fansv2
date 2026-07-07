//! Approach (b): validate Pocket Fans program logic in LiteSVM with the Orca
//! swap CPI stubbed out (build with `--features stub-swap`).
//!
//! SELF-CLAIM MODEL: flow verified is initialize_vault -> create_rule (fixes
//! match_id + match_end_ts, grants bounded SPL delegation) -> execute_rule
//! (the RULE OWNER itself pulls USDC via the delegation, after match_end_ts has
//! passed; increments executions_done). No oracle account/signer is involved
//! anywhere in this flow anymore. Negative cases: wrong signer (not the
//! owner), execute-before-match_end_ts, and execute-after-revoke.
//!
//! Real SPL `approve` / delegated `transfer` run for real here (LiteSVM bundles
//! the SPL Token program); only the Orca swap is stubbed. The real swap CPI is
//! covered by approach (a) against a devnet-cloned Whirlpool.
//!
//! Only compiles/runs WITH `--features stub-swap` (and the matching stub `.so`),
//! so it never runs against a non-stub build. Approach (a) is the inverse.
#![cfg(feature = "stub-swap")]

use anchor_lang::{
    solana_program::clock::Clock, solana_program::instruction::Instruction,
    solana_program::system_program, AccountDeserialize, InstructionData, ToAccountMetas,
};
use anchor_lang::prelude::Pubkey;
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

// --- SPL account byte packing (avoids pulling the spl-token crate) ---

fn pack_mint(mint_authority: &Pubkey, decimals: u8) -> Vec<u8> {
    let mut d = vec![0u8; 82];
    d[0..4].copy_from_slice(&1u32.to_le_bytes()); // mint_authority = Some
    d[4..36].copy_from_slice(mint_authority.as_ref());
    // supply (36..44) = 0
    d[44] = decimals;
    d[45] = 1; // is_initialized
    // freeze_authority COption None (46..50) = 0
    d
}

/// amount at 64..72; optional (delegate, delegated_amount).
fn pack_token_account(
    mint: &Pubkey,
    owner: &Pubkey,
    amount: u64,
    delegate: Option<(&Pubkey, u64)>,
) -> Vec<u8> {
    let mut d = vec![0u8; 165];
    d[0..32].copy_from_slice(mint.as_ref());
    d[32..64].copy_from_slice(owner.as_ref());
    d[64..72].copy_from_slice(&amount.to_le_bytes());
    if let Some((del, amt)) = delegate {
        d[72..76].copy_from_slice(&1u32.to_le_bytes()); // delegate = Some
        d[76..108].copy_from_slice(del.as_ref());
        d[121..129].copy_from_slice(&amt.to_le_bytes()); // delegated_amount
    }
    d[108] = 1; // state = Initialized
    // is_native None (109..121), close_authority None (129..165)
    d
}

fn token_account(mint: &Pubkey, owner: &Pubkey, amount: u64) -> Account {
    Account {
        lamports: 1_000_000_000,
        data: pack_token_account(mint, owner, amount, None),
        owner: TOKEN_ID,
        executable: false,
        rent_epoch: 0,
    }
}

fn mint_account(authority: &Pubkey, decimals: u8) -> Account {
    Account {
        lamports: 1_000_000_000,
        data: pack_mint(authority, decimals),
        owner: TOKEN_ID,
        executable: false,
        rent_epoch: 0,
    }
}

// --- token account field readers ---

fn ta_amount(svm: &LiteSVM, addr: &Pubkey) -> u64 {
    let a = svm.get_account(addr).expect("token account exists");
    u64::from_le_bytes(a.data[64..72].try_into().unwrap())
}

/// (delegate_is_some, delegate, delegated_amount)
fn ta_delegate(svm: &LiteSVM, addr: &Pubkey) -> (bool, Pubkey, u64) {
    let a = svm.get_account(addr).unwrap();
    let is_some = u32::from_le_bytes(a.data[72..76].try_into().unwrap()) == 1;
    let del = Pubkey::new_from_array(a.data[76..108].try_into().unwrap());
    let amt = u64::from_le_bytes(a.data[121..129].try_into().unwrap());
    (is_some, del, amt)
}

fn load_rule(svm: &LiteSVM, addr: &Pubkey) -> Rule {
    let a = svm.get_account(addr).expect("rule exists");
    Rule::try_deserialize(&mut a.data.as_slice()).expect("rule deserializes")
}

fn send(
    svm: &mut LiteSVM,
    ix: Instruction,
    payer: &Keypair,
    signers: &[&Keypair],
) -> Result<(), litesvm::types::FailedTransactionMetadata> {
    let bh = svm.latest_blockhash();
    let msg = Message::new_with_blockhash(&[ix], Some(&payer.pubkey()), &bh);
    let tx = VersionedTransaction::try_new(VersionedMessage::Legacy(msg), signers).unwrap();
    svm.send_transaction(tx).map(|_| ())
}

/// Advance LiteSVM's Clock sysvar to `ts` (unix seconds). Slot is bumped too so
/// later blockhashes/txs remain distinct; only unix_timestamp matters to our
/// execute_rule time guard.
fn set_clock(svm: &mut LiteSVM, ts: i64) {
    svm.set_sysvar(&Clock {
        slot: (ts.max(1)) as u64,
        epoch_start_timestamp: ts,
        epoch: 0,
        leader_schedule_epoch: 0,
        unix_timestamp: ts,
    });
}

struct Ctx {
    program_id: Pubkey,
    owner: Keypair,
    other: Keypair,
    vault_pda: Pubkey,
    rule_pda: Pubkey,
    owner_usdc: Pubkey,
    vault_usdc: Pubkey,
    vault_wsol: Pubkey,
    match_end_ts: i64,
}

const AMOUNT: u64 = 1_000_000; // 1.00 devUSDC (6dp)
const MAX_EXEC: u16 = 3;
const OWNER_START: u64 = 5_000_000;
const CREATE_TS: i64 = 1_800_000_000; // arbitrary fixed "now" at rule creation
const MATCH_END_OFFSET: i64 = 3 * 60 * 60; // +3h, matches the app's buffer

fn setup() -> (LiteSVM, Ctx) {
    let mut svm = LiteSVM::new().with_blockhash_check(false);
    set_clock(&mut svm, CREATE_TS);

    let program_id = pocket_fans::id();
    let so = include_bytes!("../../../target/deploy/pocket_fans.so");
    svm.add_program(program_id, so).unwrap();

    let owner = Keypair::new();
    let other = Keypair::new();
    for kp in [&owner, &other] {
        svm.airdrop(&kp.pubkey(), 10_000_000_000).unwrap();
    }

    let (vault_pda, _) =
        Pubkey::find_program_address(&[VAULT_SEED, owner.pubkey().as_ref()], &program_id);
    let (rule_pda, _) = Pubkey::find_program_address(
        &[RULE_SEED, vault_pda.as_ref(), &0u16.to_le_bytes()],
        &program_id,
    );

    // Materialize the real-address mints (required by the program's `address =`
    // constraints).
    let admin = Keypair::new();
    svm.set_account(DEVUSDC_MINT, mint_account(&admin.pubkey(), 6)).unwrap();
    svm.set_account(WSOL_MINT, mint_account(&admin.pubkey(), 9)).unwrap();

    // Token accounts. owner_usdc pre-funded; vault ATAs empty.
    let owner_usdc = Keypair::new().pubkey();
    let vault_usdc = Keypair::new().pubkey();
    let vault_wsol = Keypair::new().pubkey();
    svm.set_account(owner_usdc, token_account(&DEVUSDC_MINT, &owner.pubkey(), OWNER_START)).unwrap();
    svm.set_account(vault_usdc, token_account(&DEVUSDC_MINT, &vault_pda, 0)).unwrap();
    svm.set_account(vault_wsol, token_account(&WSOL_MINT, &vault_pda, 0)).unwrap();

    // Fake whirlpool account (owned by the whirlpool program) with a nonzero
    // sqrt_price at offset 65..81 so execute_rule's slippage math has an input.
    let mut wp_data = vec![0u8; 653];
    let sqrt_price: u128 = 2_753_973_151_960_090_641; // real devnet value
    wp_data[65..81].copy_from_slice(&sqrt_price.to_le_bytes());
    svm.set_account(
        SOL_DEVUSDC_WHIRLPOOL,
        Account { lamports: 1_000_000_000, data: wp_data, owner: WHIRLPOOL_PROGRAM_ID, executable: false, rent_epoch: 0 },
    )
    .unwrap();

    let match_end_ts = CREATE_TS + MATCH_END_OFFSET;

    (
        svm,
        Ctx { program_id, owner, other, vault_pda, rule_pda, owner_usdc, vault_usdc, vault_wsol, match_end_ts },
    )
}

impl Ctx {
    fn ix_init_vault(&self) -> Instruction {
        Instruction {
            program_id: self.program_id,
            accounts: pf_accounts::InitializeVault {
                owner: self.owner.pubkey(),
                vault: self.vault_pda,
                system_program: system_program::ID,
            }
            .to_account_metas(None),
            data: pf_ix::InitializeVault {}.data(),
        }
    }

    fn ix_create_rule(&self, match_id: u64) -> Instruction {
        Instruction {
            program_id: self.program_id,
            accounts: pf_accounts::CreateRule {
                owner: self.owner.pubkey(),
                vault: self.vault_pda,
                rule: self.rule_pda,
                usdc_mint: DEVUSDC_MINT,
                owner_usdc_ata: self.owner_usdc,
                token_program: TOKEN_ID,
                system_program: system_program::ID,
            }
            .to_account_metas(None),
            data: pf_ix::CreateRule {
                trigger_type: TriggerType::TeamWin { team_id: 42 },
                action_type: ActionType::SwapAndSave {
                    amount_usdc: AMOUNT,
                    target_mint: WSOL_MINT,
                    max_slippage_bps: 1500,
                },
                max_executions: MAX_EXEC,
                match_id,
                match_end_ts: self.match_end_ts,
            }
            .data(),
        }
    }

    /// `signer` lets the wrong-signer negative test pass someone other than
    /// `self.owner` while still targeting the same vault/rule PDAs (which are
    /// seeded on `self.owner`, so a mismatched signer is rejected by `has_one`).
    fn ix_execute(&self, signer: Pubkey) -> Instruction {
        Instruction {
            program_id: self.program_id,
            accounts: pf_accounts::ExecuteRule {
                owner: signer,
                vault: self.vault_pda,
                rule: self.rule_pda,
                usdc_mint: DEVUSDC_MINT,
                wsol_mint: WSOL_MINT,
                owner_usdc_ata: self.owner_usdc,
                vault_usdc_ata: self.vault_usdc,
                vault_wsol_ata: self.vault_wsol,
                whirlpool: SOL_DEVUSDC_WHIRLPOOL,
                whirlpool_token_vault_a: Pubkey::new_unique(),
                whirlpool_token_vault_b: Pubkey::new_unique(),
                tick_array_0: Pubkey::new_unique(),
                tick_array_1: Pubkey::new_unique(),
                tick_array_2: Pubkey::new_unique(),
                whirlpool_oracle: Pubkey::new_unique(),
                whirlpool_program: WHIRLPOOL_PROGRAM_ID,
                token_program: TOKEN_ID,
            }
            .to_account_metas(None),
            data: pf_ix::ExecuteRule { rule_id: 0 }.data(),
        }
    }

    fn ix_revoke(&self) -> Instruction {
        Instruction {
            program_id: self.program_id,
            accounts: pf_accounts::RevokeRule {
                owner: self.owner.pubkey(),
                vault: self.vault_pda,
                rule: self.rule_pda,
                usdc_mint: DEVUSDC_MINT,
                owner_usdc_ata: self.owner_usdc,
                token_program: TOKEN_ID,
            }
            .to_account_metas(None),
            data: pf_ix::RevokeRule { rule_id: 0 }.data(),
        }
    }
}

#[test]
fn test_pocket_fans_self_claim_logic_with_stub_swap() {
    let (mut svm, c) = setup();

    // 1) init vault + rule (fixes match_id=7, match_end_ts = CREATE_TS + 3h)
    send(&mut svm, c.ix_init_vault(), &c.owner, &[&c.owner]).expect("init vault");
    send(&mut svm, c.ix_create_rule(7), &c.owner, &[&c.owner]).expect("create rule");

    // 2) delegation must be granted to the vault for AMOUNT * MAX_EXEC (bounded)
    let (is_some, del, damt) = ta_delegate(&svm, &c.owner_usdc);
    assert!(is_some, "delegate should be set");
    assert_eq!(del, c.vault_pda, "delegate must be the vault PDA");
    assert_eq!(damt, AMOUNT * MAX_EXEC as u64, "delegated amount = AMOUNT * MAX_EXEC");
    let rule = load_rule(&svm, &c.rule_pda);
    assert_eq!(rule.executions_done, 0);
    assert_eq!(rule.match_id, 7);
    assert_eq!(rule.match_end_ts, c.match_end_ts);

    // 3) NEG: wrong signer (not the rule owner) is rejected — still before
    //    match_end_ts, so this also confirms the owner check is independent of
    //    (and checked regardless of) the time guard.
    assert!(
        send(&mut svm, c.ix_execute(c.other.pubkey()), &c.other, &[&c.other]).is_err(),
        "non-owner signer must be rejected"
    );

    // 4) NEG: owner tries to claim before match_end_ts — rejected by the time guard.
    assert!(
        send(&mut svm, c.ix_execute(c.owner.pubkey()), &c.owner, &[&c.owner]).is_err(),
        "claim before match_end_ts must be rejected"
    );
    // state unchanged by the rejected txs
    assert_eq!(ta_amount(&svm, &c.owner_usdc), OWNER_START);
    assert_eq!(load_rule(&svm, &c.rule_pda).executions_done, 0);

    // 5) advance the clock past match_end_ts, THEN the owner can self-claim.
    set_clock(&mut svm, c.match_end_ts + 1);
    send(&mut svm, c.ix_execute(c.owner.pubkey()), &c.owner, &[&c.owner])
        .expect("execute_rule should succeed once match_end_ts has passed");
    assert_eq!(ta_amount(&svm, &c.owner_usdc), OWNER_START - AMOUNT, "AMOUNT pulled from owner");
    assert_eq!(ta_amount(&svm, &c.vault_usdc), AMOUNT, "AMOUNT delivered to vault via delegation");
    assert_eq!(load_rule(&svm, &c.rule_pda).executions_done, 1, "executions_done incremented");

    // 6) revoke clears the delegation and deactivates the rule
    send(&mut svm, c.ix_revoke(), &c.owner, &[&c.owner]).expect("revoke");
    let (is_some_after, _, _) = ta_delegate(&svm, &c.owner_usdc);
    assert!(!is_some_after, "delegation must be cleared after revoke");
    assert!(!load_rule(&svm, &c.rule_pda).is_active, "rule inactive after revoke");

    // 7) NEG: execute after revoke is rejected (inactive), even past match_end_ts
    assert!(
        send(&mut svm, c.ix_execute(c.owner.pubkey()), &c.owner, &[&c.owner]).is_err(),
        "execute on revoked rule must be rejected"
    );
    assert_eq!(load_rule(&svm, &c.rule_pda).executions_done, 1, "no further executions after revoke");
}

/// The core safety boundary of the delegation model: a rule can execute at most
/// `max_executions` times, then further execute_rule calls are rejected without
/// pulling any more tokens or advancing the counter. Unchanged by the self-claim
/// migration — still enforced purely on-chain by the Rule account's counters.
#[test]
fn test_max_executions_exhaustion() {
    let (mut svm, c) = setup();

    send(&mut svm, c.ix_init_vault(), &c.owner, &[&c.owner]).expect("init vault");
    send(&mut svm, c.ix_create_rule(7), &c.owner, &[&c.owner]).expect("create rule");
    set_clock(&mut svm, c.match_end_ts + 1); // past the guard for the whole test

    // Exhaust exactly MAX_EXEC executions.
    for i in 0..MAX_EXEC {
        send(&mut svm, c.ix_execute(c.owner.pubkey()), &c.owner, &[&c.owner])
            .unwrap_or_else(|e| panic!("execution {i} should succeed: {e:?}"));
    }
    assert_eq!(load_rule(&svm, &c.rule_pda).executions_done, MAX_EXEC);
    assert_eq!(ta_amount(&svm, &c.owner_usdc), OWNER_START - AMOUNT * MAX_EXEC as u64);
    assert_eq!(ta_amount(&svm, &c.vault_usdc), AMOUNT * MAX_EXEC as u64);

    // The (MAX_EXEC + 1)-th call must be rejected and change nothing.
    let owner_before = ta_amount(&svm, &c.owner_usdc);
    let vault_before = ta_amount(&svm, &c.vault_usdc);
    assert!(
        send(&mut svm, c.ix_execute(c.owner.pubkey()), &c.owner, &[&c.owner]).is_err(),
        "execution beyond max_executions must be rejected"
    );
    assert_eq!(load_rule(&svm, &c.rule_pda).executions_done, MAX_EXEC, "counter must not advance past max");
    assert_eq!(ta_amount(&svm, &c.owner_usdc), owner_before, "no further tokens pulled from owner");
    assert_eq!(ta_amount(&svm, &c.vault_usdc), vault_before, "vault balance unchanged");
}

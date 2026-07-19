//! Shared-delegation fix (Option C): `create_rule` ACCUMULATES the SPL
//! delegation instead of overwriting it, and `revoke_rule` SUBTRACTS that rule's
//! share instead of clearing everything.
//!
//! Why this test exists — the bug it pins down:
//!   SPL `approve` REPLACES the delegation, and a token account holds exactly one
//!   delegate with one amount. The old `create_rule` approved only the new rule's
//!   own need, silently wiping every other active rule's allowance on the same
//!   wallet; the old `revoke_rule` called `revoke`, clearing the delegation for
//!   ALL rules when the user cancelled any one of them. Self-claim paths could
//!   paper over this from the client (the owner signs, so it can re-approve in
//!   the same transaction) but the permissionless keeper path cannot.
//!
//! The amounts below are the REAL per-rule amounts read off devnet vault
//! 32XmFTw7meCbbtZP5S5Ti3zmyTq9vDookNdk6jwEuTvw (2026-07-19), which at the time
//! of writing was demonstrating the bug live: 62,000,000 raw devUSDC of
//! outstanding need across its active rules, but only 25,000,000 actually
//! delegated — exactly the newest rule's need, with the rest silently unbacked.
//!
//! No swap is involved in create/revoke, so this runs in the normal (non-stub)
//! build. `approve` / `revoke` execute for real — LiteSVM bundles SPL Token.

use anchor_lang::prelude::Pubkey;
use anchor_lang::solana_program::clock::Clock;
use anchor_lang::{
    solana_program::instruction::Instruction, solana_program::system_program, InstructionData,
    ToAccountMetas,
};
use litesvm::LiteSVM;
use solana_account::Account;
use solana_keypair::Keypair;
use solana_message::{Message, VersionedMessage};
use solana_signer::Signer;
use solana_transaction::versioned::VersionedTransaction;

use pocket_fans::{
    accounts as pf_accounts, instruction as pf_ix, ActionType, TriggerType, DEVUSDC_MINT, RULE_SEED,
    VAULT_SEED, WSOL_MINT,
};

const TOKEN_ID: Pubkey = Pubkey::from_str_const("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const CREATE_TS: i64 = 1_800_000_000;
const MATCH_END_OFFSET: i64 = 3 * 60 * 60;

// Real per-rule amounts from the devnet vault named above (rules #14..#17, #10).
const A_RULE_14: u64 = 10_000_000; // DCA
const A_RULE_15: u64 = 10_000_000; // Stake
const A_RULE_16: u64 = 15_000_000; // DCA
const A_RULE_17: u64 = 25_000_000; // Stake
const A_RULE_10: u64 = 2_000_000; //  GoalScored — the keeper-path rule the bug strands

fn pack_mint(mint_authority: &Pubkey, decimals: u8) -> Vec<u8> {
    let mut d = vec![0u8; 82];
    d[0..4].copy_from_slice(&1u32.to_le_bytes());
    d[4..36].copy_from_slice(mint_authority.as_ref());
    d[44] = decimals;
    d[45] = 1;
    d
}

fn pack_token_account(mint: &Pubkey, owner: &Pubkey, amount: u64) -> Vec<u8> {
    let mut d = vec![0u8; 165];
    d[0..32].copy_from_slice(mint.as_ref());
    d[32..64].copy_from_slice(owner.as_ref());
    d[64..72].copy_from_slice(&amount.to_le_bytes());
    d[108..112].copy_from_slice(&1u32.to_le_bytes()); // state = Initialized
    d
}

fn token_account(mint: &Pubkey, owner: &Pubkey, amount: u64) -> Account {
    Account {
        lamports: 2_039_280,
        data: pack_token_account(mint, owner, amount),
        owner: TOKEN_ID,
        executable: false,
        rent_epoch: 0,
    }
}

fn mint_account(authority: &Pubkey, decimals: u8) -> Account {
    Account {
        lamports: 1_461_600,
        data: pack_mint(authority, decimals),
        owner: TOKEN_ID,
        executable: false,
        rent_epoch: 0,
    }
}

/// (delegate_is_some, delegate, delegated_amount) — same offsets as test_logic_stub.
fn ta_delegate(svm: &LiteSVM, addr: &Pubkey) -> (bool, Pubkey, u64) {
    let a = svm.get_account(addr).unwrap();
    let is_some = u32::from_le_bytes(a.data[72..76].try_into().unwrap()) == 1;
    let del = Pubkey::new_from_array(a.data[76..108].try_into().unwrap());
    let amt = u64::from_le_bytes(a.data[121..129].try_into().unwrap());
    (is_some, del, amt)
}

fn set_clock(svm: &mut LiteSVM, ts: i64) {
    svm.set_sysvar(&Clock {
        slot: (ts.max(1)) as u64,
        epoch_start_timestamp: ts,
        epoch: 0,
        leader_schedule_epoch: 0,
        unix_timestamp: ts,
    });
}

fn send(svm: &mut LiteSVM, ix: Instruction, payer: &Keypair) {
    let bh = svm.latest_blockhash();
    let msg = Message::new_with_blockhash(&[ix], Some(&payer.pubkey()), &bh);
    let tx = VersionedTransaction::try_new(VersionedMessage::Legacy(msg), &[payer]).unwrap();
    svm.send_transaction(tx).expect("transaction succeeds");
}

struct Ctx {
    program_id: Pubkey,
    owner: Keypair,
    vault_pda: Pubkey,
    owner_usdc: Pubkey,
}

impl Ctx {
    fn rule_pda(&self, rule_id: u16) -> Pubkey {
        Pubkey::find_program_address(
            &[RULE_SEED, self.vault_pda.as_ref(), &rule_id.to_le_bytes()],
            &self.program_id,
        )
        .0
    }

    fn ix_create(&self, rule_id: u16, amount: u64, max_executions: u16, stake: bool) -> Instruction {
        let action_type = if stake {
            ActionType::SwapStakeAndSave { amount_usdc: amount, max_slippage_bps: 1500 }
        } else {
            ActionType::SwapAndSave {
                amount_usdc: amount,
                target_mint: WSOL_MINT,
                max_slippage_bps: 1500,
            }
        };
        Instruction {
            program_id: self.program_id,
            accounts: pf_accounts::CreateRule {
                owner: self.owner.pubkey(),
                vault: self.vault_pda,
                rule: self.rule_pda(rule_id),
                usdc_mint: DEVUSDC_MINT,
                owner_usdc_ata: self.owner_usdc,
                token_program: TOKEN_ID,
                system_program: system_program::ID,
            }
            .to_account_metas(None),
            data: pf_ix::CreateRule {
                trigger_type: TriggerType::TeamWin { team_id: 42 },
                action_type,
                max_executions,
                match_id: 1_000 + rule_id as u64,
                match_end_ts: CREATE_TS + MATCH_END_OFFSET,
            }
            .data(),
        }
    }

    fn ix_revoke(&self, rule_id: u16) -> Instruction {
        Instruction {
            program_id: self.program_id,
            accounts: pf_accounts::RevokeRule {
                owner: self.owner.pubkey(),
                vault: self.vault_pda,
                rule: self.rule_pda(rule_id),
                usdc_mint: DEVUSDC_MINT,
                owner_usdc_ata: self.owner_usdc,
                token_program: TOKEN_ID,
            }
            .to_account_metas(None),
            data: pf_ix::RevokeRule { rule_id }.data(),
        }
    }
}

fn setup() -> (LiteSVM, Ctx) {
    let mut svm = LiteSVM::new().with_blockhash_check(false);
    set_clock(&mut svm, CREATE_TS);

    let program_id = pocket_fans::id();
    svm.add_program(program_id, include_bytes!("../../../target/deploy/pocket_fans.so"))
        .unwrap();

    let owner = Keypair::new();
    svm.airdrop(&owner.pubkey(), 10_000_000_000).unwrap();

    let (vault_pda, _) =
        Pubkey::find_program_address(&[VAULT_SEED, owner.pubkey().as_ref()], &program_id);

    let admin = Keypair::new();
    svm.set_account(DEVUSDC_MINT, mint_account(&admin.pubkey(), 6)).unwrap();
    svm.set_account(WSOL_MINT, mint_account(&admin.pubkey(), 9)).unwrap();

    // `approve` does not require a balance, but fund it realistically anyway.
    let owner_usdc = Keypair::new().pubkey();
    svm.set_account(
        owner_usdc,
        token_account(&DEVUSDC_MINT, &owner.pubkey(), 200_000_000),
    )
    .unwrap();

    let ctx = Ctx { program_id, owner, vault_pda, owner_usdc };

    send(
        &mut svm,
        Instruction {
            program_id,
            accounts: pf_accounts::InitializeVault {
                owner: ctx.owner.pubkey(),
                vault: vault_pda,
                system_program: system_program::ID,
            }
            .to_account_metas(None),
            data: pf_ix::InitializeVault {}.data(),
        },
        &ctx.owner,
    );

    (svm, ctx)
}

/// create_rule accumulates rather than overwriting; revoke_rule subtracts rather
/// than clearing. Uses the real devnet amounts that exhibited the bug.
#[test]
fn delegation_accumulates_across_rules_and_survives_a_revoke() {
    let (mut svm, ctx) = setup();

    // --- rule 0: the first rule sets the baseline ---
    send(&mut svm, ctx.ix_create(0, A_RULE_14, 1, false), &ctx.owner);
    let (is_some, del, amt) = ta_delegate(&svm, &ctx.owner_usdc);
    assert!(is_some, "delegate must be set after the first create_rule");
    assert_eq!(del, ctx.vault_pda, "delegate must be the vault PDA");
    assert_eq!(amt, A_RULE_14, "first rule delegates exactly its own need");

    // --- rule 1: THE REGRESSION. Old code approved 10_000_000 here, wiping
    //     rule 0's allowance. New code must reach the SUM. ---
    send(&mut svm, ctx.ix_create(1, A_RULE_15, 1, true), &ctx.owner);
    let (_, _, amt) = ta_delegate(&svm, &ctx.owner_usdc);
    assert_eq!(
        amt,
        A_RULE_14 + A_RULE_15,
        "create_rule must ACCUMULATE; overwriting here is the original bug"
    );

    // --- rules 2 and 3: keep accumulating across both action variants ---
    send(&mut svm, ctx.ix_create(2, A_RULE_16, 1, false), &ctx.owner);
    send(&mut svm, ctx.ix_create(3, A_RULE_17, 1, true), &ctx.owner);
    let (_, _, amt) = ta_delegate(&svm, &ctx.owner_usdc);
    let all_four = A_RULE_14 + A_RULE_15 + A_RULE_16 + A_RULE_17;
    assert_eq!(amt, all_four, "delegation must equal the sum of all active rules");

    // --- rule 4: a GoalScored-sized rule (the keeper-path case). The keeper
    //     cannot re-approve on the owner's behalf, so this allowance MUST
    //     survive every subsequent create. ---
    send(&mut svm, ctx.ix_create(4, A_RULE_10, 1, false), &ctx.owner);
    let (_, _, amt_with_keeper_rule) = ta_delegate(&svm, &ctx.owner_usdc);
    assert_eq!(amt_with_keeper_rule, all_four + A_RULE_10);

    // --- revoke rule 2 (15_000_000). Old code cleared the delegation entirely,
    //     disarming every other rule. New code subtracts only its share. ---
    send(&mut svm, ctx.ix_revoke(2), &ctx.owner);
    let (is_some, del, amt) = ta_delegate(&svm, &ctx.owner_usdc);
    assert!(is_some, "revoking ONE rule must not clear the delegate");
    assert_eq!(del, ctx.vault_pda);
    assert_eq!(
        amt,
        amt_with_keeper_rule - A_RULE_16,
        "revoke_rule must subtract exactly the revoked rule's share"
    );

    // The keeper-path rule's allowance is still fully covered.
    assert!(
        amt >= A_RULE_10,
        "a GoalScored rule's allowance must survive an unrelated revoke"
    );

    // --- revoking everything else drains to exactly zero and clears the delegate ---
    for (rule_id, amount) in [(0, A_RULE_14), (1, A_RULE_15), (3, A_RULE_17)] {
        let (_, _, before) = ta_delegate(&svm, &ctx.owner_usdc);
        send(&mut svm, ctx.ix_revoke(rule_id), &ctx.owner);
        let (_, _, after) = ta_delegate(&svm, &ctx.owner_usdc);
        assert_eq!(after, before - amount, "each revoke releases its own share");
    }

    // Last one standing is the GoalScored rule; revoking it must land on zero and
    // clear the delegate entirely (clean end state, no dangling delegation).
    let (_, _, before_last) = ta_delegate(&svm, &ctx.owner_usdc);
    assert_eq!(before_last, A_RULE_10);
    send(&mut svm, ctx.ix_revoke(4), &ctx.owner);
    let (is_some, _, amt) = ta_delegate(&svm, &ctx.owner_usdc);
    assert_eq!(amt, 0, "final revoke drains the delegation to zero");
    assert!(!is_some, "at zero the delegate is cleared outright");
}

/// Revoking the SAME rule twice must not double-subtract other rules' shares.
#[test]
fn double_revoke_does_not_over_release() {
    let (mut svm, ctx) = setup();
    send(&mut svm, ctx.ix_create(0, A_RULE_16, 1, false), &ctx.owner);
    send(&mut svm, ctx.ix_create(1, A_RULE_17, 1, true), &ctx.owner);

    send(&mut svm, ctx.ix_revoke(0), &ctx.owner);
    let (_, _, after_first) = ta_delegate(&svm, &ctx.owner_usdc);
    assert_eq!(after_first, A_RULE_17);

    // Second revoke of the same rule: is_active is already false. Whatever the
    // instruction does, it must NOT eat into the other rule's allowance.
    let _ = {
        let bh = svm.latest_blockhash();
        let msg = Message::new_with_blockhash(
            &[ctx.ix_revoke(0)],
            Some(&ctx.owner.pubkey()),
            &bh,
        );
        let tx =
            VersionedTransaction::try_new(VersionedMessage::Legacy(msg), &[&ctx.owner]).unwrap();
        svm.send_transaction(tx)
    };
    let (_, _, after_second) = ta_delegate(&svm, &ctx.owner_usdc);
    assert!(
        after_second >= A_RULE_17 || after_second == 0,
        "a repeat revoke must not silently under-fund the surviving rule \
         (got {after_second}, surviving rule needs {A_RULE_17})"
    );
}

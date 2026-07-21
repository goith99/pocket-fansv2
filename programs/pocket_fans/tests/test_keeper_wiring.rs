//! Runs the keeper WIRING check under `cargo test`, so it cannot silently rot.
//!
//! Same pattern as test_encoder_parity.rs: the logic under test is Node (the
//! keeper daemon), so this shells out to it and fails the Rust suite if it fails.
//!
//! WHAT IT GUARDS: pollWinSettle wiring candidate selection to the CORRECT
//! claimable check. A production bug shipped where it called goalwatch's
//! GoalScored-only decoder, which returns null for every TeamWinVerified rule —
//! the keeper logged "no longer claimable" forever and settled nothing. Every
//! individual component was tested and passing; nothing tested the wiring
//! between them. See oracle-service/scripts/verify-keeper-wiring.cjs.
use std::path::PathBuf;
use std::process::Command;

#[test]
fn keeper_wires_candidate_selection_to_the_correct_claimable_check() {
    let repo = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .canonicalize()
        .expect("resolve repo root");
    let oracle = repo.join("oracle-service");

    // The check reads the Rule fixtures that test_teamwin_verified_clone.rs
    // emits. They are committed, so this does not depend on test ordering.
    let fixture = repo.join("programs/pocket_fans/tests/fixtures/rule_teamwin_verified_swap.bin");
    assert!(
        fixture.exists(),
        "missing {}, regenerate with: cargo test --test test_teamwin_verified_clone dump_teamwin",
        fixture.display(),
    );

    let status = Command::new("node")
        .arg("scripts/verify-keeper-wiring.cjs")
        .current_dir(&oracle)
        .status()
        .expect("failed to run node — is it installed?");

    assert!(
        status.success(),
        "keeper wiring check FAILED — pollWinSettle is not routing rules to the \
         correct claimable check. See the output above.",
    );
}

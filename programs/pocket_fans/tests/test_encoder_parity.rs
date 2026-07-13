//! Pins the two off-chain StatValidationInput encoders to each other AND to the
//! real on-chain struct.
//!
//! The borsh encoder exists twice — app/src/lib/pf.ts (browser) and
//! oracle-service/src/statvalidation.cjs (keeper) — because they cannot share a
//! module: the Next app reaches oracle-service only through a SERVER-ONLY
//! `webpackIgnore` dynamic import (app/src/lib/serverOracle.ts), which browser
//! code cannot use. The duplication is deliberate; this test is what makes it
//! safe.
//!
//! Chain of custody, end to end:
//!   real captured TxLINE payload (tests/fixtures/stat_validation_18179759.json)
//!     -> pf.ts encoder        \
//!                              +-- asserted byte-identical (in the JS harness)
//!     -> statvalidation.cjs   /
//!     -> BOTH deserialized here into the actual StatValidationInput struct
//!
//! If either encoder drifts from the other, or from the program, this fails.
//! Runs under plain `cargo test` (which is what `anchor test` invokes), so it
//! cannot quietly stop being run.
//!
//! Requires node + npx (already required to build/test this Anchor project).
use anchor_lang::AnchorDeserialize;
use pocket_fans::instructions::txoracle::StatValidationInput;
use std::path::PathBuf;
use std::process::Command;

fn repo_root() -> PathBuf {
    // CARGO_MANIFEST_DIR = <repo>/programs/pocket_fans
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .canonicalize()
        .expect("resolve repo root")
}

#[test]
fn ts_and_cjs_encoders_agree_and_match_the_onchain_struct() {
    let root = repo_root();
    let app = root.join("app");
    let out = root.join("target/encoder-parity");

    // Runs the JS harness, which asserts pf.ts === statvalidation.cjs byte-for-byte
    // and emits both encodings for us to deserialize.
    let status = Command::new("npx")
        .args([
            "tsx",
            "scripts/encoder-parity.ts",
            out.to_str().expect("utf8 out path"),
        ])
        .current_dir(&app)
        .status()
        .expect("failed to run `npx tsx scripts/encoder-parity.ts` — is node/npx installed?");

    assert!(
        status.success(),
        "encoder parity harness failed — pf.ts and statvalidation.cjs have DRIFTED. \
         See app/scripts/encoder-parity.ts output above."
    );

    // Both encodings must deserialize into the real on-chain struct, identically.
    let mut decoded = Vec::new();
    for name in ["parity_ts.bin", "parity_cjs.bin"] {
        let raw = std::fs::read(out.join(name))
            .unwrap_or_else(|e| panic!("{name} not produced by the harness: {e}"));
        let mut slice = raw.as_slice();
        let p = StatValidationInput::deserialize(&mut slice)
            .unwrap_or_else(|e| panic!("{name}: borsh deserialize into StatValidationInput failed: {e}"));
        assert!(
            slice.is_empty(),
            "{name}: {} trailing bytes — encoder emitted more than the struct consumes",
            slice.len()
        );
        decoded.push((name, raw, p));
    }

    // Values must match the captured fixture (guards against an encoder that is
    // self-consistent but writes the wrong fields).
    for (name, raw, p) in &decoded {
        assert_eq!(p.fixture_summary.fixture_id, 18_179_759, "{name}: fixture_id");
        assert_eq!(p.ts, 1_782_879_170_255, "{name}: ts");
        assert_eq!(p.stats.len(), 1, "{name}: stats len");
        assert_eq!(p.stats[0].stat.key, 1, "{name}: stat key (1 = home goals)");
        assert_eq!(p.stats[0].stat.value, 2, "{name}: stat value");
        assert_eq!(p.stats[0].stat_proof.len(), 5, "{name}: stat proof depth");
        assert_eq!(p.main_tree_proof.len(), 1, "{name}: main_tree_proof len");
        assert_eq!(p.fixture_proof.len(), 1, "{name}: fixture_proof len");
        println!("{name}: {} bytes -> StatValidationInput OK", raw.len());
    }

    assert_eq!(
        decoded[0].1, decoded[1].1,
        "pf.ts and statvalidation.cjs emitted different bytes"
    );
    println!("encoder parity: pf.ts === statvalidation.cjs === on-chain struct");
}

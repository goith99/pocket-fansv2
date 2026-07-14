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
//! Chain of custody, end to end, for EACH committed fixture:
//!   real captured TxLINE payload (tests/fixtures/stat_validation_*.json)
//!     -> pf.ts encoder        \
//!                              +-- asserted byte-identical (in the JS harness)
//!     -> statvalidation.cjs   /
//!     -> BOTH deserialized here into the actual StatValidationInput struct
//!
//! If either encoder drifts from the other, or from the program, this fails.
//! Runs under plain `cargo test` (which is what `anchor test` invokes), so it
//! cannot quietly stop being run.
//!
//! TWO FIXTURES, DELIBERATELY:
//!   18179759 — end-of-match, subTreeProof depth 1 (a SHALLOW proof)
//!   18187298 — mid-match,    subTreeProof depth 8 (a DEEP proof)
//!
//! The shallow one used to be the only fixture, and that hid a real bug: proof
//! depth drives transaction size, and at realistic mid-match depths
//! execute_rule_verified did not fit in a 1232-byte packet as a legacy
//! transaction — it threw "Transaction too large" at construction, so the rule
//! never fired. A GoalScored rule ALWAYS fires mid-match, so the shallow fixture
//! was the one case that could never occur in production. The JS harness now
//! also asserts the transaction-size bound (see app/scripts/encoder-parity.ts);
//! this test covers the encoding/struct half.
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

    // Expected values per fixture. `fixture_proof_len` is the SIZE-CRITICAL one:
    // it is what drives transaction size (see the module doc). The 18187298 entry
    // must stay DEEP — if a future capture makes it shallow, the size risk stops
    // being covered, and the JS harness fails loudly for exactly that reason.
    struct Expect {
        id: i64,
        ts: i64,
        stat_key: u32,
        stat_value: i32,
        stat_proof_len: usize,
        main_tree_proof_len: usize,
        fixture_proof_len: usize,
    }
    let expected = [
        Expect {
            id: 18_179_759,
            ts: 1_782_879_170_255,
            stat_key: 1,
            stat_value: 2,
            stat_proof_len: 5,
            main_tree_proof_len: 1,
            fixture_proof_len: 1, // shallow: end-of-match outlier
        },
        Expect {
            id: 18_187_298,
            ts: 1_783_281_819_336,
            stat_key: 1,
            stat_value: 0,
            stat_proof_len: 2,
            main_tree_proof_len: 1,
            fixture_proof_len: 8, // DEEP: the realistic mid-match case
        },
    ];

    for e in &expected {
        // Both encodings must deserialize into the real on-chain struct, identically.
        let mut decoded = Vec::new();
        for side in ["ts", "cjs"] {
            let name = format!("parity_{side}_{}.bin", e.id);
            let raw = std::fs::read(out.join(&name))
                .unwrap_or_else(|err| panic!("{name} not produced by the harness: {err}"));
            let mut slice = raw.as_slice();
            let p = StatValidationInput::deserialize(&mut slice).unwrap_or_else(|err| {
                panic!("{name}: borsh deserialize into StatValidationInput failed: {err}")
            });
            assert!(
                slice.is_empty(),
                "{name}: {} trailing bytes — encoder emitted more than the struct consumes",
                slice.len()
            );
            decoded.push((name, raw, p));
        }

        // Values must match the captured fixture (guards against an encoder that
        // is self-consistent but writes the wrong fields).
        for (name, raw, p) in &decoded {
            assert_eq!(p.fixture_summary.fixture_id, e.id, "{name}: fixture_id");
            assert_eq!(p.ts, e.ts, "{name}: ts");
            assert_eq!(p.stats.len(), 1, "{name}: stats len");
            assert_eq!(p.stats[0].stat.key, e.stat_key, "{name}: stat key (1 = home goals)");
            assert_eq!(p.stats[0].stat.value, e.stat_value, "{name}: stat value");
            assert_eq!(p.stats[0].stat_proof.len(), e.stat_proof_len, "{name}: stat proof depth");
            assert_eq!(p.main_tree_proof.len(), e.main_tree_proof_len, "{name}: main_tree_proof len");
            assert_eq!(
                p.fixture_proof.len(),
                e.fixture_proof_len,
                "{name}: fixture_proof depth — this is the SIZE-CRITICAL field; see the module doc"
            );
            println!(
                "{name}: {} bytes, fixture_proof depth {} -> StatValidationInput OK",
                raw.len(),
                p.fixture_proof.len()
            );
        }

        assert_eq!(
            decoded[0].1, decoded[1].1,
            "fixture {}: pf.ts and statvalidation.cjs emitted different bytes",
            e.id
        );
    }

    println!("encoder parity: pf.ts === statvalidation.cjs === on-chain struct (both fixtures)");
}

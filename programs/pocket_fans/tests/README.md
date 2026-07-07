# pocket_fans tests

Two suites, mutually exclusive via the `stub-swap` cargo feature so a build/`.so`
mismatch can't cross-contaminate.

## (b) Program-logic test — `test_logic_stub.rs`
Validates initialize_vault → create_rule (bounded SPL delegation) → execute_rule
(delegated USDC pull + counter) plus negative cases, with the Orca swap **stubbed**.
Runs only WITH `--features stub-swap`.

```bash
cargo build-sbf --features stub-swap          # stub .so at target/deploy/pocket_fans.so
cargo test --features stub-swap --test test_logic_stub
```

## (a) Real-Orca cloned-devnet test — `test_orca_clone.rs`
Runs the REAL Orca Whirlpool `swap` via our `invoke_signed` CPI against the actual
Orca program bytecode + pool accounts cloned from devnet (`tests/fixtures/`), and
asserts wSOL actually settles into the user vault. Runs only in the NON-stub build.

```bash
cargo build-sbf                               # real .so
cargo test --test test_orca_clone -- --nocapture
```

Note: LiteSVM's `Clock` is set just past the cloned pool's
`reward_last_updated_timestamp`, else Orca returns `Custom(6022) InvalidTimestamp`.

## Fixtures (`tests/fixtures/`)
Dumped from devnet on 2026-07-05: `whirlpool_program.so` (Orca program), plus
`whirlpool`, both pool token vaults, two tick arrays, and both mints. Re-dump with
`solana program dump` / `solana account --output json` if the pool state drifts and
the swap test starts failing on tick-array/price bounds. The pool `oracle` account
does not exist on devnet (vestigial in classic `swap`) and is passed empty.

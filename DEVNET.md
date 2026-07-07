# Pocket Fans — Devnet Deployment & Verification

Devnet only. No mainnet activity.

**v2 — self-claim model.** This supersedes the oracle/admin-based verification
below. The oracle signer and `/admin` execute flow have been removed entirely:
`execute_rule` is now signed by the rule's own owner, gated only by an on-chain
time guard (`match_end_ts`). See `README.md` for the full trust-model rationale.
The historical oracle-model sections further down are kept for record only —
none of that flow is live or reachable in this version.

## Program

| Item | Value |
|---|---|
| Program ID | `4f74EBY7KMe8mUP9MpNzRnPzW6LojYX8wm56ZZz3iDgB` (same address — upgraded in place) |
| Upgrade authority | `8L9SoH5Kw4DLw32vUQY4H3PMgkRL9mm9MLDT5z2QEbTd` (deploy wallet = `~/.config/solana/id.json`) |
| Last upgrade slot (v2) | `474579392` |
| Data length (v2 `.so`) | 285,384 bytes (ProgramData capacity 301,720 bytes — no `program extend` needed) |
| anchor-lang / anchor-spl | 1.1.2 · anchor CLI 1.0.2 · solana-cli 3.1.10 |

## PDAs (seeds) — v2

| Account | Seeds | Notes |
|---|---|---|
| `UserVault` | `["vault", owner]` | one per user |
| `Rule` | `["rule", vault, rule_id_u16_LE]` | `rule_id` from `UserVault.total_rules`; now carries `match_id` (u64) + `match_end_ts` (i64), fixed at `create_rule` |

`OracleAuthority` PDA (`["oracle_authority"]`) from v1 still exists on-chain as an
orphaned account (harmless, ~0.001 SOL rent) — the v2 program no longer has any
instruction that reads, writes, or checks it.

## Verified addresses (Orca Whirlpools, devnet) — unchanged from v1

| Item | Address | Notes |
|---|---|---|
| devUSDC mint | `BRjpCHtyQLNCo8gqRUr8jtdAj5AjPYQaoqbvcZiHok1k` | 6 decimals |
| wSOL mint | `So11111111111111111111111111111111111111112` | 9 decimals |
| Whirlpool program | `whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc` | |
| SOL/devUSDC whirlpool | `3KBZiL2g8C7tiJ32hTv5v3KM7aK9htpqTw4cTXz1HvPt` | |
| Whirlpool token vault A (wSOL) | `C9zLV5zWF66j3rZj3uuhDqvfuA8esJyWnruGzDW9qEj2` | |
| Whirlpool token vault B (devUSDC) | `7DM3RMz2yzUB8yPRQM3FMZgdFrwZGMsabsfsKopWktoX` | |
| SPL Token program | `TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA` | classic SPL Token |

`execute_rule` swap CPI = Orca `swap`, discriminator `[248,198,158,145,225,117,135,200]`,
USDC→SOL (`a_to_b=false`, `amount_specified_is_input=true`).

## Live-devnet verification session — self-claim, `live_flow.cjs` (2026-07-07)

RPC: public `api.devnet.solana.com`. Wallet (rule owner, self-claiming):
`8L9SoH5Kw4DLw32vUQY4H3PMgkRL9mm9MLDT5z2QEbTd`.

| Step | Signer | Result |
|---|---|---|
| Source devUSDC (Orca SOL→USDC swap) | owner | `2RqcLDPppkumvu4Ps4XoLSZ34MaduwL4UmFFHVR5JSHcq3eMMsx3n5roc22v4kMcuuAtySPiT7d8oP1UmVp3VSWP` |
| `create_rule` (match_id `1783418093136`, match_end_ts +20s) | owner | `541VcgD5wfDcYAifRUXk67Aje4D2XdsdR4Fa2UabdcGJ6Lf4YK38Ejxbi4aKPR3SkGFEfCqHJVJ6wt6NkQboWzYM` |
| `execute_rule` — **early claim, before match_end_ts** | owner | **Rejected on-chain**: simulation error `0x177f` = `MatchNotFinished` (Anchor custom error code 6015). No signature (rejected in simulation, never sent). |
| *(wait ~25s for match_end_ts to pass)* | — | — |
| `execute_rule` — self-claim after match_end_ts | **owner (no oracle, no admin)** | `2VPMcd7sswNK8wfHUC8Bu6bttH7QE3egjGuTuZnn2qmvM29nZC4kUN2RwAEjavg9vyErvaX5tRW5iHqBGxbNmt1n` |
| `withdraw_from_vault` | owner | `56i1gAviourkW4k78YGrbZePovU57SA7mAo1C27AxCqkj6AaTvybRkkzEnNcqkao8PgZSRgYKdH1NeDCGA5PkDzF` |

Result: `execute_rule` pulled **1.000000 devUSDC** via the owner-granted delegation
and settled **0.044791746 SOL (44,791,746 raw wSOL)** into the vault — real Orca
swap, no oracle involved. `withdraw_from_vault` returned the full amount to the
owner wallet. Vault PDA: `BBgpYGsqcWnTk73nUY22uG5sRUZPahKfZdCTrmaVxe9C`; rule PDA
(rule_id 1): `3vxnGc7tCPgh4N7YYEmYU5Lcw6ycRhfUgRb1mrPEqJPZ`.

**Why the early-claim rejection matters:** the whole self-claim model rests on
the time guard being the *only* gate — there is no oracle to fall back on if it
didn't work. Error `0x177f` decodes to `MatchNotFinished`, the exact error
`programs/pocket_fans/src/error.rs` defines for this check (not a generic
failure, not an unrelated account error) — confirming the guard is live and
correctly wired, not merely absent-and-coincidentally-failing.

## Notes on this session

- Public RPC (`api.devnet.solana.com`) was sufficient for this flow (a handful
  of sequential transactions). It was **not** sufficient for the initial
  program *upgrade* deploy (many small buffer-write transactions in a tight
  loop hit `Blockhash expired` / max retries) — that step needed a paid RPC
  (Alchemy/Helius) plus `--max-sign-attempts 100 --use-rpc`. Rule of thumb:
  paid RPC for deploys, public RPC is workable for ordinary user transactions.
- No devnet airdrop or extra funding was needed — the wallet already held
  enough SOL/devUSDC from prior sessions.

---

## Historical: v1 oracle-model verification (superseded, kept for record)

Everything below refers to the **removed** oracle/admin flow
(`initialize_oracle_authority`, `oracle_signer`, `/admin`). It no longer applies
to this program version and is retained only so past reasoning isn't lost.

### PDAs (seeds) — v1

| Account | Seeds | Notes |
|---|---|---|
| `OracleAuthority` (singleton) | `["oracle_authority"]` | PDA `F3Ay739bpDNmHsEaRKrzbpRDQHSeqeqf8Ut73NgUt918` |
| `OracleAuthority.authority` | — | `8L9SoH5Kw4DLw32vUQY4H3PMgkRL9mm9MLDT5z2QEbTd` (deploy wallet; used to sign `execute_rule`) |

### Live-devnet verification session — transaction signatures (2026-07-05)

| Step | Signature |
|---|---|
| Deploy (resumed from buffer) | `YabDJFzUzDwqKusej8AvCcDmsjeh1weXwer7r6iJU9Cm2mdbyGWVQPuc5uDESCst8dDEyxfDqPQYgvUuVXD4HNJ` |
| Source devUSDC (Orca SOL→USDC swap) | `5iKtE7AhYga2Enw7H9S8FJ4jZBpQ1Gyc6N6DAhysNgSXLxPUsfDoyk2iKCkjcc5TYxFEtZcWaznDvxXo8uR2E22G` |
| `initialize_oracle_authority` | `4mPjxymnSaFw7jzTqWAXrCVZTZBsv8tRdLArjfkjW8T5FbKfFuE4Fe4aAQLauyWFYKEBZ8oN17opuuEinutdJ65Y` |
| `initialize_vault` | `5mky9FV7FzQepb3MmfVf581assLmrtW4YQgZSfXRX5Qj1gLipQaKbPPexC6df6P7Zejx9jnfCT7jdxKTzjsGUtVP` |
| `create_rule` | `5hMP9XpFGr9mWKXVCc2irbqUcLLwbvXpReZYTWiepyn6m1eEXHLSKi6Ju3Hrr7Kks5PL7DZT3seta2fqNADQw5ZS` |
| `execute_rule` (oracle-signed) | `32nXtfNytEaxwrj4uBJXJ84MejmdehbhY9iffXGrpPqzNrWhUhKB7cRUWscrFGgACdSvPQYiocqnETHfLhTa1VwB` |
| `withdraw_from_vault` | `4csAmhH2LVWEoExZDJUaGG4XcnnYzW2cykCPRDBp4GXxcT8ubCCT3DQ1KivuQQnM5oVoNtJdXwVJXUAnq4YgSNWD` |

### Frontend verification (manual, real browser) — v1 oracle flow

- Privy login via Google OAuth succeeded; embedded Solana wallet auto-created:
  `Ax9Ag5691p3XiKvLR9i913wcTcmHzNcj5ohbdSxii9tN`.
- `create_rule` ran end-to-end from the UI (Portugal rule, tx
  `3axWhMZJhPNf1QbJ31wk6KYhybUuFYtHXb4Bd57tss81WvqSFW8zKwRRZEFfouNrYfRpcRgaWDkjH7QcBHd4C3nj`).
- `/admin` oracle `execute_rule` (Solflare = OracleAuthority signer, Mexico
  rule): `2cNYNHrHVeuJSCvNbQEEwm2DnVheUyhAFoQJiffQwsdctiPKSRLoQmVnbteBssVYtESWLCq5tgp6jnSqG3kjVug6`.
- `withdraw_from_vault` (Privy, returned 0.004479 wSOL):
  `5xCEaHF99waFxLABhTR6p1EAFhGm1QAWtvGgzrHhPp7w75ASFLwku35bGsiT2wCZtCmaryiErXDwg4jtdaPNJY4D`.
- `revoke_rule` (Privy, rule#0, delegation cleared):
  `4KrrHorjw83N6PgK5ScZMBFYwt2J1Z1tUHxixdREthshbyBcQHSNHGESqhigZWLVHL89wN3SS72GXFoJrnW5Jpf4`.

### Vault-ATA bug (found & fixed 2026-07-06, v1)

**Symptom:** clicking "Execute Rule" on `/admin` for the Mexico rule made
Solflare show *"Simulation failed — this transaction couldn't be simulated."*

**Root cause:** `vault_usdc_ata` / `vault_wsol_ata` didn't exist yet —
`create_rule` never created them (plain `token::` accounts, no
`init_if_needed`).

**Fix in v1:** `/admin`'s build-execute step pre-created missing vault ATAs
(oracle-side workaround) and `UserDashboard.tsx`'s `createRule` was updated to
create them at rule-creation time (permanent fix).

**In v2:** this is moot — there is no `/admin` step. `createChallenge` in
`app/src/lib/useFanApp.ts` creates the vault's devUSDC + wSOL ATAs directly at
`create_rule` time (same permanent fix, now the only path).

## Notes (general)

- Devnet public faucet + free-tier RPCs are rate-limited / may block
  `getProgramAccounts`; use a paid RPC (Alchemy for sends, Helius for
  `getProgramAccounts`) for anything beyond light, occasional reads.
- Some devnet RPC providers don't serve WebSocket `signatureSubscribe`;
  confirm via HTTP `getSignatureStatuses` polling instead (see `live_flow.cjs`).

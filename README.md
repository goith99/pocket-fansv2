# Pocket Fans

Automated, non-gambling match-day savings for football fans — built on Solana. **Devnet only.**

## What it is

Pick a team. Set a save amount. When the match condition is met, a fixed amount of your **own** USDC is swapped into **SOL** — either straight into your wallet or staked into mSOL. No odds, no opponent, no house: this isn't gambling, it's a savings habit built around the sport fans already watch.

Built for the TxODDS × Superteam × Solana World Cup Hackathon — Consumer & Fan Experiences track.

## What "saving" means here

Each time a challenge fires, `amount_usdc` is pulled from the user's wallet **via a bounded SPL delegation they granted themselves** at challenge creation (cumulative across rules — `create_rule` adds to the running total and `revoke_rule` subtracts only its own share, so rules never invalidate each other), swapped USDC → wSOL through a real Orca Whirlpools CPI (slippage-protected `min_out` derived from the pool's live `sqrt_price`), and delivered as SOL savings.

There is **no way to lose funds to a counterparty**: nothing is staked against anyone, no payout depends on being "right", and funds only ever move from the user's wallet to the user's own wallet or vault. The match decides *when* the fan is nudged to move their own money out of a stablecoin — not whether they keep it.

Standard devnet caveats apply: devUSDC and a devnet Orca pool mean swap pricing and liquidity are not representative, and slippage defaults (1500 bps) are tuned for a thin pool.

## Triggers

### Team Wins — self-claim, time-guarded ✅ live

The user signs their own claim. The only on-chain gate is a **time guard**: the claim instruction requires `Clock::unix_timestamp >= rule.match_end_ts`, where `match_end_ts` = the fixture's kickoff + 3h, fixed at creation. No oracle, no privileged key — nothing but the user's own signature can move their funds.

Match results appear in the UI (read-only, from TxLINE) as information for the fan, **not** as an on-chain condition. Claiming when your team didn't win just means you saved into SOL anyway, which is the behaviour the app exists to encourage.

### Goal Scored — permissionless keeper + on-chain oracle proof ⚠️ creation currently disabled

A fundamentally different trust model, in its own instruction (`execute_rule_verified`). **No signer identity is trusted at all.** Anyone may submit the claim — a keeper bot, or the owner themselves as fallback — and the only gate is a CPI into TxODDS's on-chain **Txoracle** `validate_stat_v2`, which must verify a Merkle proof that the pinned stat reached its threshold. The program builds the comparison strategy itself and pins `fixture_id` + `stat_key` on-chain, so a caller cannot substitute another match's or another stat's proof.

**The on-chain instruction works and has fired successfully on devnet.** However, **creating new Goal Scored rules is disabled in the UI** (`GOALSCORED_CREATION_ENABLED = false` in `app/src/lib/constants.ts`), enforced inside `createGoalChallenge` itself rather than only on the UI chip, so no page can bypass it. This is now a deliberate hold rather than a blocker: the shared-delegation bug that originally forced it has been fixed in the program. Existing on-chain Goal Scored rules are unaffected.

The keeper loop that watches live matches is separately gated by `GOAL_WATCH_ENABLED` (default `false`) in the poller service.

## Save actions

| Action | Result | Instructions |
| --- | --- | --- |
| **Auto DCA** | USDC → wSOL | `execute_rule` (vault), `execute_rule_direct` (wallet) |
| **Auto Stake** | USDC → wSOL → unwrapped → Marinade deposit → mSOL | `execute_rule_staked` (vault), `execute_rule_staked_direct` (wallet) |

Both actions have **two variants**. The original ones land funds in the user's vault PDA, requiring a separate `withdraw_from_vault` to collect — and because the exact swap output isn't known until the swap executes, that chained withdraw had to target a slippage-floor amount, stranding dust in the vault on every claim.

The **`_direct` variants** collapse this into a single instruction that delivers the full output straight to the user's wallet, with **zero dust and no second transaction**. The vault PDA still signs the swap/deposit; only the output account differs. Both are additive — the vault-landing instructions remain in the program untouched.

**The app currently uses the `_direct` variants for both actions.** The vault-landing instructions and any funds already sitting in a vault from earlier claims remain fully usable and withdrawable.

## How it works

1. **Log in with Google** — an embedded Solana wallet is created automatically (Privy). No seed phrase.
2. **Create a challenge** — pick a team and an amount. The app pins the challenge to that team's next fixture (TxLINE fixture id + kickoff) and you approve one bounded token delegation in your own wallet.
3. **Claim** — once the time guard has elapsed (Team Wins), a **Claim** button appears. You sign; the swap runs on-chain and the SOL or mSOL lands in your wallet.
4. **Withdraw** — anything held in the vault from earlier claims is always yours to take back.

## Architecture

- **Program** (`programs/pocket_fans`) — Anchor program on Solana devnet. Generic `TriggerType` / `ActionType` enums so new triggers and actions can be added without migrating existing accounts.
- **Frontend** (`app`) — Next.js on Vercel. Google/Privy login. The browser builds and the user signs *every* transaction; there is no server-side signer and no admin panel.
- **Fixtures cache** (Supabase) — `fixtures_cache`, the single source of schedule/result data the app reads. The app never calls TxLINE directly.
- **Poller / keeper** (`oracle-service`, Railway) — a long-running daemon, the only thing that calls TxLINE for schedule data. Keeps `fixtures_cache` fresh and (when enabled) runs the Goal Scored keeper loop. The keeper is **unprivileged**: it pays fees and submits transactions but has no authority over user funds.
- **TxLINE / Txoracle** (TxODDS) — TxLINE provides fixture schedules and results (read-only, for display and for pinning `match_id`). Txoracle is the on-chain program that `execute_rule_verified` CPIs into for Merkle-proof verification.

## Program instructions

| Instruction | Signer | Purpose |
| --- | --- | --- |
| `initialize_vault` | user | Create the user's vault PDA (one per wallet) |
| `create_rule` | user | Create a rule + grant the bounded SPL delegation |
| `execute_rule` | user (self-claim) | Team Wins → swap to wSOL **in the vault** |
| `execute_rule_direct` | user (self-claim) | Team Wins → swap to wSOL **straight to wallet** |
| `execute_rule_staked` | user (self-claim) | Team Wins → swap + Marinade → mSOL **in the vault** |
| `execute_rule_staked_direct` | user (self-claim) | Team Wins → swap + Marinade → mSOL **straight to wallet** |
| `execute_rule_verified` | **anyone** (oracle-gated) | Goal Scored → Txoracle proof required, then swap |
| `revoke_rule` | user | Deactivate a rule and release its share of the delegation |
| `withdraw_from_vault` | user | Withdraw saved tokens (mint-generic: wSOL or mSOL) |

## Deployment

| Item | Value |
| --- | --- |
| Network | **Solana devnet** |
| Program ID | `4f74EBY7KMe8mUP9MpNzRnPzW6LojYX8wm56ZZz3iDgB` |
| Token | devUSDC (6dp) via a devnet Orca SOL/devUSDC Whirlpool |
| Staking | Marinade (same program addresses on devnet and mainnet) |

Instruction-level transaction signatures and verification steps are in [DEVNET.md](DEVNET.md). Note that DEVNET.md documents earlier verification sessions and its program metadata (slot, `.so` size) reflects an older upgrade — the program has been upgraded in place since.

## Known limitations

**This is a devnet hackathon project. It has not been audited and is not production-ready.**

- **Goal Scored creation is disabled** (`GOALSCORED_CREATION_ENABLED = false`). The instruction works and has fired on devnet, and the shared-delegation blocker that originally forced this is now fixed — re-enabling is a deliberate decision still to be made, pending an end-to-end run of the keeper path.
- **The keeper loop is off by default** (`GOAL_WATCH_ENABLED=false`), gated on keeper funding and TxLINE stat-validation access.
- **A stuck fixture status is possible.** If the poller is down when a match finalises, its cached status can remain `live` indefinitely. This affects display only — claims are gated on the rule's own `match_end_ts`, not on cached status.
- **mSOL is displayed as SOL** in some balance views. The rate is ~1.0013, so this understates slightly.
- **One dev-only route** (`/dev/direct-rule`) remains as a throwaway test harness and should be removed before any real release.

## Tech stack

Solana · Anchor · Orca Whirlpools · Marinade · TxODDS TxLINE + Txoracle · Privy · Next.js · TypeScript · Supabase · Railway

## Running locally

Verified toolchain: anchor-cli 1.0.2 · solana-cli 3.1.10 (Agave) · rustc/cargo 1.95.0 · Node v22.

### Program (Anchor)

```
anchor build
anchor test   # litesvm + `cargo test` harness (Anchor.toml: test = "cargo test")
```

`Anchor.toml` sets `cluster = "localnet"`; deploy to devnet with `anchor deploy --provider.cluster devnet`.

### Frontend (Next.js)

```
cd app
npm install
cp .env.local.example .env.local   # then fill in the values below
npm run dev                        # serves on http://localhost:3055
```

`app/.env.local` — set these variable **names** (never commit real values):

- `NEXT_PUBLIC_PRIVY_APP_ID` — public, client-side Privy app id
- `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` — server-only, for the fixtures cache
- `HELIUS_RPC_URL` — server-only, `getProgramAccounts`-capable devnet RPC
- `TXLINE_API_TOKEN` — server-only TxLINE token

### Poller / keeper (`oracle-service`)

Requires `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` and `TXLINE_API_TOKEN`. The Goal Scored keeper loop additionally requires `GOAL_WATCH_ENABLED=true` and a funded keeper keypair.

### Live devnet E2E (`live_flow.cjs`)

```
RPC_URL=<paid devnet rpc> node live_flow.cjs
```

Runs the self-claim flow against real devnet: sources devUSDC, creates a rule with a ~20s `match_end_ts`, **proves the time guard rejects an early claim**, waits it out, self-claims through the real Orca swap, and withdraws. Note this script exercises the original vault-landing `execute_rule`, not the `_direct` variant the app now uses.

## License

MIT

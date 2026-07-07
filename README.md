# Pocket Fans

Automated, non-gambling match-day savings for football fans — built on Solana.

## What it is

Pick a team. Set a save amount. After their match, tap **Claim** — and your own USDC is swapped into **$SOL** and lands in a savings vault you fully control. No odds, no opponent, no house, no oracle, no admin: this isn't gambling, it's a savings habit built around the sport fans already watch.

Built for the TxODDS × Superteam × Solana World Cup Hackathon — Consumer & Fan Experiences track.

## What does "saving" mean here?

**Saving = Victory DCA into $SOL.** Each time a challenge fires, a fixed amount of the user's **own devUSDC** is swapped to **wSOL ($SOL)** through a real Orca Whirlpools CPI and credited to a vault PDA that only the user can withdraw from. Think of it as dollar-cost averaging (DCA) into SOL, where the *rhythm* of the DCA is set by your team's match days instead of a calendar.

Concretely, per claim:

1. `amount_usdc` (e.g. 1.00 devUSDC) is pulled from the user's wallet **via a bounded SPL delegation the user granted themselves** at challenge creation (capped at `amount × max_executions`, revocable anytime).
2. That USDC is swapped USDC → wSOL on Orca (slippage-protected `min_out` computed from the pool's live `sqrt_price`).
3. The wSOL lands in the user's vault PDA — their growing **$SOL savings**.
4. `withdraw_from_vault` returns it to their wallet whenever they want.

There is **no way to lose funds**: no stake is ever at risk, no counterparty takes the other side, and no payout depends on being "right". The only thing a match decides is *when* the fan is nudged to move their own money from a stablecoin into SOL.

## How it works

1. **Log in with Google** — an embedded Solana wallet is created automatically (Privy). No seed phrase.
2. **Create a challenge** — pick a team and a save amount. The app pins the challenge to that team's next fixture (TxLINE fixture id + kickoff time) and you approve one bounded token delegation, in your own wallet.
3. **Match day passes, you claim** — once the fixture's time window (`match_end_ts` = kickoff + 3h) has elapsed, a **Claim** button appears. You tap it, your wallet signs, and the USDC → $SOL swap runs on-chain. That's the saving.
4. **Withdraw anytime** — your savings are always yours to take back.

## Trust model — read this

**This program has no oracle and no admin. Every instruction is signed by the user themselves.**

The previous iteration verified match results through a manually-attended oracle signer. That has been removed entirely — deliberately. The reasoning:

- The funds in Pocket Fans are **always the user's own money with no counterparty**. A "false" claim (claiming when your team didn't win) just means you voluntarily saved into $SOL anyway — which is the healthy behavior the app exists to encourage, not an exploit. There is nothing for an oracle to protect.
- Removing the oracle removes the **single most dangerous trust assumption**: a privileged key that could decide when (or whether) user funds move. Now no key other than the user's can ever trigger a swap of their funds.
- The only on-chain gate is a **time guard**: `execute_rule` requires `Clock::unix_timestamp >= rule.match_end_ts`, fixed at creation from the fixture's kickoff time. This preserves the match-day ritual ("claim after the final whistle") without introducing any trusted party.

Match results still appear in the UI — fetched read-only from TxLINE — as information for the fan, not as an on-chain condition.

## Live proof, not simulation

Every instruction in the program has a real, finalized Solana devnet transaction behind it — created and signed through the actual browser UI, not just local tests. Full signatures, addresses, and verification steps are in [DEVNET.md](DEVNET.md).

| Instruction           | Signer         | Status              |
| --------------------- | -------------- | ------------------- |
| `initialize_vault`    | user           | ✅ Verified on devnet |
| `create_rule`         | user           | ✅ Verified on devnet |
| `execute_rule`        | **user (self-claim)** | ✅ Verified on devnet (real Orca swap) |
| `withdraw_from_vault` | user           | ✅ Verified on devnet |
| `revoke_rule`         | user           | ✅ Verified on devnet |

## Architecture

- **Program** (`programs/pocket_fans`) — Anchor program on Solana. Generic `TriggerType` / `ActionType` enums so new triggers (goal scored, corner, cards) and actions (staking, round-up) can be added without migrating existing accounts. Currently live: `TeamWin` display intent → `SwapAndSave` action (Victory DCA into $SOL) via a real Orca Whirlpools CPI. Rules carry `match_id` (TxLINE fixture) + `match_end_ts` (claimable-after timestamp), both fixed at creation.
- **Frontend** (`app`) — Next.js. Google/Privy login, light consumer-facing design. The browser builds and the user signs *every* transaction, including the claim itself — there is no server-side signer and no admin panel.
- **TxLINE data** (`oracle-service` + `/api/schedule`, `/api/challenges/results`) — read-only fixture schedules and results for display. Never signs, never touches the program.

## Tech stack

Solana · Anchor · Orca Whirlpools · TxLINE (TxODDS, read-only) · Privy · Next.js · TypeScript

## Running locally

Verified toolchain: anchor-cli 1.0.2 · solana-cli 3.1.10 (Agave) · rustc/cargo 1.95.0 · Node v22.

### Program (Anchor)

From the repo root:

```
anchor build
anchor test   # litesvm + `cargo test` harness (Anchor.toml: test = "cargo test")
```

### Frontend (Next.js)

```
cd app
npm install
cp .env.local.example .env.local   # then fill in the values below
npm run dev                        # serves on http://localhost:3055
```

`app/.env.local` — set these variable **names** (never commit real values):

- `NEXT_PUBLIC_PRIVY_APP_ID` — public, client-side Privy app id
- `HELIUS_RPC_URL` — server-only, `getProgramAccounts`-capable devnet RPC
- `TXLINE_API_TOKEN` — server-only TxLINE token

### Live devnet E2E (`live_flow.cjs`)

```
RPC_URL=<paid devnet rpc> node live_flow.cjs
```

Runs the full self-claim flow against real devnet: sources devUSDC, creates a rule with a ~20s `match_end_ts`, **proves the time guard rejects an early claim**, waits it out, self-claims through the real Orca swap, and withdraws.

## License

MIT

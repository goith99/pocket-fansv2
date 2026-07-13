// Central config. Env-driven with devnet-safe defaults. Nothing here signs or
// reaches the network. Mirrors the Witness daemon's .env-fallback pattern so the
// TxLINE token is reused from ../../shroudline/.env rather than copied here.
const fs = require('fs');
const os = require('os');
const path = require('path');

function loadDotEnv(file) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    if (process.env[m[1]] !== undefined) continue; // real env wins
    process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}
// oracle-service/.env first, then the shared shroudline/.env for API creds.
loadDotEnv(path.resolve(__dirname, '../.env'));
loadDotEnv(path.resolve(__dirname, '../../../shroudline/.env'));

const num = (k, d) => (process.env[k] !== undefined ? Number(process.env[k]) : d);
const list = (k) => (process.env[k] || '').split(',').map((s) => Number(s.trim())).filter((n) => Number.isFinite(n) && n > 0);

const config = {
  // --- Solana (devnet) ---
  // The oracle needs getProgramAccounts (to enumerate Rule accounts). The repo's
  // Alchemy endpoint is FREE-tier and blocks gPA, so prefer a gPA-capable RPC:
  // explicit RPC_URL, else HELIUS_RPC_URL (read from ../../shroudline/.env), else
  // Alchemy as a last resort (works for everything except gPA).
  rpcUrl: process.env.RPC_URL || process.env.HELIUS_RPC_URL || 'https://api.devnet.solana.com',
  // Whether a gPA-capable RPC was EXPLICITLY configured, vs. us silently
  // falling back to the public devnet endpoint. The goal-watch loop depends on
  // getProgramAccounts, which the public endpoint rate-limits hard — that
  // degrades into intermittent "no rules found" rather than a clean error, so
  // the loop refuses to start without a real RPC (see the guard below).
  rpcExplicitlyConfigured: !!(process.env.RPC_URL || process.env.HELIUS_RPC_URL),
  programId: process.env.PROGRAM_ID || '4f74EBY7KMe8mUP9MpNzRnPzW6LojYX8wm56ZZz3iDgB',
  // On-chain OracleAuthority.authority (the deploy/upgrade-authority wallet).
  // Recorded for reporting only — the dry-run loads NO keypair and never signs.
  expectedOracleAuthority: '8L9SoH5Kw4DLw32vUQY4H3PMgkRL9mm9MLDT5z2QEbTd',

  // --- TxLINE API ---
  apiOrigin: process.env.TXLINE_API_ORIGIN || 'https://txline-dev.txodds.com',
  apiToken: process.env.TXLINE_API_TOKEN, // required; checked at startup with a clear error
  competitionId: num('COMPETITION_ID', 72), // World Cup

  // --- fixture windows (hours relative to StartTime) ---
  finalizeAfterH: num('FINALIZE_AFTER_H', 3), // consider a fixture finalizable this long after kickoff
  knockoutFixtureIds: list('KNOCKOUT_FIXTURE_IDS'),
  probeFixtureIds: list('PROBE_FIXTURE_IDS'), // extra ids to probe (finished fixtures drop off snapshot)

  // --- persistence / logging ---
  logFile: process.env.LOG_FILE || path.resolve(__dirname, '../logs/oracle.log'),

  // --- Supabase (fixtures cache) ---
  // Written by poller.cjs (this service, on Railway), read by the Next.js app
  // (app/src/lib/serverSupabase.ts, on Vercel). Both sides use the SAME
  // service-role key — this table is never exposed to the browser.
  supabaseUrl: process.env.SUPABASE_URL,
  supabaseServiceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY,

  // --- GoalScored keeper (execute_rule_verified) ---
  // The DEDICATED keeper identity that signs and pays for execute_rule_verified.
  // NOT a user wallet, holds no user funds — it only pays tx fees.
  //
  // The keeper is UNPRIVILEGED by design: execute_rule_verified trusts no
  // signer, only the Txoracle CPI verdict. A compromised keeper can waste its
  // own SOL on fees; it cannot move or steal user funds.
  //
  // TWO WAYS to supply it, because Railway (and most PaaS) have no file mounts:
  //   KEEPER_SECRET_KEY  — the secret key as a JSON array string, e.g. "[12,34,...]".
  //                        Set it in the platform's secret store. PREFERRED, and
  //                        wins if both are set.
  //   KEEPER_KEYPAIR_PATH — path to a keypair file. For LOCAL DEV. Defaults to
  //                        ~/.config/solana/pocket-fans-keeper.json. Generate with:
  //                        solana-keygen new --no-bip39-passphrase -o <path>
  // The file lives outside the repo so it can never be committed; the inline
  // secret must never be written into a repo file either — set it in the
  // platform dashboard only.
  keeperSecretKey: process.env.KEEPER_SECRET_KEY || null,
  keeperKeypairPath: process.env.KEEPER_KEYPAIR_PATH || path.join(os.homedir(), '.config/solana/pocket-fans-keeper.json'),
  /** True only if KEEPER_KEYPAIR_PATH was set explicitly (not the default). */
  keeperKeypairPathExplicit: !!process.env.KEEPER_KEYPAIR_PATH,

  // How often to check live fixtures that have an open GoalScored rule.
  pollGoalWatchMs: num('POLL_GOAL_WATCH_MS', 15_000),

  // MASTER SWITCH for the goal-watch loop. Stays false until (1) the keeper is
  // funded with devnet SOL and (2) TxLINE has confirmed /scores/stat-validation
  // access for our token. The loop is not even scheduled while this is false.
  goalWatchEnabled: process.env.GOAL_WATCH_ENABLED === 'true',

  // --- poller intervals (ms) ---
  // How often to re-pull the forward fixture list (catches newly announced
  // fixtures / schedule changes). Cheap call, no need to run it often.
  pollForwardMs: num('POLL_FORWARD_MS', 5 * 60_000), // 5 min
  // How often to check in-progress fixtures (kickoff has passed, not yet
  // finished) for a final-whistle event. This is the one that matters for UX
  // latency — lower = fresher "finished" status, at the cost of more TxLINE
  // calls. 20s keeps well within the free SL1 tier's lack of rate limit.
  pollLiveMs: num('POLL_LIVE_MS', 20_000),

  // Hard safety for the TeamWin/self-claim path (dryrun.cjs): that path NEVER
  // loads a signer and never sends a tx — TeamWin rules are claimed by the user
  // themself in the app, never by this service.
  //
  // SCOPE NOTE: this flag does NOT cover the GoalScored keeper loop, which is a
  // different trust model entirely (permissionless, oracle-gated) and DOES sign
  // with its own fee-payer keypair. That loop has its own switch above
  // (goalWatchEnabled), off by default.
  dryRun: true,
};

// ---------------------------------------------------------------------------
// Startup validation — ONLY for the goal-watch loop.
//
// Scoped deliberately: this module is also loaded by the Next.js app (via the
// server-only import in app/src/lib/serverOracle.ts) and by the TeamWin dry-run,
// neither of which sets GOAL_WATCH_ENABLED. So these throws can only ever fire
// in the one process that actually needs them — the keeper.
//
// The failure this prevents: on Railway the ../../shroudline/.env fallback does
// not exist, so RPC_URL/HELIUS_RPC_URL silently resolve to the PUBLIC devnet
// endpoint. getProgramAccounts there is heavily rate-limited, which surfaces as
// the loop intermittently seeing zero open rules — a silent no-op, not an error.
// Better to refuse to start.
// ---------------------------------------------------------------------------
if (config.goalWatchEnabled) {
  const missing = [];
  if (!config.rpcExplicitlyConfigured) {
    missing.push(
      'RPC_URL or HELIUS_RPC_URL — the goal-watch loop needs a getProgramAccounts-capable RPC.\n' +
      '    Falling back to the public devnet endpoint would rate-limit gPA and make the loop\n' +
      '    silently find no rules. Set one explicitly.',
    );
  }
  // No usable identity = no inline secret AND no keypair file actually on disk.
  // Checked by EXISTENCE, not by whether the var was set: an explicitly-set
  // KEEPER_KEYPAIR_PATH pointing at a missing file is exactly the Railway
  // failure we're trying to catch.
  if (!config.keeperSecretKey && !fs.existsSync(config.keeperKeypairPath)) {
    missing.push(
      'KEEPER_SECRET_KEY (JSON array string) or KEEPER_KEYPAIR_PATH — no keeper identity found.\n' +
      `    No keypair file at ${config.keeperKeypairPath}${config.keeperKeypairPathExplicit ? '' : ' (the default)'}.\n` +
      '    On a platform without file mounts (Railway), set KEEPER_SECRET_KEY in the dashboard\n' +
      '    secret store instead.',
    );
  }
  if (!config.apiToken) {
    missing.push('TXLINE_API_TOKEN — required to fetch score snapshots and stat-validation proofs.');
  }
  if (missing.length) {
    console.error(
      '[config] GOAL_WATCH_ENABLED=true but the goal-watch loop is not fully configured:\n' +
        missing.map((m) => `  - ${m}`).join('\n') +
        '\nSee oracle-service/.env.example. Refusing to start rather than run a silently broken keeper.',
    );
    process.exit(1);
  }
}

module.exports = { config };

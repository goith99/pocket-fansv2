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

  // Hard safety: this build is DRY-RUN only. No signer is ever loaded.
  dryRun: true,
};

module.exports = { config };

// Read-only on-chain access: enumerate Rule accounts via getProgramAccounts and
// decode them by hand (layout mirrors programs/pocket_fans/src/state.rs). No IDL
// dependency, no signing.
const crypto = require('crypto');

// @solana/web3.js is required directly when it resolves from here — the standalone
// dry-run (`node src/dryrun.cjs`) and local dev, where repo-root node_modules is on
// the resolution path. On Vercel these oracle-service modules are loaded via an
// external `webpackIgnore` import from a sibling dir where web3.js is NOT on that
// path, so this require throws; there the Next app (which bundles web3.js) injects
// PublicKey via init(). See app/src/lib/serverOracle.ts.
let PublicKey;
try {
  ({ PublicKey } = require('@solana/web3.js'));
} catch {
  /* not resolvable in this context — caller must call init({ PublicKey }) before use */
}

// Inject web3 primitives from a context where they resolve (the Next.js app bundle).
function init(deps) {
  if (deps && deps.PublicKey) PublicKey = deps.PublicKey;
}

const anchorDisc = (kind, name) => crypto.createHash('sha256').update(`${kind}:${name}`).digest().subarray(0, 8);
const RULE_DISC = anchorDisc('account', 'Rule');
const RULE_SIZE = 128; // 8 disc + 32 vault + 2 rule_id + 5 trigger + 43 action + 2 + 2 + 1 + 1 + 32

// Rule layout offsets (into the full account data, disc included)
function decodeRule(pubkey, data) {
  if (data.length !== RULE_SIZE || !data.subarray(0, 8).equals(RULE_DISC)) return null;
  const triggerTag = data[42];        // 0 = TeamWin (only variant)
  const actionTag = data[47];         // 0 = SwapAndSave (only variant)
  return {
    pubkey: pubkey.toBase58(),
    vault: new PublicKey(data.subarray(8, 40)).toBase58(),
    ruleId: data.readUInt16LE(40),
    triggerKind: triggerTag === 0 ? 'TeamWin' : `unknown(${triggerTag})`,
    teamId: triggerTag === 0 ? data.readUInt32LE(43) : null,
    actionKind: actionTag === 0 ? 'SwapAndSave' : `unknown(${actionTag})`,
    amountUsdc: actionTag === 0 ? data.readBigUInt64LE(48).toString() : null,
    targetMint: actionTag === 0 ? new PublicKey(data.subarray(56, 88)).toBase58() : null,
    maxSlippageBps: actionTag === 0 ? data.readUInt16LE(88) : null,
    maxExecutions: data.readUInt16LE(90),
    executionsDone: data.readUInt16LE(92),
    isActive: data[94] === 1,
  };
}

// All Rule accounts for the program.
async function getAllRules(connection, programId) {
  const accts = await connection.getProgramAccounts(new PublicKey(programId), {
    filters: [{ dataSize: RULE_SIZE }],
  });
  return accts.map((a) => decodeRule(a.pubkey, a.account.data)).filter((r) => r !== null);
}

// Only rules the oracle should act on: active TeamWin rules with executions left.
async function getActiveTeamWinRules(connection, programId) {
  const all = await getAllRules(connection, programId);
  return all.filter((r) => r.triggerKind === 'TeamWin' && r.isActive && r.executionsDone < r.maxExecutions);
}

// UserVault.owner (needed to derive the user's/vault's ATAs for a would-be tx).
// UserVault layout: 8 disc + owner(32) + ...
async function getVaultOwner(connection, vaultPubkey) {
  const info = await connection.getAccountInfo(new PublicKey(vaultPubkey));
  if (!info) return null;
  return new PublicKey(info.data.subarray(8, 40)).toBase58();
}

// OracleAuthority.authority (for the startup sanity check / reporting).
async function getOracleAuthority(connection, programId) {
  const pda = PublicKey.findProgramAddressSync([Buffer.from('oracle_authority')], new PublicKey(programId))[0];
  const info = await connection.getAccountInfo(pda);
  return {
    pda: pda.toBase58(),
    authority: info ? new PublicKey(info.data.subarray(8, 40)).toBase58() : null,
  };
}

module.exports = { init, getAllRules, getActiveTeamWinRules, getVaultOwner, getOracleAuthority, anchorDisc, RULE_DISC };

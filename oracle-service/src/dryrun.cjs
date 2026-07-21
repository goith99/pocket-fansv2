// Pocket Fans oracle — DRY RUN.
//
// Loads NO signing key and sends NO transaction. It:
//   1. reads active TeamWin rules on-chain (getProgramAccounts, decoded),
//   2. discovers relevant fixtures (snapshot + persisted state + PROBE ids),
//   3. for finalized ones, determines the winning team_id from TxLINE, and
//   4. LOGS exactly what execute_rule it WOULD submit (never signs/sends).
//
// Fails fast: on any RPC/API error it logs and exits(1) — no retry loop.
require('dns').setDefaultResultOrder('ipv4first'); // WSL/IPv6: some RPC hosts fail otherwise
const { Connection, PublicKey } = require('@solana/web3.js');
const { config } = require('./config.cjs');
const log = require('./logger.cjs');
const state = require('./state.cjs');
const { getFixtures, getFinishedResult } = require('./txline.cjs');
const { resolveWinner } = require('./resolve.cjs');
const { getActiveTeamWinRules, getVaultOwner, getOracleAuthority, anchorDisc } = require('./onchain.cjs');

const H = 3_600_000;
const DEVUSDC = new PublicKey('BRjpCHtyQLNCo8gqRUr8jtdAj5AjPYQaoqbvcZiHok1k');
const WSOL = new PublicKey('So11111111111111111111111111111111111111112');
const TOKEN_PROGRAM = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const ATA_PROGRAM = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');

const ata = (mint, owner) =>
  PublicKey.findProgramAddressSync(
    [new PublicKey(owner).toBuffer(), TOKEN_PROGRAM.toBuffer(), mint.toBuffer()],
    ATA_PROGRAM,
  )[0].toBase58();

const u16 = (n) => { const b = Buffer.alloc(2); b.writeUInt16LE(n); return b; };
const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
const u64 = (n) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };

// The exact execute_rule the oracle WOULD build for (rule, finished fixture).
async function buildWouldSubmit(conn, oa, rule, fixtureId, winningTeamId) {
  const owner = await getVaultOwner(conn, rule.vault);
  const data = Buffer.concat([anchorDisc('global', 'execute_rule'), u16(rule.ruleId), u64(fixtureId), u32(winningTeamId)]);
  return {
    ix: 'execute_rule',
    rule: rule.pubkey,
    matchResult: { match_id: fixtureId, winning_team_id: winningTeamId },
    ixDataHex: data.toString('hex'),
    signer_required: oa.authority, // OracleAuthority.authority (deploy wallet); NOT loaded in dry-run
    accounts: {
      program: config.programId,
      oracle_signer: oa.authority,
      oracle_authority: oa.pda,
      owner,
      vault: rule.vault,
      rule: rule.pubkey,
      usdc_mint: DEVUSDC.toBase58(),
      wsol_mint: WSOL.toBase58(),
      owner_usdc_ata: owner ? ata(DEVUSDC, owner) : null,
      vault_usdc_ata: ata(DEVUSDC, rule.vault),
      vault_wsol_ata: ata(WSOL, rule.vault),
      orca_swap_accounts: 'resolved at submit-time from live pool state (whirlpool, vaults, 3 tick arrays, pool oracle) — see live_flow.cjs',
    },
    signature: 'DRY-RUN — not submitted',
  };
}

async function main() {
  log.info('================ POCKET FANS ORACLE — DRY RUN ================');
  log.info(`NO signer loaded, NO transaction will be sent. dryRun=${config.dryRun}`);
  log.info(`rpc=${config.rpcUrl.replace(/\/v2\/.*/, '/v2/***')} program=${config.programId}`);
  log.info(`txline=${config.apiOrigin} competition=${config.competitionId ?? 'ALL entitled'}`);
  if (!config.apiToken) throw new Error('TXLINE_API_TOKEN not set (checked oracle-service/.env then shroudline/.env)');

  const conn = new Connection(config.rpcUrl, 'confirmed');

  // 1) oracle authority
  const oa = await getOracleAuthority(conn, config.programId);
  const match = oa.authority === config.expectedOracleAuthority;
  log.info(`OracleAuthority PDA ${oa.pda} authority=${oa.authority} (expected ${config.expectedOracleAuthority}: ${match ? 'OK' : 'MISMATCH'})`);
  if (!oa.authority) throw new Error('OracleAuthority not initialised on-chain');

  // 2) active TeamWin rules
  const rules = await getActiveTeamWinRules(conn, config.programId);
  log.info(`active TeamWin rules: ${rules.length}`);
  const teamToRules = new Map();
  for (const r of rules) {
    log.info(`  rule ${r.pubkey} team_id=${r.teamId} exec=${r.executionsDone}/${r.maxExecutions} amount_usdc=${r.amountUsdc} vault=${r.vault}`);
    if (!teamToRules.has(r.teamId)) teamToRules.set(r.teamId, []);
    teamToRules.get(r.teamId).push(r);
  }
  const relevantTeams = new Set(rules.map((r) => r.teamId));

  // 3) discover fixtures (snapshot ∪ persisted state), remember them
  const snapshot = await getFixtures();
  const st = state.mergeSnapshot(snapshot);
  log.info(`snapshot fixtures: ${snapshot.length} | persisted fixtures: ${Object.keys(st.fixtures).length}`);

  // 4) candidates = finalizable fixtures involving an active team  ∪  PROBE ids
  const now = Date.now();
  const candidates = new Set(config.probeFixtureIds);
  for (const f of Object.values(st.fixtures)) {
    const finalizable = now > f.StartTime + config.finalizeAfterH * H;
    const relevant = relevantTeams.has(f.Participant1Id) || relevantTeams.has(f.Participant2Id);
    if (finalizable && relevant) candidates.add(f.FixtureId);
  }
  log.info(`candidate fixtures to check (relevant+finalizable ∪ probe): ${[...candidates].join(', ') || '(none)'}`);

  // 5) resolve each candidate and log would-submit
  let wouldSubmit = 0;
  for (const fixtureId of candidates) {
    const res = await getFinishedResult(fixtureId);
    const meta = st.fixtures[fixtureId];
    const label = meta ? `${meta.Participant1} v ${meta.Participant2}` : '(metadata via historical)';
    if (!res) { log.info(`fixture ${fixtureId} ${label}: not finalised yet — skip`); continue; }

    const isKnockout = config.knockoutFixtureIds.includes(fixtureId);
    const w = resolveWinner(res, isKnockout);
    log.info(`fixture ${fixtureId} ${label}: FINAL ${res.homeGoals}-${res.awayGoals} → ${w.reason} → winning_team_id=${w.winningTeamId}`);
    if (w.winningTeamId === 0) continue;

    const hits = teamToRules.get(w.winningTeamId) || [];
    if (!hits.length) {
      log.info(`  no active rule targets team_id=${w.winningTeamId} → nothing to submit`);
      continue;
    }
    for (const rule of hits) {
      const payload = await buildWouldSubmit(conn, oa, rule, fixtureId, w.winningTeamId);
      log.attempt(payload);
      wouldSubmit++;
    }
  }

  // 6) illustrative complete payload on real data (only if nothing matched, so
  //    the operator can still see a full would-submit against a real finished
  //    fixture). Clearly flagged as illustrative — pairs an existing active rule
  //    with a real finished probe fixture regardless of team match.
  if (wouldSubmit === 0 && rules.length && config.probeFixtureIds.length) {
    const rule = rules[0];
    const fixtureId = config.probeFixtureIds[0];
    const res = await getFinishedResult(fixtureId);
    if (res) {
      const w = resolveWinner(res, config.knockoutFixtureIds.includes(fixtureId));
      log.info(`ILLUSTRATIVE (real finished fixture ${fixtureId}, winner team_id=${w.winningTeamId}) — would-submit template for active rule ${rule.pubkey} (fires in production only when the rule's team_id equals the winner):`);
      log.attempt({ illustrative: true, ...(await buildWouldSubmit(conn, oa, rule, fixtureId, w.winningTeamId)) });
    }
  }

  log.info(`DRY RUN complete. real would-submit attempts: ${wouldSubmit}. Log: ${config.logFile}`);
}

main().catch((e) => { log.error(`DRY RUN aborted (no retry): ${e.message}`); process.exit(1); });

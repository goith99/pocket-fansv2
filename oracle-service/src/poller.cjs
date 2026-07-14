// Pocket Fans fixtures poller — long-running daemon (Railway), NOT a
// serverless function. This is the ONLY thing that ever calls TxLINE for
// schedule data; the Next.js app (Vercel) only ever reads the Supabase cache
// this writes to (see app/src/lib/serverSupabase.ts). That split exists
// because:
//   - a serverless function dies after each request, so it can't "wait" for
//     a live match the way this daemon can
//   - TxLINE's historical payload for an eventful fixture can take 10s+ to
//     download (see txline.cjs FETCH_TIMEOUT_MS comment) — fine for a
//     background loop, bad for something a user is staring at a spinner for
//   - polling here also means N users loading the app never turns into N
//     TxLINE calls for the same fixture; it's always exactly one caller
//
// Two independent loops:
//   1. refreshForward  — every config.pollForwardMs: pulls the forward fixture
//      list, upserts any NEW fixtures as 'upcoming' (never touches fixtures
//      already 'live' or 'finished' in the cache — the live loop below owns
//      those transitions).
//   2. pollLive         — every config.pollLiveMs: for every cached fixture
//      that is not yet 'finished' and whose kickoff has passed, checks TxLINE
//      for a final-whistle event. Flips to 'finished' (with score) once found,
//      otherwise ensures it's marked 'live'.
//
// Forward-compatible with granular triggers (goal/corner/yellow card): those
// would add a third loop here that reads the SAME live SSE data this already
// fetches and writes into a separate events table — the cache/read-path this
// sets up for the app does not need to change.
const { createClient } = require('@supabase/supabase-js');
const {
  Connection, PublicKey,
} = require('@solana/web3.js');
const { config } = require('./config.cjs');
const log = require('./logger.cjs');
const txline = require('./txline.cjs');
const goalwatch = require('./goalwatch.cjs');
const statvalidation = require('./statvalidation.cjs');

if (!config.supabaseUrl || !config.supabaseServiceRoleKey) {
  console.error('[poller] SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required. Set them in oracle-service/.env.');
  process.exit(1);
}
if (!config.apiToken) {
  console.error('[poller] TXLINE_API_TOKEN is required. Set it in oracle-service/.env.');
  process.exit(1);
}

const supabase = createClient(config.supabaseUrl, config.supabaseServiceRoleKey, {
  auth: { persistSession: false },
});

// Used only by the goal-watch loop (getProgramAccounts + tx submission). The two
// original loops are Supabase/TxLINE only and never touch the chain.
const connection = new Connection(config.rpcUrl, 'confirmed');

// The keeper's fee-payer keypair. Loaded ONCE in main(), and ONLY when the
// goal-watch loop is enabled — the TeamWin/self-claim path never loads a signer.
let keeper = null;

async function refreshForward() {
  try {
    const fixtures = await txline.getFixtures();
    if (!fixtures.length) { log.warn('refreshForward: TxLINE returned 0 fixtures'); return; }

    // Only INSERT fixtures we haven't seen at all — never overwrite a row
    // that pollLive owns (status live/finished, or a score already set).
    const { data: existing, error: selErr } = await supabase.from('fixtures_cache').select('fixture_id');
    if (selErr) throw selErr;
    const known = new Set((existing || []).map((r) => Number(r.fixture_id)));

    const now = Date.now();
    const newRows = fixtures
      .filter((f) => !known.has(Number(f.FixtureId)))
      .map((f) => ({
        fixture_id: Number(f.FixtureId),
        competition: f.Competition ?? null,
        participant1_id: Number(f.Participant1Id),
        participant1_name: f.Participant1,
        participant2_id: Number(f.Participant2Id),
        participant2_name: f.Participant2,
        participant1_is_home: f.Participant1IsHome === true,
        start_time: Number(f.StartTime),
        status: Number(f.StartTime) <= now ? 'live' : 'upcoming',
        score: null,
        updated_at: new Date().toISOString(),
      }));

    if (newRows.length) {
      const { error: insErr } = await supabase.from('fixtures_cache').insert(newRows);
      if (insErr) throw insErr;
      log.info(`refreshForward: added ${newRows.length} new fixture(s)`);
    }
  } catch (e) {
    log.error(`refreshForward failed: ${e.message || e}`);
  }
}

async function pollLive() {
  try {
    const now = Date.now();
    const { data: candidates, error: selErr } = await supabase
      .from('fixtures_cache')
      .select('fixture_id, participant1_id, participant2_id, participant1_is_home, start_time, status')
      .neq('status', 'finished')
      .lte('start_time', now);
    if (selErr) throw selErr;
    if (!candidates || !candidates.length) return;

    for (const row of candidates) {
      try {
        const res = await txline.getFinishedResult(row.fixture_id);
        if (res) {
          const p1Home = row.participant1_is_home;
          const p1 = p1Home ? res.homeGoals : res.awayGoals;
          const p2 = p1Home ? res.awayGoals : res.homeGoals;
          const homeId = p1Home ? row.participant1_id : row.participant2_id;
          const awayId = p1Home ? row.participant2_id : row.participant1_id;
          let winnerId = 0;
          if (res.homeGoals !== res.awayGoals) winnerId = res.homeGoals > res.awayGoals ? homeId : awayId;
          else if (res.hasPens && res.homePens !== res.awayPens) winnerId = res.homePens > res.awayPens ? homeId : awayId;

          const { error: updErr } = await supabase
            .from('fixtures_cache')
            .update({ status: 'finished', score: { p1, p2, winnerId }, updated_at: new Date().toISOString() })
            .eq('fixture_id', row.fixture_id);
          if (updErr) throw updErr;
          log.info(`pollLive: fixture ${row.fixture_id} finished ${p1}-${p2} (winner ${winnerId || 'draw'})`);
        } else if (row.status !== 'live') {
          const { error: updErr } = await supabase
            .from('fixtures_cache')
            .update({ status: 'live', updated_at: new Date().toISOString() })
            .eq('fixture_id', row.fixture_id);
          if (updErr) throw updErr;
          log.info(`pollLive: fixture ${row.fixture_id} now live`);
        }
      } catch (e) {
        // One fixture's TxLINE call failing (timeout, transient 5xx) must
        // never stop the others in this batch — log and move on, next tick
        // retries automatically.
        log.warn(`pollLive: fixture ${row.fixture_id} check failed: ${e.message || e}`);
      }
    }
  } catch (e) {
    log.error(`pollLive failed: ${e.message || e}`);
  }
}

// ===========================================================================
// Loop 3: pollGoalWatch — GoalScored trigger (permissionless keeper).
//
// Independent of the two loops above; does not touch their cadence or state.
// Only looks at fixtures already 'live' in fixtures_cache that ALSO have at
// least one open on-chain GoalScored rule — so a live match nobody has a rule
// on costs zero TxLINE calls.
//
// DISABLED BY DEFAULT (config.goalWatchEnabled). Two gates before it can run:
//   1. keeper keypair funded with devnet SOL (checked at startup, not per-tick)
//   2. TxLINE has confirmed our token can reach /scores/stat-validation
//      (see checkAndTriggerGoals — still blocked on that answer)
// ===========================================================================

/**
 * For one live fixture with open GoalScored rules: read the fixture's current
 * score snapshot (one cheap call, shared by every rule on that fixture), and for
 * each rule whose pinned stat_key has reached its threshold, fetch that stat's
 * Merkle proof and submit execute_rule_verified signed by the keeper.
 *
 * NOTE — the threshold check here is only a CHEAP PRE-FILTER to avoid pulling a
 * proof we don't need. It is NOT the security boundary: the program re-checks
 * the predicate on-chain against the Txoracle-proven value (and pins fixture_id
 * + stat_key), so a wrong or stale snapshot can only ever cost us a failed tx,
 * never a false execution.
 *
 * VAR: no settle delay, by design. A goal that is later overturned may still
 * have fired the rule; funds only ever move from the user's own wallet into
 * their own vault, so the worst case is "saved slightly early", never a loss.
 */
async function checkAndTriggerGoals(fixtureId, openRules) {
  const events = await txline.getScoresSnapshot(fixtureId);
  const latest = txline.latestStatEvent(events);
  if (!latest) return; // no stat-bearing event yet — nothing to check

  const seq = Number(latest.Seq);
  if (!Number.isFinite(seq) || seq <= 0) {
    log.warn(`pollGoalWatch: fixture ${fixtureId} has no usable Seq — skipping`);
    return;
  }
  const stats = latest.Stats || {};

  for (const rule of openRules) {
   try {
    const current = Number(stats[String(rule.statKey)] ?? 0);
    if (current < rule.threshold) continue; // not reached yet

    // Skip anything already claimed since getOpenGoalWatchRules ran (another
    // keeper, or the owner manually). Cheap re-read beats a doomed tx.
    const fresh = await goalwatch.getRuleIfClaimable(connection, rule.rulePda);
    if (!fresh) {
      log.info(`pollGoalWatch: rule ${rule.rulePda} no longer claimable — skipping`);
      continue;
    }

    const sv = await txline.getStatValidation(fixtureId, seq, [rule.statKey]);
    if (!sv) {
      log.warn(`pollGoalWatch: no proof leaf for fixture ${fixtureId} seq ${seq} key ${rule.statKey}`);
      continue;
    }

    const payload = statvalidation.buildStatValidationInput(sv);

    // The proof must actually prove what we think it does. If TxLINE returned a
    // different key, or a value below the threshold, submitting would just burn
    // a tx on an on-chain revert — catch it here instead.
    const proven = payload.stats.find((s) => s.stat.key === rule.statKey);
    if (!proven) {
      log.warn(`pollGoalWatch: proof for fixture ${fixtureId} lacks stat_key ${rule.statKey} — skipping`);
      continue;
    }
    if (proven.stat.value < rule.threshold) {
      log.warn(`pollGoalWatch: proven ${rule.statKey}=${proven.stat.value} < threshold ${rule.threshold} (snapshot said ${current}) — skipping`);
      continue;
    }

    const owner = await goalwatch.getVaultOwner(connection, rule.vault);
    if (!owner) {
      log.warn(`pollGoalWatch: vault ${rule.vault} not found for rule ${rule.rulePda} — skipping`);
      continue;
    }

    const { ta0, ta1, ta2, whirlpoolOracle } = await statvalidation.ticksForBToA(connection);
    const ix = statvalidation.ixExecuteRuleVerified({
      caller: keeper.publicKey,
      vaultOwner: new PublicKey(owner),
      ruleId: rule.ruleId,
      payload,
      ta0, ta1, ta2, whirlpoolOracle,
    });

    // v0 + Address Lookup Table, NOT a legacy Transaction. A real mid-match
    // proof (subTreeProof 5..8) makes the legacy encoding 1240..1372 B, over
    // the 1232 B limit — it throws at construction and the rule never fires.
    // See the block comment above LOOKUP_TABLE_ADDRESS in statvalidation.cjs.
    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();
    const { vtx, size } = await statvalidation.buildExecuteRuleVerifiedTx({
      connection, keeper, ix, blockhash,
    });

    const sig = await connection.sendTransaction(vtx, {
      skipPreflight: false, // let a bad proof fail in simulation, before it costs a fee
      preflightCommitment: 'confirmed',
    });
    await connection.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, 'confirmed');
    log.info(
      `pollGoalWatch: FIRED rule ${rule.rulePda} (fixture ${fixtureId}, ` +
        `stat_key ${rule.statKey} = ${proven.stat.value} >= ${rule.threshold}, seq ${seq}, ` +
        `v0 tx ${size}B) sig ${sig}`,
    );
   } catch (e) {
    // Isolate per RULE as well as per fixture: one rule's failed proof/tx must
    // not stop the other rules on the same fixture. Next tick retries it.
    log.warn(`pollGoalWatch: rule ${rule.rulePda} failed: ${e.message || e}`);
   }
  }
}

async function pollGoalWatch() {
  try {
    const { data: liveFixtures, error } = await supabase
      .from('fixtures_cache')
      .select('fixture_id')
      .eq('status', 'live');
    if (error) throw error;
    if (!liveFixtures || !liveFixtures.length) return;

    const openRules = await goalwatch.getOpenGoalWatchRules(connection, config.programId);
    if (!openRules.size) return; // nothing on-chain is waiting — skip entirely

    for (const { fixture_id } of liveFixtures) {
      const rulesForThisMatch = openRules.get(Number(fixture_id));
      if (!rulesForThisMatch || !rulesForThisMatch.length) continue;
      try {
        await checkAndTriggerGoals(Number(fixture_id), rulesForThisMatch);
      } catch (e) {
        // One fixture's failure must never stop the others — same isolation
        // principle as pollLive.
        log.warn(`pollGoalWatch: fixture ${fixture_id} check failed: ${e.message || e}`);
      }
    }
  } catch (e) {
    log.error(`pollGoalWatch failed: ${e.message || e}`);
  }
}

async function main() {
  log.info(`poller starting — forward every ${config.pollForwardMs}ms, live every ${config.pollLiveMs}ms`);
  await refreshForward();
  await pollLive();
  setInterval(refreshForward, config.pollForwardMs);
  setInterval(pollLive, config.pollLiveMs);

  if (!config.goalWatchEnabled) {
    log.info('pollGoalWatch: DISABLED (set GOAL_WATCH_ENABLED=true to enable once the keeper is funded and TxLINE stat-validation access is confirmed)');
    return;
  }

  // Fail fast and loudly at startup rather than per-tick: an unfunded keeper
  // would otherwise surface as a confusing stream of tx-send failures.
  // Prefers KEEPER_SECRET_KEY (Railway) over KEEPER_KEYPAIR_PATH (local dev).
  keeper = goalwatch.loadKeeper(config);
  const bal = await goalwatch.assertKeeperFunded(connection, keeper);
  log.info(`pollGoalWatch: ENABLED — keeper ${keeper.publicKey.toBase58()} (${bal / 1e9} SOL), every ${config.pollGoalWatchMs}ms`);

  await pollGoalWatch();
  setInterval(pollGoalWatch, config.pollGoalWatchMs);
}

main().catch((e) => { console.error('[poller] fatal:', e); process.exit(1); });

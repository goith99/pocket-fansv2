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
const winwatch = require('./winwatch.cjs');
const statvalidation = require('./statvalidation.cjs');

/// The `period` a proven stat carries at full time. Mirrors FULL_TIME_PERIOD in
/// programs/pocket_fans/src/constants.rs — the on-chain pin that makes the
/// TeamWinVerified trigger sound. Checked keeper-side too so a wrong-period
/// proof is dropped before it costs a transaction fee.
const FULL_TIME_PERIOD = 100;

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

/**
 * Resolve one fixture, snapshot-first. Returns { res, health } where health is
 * one of 'ok' | 'empty' | 'denied' | 'error' — see reportTickHealth below.
 *
 * /scores/snapshot is primary because /scores/historical only serves a fixture
 * between two weeks and SIX HOURS after its start time (see the block comment
 * on getFinishedResult). Polling historical meant every fixture sat at 'live'
 * for six hours after kickoff no matter how fast we polled.
 *
 * getFinishedResult stays as the fallback, tried only when the snapshot gives
 * us nothing usable. It reads a different backing store, so it can still answer
 * when snapshot 403s or comes back empty — but it can equally return null
 * purely because we are inside its six-hour blackout, so a null from it is
 * never evidence that the match is unfinished.
 */
async function resolveFixture(fixtureId) {
  try {
    const { sawAny, result } = await txline.getFinishedResultFromSnapshot(fixtureId);
    if (result) return { res: result, health: 'ok' };
    // Events but no game_finalised = genuinely still in progress. Authoritative:
    // the snapshot has no window, so there is nothing for the fallback to add.
    if (sawAny) return { res: null, health: 'ok' };
  } catch (e) {
    const denied = /HTTP 40[13]\b/.test(e.message || '');
    try {
      return { res: await txline.getFinishedResult(fixtureId), health: 'ok' };
    } catch {
      return { res: null, health: denied ? 'denied' : 'error', err: e };
    }
  }
  // Snapshot returned zero events — fall back before giving up on this tick.
  try {
    const res = await txline.getFinishedResult(fixtureId);
    return { res, health: res ? 'ok' : 'empty' };
  } catch (e) {
    return { res: null, health: 'error', err: e };
  }
}

// --- pollLive tick health --------------------------------------------------
// ONE fixture failing is routine (transient 5xx, a fixture TxLINE doesn't
// cover) and stays a per-fixture warn. EVERY fixture in a tick failing the SAME
// way is an outage: an expired/revoked API token (403) or an endpoint that
// stopped returning data (empty). That case used to be invisible — each failure
// was warn'd individually and pollLive simply left every fixture at 'live', so
// a total loss of TxLINE access looked exactly like healthy-but-slow polling.
// That is precisely what made the six-hour stall take so long to spot.
let tickFailStreak = 0;
let tickFailKind = null;

function reportTickHealth(total, counts) {
  // 403 is never normal, so escalate it even for a single candidate. 'empty'
  // can legitimately describe one fixture that has only just kicked off, so
  // require at least two before calling it an outage.
  let kind = null;
  if (counts.denied === total) kind = 'denied';
  else if (counts.empty === total && total >= 2) kind = 'empty';

  if (!kind) {
    if (tickFailStreak) {
      log.info(`pollLive: recovered — ${total} fixture(s) responding again after ${tickFailStreak} failed tick(s)`);
    }
    tickFailStreak = 0;
    tickFailKind = null;
    return;
  }

  if (kind !== tickFailKind) { tickFailStreak = 0; tickFailKind = kind; }
  tickFailStreak++;

  // Loud immediately, then every ~5 min, so an outage is impossible to miss
  // without drowning the log at one message per pollLiveMs.
  const every = Math.max(1, Math.round(300_000 / config.pollLiveMs));
  if (tickFailStreak === 1 || tickFailStreak % every === 0) {
    log.error(
      kind === 'denied'
        ? `pollLive: TxLINE ACCESS LOST — all ${total} fixture(s) returned HTTP 401/403 for ${tickFailStreak} consecutive tick(s). ` +
          'Expired/revoked TXLINE_API_TOKEN or lost entitlement. NO fixture can be resolved; all are stuck at \'live\'.'
        : `pollLive: TxLINE RETURNING NO DATA — all ${total} fixture(s) produced zero score events for ${tickFailStreak} consecutive tick(s). ` +
          'Endpoint reachable but empty. NO fixture can be resolved; all are stuck at \'live\'.',
    );
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

    const counts = { ok: 0, empty: 0, denied: 0, error: 0 };
    for (const row of candidates) {
      try {
        const { res, health, err } = await resolveFixture(row.fixture_id);
        counts[health]++;
        if (health === 'denied' || health === 'error') {
          // Still a per-fixture warn — reportTickHealth escalates only if EVERY
          // fixture in this tick failed the same way.
          log.warn(`pollLive: fixture ${row.fixture_id} check failed: ${(err && err.message) || health}`);
          continue;
        }
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
        // One fixture's Supabase write failing must never stop the others in
        // this batch — log and move on, next tick retries automatically.
        // (TxLINE failures are classified in resolveFixture and handled above,
        // so this fixture already has a health count — don't count it twice.)
        log.warn(`pollLive: fixture ${row.fixture_id} check failed: ${e.message || e}`);
      }
    }
    reportTickHealth(candidates.length, counts);
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

    // 404 -> null. EXPECTED, not a failure: the score snapshot can show the goal
    // a moment before TxLINE's Merkle tree has a leaf for that key at that seq.
    // Info, not warn — a genuine failure (bad token, 429, 5xx) THROWS instead
    // (txline.cjs getStatValidation), lands in the per-rule catch below, and is
    // logged there with its HTTP status. Keeping the two at different levels is
    // what makes a real error visible instead of buried in normal 404 chatter.
    const sv = await txline.getStatValidation(fixtureId, seq, [rule.statKey]);
    if (!sv) {
      log.info(
        `pollGoalWatch: no proof leaf yet for fixture ${fixtureId} seq ${seq} key ${rule.statKey} — retrying next tick`,
      );
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

// ===========================================================================
// Loop 4: pollWinSettle — TeamWinVerified trigger (permissionless keeper).
//
// Hangs off the SAME finality pollLive already detects: it only looks at
// fixtures already 'finished' in fixtures_cache that also have an open
// TeamWinVerified rule on-chain. A live match costs this loop nothing.
//
// Cost per pass for a fixture with open rules: ONE /scores/snapshot (to find the
// game_finalised seq) plus ONE /scores/stat-validation per distinct key order.
// There are only two possible key orders — [home,away] and [away,home] — so
// backers of both sides in the same match cost two proofs, not one per rule.
// ===========================================================================

/**
 * Settle every eligible win rule on one finished fixture.
 *
 * The proof MUST be taken at the `game_finalised` seq: the on-chain full-time
 * pin (period == 100) rejects anything else, and rightly so — a mid-match proof
 * can show a scoreline that never became final.
 */
async function settleWinsForFixture(fixtureId, rules, deps = {}) {
  // `deps` exists ONLY so tests can drive this function with a stub connection /
  // signer and exercise the real candidate -> claimable -> build wiring. It was
  // the absence of exactly that coverage that let the goalwatch/winwatch decoder
  // mix-up reach production. Defaults are the module globals; production never
  // passes anything.
  const conn = deps.connection || connection;
  const signer = deps.keeper || keeper;

  const events = await txline.getScoresSnapshot(fixtureId);
  const fin = txline.finalFromSnapshot(events);
  if (!fin) {
    log.warn(`pollWinSettle: fixture ${fixtureId} has no game_finalised event yet — skipping`);
    return;
  }
  const seq = Number(fin.Seq);
  if (!Number.isFinite(seq) || seq <= 0) {
    log.warn(`pollWinSettle: fixture ${fixtureId} game_finalised has no usable Seq — skipping`);
    return;
  }

  // Group by the rule's PINNED key order. The order is not cosmetic: it is what
  // encodes home/away direction, and the program pins stats[0]/stats[1] to it.
  // /scores/stat-validation returns stats in the order requested (verified
  // against the live API 2026-07-21), which is what makes this grouping sound.
  const byOrder = new Map();
  for (const r of rules) {
    const k = `${r.teamStatKey},${r.opponentStatKey}`;
    if (!byOrder.has(k)) byOrder.set(k, []);
    byOrder.get(k).push(r);
  }

  for (const [order, group] of byOrder) {
    const keys = order.split(',').map(Number);
    let payload;
    try {
      const sv = await txline.getStatValidation(fixtureId, seq, keys);
      if (!sv) {
        log.info(`pollWinSettle: no proof leaf yet for fixture ${fixtureId} seq ${seq} keys ${order} — retrying next tick`);
        continue;
      }
      payload = statvalidation.buildStatValidationInput(sv);
    } catch (e) {
      log.warn(`pollWinSettle: fixture ${fixtureId} keys ${order} proof fetch failed: ${e.message || e}`);
      continue;
    }

    // Verify the proof is the shape the program demands BEFORE spending a fee.
    if (payload.stats.length !== 2
        || payload.stats[0].stat.key !== keys[0]
        || payload.stats[1].stat.key !== keys[1]) {
      log.warn(`pollWinSettle: fixture ${fixtureId} proof stat order/shape wrong for keys ${order} — skipping`);
      continue;
    }
    if (!payload.stats.every((s) => s.stat.period === FULL_TIME_PERIOD)) {
      log.warn(
        `pollWinSettle: fixture ${fixtureId} seq ${seq} proof is period ` +
          `${payload.stats.map((s) => s.stat.period).join('/')}, not full time (${FULL_TIME_PERIOD}) — skipping`,
      );
      continue;
    }
    if (!(payload.stats[0].stat.value > payload.stats[1].stat.value)) {
      log.info(
        `pollWinSettle: fixture ${fixtureId} proven ${payload.stats[0].stat.value}-${payload.stats[1].stat.value} ` +
          `for keys ${order} — not a win, nothing to settle`,
      );
      continue;
    }

    for (const rule of group) {
      try {
        // Re-read on-chain: another keeper (or the owner) may have settled it
        // since getOpenWinRules ran. A cheap read beats a doomed transaction.
        //
        // MUST be winwatch's, not goalwatch's. goalwatch.getRuleIfClaimable
        // decodes with the GoalScored layout (trigger tag 1) and returns null
        // for every TeamWinVerified rule (tag 2) — using it here meant the
        // keeper logged "no longer claimable" forever and never settled
        // anything. See the note on winwatch.getRuleIfClaimable.
        const fresh = await winwatch.getRuleIfClaimable(conn, rule.rulePda);
        if (!fresh) {
          log.info(`pollWinSettle: rule ${rule.rulePda} no longer claimable — skipping`);
          continue;
        }
        const owner = await goalwatch.getVaultOwner(conn, rule.vault);
        if (!owner) {
          log.warn(`pollWinSettle: vault ${rule.vault} not found for rule ${rule.rulePda} — skipping`);
          continue;
        }

        const { ta0, ta1, ta2, whirlpoolOracle } = await statvalidation.ticksForBToA(conn);
        const args = {
          caller: signer.publicKey,
          vaultOwner: new PublicKey(owner),
          ruleId: rule.ruleId,
          payload,
          ta0, ta1, ta2, whirlpoolOracle,
        };
        const ix = rule.isStaked
          ? statvalidation.ixExecuteRuleStakedVerifiedWin(args)
          : statvalidation.ixExecuteRuleVerifiedWin(args);

        // v0 + ALT, mandatory. The staked variant does not merely exceed the
        // packet limit as a legacy tx — it throws at CONSTRUCTION.
        const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash();
        const { vtx, size } = await statvalidation.buildExecuteRuleVerifiedTx({
          connection: conn, keeper: signer, ix, blockhash,
        });

        const sig = await conn.sendTransaction(vtx, {
          skipPreflight: false, // let a bad proof fail in simulation, before it costs a fee
          preflightCommitment: 'confirmed',
        });
        await conn.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, 'confirmed');
        log.info(
          `pollWinSettle: SETTLED rule ${rule.rulePda} (${rule.actionKind}, fixture ${fixtureId}, ` +
            `full-time ${payload.stats[0].stat.value}-${payload.stats[1].stat.value} on keys ${order}, ` +
            `seq ${seq}, v0 tx ${size}B) sig ${sig}`,
        );
      } catch (e) {
        // Isolate per rule: one failure must not stop the others on this
        // fixture. Next tick retries — the rule stays open until it settles.
        log.warn(`pollWinSettle: rule ${rule.rulePda} failed: ${e.message || e}`);
      }
    }
  }
}

async function pollWinSettle() {
  try {
    const { data: finished, error } = await supabase
      .from('fixtures_cache')
      .select('fixture_id, participant1_id, participant2_id, score')
      .eq('status', 'finished');
    if (error) throw error;
    if (!finished || !finished.length) return;

    const openRules = await winwatch.getOpenWinRules(connection, config.programId);
    if (!openRules.size) return; // nothing on-chain is waiting — skip entirely

    for (const row of finished) {
      const rules = openRules.get(Number(row.fixture_id));
      if (!rules || !rules.length) continue;

      // Pre-filter on the CACHED full-time goals, not on winnerId: a match level
      // after extra time and decided on penalties has a winnerId but is a draw
      // by the full-time stat keys, so it can never settle (documented v1 scope).
      const eligible = rules.filter((r) => winwatch.isFullTimeWinner(r, row));
      if (!eligible.length) continue;

      try {
        await settleWinsForFixture(Number(row.fixture_id), eligible);
      } catch (e) {
        log.warn(`pollWinSettle: fixture ${row.fixture_id} settle failed: ${e.message || e}`);
      }
    }
  } catch (e) {
    log.error(`pollWinSettle failed: ${e.message || e}`);
  }
}

async function main() {
  log.info(`poller starting — forward every ${config.pollForwardMs}ms, live every ${config.pollLiveMs}ms`);
  await refreshForward();
  await pollLive();
  setInterval(refreshForward, config.pollForwardMs);
  setInterval(pollLive, config.pollLiveMs);

  if (!config.goalWatchEnabled && !config.winWatchEnabled) {
    log.info('pollGoalWatch: DISABLED (set GOAL_WATCH_ENABLED=true to enable once the keeper is funded and TxLINE stat-validation access is confirmed)');
    log.info('pollWinSettle: DISABLED (set WIN_WATCH_ENABLED=true to auto-settle TeamWinVerified rules)');
    return;
  }

  // Fail fast and loudly at startup rather than per-tick: an unfunded keeper
  // would otherwise surface as a confusing stream of tx-send failures.
  // Prefers KEEPER_SECRET_KEY (Railway) over KEEPER_KEYPAIR_PATH (local dev).
  // ONE keeper identity, shared by both keeper loops. Loaded once, and only
  // when at least one of them is enabled — the TeamWin/self-claim path never
  // loads a signer.
  keeper = goalwatch.loadKeeper(config);
  winwatch.init({ PublicKey });
  const bal = await goalwatch.assertKeeperFunded(connection, keeper);
  log.info(`keeper ${keeper.publicKey.toBase58()} funded with ${bal / 1e9} SOL`);

  if (config.goalWatchEnabled) {
    log.info(`pollGoalWatch: ENABLED — every ${config.pollGoalWatchMs}ms`);
    await pollGoalWatch();
    setInterval(pollGoalWatch, config.pollGoalWatchMs);
  } else {
    log.info('pollGoalWatch: DISABLED (set GOAL_WATCH_ENABLED=true)');
  }

  if (config.winWatchEnabled) {
    log.info(`pollWinSettle: ENABLED — every ${config.pollWinSettleMs}ms`);
    await pollWinSettle();
    setInterval(pollWinSettle, config.pollWinSettleMs);
  } else {
    log.info('pollWinSettle: DISABLED (set WIN_WATCH_ENABLED=true)');
  }
}

// Only start the loops when run as the entry point (`node src/poller.cjs`, which
// is what Railway does). Guarding this lets tests require the module to exercise
// resolveFixture/reportTickHealth without spawning the daemon.
if (require.main === module) {
  main().catch((e) => { console.error('[poller] fatal:', e); process.exit(1); });
}

module.exports = { resolveFixture, reportTickHealth, pollLive, pollWinSettle, settleWinsForFixture };

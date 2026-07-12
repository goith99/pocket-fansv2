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
const { config } = require('./config.cjs');
const log = require('./logger.cjs');
const txline = require('./txline.cjs');

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

async function main() {
  log.info(`poller starting — forward every ${config.pollForwardMs}ms, live every ${config.pollLiveMs}ms`);
  await refreshForward();
  await pollLive();
  setInterval(refreshForward, config.pollForwardMs);
  setInterval(pollLive, config.pollLiveMs);
}

main().catch((e) => { console.error('[poller] fatal:', e); process.exit(1); });

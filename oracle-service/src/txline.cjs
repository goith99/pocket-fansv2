// TxLINE API client (reused pattern from the Witness daemon / shroudline scripts).
// Pure fetch — no on-chain concerns, no signing. Node 22 global fetch.
const { config } = require('./config.cjs');
const log = require('./logger.cjs');

let jwt = null; // { token, exp }

// Per-request timeout. TxLINE historical responses are large (~1MB / 1000+ SSE
// events) and the endpoint occasionally hangs/rate-limits; without a bound, a
// single slow fixture can stall the whole admin request (and on Vercel hit the
// function time limit), silently dropping that fixture. See getFinishedResult.
// Measured directly against a real knockout fixture's historical payload
// (625KB, 1000+ events): took 10.27s end-to-end. 6000ms aborted every single
// attempt before the body was even fully received — the fetch never got a
// chance to see the `game_finalised` event, so getFinishedResult always
// returned null (caught by the caller's `.catch(() => null)`) and the fixture
// stayed permanently stuck as "live". 15000ms gives ~50% headroom over the
// worst case measured so far.
const FETCH_TIMEOUT_MS = 15000;

// fetch() with an AbortController deadline. Returns { res, done }: the caller
// MUST call done() once it has finished consuming the body, so the timeout also
// covers streaming a large body (not just the connect/headers phase).
function timedFetch(url, opts) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  return {
    // cache:'no-store' is REQUIRED: under Next.js the global fetch is patched to
    // buffer/cache responses, and for a large SSE body (~1MB) that patched fetch
    // returns an EMPTY body from res.text() — which silently dropped finished
    // fixtures. no-store makes Next pass the response straight through.
    promise: fetch(url, { ...opts, cache: 'no-store', signal: ctrl.signal }),
    done: () => clearTimeout(timer),
  };
}

async function headers() {
  if (!jwt || Date.now() > jwt.exp) {
    const f = timedFetch(`${config.apiOrigin}/auth/guest/start`, { method: 'POST' });
    let res;
    try { res = await f.promise; const ok = res.ok; if (ok) { const { token } = await res.json(); jwt = { token, exp: Date.now() + 9 * 60_000 }; } else { throw new Error(`guest auth failed HTTP ${res.status}`); } }
    finally { f.done(); }
  }
  return { Authorization: `Bearer ${jwt.token}`, 'X-Api-Token': config.apiToken };
}

// Forward-looking fixtures for the competition. NOTE: finished fixtures drop off
// this snapshot — that's why we persist ids / allow PROBE_FIXTURE_IDS.
async function getFixtures() {
  // No competitionId => every competition this token is entitled to. See the
  // config comment: hardcoding one competition is what emptied the app when the
  // World Cup ended.
  const qs = config.competitionId ? `?competitionId=${config.competitionId}` : '';
  const f = timedFetch(
    `${config.apiOrigin}/api/fixtures/snapshot${qs}`,
    { headers: await headers() },
  );
  let res;
  try { res = await f.promise; if (!res.ok) throw new Error(`fixtures/snapshot HTTP ${res.status}`); const j = await res.json(); return Array.isArray(j) ? j : []; }
  finally { f.done(); }
}

// Scan a historical SSE body for what we need: whether we saw ANY event, and the
// LAST event whose Action matches /final/i. We read the body with res.text() (not
// res.body streaming) on purpose: under Next.js's patched fetch, res.body is not
// reliably exposed as a web ReadableStream, so getReader()-based streaming silently
// yields nothing there. text() is Next-safe. We still scan line-by-line and keep
// only the final event rather than building a full ~1000-element parsed array.
function lastFinalFromText(text) {
  let sawAny = false;
  let fin = null;
  let start = 0;
  const len = text.length;
  while (start < len) {
    let nl = text.indexOf('\n', start);
    if (nl < 0) nl = len;
    let line = text.slice(start, nl);
    start = nl + 1;
    if (line.endsWith('\r')) line = line.slice(0, -1);
    if (!line.startsWith('data:')) continue;
    sawAny = true;
    let ev;
    try { ev = JSON.parse(line.slice(5).trim()); } catch { continue; }
    if (ev && /final/i.test(ev.Action || '')) fin = ev; // keep the last match
  }
  return { sawAny, fin };
}

// Shared mapping from a finalised score event to our result shape, so the
// historical and snapshot paths below can never drift apart.
//   Stats["1"] = home goals, Stats["2"] = away goals,
//   Stats["6001"]/["6002"] = penalty-shootout goals (knockout tiebreak).
// Both endpoints carry participant metadata on the event, so a finished fixture
// that has dropped off the forward snapshot is still fully resolvable.
function mapFinalEvent(fixtureId, fin) {
  const S = fin.Stats || {};
  const n = (k) => Number(S[k] ?? 0);
  return {
    fixtureId,
    seq: Number(fin.Seq),
    action: fin.Action,
    participant1Id: Number(fin.Participant1Id),
    participant2Id: Number(fin.Participant2Id),
    participant1IsHome: fin.Participant1IsHome === true,
    homeGoals: n('1'),
    awayGoals: n('2'),
    homePens: n('6001'),
    awayPens: n('6002'),
    hasPens: S['6001'] !== undefined || S['6002'] !== undefined,
  };
}

// Final-whistle result for a fixture, via /scores/historical.
//
// ⚠ FALLBACK ONLY — do NOT use this as the primary resolver. TxLINE's OpenAPI
// spec (https://txline-dev.txodds.com/docs, docs.yaml) documents this endpoint
// as serving a fixture only "provided its start time is between two weeks and
// SIX HOURS in the past from current time". Outside that window it returns
// HTTP 200 with a ZERO-BYTE body — not a 404 — which lands in the `!sawAny`
// branch below and returns null, i.e. it is indistinguishable from "still in
// progress". Measured 2026-07-21: fixtures resolved 0.7-18.7s after
// (actual kickoff + 6h), keyed to TxLINE's StartTime (fixture 18257739 kicked
// off 5 min late and its release slipped exactly 5 min with it). The two-week
// end of the window is worse: a fixture not resolved inside it becomes
// permanently unresolvable here and sits at 'live' forever.
//
// getFinishedResultFromSnapshot() below has no such window and is byte-identical
// on every fixture where both work. Kept here because it is a genuinely useful
// safety net: it reads a different backing store, so it can still answer when
// the snapshot endpoint 403s or returns nothing.
//
// Return semantics (callers rely on the distinction between the two failure kinds):
//   - returns an object  → the finalised result
//   - returns null       → definitively no final result yet (404 / not started /
//                          in progress). NOT an error — skip it.
//   - THROWS             → transport failure after a retry (timeout, network,
//                          non-404 HTTP). Lets callers surface "couldn't load"
//                          instead of silently treating it like "no result".
// Winner is derived from the last SSE event whose Action matches /final/i:
//   Stats["1"] = home goals, Stats["2"] = away goals,
//   Stats["6001"]/["6002"] = penalty-shootout goals (knockout tiebreak).
async function getFinishedResult(fixtureId) {
  const url = `${config.apiOrigin}/api/scores/historical/${fixtureId}`;
  let lastErr = null;
  for (let attempt = 0; attempt < 2; attempt++) { // initial try + one retry
    let f = null;
    try {
      const hdrs = await headers(); // may throw (auth timeout) — kept in try so it retries
      f = timedFetch(url, { headers: hdrs });
      const res = await f.promise;
      if (res.status === 404) return null; // definitively no data — don't retry/throw
      if (!res.ok) { log.warn(`scores/historical/${fixtureId} HTTP ${res.status}`); lastErr = new Error(`HTTP ${res.status}`); continue; }
      const { sawAny, fin } = lastFinalFromText(await res.text());
      if (!sawAny) return null; // not started — OR outside the window, see above
      if (!fin) return null; // in progress, not finalised
      return mapFinalEvent(fixtureId, fin);
    } catch (e) {
      lastErr = e; // AbortError (timeout) / network — retry once
    } finally {
      if (f) f.done(); // f is unset if headers() threw before the fetch started
    }
  }
  throw new Error(`scores/historical/${fixtureId} fetch failed: ${(lastErr && lastErr.message) || 'unknown'}`);
}

// ---------------------------------------------------------------------------
// GoalScored keeper endpoints.
//
// AUTH: identical to everything above — guest jwt + X-Api-Token via headers().
// Confirmed live on 2026-07-14: our existing TXLINE_API_TOKEN already returns
// HTTP 200 with a full proof payload from /scores/stat-validation. No separate
// on-chain subscribe() + /api/token/activate is required for this endpoint.
// ---------------------------------------------------------------------------

/**
 * Current score-event snapshot for ONE fixture. Note the fixtureId is a PATH
 * segment, not a query param (`?fixtureId=` 404s).
 *
 * Deliberately used instead of /scores/historical for the live loop: historical
 * replays the fixture's ENTIRE event stream (~886 events / ~10s on a finished
 * match — see FETCH_TIMEOUT_MS above), which is far too heavy to poll every 15s.
 * This returns only the current snapshot (~38 events / ~1s).
 */
async function getScoresSnapshot(fixtureId) {
  const f = timedFetch(`${config.apiOrigin}/api/scores/snapshot/${fixtureId}`, { headers: await headers() });
  try {
    const res = await f.promise;
    if (res.status === 404) return [];
    if (!res.ok) throw new Error(`scores/snapshot/${fixtureId} HTTP ${res.status}`);
    const j = await res.json();
    return Array.isArray(j) ? j : [];
  } finally { f.done(); }
}

/**
 * The LATEST event carrying a Stats map, by highest Seq. The snapshot array is
 * not guaranteed to be Seq-ordered, so pick by max Seq rather than trusting
 * array position. Returns null if the fixture has no stat-bearing event yet.
 */
function latestStatEvent(events) {
  let best = null;
  for (const e of events) {
    if (!e || !e.Stats || !Object.keys(e.Stats).length) continue;
    const seq = Number(e.Seq);
    if (!Number.isFinite(seq)) continue;
    if (!best || seq > Number(best.Seq)) best = e;
  }
  return best;
}

/**
 * The finalised `game_finalised` event from a snapshot array, or null.
 *
 * MUST NOT reuse lastFinalFromText()'s "keep the last /final/i match" rule.
 * That rule is correct for /scores/historical, which is a CHRONOLOGICAL replay
 * where game_finalised necessarily comes after halftime_finalised. The snapshot
 * is a different shape entirely: one event per Action type, NOT Seq-ordered. So
 * halftime_finalised is a sibling entry here, not a superseded earlier one, and
 * "last match in array order" picks it. Verified 2026-07-21 across 10 fixtures:
 * the /final/i rule picked halftime_finalised on 10/10 — e.g. fixture 18257739
 * would have been recorded 0-0 (a draw, winnerId 0) instead of its true 1-0.
 *
 * Hence: exact Action match, highest Seq wins (same max-Seq discipline as
 * latestStatEvent, and for the same reason).
 */
function finalFromSnapshot(events) {
  let fin = null;
  for (const e of events) {
    if (!e || e.Action !== 'game_finalised') continue;
    const seq = Number(e.Seq);
    if (!Number.isFinite(seq)) continue;
    if (!fin || seq > Number(fin.Seq)) fin = e;
  }
  return fin;
}

/**
 * Final-whistle result via /scores/snapshot — the PRIMARY resolver for pollLive.
 * Unlike getFinishedResult it has no eligibility window, so a fixture is
 * resolvable as soon as TxLINE publishes the final whistle rather than six
 * hours after kickoff.
 *
 * Returns { sawAny, result } rather than a bare result, because pollLive needs
 * to tell "TxLINE gave us nothing at all" apart from "the match is genuinely
 * still in progress" in order to escalate a total outage:
 *   sawAny — the fixture returned at least one event (we have access and the
 *            fixture exists). false = 404 or an empty array.
 *   result — the mapped game_finalised result, or null if not finalised yet.
 * THROWS on 403 / non-404 HTTP / network, same as getScoresSnapshot.
 */
async function getFinishedResultFromSnapshot(fixtureId) {
  const events = await getScoresSnapshot(fixtureId);
  if (!events.length) return { sawAny: false, result: null };
  const fin = finalFromSnapshot(events);
  return { sawAny: true, result: fin ? mapFinalEvent(fixtureId, fin) : null };
}

/**
 * Merkle proof payload for `statKeys` at a given fixture+seq. Returns the RAW
 * API response — map it with statvalidation.cjs buildStatValidationInput()
 * before encoding (the API's field names are not 1:1 with the on-chain struct).
 * Returns null on 404 (no leaf for that key/seq — e.g. a stat that doesn't exist
 * at that point), throws on any other failure.
 */
async function getStatValidation(fixtureId, seq, statKeys) {
  const url = `${config.apiOrigin}/api/scores/stat-validation`
    + `?fixtureId=${fixtureId}&seq=${seq}&statKeys=${statKeys.join(',')}`;
  const f = timedFetch(url, { headers: await headers() });
  try {
    const res = await f.promise;
    if (res.status === 404) return null;
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`scores/stat-validation HTTP ${res.status}: ${body.slice(0, 200)}`);
    }
    return await res.json();
  } finally { f.done(); }
}

// `headers` and `timedFetch` are exported so callers can reuse this module's
// auth + timeout discipline rather than duplicating either.
module.exports = {
  getFixtures, getFinishedResult, getFinishedResultFromSnapshot, headers, timedFetch,
  getScoresSnapshot, latestStatEvent, finalFromSnapshot, getStatValidation,
};

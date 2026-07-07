// TxLINE API client (reused pattern from the Witness daemon / shroudline scripts).
// Pure fetch — no on-chain concerns, no signing. Node 22 global fetch.
const { config } = require('./config.cjs');
const log = require('./logger.cjs');

let jwt = null; // { token, exp }

// Per-request timeout. TxLINE historical responses are large (~1MB / 1000+ SSE
// events) and the endpoint occasionally hangs/rate-limits; without a bound, a
// single slow fixture can stall the whole admin request (and on Vercel hit the
// function time limit), silently dropping that fixture. See getFinishedResult.
const FETCH_TIMEOUT_MS = 6000;

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
  const f = timedFetch(
    `${config.apiOrigin}/api/fixtures/snapshot?competitionId=${config.competitionId}`,
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

// Final-whistle result for a fixture. Return semantics (callers rely on the
// distinction between the two failure kinds):
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
      if (!sawAny) return null; // not started
      if (!fin) return null; // in progress, not finalised
      const S = fin.Stats || {};
      const n = (k) => Number(S[k] ?? 0);
      // The historical events carry participant metadata too, so a finished fixture
      // that has dropped off the forward snapshot is still fully resolvable.
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
    } catch (e) {
      lastErr = e; // AbortError (timeout) / network — retry once
    } finally {
      if (f) f.done(); // f is unset if headers() threw before the fetch started
    }
  }
  throw new Error(`scores/historical/${fixtureId} fetch failed: ${(lastErr && lastErr.message) || 'unknown'}`);
}

module.exports = { getFixtures, getFinishedResult };

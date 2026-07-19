// SERVER ONLY. Reads the fixtures_cache table that oracle-service/src/poller.cjs
// (running continuously on Railway) keeps fresh from TxLINE. The app NEVER
// calls TxLINE directly anymore — every read here is a plain Postgres SELECT,
// typically <100ms, with zero dependency on TxLINE's own latency/uptime. See
// supabase/001_fixtures_cache.sql for the schema and the rationale.
import "server-only";
import { createClient } from "@supabase/supabase-js";

function client() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not configured");
  return createClient(url, key, {
    auth: { persistSession: false },
    // MUST bypass Next's Data Cache. supabase-js issues its queries through the
    // global `fetch`, which the Next App Router patches and caches with
    // force-cache semantics by default. `export const dynamic = "force-dynamic"`
    // on the route makes RENDERING dynamic but does not opt these nested fetches
    // out, so /api/schedule happily served a ~6.5-day-old snapshot of
    // fixtures_cache: finished matches still reading "upcoming", and the two
    // genuinely-upcoming fixtures missing entirely. That fed the team picker
    // stale teams AND made createChallenge derive a match_end_ts already in the
    // past, which create_rule rejects with InvalidMatchEndTs.
    //
    // These are live sports results — every read must hit Postgres.
    global: {
      fetch: (input, init) => fetch(input, { ...init, cache: "no-store" }),
    },
  });
}

export interface CachedFixture {
  fixtureId: number;
  competition: string | null;
  participant1: { id: number; name: string };
  participant2: { id: number; name: string };
  participant1IsHome: boolean;
  startTime: number;
  status: "upcoming" | "live" | "finished";
  score: { p1: number; p2: number; winnerId: number } | null;
}

function mapRow(r: any): CachedFixture {
  return {
    fixtureId: Number(r.fixture_id),
    competition: r.competition,
    participant1: { id: Number(r.participant1_id), name: r.participant1_name },
    participant2: { id: Number(r.participant2_id), name: r.participant2_name },
    participant1IsHome: r.participant1_is_home === true,
    startTime: Number(r.start_time),
    status: r.status,
    score: r.score ?? null,
  };
}

/** All cached fixtures, soonest kickoff first. Powers the Schedule screen and the team picker. */
export async function getCachedFixtures(): Promise<CachedFixture[]> {
  const { data, error } = await client()
    .from("fixtures_cache")
    .select("*")
    .order("start_time", { ascending: true });
  if (error) throw error;
  return (data || []).map(mapRow);
}

/**
 * Most recent FINISHED fixtures involving `teamId`, most recent first. Used by
 * /api/challenges/results to find "played and didn't win" fixtures for a team
 * — same purpose the old direct-TxLINE version served, just reading the cache.
 */
export async function getRecentFinishedForTeam(teamId: number, limit = 5): Promise<CachedFixture[]> {
  const { data, error } = await client()
    .from("fixtures_cache")
    .select("*")
    .eq("status", "finished")
    .or(`participant1_id.eq.${teamId},participant2_id.eq.${teamId}`)
    .order("start_time", { ascending: false })
    .limit(limit);
  if (error) throw error;
  return (data || []).map(mapRow);
}

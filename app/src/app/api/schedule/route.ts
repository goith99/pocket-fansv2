// Live World Cup schedule — now served entirely from the Supabase cache that
// oracle-service/src/poller.cjs (Railway, always running) keeps fresh. This
// route no longer calls TxLINE at all: no 10s+ waits, no timeout tuning, no
// maxDuration concerns — it's a single fast Postgres SELECT. See
// app/src/lib/serverSupabase.ts and supabase/001_fixtures_cache.sql.
import { NextResponse } from "next/server";
import { getCachedFixtures } from "@/lib/serverSupabase";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const fixtures = await getCachedFixtures();

    const rows = fixtures.map((f) => ({
      fixtureId: f.fixtureId,
      startTime: f.startTime,
      competition: f.competition,
      participant1: f.participant1,
      participant2: f.participant2,
      participant1IsHome: f.participant1IsHome,
      status: f.status,
      score: f.score,
    }));

    // Deduped team list (single source of truth for the picker) — unchanged shape.
    const teamMap = new Map<number, string>();
    for (const r of rows) {
      teamMap.set(r.participant1.id, r.participant1.name);
      teamMap.set(r.participant2.id, r.participant2.name);
    }
    const teams = [...teamMap.entries()].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name));

    return NextResponse.json({ fixtures: rows, teams });
  } catch (e: any) {
    return NextResponse.json({ error: e.message || String(e) }, { status: 502 });
  }
}

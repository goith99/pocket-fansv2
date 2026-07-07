// Live World Cup schedule from TxLINE (reuses oracle-service txline.cjs). Used by
// the Schedule screen AND as the single source of truth for the team picker.
import { NextResponse } from "next/server";
import { getTxline } from "@/lib/serverOracle";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const txline = await getTxline();
    const fixtures = await txline.getFixtures();
    const now = Date.now();

    const rows = await Promise.all(
      fixtures.map(async (f: any) => {
        const start = Number(f.StartTime);
        let status: "upcoming" | "live" | "finished" = "upcoming";
        // Real final score for finished fixtures (per-participant goals + winner).
        // TxLINE has no in-progress score/minute feed, so `live` carries no score.
        let score: { p1: number; p2: number; winnerId: number } | null = null;
        if (now >= start) {
          // Past kickoff → check for a final-whistle event, else treat as live.
          const res = await txline.getFinishedResult(Number(f.FixtureId)).catch(() => null);
          if (res) {
            status = "finished";
            const p1Home = f.Participant1IsHome === true;
            const p1 = p1Home ? res.homeGoals : res.awayGoals;
            const p2 = p1Home ? res.awayGoals : res.homeGoals;
            const homeId = p1Home ? Number(f.Participant1Id) : Number(f.Participant2Id);
            const awayId = p1Home ? Number(f.Participant2Id) : Number(f.Participant1Id);
            let winnerId = 0;
            if (res.homeGoals !== res.awayGoals) winnerId = res.homeGoals > res.awayGoals ? homeId : awayId;
            else if (res.hasPens && res.homePens !== res.awayPens) winnerId = res.homePens > res.awayPens ? homeId : awayId;
            score = { p1, p2, winnerId };
          } else {
            status = "live";
          }
        }
        return {
          fixtureId: Number(f.FixtureId),
          startTime: start,
          competition: f.Competition,
          participant1: { id: Number(f.Participant1Id), name: f.Participant1 },
          participant2: { id: Number(f.Participant2Id), name: f.Participant2 },
          participant1IsHome: f.Participant1IsHome === true,
          status,
          score,
        };
      }),
    );
    rows.sort((a, b) => a.startTime - b.startTime);

    // Deduped team list (single source of truth for the picker).
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

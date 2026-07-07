// READ-ONLY informational endpoint. For each requested team_id, finds the most
// recent FINISHED fixture where the team did NOT win (loss or draw), using the
// same TxLINE data the oracle uses. It NEVER signs, writes, or touches the
// program — purely surfaces match facts so the UI can show a calm "played and
// didn't win" note.
//
// Finished fixtures drop off the forward snapshot, so we enumerate candidate
// fixtures from the oracle-service persisted fixture metadata (read-only) plus
// the live snapshot, then resolve each via getFinishedResult (per-fixture).
import { NextRequest, NextResponse } from "next/server";
import fs from "node:fs";
import path from "node:path";
import { getTxline, getResolve } from "@/lib/serverOracle";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface Meta { id: number; p1: number; p2: number; p1Name: string; p2Name: string; p1Home: boolean; start: number }

// read-only: the oracle-service's accumulated fixture metadata (id → teams+start)
function loadPersisted(): Meta[] {
  try {
    const p = path.resolve(process.cwd(), "../oracle-service/state/fixtures.json");
    const s = JSON.parse(fs.readFileSync(p, "utf8"));
    return Object.values(s.fixtures || {}).map((f: any) => ({
      id: Number(f.FixtureId), p1: Number(f.Participant1Id), p2: Number(f.Participant2Id),
      p1Name: f.Participant1, p2Name: f.Participant2, p1Home: f.Participant1IsHome === true, start: Number(f.StartTime),
    }));
  } catch { return []; }
}

export async function GET(req: NextRequest) {
  try {
    const teamIds = (req.nextUrl.searchParams.get("teams") || "")
      .split(",").map((s) => Number(s.trim())).filter((n) => Number.isFinite(n) && n > 0);
    if (!teamIds.length) return NextResponse.json({ results: {} });

    const txline = await getTxline();
    const { resolveWinner } = await getResolve();

    const byId = new Map<number, Meta>();
    for (const f of loadPersisted()) byId.set(f.id, f);
    try {
      const snap = await txline.getFixtures();
      for (const f of snap) byId.set(Number(f.FixtureId), {
        id: Number(f.FixtureId), p1: Number(f.Participant1Id), p2: Number(f.Participant2Id),
        p1Name: f.Participant1, p2Name: f.Participant2, p1Home: f.Participant1IsHome === true, start: Number(f.StartTime),
      });
    } catch { /* snapshot optional */ }

    const now = Date.now();
    const want = new Set(teamIds);
    // candidate finished fixtures involving a requested team, most recent first
    const candidates = [...byId.values()]
      .filter((f) => f.start < now && (want.has(f.p1) || want.has(f.p2)))
      .sort((a, b) => b.start - a.start);

    const results: Record<number, any> = {};
    for (const f of candidates) {
      const teamsHere = [f.p1, f.p2].filter((id) => want.has(id) && results[id] === undefined);
      if (!teamsHere.length) continue;
      const res = await txline.getFinishedResult(f.id).catch(() => null);
      if (!res) continue; // not finalised yet
      const w = resolveWinner(res, res.hasPens === true); // resolveWinner handles pens when present
      const homeId = f.p1Home ? f.p1 : f.p2;
      for (const teamId of teamsHere) {
        if (w.winningTeamId === teamId) continue; // won this one → keep looking for an older non-win
        const isHome = teamId === homeId;
        const teamGoals = isHome ? res.homeGoals : res.awayGoals;
        const oppGoals = isHome ? res.awayGoals : res.homeGoals;
        const isP1 = f.p1 === teamId;
        results[teamId] = {
          team: isP1 ? f.p1Name : f.p2Name,
          opponent: isP1 ? f.p2Name : f.p1Name,
          opponentId: isP1 ? f.p2 : f.p1,
          date: f.start,
          teamGoals,
          oppGoals,
          outcome: w.winningTeamId === 0 ? "draw" : "loss",
        };
      }
    }
    for (const id of teamIds) if (results[id] === undefined) results[id] = null;
    return NextResponse.json({ results });
  } catch (e: any) {
    return NextResponse.json({ error: e.message || String(e) }, { status: 502 });
  }
}

// READ-ONLY informational endpoint. For each requested team_id, finds the most
// recent FINISHED fixture where the team did NOT win (loss or draw). Now reads
// entirely from the Supabase cache (see app/src/lib/serverSupabase.ts) instead
// of calling TxLINE directly — same rationale as app/src/app/api/schedule/route.ts.
// It NEVER signs, writes, or touches the program — purely surfaces match facts
// so the UI can show a calm "played and didn't win" note. Response shape is
// unchanged from the previous TxLINE-direct version (consumed by
// app/src/lib/useChallengeNotes.ts).
import { NextRequest, NextResponse } from "next/server";
import { getRecentFinishedForTeam } from "@/lib/serverSupabase";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  try {
    const teamIds = (req.nextUrl.searchParams.get("teams") || "")
      .split(",").map((s) => Number(s.trim())).filter((n) => Number.isFinite(n) && n > 0);
    if (!teamIds.length) return NextResponse.json({ results: {} });

    const results: Record<number, any> = {};
    for (const teamId of teamIds) {
      const recent = await getRecentFinishedForTeam(teamId, 5);
      const lost = recent.find((f) => f.score && f.score.winnerId !== teamId);
      if (!lost || !lost.score) { results[teamId] = null; continue; }
      const isP1 = lost.participant1.id === teamId;
      const teamGoals = isP1 ? lost.score.p1 : lost.score.p2;
      const oppGoals = isP1 ? lost.score.p2 : lost.score.p1;
      results[teamId] = {
        team: isP1 ? lost.participant1.name : lost.participant2.name,
        opponent: isP1 ? lost.participant2.name : lost.participant1.name,
        opponentId: isP1 ? lost.participant2.id : lost.participant1.id,
        date: lost.startTime,
        teamGoals,
        oppGoals,
        outcome: lost.score.winnerId === 0 ? "draw" : "loss",
      };
    }
    return NextResponse.json({ results });
  } catch (e: any) {
    return NextResponse.json({ error: e.message || String(e) }, { status: 502 });
  }
}

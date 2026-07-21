// SERVER ONLY. Fetches a FULL-TIME TxLINE proof so the rule's owner can settle a
// TeamWinVerified challenge themselves, without waiting for the keeper.
//
// WHY A SERVER ROUTE AT ALL: the browser cannot call TxLINE. The API token is
// server-side only, and the app deliberately never talks to TxLINE directly
// (see serverSupabase.ts). So this is a thin authenticated PROXY — it fetches
// and returns the raw /api/scores/stat-validation response and does not
// transform it. The client maps it with statValidationFromApi() in pf.ts, the
// same function the encoder-parity harness pins against the keeper's encoder.
//
// -------------------------------------------------------------------------
// THIS ROUTE IS NOT TRUSTED BY THE PROGRAM. Read before "hardening" it.
//
// A malicious or buggy response here CANNOT cause an invalid settlement,
// because nothing about the settlement decision depends on this server:
//
//   * the payload it returns is verified ON-CHAIN by Txoracle's
//     validate_stat_v2 CPI against `daily_scores_roots`, an account owned by
//     the Txoracle program and committed by TxODDS. A forged leaf or proof
//     fails there — it would require finding a Merkle preimage.
//   * the program independently pins the payload to the RULE, not to anything
//     this route says: fixture_id must equal rule.match_id, the two stat keys
//     must equal the rule's pinned pair IN ORDER, and both must carry
//     period == 100 (full time). See instructions/winverify.rs.
//   * the program then cross-checks the oracle's verdict against its own
//     arithmetic over the proven values and refuses to settle if they disagree.
//
// So the worst this route can do is return something that makes the owner's own
// transaction REVERT (wasting their fee), or return the honest proof. It cannot
// make a losing team win, settle another user's rule, or redirect funds — the
// destination accounts are derived from the rule's vault owner on-chain.
// programs/pocket_fans/tests/test_teamwin_verified_clone.rs exercises each of
// those rejections against the real cloned Txoracle.
// -------------------------------------------------------------------------
import { NextRequest, NextResponse } from "next/server";
import { getTxline } from "@/lib/serverOracle";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The `period` a proven stat carries at full time. Mirrors FULL_TIME_PERIOD in
 *  programs/pocket_fans/src/constants.rs. Checked here only to fail fast with a
 *  readable message — the on-chain pin is what actually enforces it. */
const FULL_TIME_PERIOD = 100;

export async function GET(req: NextRequest) {
  try {
    const q = req.nextUrl.searchParams;
    const fixtureId = Number(q.get("fixtureId"));
    const teamStatKey = Number(q.get("teamStatKey"));
    const opponentStatKey = Number(q.get("opponentStatKey"));

    if (!Number.isFinite(fixtureId) || fixtureId <= 0) {
      return NextResponse.json({ error: "fixtureId required" }, { status: 400 });
    }
    // Only the two full-time goal keys are ever valid for this trigger. This is
    // a sanity guard, not a security boundary: the program pins the pair to the
    // rule regardless of what is requested here.
    const valid = [1, 2];
    if (!valid.includes(teamStatKey) || !valid.includes(opponentStatKey) || teamStatKey === opponentStatKey) {
      return NextResponse.json({ error: "teamStatKey/opponentStatKey must be 1 and 2, in the rule's order" }, { status: 400 });
    }

    const txline = await getTxline();

    // The proof MUST come from the game_finalised event. Any other seq proves a
    // scoreline that could still change, and the on-chain period pin rejects it.
    const events = await txline.getScoresSnapshot(fixtureId);
    const fin = txline.finalFromSnapshot(events);
    if (!fin) {
      return NextResponse.json({ error: "match has not finished yet" }, { status: 409 });
    }
    const seq = Number(fin.Seq);
    if (!Number.isFinite(seq) || seq <= 0) {
      return NextResponse.json({ error: "final event has no usable seq" }, { status: 502 });
    }

    // ORDER MATTERS: the API returns stats in the order requested, and that
    // order is what encodes home/away direction on-chain.
    const sv = await txline.getStatValidation(fixtureId, seq, [teamStatKey, opponentStatKey]);
    if (!sv) {
      return NextResponse.json({ error: "no proof available for this fixture yet" }, { status: 409 });
    }

    // Fail fast on a shape the program would reject anyway, so the user gets a
    // sentence instead of a reverted transaction.
    const stats = sv.statsToProve || [];
    if (stats.length !== 2 || Number(stats[0].key) !== teamStatKey || Number(stats[1].key) !== opponentStatKey) {
      return NextResponse.json({ error: "proof stat order/shape unexpected" }, { status: 502 });
    }
    if (!stats.every((s: any) => Number(s.period) === FULL_TIME_PERIOD)) {
      return NextResponse.json({ error: "proof is not from full time" }, { status: 409 });
    }
    if (!(Number(stats[0].value) > Number(stats[1].value))) {
      return NextResponse.json(
        { error: "not a win at full time — this challenge cannot settle", teamGoals: Number(stats[0].value), opponentGoals: Number(stats[1].value) },
        { status: 409 },
      );
    }

    return NextResponse.json({ seq, proof: sv });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || "failed to fetch proof" }, { status: 500 });
  }
}

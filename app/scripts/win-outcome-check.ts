// Pure-logic test for the TeamWinVerified card state machine.
//
// The bug this exists to prevent: showing "Expired" for a match the backed team
// WON, during the keeper's settle window. That tells the user their money is
// never coming moments before it arrives — worse than showing nothing.
import { fullTimeOutcome } from "../src/lib/pf";

let fail = 0;
const ok = (n: string, c: boolean, x = "") => { c ? console.log(`  PASS ${n}`) : (fail++, console.log(`  FAIL ${n} ${x}`)); };
const fx = (status: any, score: any) => ({ status, participant1: { id: 3021 }, participant2: { id: 1489 }, score });
const HOME = 3021, AWAY = 1489;

console.log("[pending]");
ok("upcoming", fullTimeOutcome(fx("upcoming", null), HOME) === "pending");
ok("live", fullTimeOutcome(fx("live", null), HOME) === "pending");
ok("finished but no score yet", fullTimeOutcome(fx("finished", null), HOME) === "pending");
ok("fixture missing entirely", fullTimeOutcome(undefined, HOME) === "pending");
ok("malformed score", fullTimeOutcome(fx("finished", { p1: null, p2: 0, winnerId: 0 } as any), HOME) === "pending");

console.log("\n[decided]");
ok("home 1-0, backing home -> won", fullTimeOutcome(fx("finished", { p1: 1, p2: 0, winnerId: HOME }), HOME) === "won");
ok("home 1-0, backing away -> lost", fullTimeOutcome(fx("finished", { p1: 1, p2: 0, winnerId: HOME }), AWAY) === "lost");
ok("away 0-2, backing away -> won", fullTimeOutcome(fx("finished", { p1: 0, p2: 2, winnerId: AWAY }), AWAY) === "won");
ok("away 0-2, backing home -> lost", fullTimeOutcome(fx("finished", { p1: 0, p2: 2, winnerId: AWAY }), HOME) === "lost");

console.log("\n[the two flagged risks]");
// RISK 1 — a WON match must resolve to "won", never a dead state, so the card
// shows "settling now" while the keeper works.
ok("WON never resolves to lost/drawn", ["won"].includes(fullTimeOutcome(fx("finished", { p1: 3, p2: 1, winnerId: HOME }), HOME)));
// RISK 2 — v1 scope: level at full time, decided on PENALTIES. winnerId is set
// and non-zero, but full-time goal keys exclude shootout goals, so the rule can
// structurally never settle and must read Expired, not a permanent "waiting".
ok("1-1 decided on pens, backing the shootout WINNER -> drawn (not won)",
   fullTimeOutcome(fx("finished", { p1: 1, p2: 1, winnerId: HOME }), HOME) === "drawn");
ok("1-1 decided on pens, backing the shootout loser -> drawn",
   fullTimeOutcome(fx("finished", { p1: 1, p2: 1, winnerId: HOME }), AWAY) === "drawn");
ok("0-0 group-stage draw (winnerId 0) -> drawn",
   fullTimeOutcome(fx("finished", { p1: 0, p2: 0, winnerId: 0 }), HOME) === "drawn");

console.log("\n[team not in fixture]");
ok("unrelated team -> lost, never won", fullTimeOutcome(fx("finished", { p1: 1, p2: 0, winnerId: HOME }), 999) === "lost");
ok("null teamId -> lost, never won", fullTimeOutcome(fx("finished", { p1: 1, p2: 0, winnerId: HOME }), null) === "lost");

console.log(fail ? `\nFAILED (${fail})` : "\nALL PASSED — a won match never resolves to a dead state; shootouts always do");
process.exit(fail ? 1 : 0);

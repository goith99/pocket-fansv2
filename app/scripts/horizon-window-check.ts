// Exercises isFixtureCreatable against the REAL fixtures currently in TxLINE's
// forward snapshot, today and at simulated future dates.
//
// DIRECTION MATTERS, and it is easy to get backwards (I did, and this check is
// what caught it). create_rule requires:
//     match_end_ts > now                              <- LOWER bound
//     match_end_ts <= now + MAX_MATCH_END_TS_HORIZON  <- UPPER bound
// `now` appears on the right of BOTH. So as time passes the upper bound moves
// FORWARD and a fixed fixture's headroom GROWS — a far-future fixture becomes
// MORE creatable, never less. The bound that actually removes fixtures over
// time is the lower one: kickoff passes.
//
// So the upper guard is not about fixtures ageing out; it is about a fixture
// announced further ahead than the program will accept (friendlies are often
// scheduled a year out). This exercises both bounds against real data.
import { isFixtureCreatable, type CreatableFixture } from "../src/lib/pf";
import { MATCH_END_BUFFER_SECS, MAX_MATCH_END_TS_HORIZON_SECS } from "../src/lib/constants";

// Real /api/fixtures/snapshot output, captured 2026-07-21 (competition 430).
const FIXTURES: (CreatableFixture & { label: string; fixtureId: number })[] = [
  { fixtureId: 18272873, startTime: 1790175600000, label: "Azerbaijan v Tajikistan" },
  { fixtureId: 18182808, startTime: 1790348400000, label: "Australia v Brazil" },
  { fixtureId: 18182864, startTime: 1790694000000, label: "Australia v Brazil (2)" },
  { fixtureId: 18263783, startTime: 1791225900000, label: "Liechtenstein v Gibraltar" },
  { fixtureId: 18242838, startTime: 1794560400000, label: "New Zealand v India" },
  { fixtureId: 18242839, startTime: 1794819600000, label: "New Zealand v India (2)" },
].map((f) => ({ ...f, status: "upcoming" as const }));

let fail = 0;
const ok = (n: string, c: boolean, x = "") => { c ? console.log(`  PASS ${n}`) : (fail++, console.log(`  FAIL ${n} ${x}`)); };

const day = 86400000;
const now = Date.now();
const marginDays2 = (f: CreatableFixture, at: number) =>
  ((Math.floor(at / 1000) + MAX_MATCH_END_TS_HORIZON_SECS) - (Math.floor(f.startTime / 1000) + MATCH_END_BUFFER_SECS)) / 86400;
const marginDays = (f: CreatableFixture) => marginDays2(f, now);

console.log(`today ${new Date(now).toISOString().slice(0, 10)} — creatable now?\n`);
for (const f of FIXTURES) {
  console.log(`  ${isFixtureCreatable(f, now) ? "offer " : "HIDE  "} headroom ${marginDays(f).toFixed(1).padStart(6)}d  ${f.label}`);
}

console.log("\nas time passes (headroom GROWS — fixtures drop out by kickoff, not by horizon):");
console.log("  days ahead | creatable | dropped (kickoff passed)");
for (const d of [0, 6, 65, 70, 80, 118]) {
  const t = now + d * day;
  const creatable = FIXTURES.filter((f) => isFixtureCreatable(f, t));
  const dropped = FIXTURES.filter((f) => !isFixtureCreatable(f, t)).map((f) => f.label);
  console.log(`  +${String(d).padStart(3)}d      | ${String(creatable.length).padStart(2)}/6      | ${dropped.length ? dropped.join(", ") : "—"}`);
}

const nz1 = FIXTURES[4], nz2 = FIXTURES[5];
console.log("\nUPPER bound (the horizon guard):");
ok("all 6 real fixtures are within the horizon today", FIXTURES.every((f) => isFixtureCreatable(f, now)));
ok("headroom GROWS with time, it does not shrink", marginDays(nz2) < marginDays2(nz2, now + 10 * day));
// A fixture announced beyond the horizon must be hidden, or the user gets an
// opaque InvalidMatchEndTs at signing time.
const tooFar = { ...FIXTURES[0], startTime: now + (MAX_MATCH_END_TS_HORIZON_SECS * 1000) + 2 * day, label: "synthetic +122d" };
ok("a fixture BEYOND the horizon is excluded", !isFixtureCreatable(tooFar, now));
ok("...and becomes creatable once the horizon reaches it", isFixtureCreatable(tooFar, now + 5 * day));

console.log("\nLOWER bound (kickoff passes — the one that removes fixtures over time):");
ok("NZ v India (1) offered today", isFixtureCreatable(nz1, now));
ok("NZ v India (1) excluded after its kickoff + buffer", !isFixtureCreatable(nz1, nz1.startTime + (MATCH_END_BUFFER_SECS + 60) * 1000));
const past = { ...FIXTURES[0], startTime: now - 10 * 3600 * 1000 };
ok("a fixture whose match_end_ts has passed is excluded", !isFixtureCreatable(past, now));
ok("a finished fixture is excluded regardless", !isFixtureCreatable({ ...FIXTURES[0], status: "finished" }, now));

console.log(fail ? `\nFAILED (${fail})` : "\nALL PASSED — the picker only offers fixtures create_rule would accept");
process.exit(fail ? 1 : 0);

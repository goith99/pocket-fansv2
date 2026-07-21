// Pins the app's copies of create_rule's timing constants to the Rust source.
//
// isFixtureCreatable() decides which teams the picker offers by reproducing
// create_rule's two guards client-side. If the TS copies drift from the program,
// the picker either offers teams whose rule the chain rejects (opaque
// InvalidMatchEndTs at signing time) or silently hides teams that are fine.
// Neither fails loudly on its own, so this check exists to make drift loud.
import fs from "fs";
import path from "path";
import { MAX_MATCH_END_TS_HORIZON_SECS, MATCH_END_BUFFER_SECS } from "../src/lib/constants";

const rs = fs.readFileSync(
  path.resolve(__dirname, "../../programs/pocket_fans/src/constants.rs"), "utf8",
);

let fail = 0;
const ok = (n: string, c: boolean, x = "") => { c ? console.log(`  PASS ${n}`) : (fail++, console.log(`  FAIL ${n} ${x}`)); };

// Parse the Rust expression rather than a literal, so `120 * 24 * 60 * 60` and a
// bare number both work and a reformat doesn't produce a false failure.
function rustConst(name: string): number | null {
  const m = rs.match(new RegExp(`pub const ${name}:\\s*i64\\s*=\\s*([^;]+);`));
  if (!m) return null;
  const expr = m[1].replace(/_/g, "").trim();
  if (!/^[\d\s*+()-]+$/.test(expr)) return null; // refuse to eval anything unexpected
  // eslint-disable-next-line no-new-func
  return Number(new Function(`return (${expr})`)());
}

const rustHorizon = rustConst("MAX_MATCH_END_TS_HORIZON_SECS");
ok("MAX_MATCH_END_TS_HORIZON_SECS found in constants.rs", rustHorizon !== null);
ok(
  `horizon matches (ts ${MAX_MATCH_END_TS_HORIZON_SECS} === rust ${rustHorizon})`,
  MAX_MATCH_END_TS_HORIZON_SECS === rustHorizon,
  "the picker's filter no longer matches what create_rule enforces",
);

// The buffer is app-side only (the program never sees it), but it feeds the
// match_end_ts the program DOES check, so a sane value still matters.
ok(`MATCH_END_BUFFER_SECS is positive and < horizon (${MATCH_END_BUFFER_SECS}s)`,
   MATCH_END_BUFFER_SECS > 0 && MATCH_END_BUFFER_SECS < MAX_MATCH_END_TS_HORIZON_SECS);

console.log(fail ? `\nFAILED (${fail})` : "\nALL PASSED — the picker's horizon filter matches create_rule");
process.exit(fail ? 1 : 0);

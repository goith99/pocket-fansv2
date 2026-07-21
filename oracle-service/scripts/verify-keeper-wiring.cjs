// Keeper WIRING test — drives the real settleWinsForFixture end to end.
//
// WHY THIS EXISTS (a post-mortem, not a formality):
//
// A production bug shipped where pollWinSettle called goalwatch's
// getRuleIfClaimable — which decodes with the GoalScored layout and returns null
// for every TeamWinVerified rule (trigger tag 2 vs 1). The keeper logged
// "no longer claimable — skipping" on every tick and could never settle
// anything. Rule FNDApw6VtqA7Uvuh3juXV1ws3YN2J5AJ5eY7nuhumBTa sat unclaimed for
// minutes in Railway production while the logs looked superficially healthy.
//
// Every component involved was already tested, and every one of them PASSED:
//   - the settle instruction        -> test_teamwin_verified_clone.rs (LiteSVM)
//   - the winwatch rule decoder     -> verify-win-layout.cjs (real account bytes)
//   - the proof fetch + ix build    -> manual-settle-check.ts (live TxLINE)
//   - both encoders                 -> encoder-parity.ts
//
// The defect was in NONE of them. It was in how pollWinSettle WIRED them
// together, and nothing invoked pollWinSettle or settleWinsForFixture at all —
// every test exercised a component in isolation, and the one dry-run that walked
// the sequence RE-IMPLEMENTED the orchestration instead of calling it, so it
// could not observe the wrong function being called.
//
// So this test deliberately calls the real function and asserts on its real
// behaviour, stubbing only the network. If someone swaps the decoder back, or
// mis-wires candidate selection to the claimable check again, this fails.
const fs = require('fs');
const path = require('path');
const { Keypair, PublicKey } = require('@solana/web3.js');

// poller.cjs hard-exits without these; it never connects during this test.
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost/stub';
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'stub';
process.env.TXLINE_API_TOKEN = process.env.TXLINE_API_TOKEN || 'stub';

const SRC = path.resolve(__dirname, '../src');
const log = require(`${SRC}/logger.cjs`);
const txline = require(`${SRC}/txline.cjs`);
const statvalidation = require(`${SRC}/statvalidation.cjs`);
const goalwatch = require(`${SRC}/goalwatch.cjs`);
const winwatch = require(`${SRC}/winwatch.cjs`);
goalwatch.init({ PublicKey, Keypair });
winwatch.init({ PublicKey });

// capture log lines instead of printing them
let LINES = [];
for (const lvl of ['info', 'warn', 'error']) log[lvl] = (m) => LINES.push(`${lvl.toUpperCase()} ${m}`);
const poller = require(`${SRC}/poller.cjs`);

const REPO = path.resolve(__dirname, '../..');
const ruleBytes = (variant) => {
  const f = `${REPO}/programs/pocket_fans/tests/fixtures/rule_teamwin_verified_${variant}.bin`;
  if (!fs.existsSync(f)) {
    console.error(`missing ${f}\nrun: cargo test --test test_teamwin_verified_clone dump_teamwin`);
    process.exit(1);
  }
  return fs.readFileSync(f);
};
const RAW_PROOF = JSON.parse(fs.readFileSync(
  `${REPO}/programs/pocket_fans/tests/fixtures/stat_validation_18257739_fulltime.json`, 'utf8'));

let fail = 0;
const ok = (n, c, x = '') => { c ? console.log(`  PASS ${n}`) : (fail++, console.log(`  FAIL ${n} ${x}`)); };

// --- a connection that serves real bytes and swallows sends -----------------
function stubConnection(rulePda, data, ownerPk) {
  const vaultPk = new PublicKey(data.subarray(8, 40));
  const vaultData = Buffer.alloc(120);
  vaultData.set(ownerPk.toBuffer(), 8); // UserVault.owner at 8..40
  return {
    sent: [],
    async getAccountInfo(pk) {
      const k = pk.toBase58();
      if (k === rulePda.toBase58()) return { data, owner: statvalidation.PROGRAM_ID };
      if (k === vaultPk.toBase58()) return { data: vaultData, owner: statvalidation.PROGRAM_ID };
      return null;
    },
    async getLatestBlockhash() { return { blockhash: '11111111111111111111111111111111', lastValidBlockHeight: 1 }; },
    async sendTransaction(vtx) { this.sent.push(vtx); return 'STUB_SIGNATURE'; },
    async confirmTransaction() { return {}; },
  };
}

(async () => {
  // =========================================================================
  // 1. The trap itself: the two claimable checks have DISJOINT domains.
  // =========================================================================
  console.log('[1] decoder domains — the exact confusion that caused the bug');
  const data = ruleBytes('swap');
  const rulePda = Keypair.generate().publicKey;
  const owner = Keypair.generate().publicKey;
  const conn = stubConnection(rulePda, data, owner);

  const viaWin = await winwatch.getRuleIfClaimable(conn, rulePda);
  const viaGoal = await goalwatch.getRuleIfClaimable(conn, rulePda);
  ok('winwatch ACCEPTS a real TeamWinVerified rule', viaWin !== null && viaWin.isActive);
  ok('goalwatch REJECTS it (returns null) — using it here is the bug',
     viaGoal === null,
     'goalwatch unexpectedly accepted a tag-2 rule; the layouts may have converged');

  // =========================================================================
  // 2. THE WIRING: run the real settleWinsForFixture and assert it settles.
  //    This is the test that did not exist.
  // =========================================================================
  console.log('\n[2] real settleWinsForFixture, network stubbed');

  const realSnapshot = txline.getScoresSnapshot;
  const realFinal = txline.finalFromSnapshot;
  const realSV = txline.getStatValidation;
  const realTicks = statvalidation.ticksForBToA;
  const realBuild = statvalidation.buildExecuteRuleVerifiedTx;

  txline.getScoresSnapshot = async () => [{ Action: 'game_finalised', Seq: 1385 }];
  txline.finalFromSnapshot = (evs) => evs.find((e) => e.Action === 'game_finalised') || null;
  txline.getStatValidation = async (fixtureId, seq, keys) => {
    // Mirror the live API's contract: stats come back in the order requested.
    const byKey = Object.fromEntries(RAW_PROOF.statsToProve.map((s, i) => [Number(s.key), i]));
    const order = keys.map((k) => byKey[k]);
    return {
      ...RAW_PROOF,
      statsToProve: order.map((i) => RAW_PROOF.statsToProve[i]),
      statProofs: order.map((i) => RAW_PROOF.statProofs[i]),
    };
  };
  const dummy = Keypair.generate().publicKey;
  statvalidation.ticksForBToA = async () => ({ ta0: dummy, ta1: dummy, ta2: dummy, whirlpoolOracle: dummy });
  statvalidation.buildExecuteRuleVerifiedTx = async () => ({ vtx: { serialize: () => Buffer.alloc(919) }, size: 919 });

  for (const [variant, actionKind] of [['swap', 'SwapAndSave'], ['stake', 'SwapStakeAndSave']]) {
    const d = ruleBytes(variant);
    const pda = Keypair.generate().publicKey;
    const own = Keypair.generate().publicKey;
    const c = stubConnection(pda, d, own);
    const rule = winwatch.decodeTeamWinVerifiedRule(pda, d);

    LINES = [];
    await poller.settleWinsForFixture(rule.matchId, [rule], {
      connection: c,
      keeper: Keypair.generate(),
    });

    const claimBail = LINES.find((l) => l.includes('no longer claimable'));
    const settled = LINES.find((l) => l.includes('SETTLED'));
    ok(`${actionKind}: does NOT bail at the claimable check`, !claimBail, claimBail || '');
    ok(`${actionKind}: reaches SETTLED`, !!settled, LINES.join(' | '));
    ok(`${actionKind}: a transaction was actually submitted`, c.sent.length === 1, `sent=${c.sent.length}`);
  }

  // =========================================================================
  // 3. The guard still works when it SHOULD reject: an exhausted rule.
  //    (Otherwise "never bails" could be satisfied by removing the check.)
  // =========================================================================
  console.log('\n[3] the claimable check still rejects a genuinely unclaimable rule');
  const spent = Buffer.from(ruleBytes('swap'));
  // Drive executions_done up to max_executions, read from the account itself —
  // the dumped fixture uses max 3, and hardcoding 1 here silently made this case
  // still-claimable (caught by this very assertion on first run).
  spent.writeUInt16LE(spent.readUInt16LE(114), 116); // executions_done = max_executions
  const pda3 = Keypair.generate().publicKey;
  const c3 = stubConnection(pda3, spent, Keypair.generate().publicKey);
  const rule3 = winwatch.decodeTeamWinVerifiedRule(pda3, ruleBytes('swap')); // stale view: still 0/1
  LINES = [];
  await poller.settleWinsForFixture(rule3.matchId, [rule3], { connection: c3, keeper: Keypair.generate() });
  ok('exhausted rule IS skipped', !!LINES.find((l) => l.includes('no longer claimable')), LINES.join(' | '));
  ok('and nothing was submitted', c3.sent.length === 0, `sent=${c3.sent.length}`);

  txline.getScoresSnapshot = realSnapshot;
  txline.finalFromSnapshot = realFinal;
  txline.getStatValidation = realSV;
  statvalidation.ticksForBToA = realTicks;
  statvalidation.buildExecuteRuleVerifiedTx = realBuild;

  console.log(fail ? `\nFAILED (${fail})` : '\nALL PASSED — pollWinSettle wires candidate selection to the correct claimable check');
  process.exit(fail ? 1 : 0);
})();

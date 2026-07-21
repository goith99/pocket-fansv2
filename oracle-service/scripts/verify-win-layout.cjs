// Asserts winwatch.cjs's hand-written Rule offsets against REAL account bytes
// emitted by the compiled program (dumped by
// programs/pocket_fans/tests/test_teamwin_verified_clone.rs test 7).
const fs = require('fs');
const { PublicKey } = require('@solana/web3.js');
const ww = require('../src/winwatch.cjs');
ww.init({ PublicKey });
const T = `${__dirname}/../../programs/pocket_fans/tests/fixtures/`;

let fail = 0;
const ok = (n, c, extra = '') => { c ? console.log(`  PASS ${n}`) : (fail++, console.log(`  FAIL ${n} ${extra}`)); };

for (const [label, kind, staked] of [['swap', 'SwapAndSave', false], ['stake', 'SwapStakeAndSave', true]]) {
  const f = `${T}rule_teamwin_verified_${label}.bin`;
  if (!fs.existsSync(f)) { console.error(`missing ${f} — run: cargo test --test test_teamwin_verified_clone dump_teamwin`); process.exit(1); }
  const data = fs.readFileSync(f);
  console.log(`\n[${label}] ${data.length} real bytes from the program`);
  const r = ww.decodeTeamWinVerifiedRule(new PublicKey('11111111111111111111111111111111'), data);
  if (!r) { fail++; console.log('  FAIL decoder returned null — keeper would never see this rule'); continue; }
  ok(`actionKind ${kind}`, r.actionKind === kind, r.actionKind);
  ok('isStaked', r.isStaked === staked, String(r.isStaked));
  ok('teamId 3021', r.teamId === 3021, String(r.teamId));
  ok('teamStatKey 1', r.teamStatKey === 1, String(r.teamStatKey));
  ok('opponentStatKey 2', r.opponentStatKey === 2, String(r.opponentStatKey));
  ok('amountUsdc 1000000', r.amountUsdc === '1000000', r.amountUsdc);
  ok('maxSlippageBps 1500', r.maxSlippageBps === 1500, String(r.maxSlippageBps));
  ok('matchId 18257739', r.matchId === 18257739, String(r.matchId));
  ok('maxExecutions 3', r.maxExecutions === 3, String(r.maxExecutions));
  ok('executionsDone 0', r.executionsDone === 0, String(r.executionsDone));
  ok('isActive true', r.isActive === true, String(r.isActive));
  ok('ruleId 0', r.ruleId === 0, String(r.ruleId));
  ok(staked ? 'targetMint absent' : 'targetMint = wSOL',
     staked ? r.targetMint === null : r.targetMint === 'So11111111111111111111111111111111111111112', String(r.targetMint));
}

console.log('\n[pre-filter] isFullTimeWinner');
const row = { participant1_id: 3021, participant2_id: 1489 };
const rule = { teamId: 3021 }, oppRule = { teamId: 1489 };
ok('home 1-0, backing winner -> true',  ww.isFullTimeWinner(rule,    { ...row, score: { p1: 1, p2: 0, winnerId: 3021 } }) === true);
ok('home 1-0, backing loser  -> false', ww.isFullTimeWinner(oppRule, { ...row, score: { p1: 1, p2: 0, winnerId: 3021 } }) === false);
ok('away 0-2, backing winner -> true',  ww.isFullTimeWinner(oppRule, { ...row, score: { p1: 0, p2: 2, winnerId: 1489 } }) === true);
// THE v1 SCOPE CASE: level after ET, decided on penalties. winnerId is set, but
// full-time goals are level, so the on-chain predicate can never prove a win.
ok('1-1 decided on PENS, winnerId set -> false (v1 scope)',
   ww.isFullTimeWinner(rule, { ...row, score: { p1: 1, p2: 1, winnerId: 3021 } }) === false);
ok('no score yet -> false', ww.isFullTimeWinner(rule, { ...row, score: null }) === false);

console.log(fail ? `\nFAILED (${fail})` : '\nALL PASSED — winwatch offsets match the compiled program');
process.exit(fail ? 1 : 0);

// TeamWinVerified keeper — on-chain reads for the auto-settled "my team won"
// trigger. Sibling of goalwatch.cjs; both are UNPRIVILEGED fee-payers whose
// submissions are gated entirely by the Txoracle CPI verdict, never by identity.
//
// DIFFERENT CADENCE FROM GOALWATCH, deliberately. GoalScored polls live matches
// every 15s because a goal can land at any minute. A win can only be decided
// once, at the final whistle, so this hangs off the poller's existing
// match-finality detection (fixtures_cache flipping to 'finished') and does
// nothing at all while a match is in progress. A live match with an open win
// rule costs ZERO extra TxLINE requests.
const crypto = require('crypto');

let PublicKey;
try {
  ({ PublicKey } = require('@solana/web3.js'));
} catch {
  /* injected via init() where web3.js isn't on the resolution path */
}
function init(deps) {
  if (deps && deps.PublicKey) PublicKey = deps.PublicKey;
}

const anchorDisc = (kind, name) =>
  crypto.createHash('sha256').update(`${kind}:${name}`).digest().subarray(0, 8);
const RULE_DISC = anchorDisc('account', 'Rule');

// ---------------------------------------------------------------------------
// RULE LAYOUT for the TeamWinVerified variant.
//
// Same hazard as goalwatch.cjs: TriggerType AND ActionType are both borsh-tagged
// enums, so every field after them shifts. TeamWinVerified is the LONGEST
// trigger, which is why Rule's allocated size grew from 141 to 144 bytes when it
// was added (TriggerType::INIT_SPACE 10 -> 13).
//
//   TeamWinVerified { team_id, team_stat_key, opponent_stat_key } -> 1 + 12 = 13
//
// Offsets below are VERIFIED against real account bytes emitted by the compiled
// program (programs/pocket_fans/tests/test_teamwin_verified_clone.rs dumps both
// action variants; scripts/verify-win-layout.cjs asserts this decoder against
// them), not derived on paper.
//
//                                        SwapAndSave   SwapStakeAndSave
//   disc                0..8               yes            yes
//   vault (32)          8..40              yes            yes
//   rule_id (u16)       40..42             yes            yes
//   trigger tag         42                 2              2
//     team_id (u32)     43..47             43..47         43..47
//     team_stat_key     47..51             47..51         47..51
//     opponent_stat_key 51..55             51..55         51..55
//   action tag          55                 0              1
//     amount_usdc(u64)                     56..64         56..64
//     target_mint(32)                      64..96         -- (absent)
//     slippage (u16)                       96..98         64..66
//   match_id (u64)                         98..106        66..74
//   match_end_ts (i64)                     106..114       74..82
//   max_executions(u16)                    114..116       82..84
//   executions_done(u16)                   116..118       84..86
//   is_active (bool)                       118            86
//
// DO NOT add a dataSize filter (see goalwatch.cjs for why) and DO NOT memcmp on
// is_active: it sits at a different offset per ACTION variant, so a single
// offset would silently drop every rule of the other kind. Filter on the
// discriminator + trigger tag, then check is_active in the decoder.
// ---------------------------------------------------------------------------
const TRIGGER_TAG_OFF = 42;
const TRIGGER_TEAM_WIN_VERIFIED = 2;

const ACTION_SWAP_AND_SAVE = 0;
const ACTION_SWAP_STAKE_AND_SAVE = 1;

const TW = {
  teamId: 43,
  teamStatKey: 47,
  opponentStatKey: 51,
  actionTag: 55,
  amountUsdc: 56,
};
// Everything after amount_usdc depends on whether target_mint is present.
const TAIL = {
  [ACTION_SWAP_AND_SAVE]: {
    targetMint: 64, slippageBps: 96, matchId: 98, matchEndTs: 106,
    maxExecutions: 114, executionsDone: 116, isActive: 118, end: 144,
  },
  [ACTION_SWAP_STAKE_AND_SAVE]: {
    targetMint: null, slippageBps: 64, matchId: 66, matchEndTs: 74,
    maxExecutions: 82, executionsDone: 84, isActive: 86, end: 112,
  },
};

function decodeTeamWinVerifiedRule(pubkey, data) {
  if (!data || data.length < 8) return null;
  if (!data.subarray(0, 8).equals(RULE_DISC)) return null;
  if (data[TRIGGER_TAG_OFF] !== TRIGGER_TEAM_WIN_VERIFIED) return null;

  const actionTag = data[TW.actionTag];
  const t = TAIL[actionTag];
  if (!t) return null; // unknown/newer action — don't misread it
  if (data.length < t.end) return null;

  return {
    rulePda: typeof pubkey === 'string' ? pubkey : pubkey.toBase58(),
    vault: new PublicKey(data.subarray(8, 40)).toBase58(),
    ruleId: data.readUInt16LE(40),
    teamId: data.readUInt32LE(TW.teamId),
    teamStatKey: data.readUInt32LE(TW.teamStatKey),
    opponentStatKey: data.readUInt32LE(TW.opponentStatKey),
    actionKind: actionTag === ACTION_SWAP_STAKE_AND_SAVE ? 'SwapStakeAndSave' : 'SwapAndSave',
    isStaked: actionTag === ACTION_SWAP_STAKE_AND_SAVE,
    amountUsdc: data.readBigUInt64LE(TW.amountUsdc).toString(),
    targetMint: t.targetMint
      ? new PublicKey(data.subarray(t.targetMint, t.targetMint + 32)).toBase58()
      : null,
    maxSlippageBps: data.readUInt16LE(t.slippageBps),
    matchId: Number(data.readBigUInt64LE(t.matchId)),
    matchEndTs: Number(data.readBigInt64LE(t.matchEndTs)),
    maxExecutions: data.readUInt16LE(t.maxExecutions),
    executionsDone: data.readUInt16LE(t.executionsDone),
    isActive: data[t.isActive] === 1,
  };
}

/**
 * Every open TeamWinVerified rule, grouped by match_id.
 * "Open" = active AND under its execution cap.
 */
async function getOpenWinRules(connection, programId) {
  const bs58 = require('bs58');
  const enc = bs58.encode || (bs58.default && bs58.default.encode);

  const accts = await connection.getProgramAccounts(new PublicKey(programId), {
    filters: [
      { memcmp: { offset: 0, bytes: enc(RULE_DISC) } },
      { memcmp: { offset: TRIGGER_TAG_OFF, bytes: enc(Buffer.from([TRIGGER_TEAM_WIN_VERIFIED])) } },
    ],
  });

  const byMatch = new Map();
  for (const a of accts) {
    const r = decodeTeamWinVerifiedRule(a.pubkey, a.account.data);
    if (!r) continue;
    if (!r.isActive) continue;
    if (r.executionsDone >= r.maxExecutions) continue;
    if (!byMatch.has(r.matchId)) byMatch.set(r.matchId, []);
    byMatch.get(r.matchId).push(r);
  }
  return byMatch;
}

/**
 * Would this rule's team be proven a winner by the FULL-TIME goal stats?
 *
 * Pre-filter only — the on-chain predicate is the real gate. Exists so the
 * keeper does not burn a transaction on a rule that is guaranteed to revert.
 *
 * `score` is the fixtures_cache row's cached {p1, p2, winnerId}. NOTE it uses
 * winnerId, which the poller derives from PENALTIES when a match is level after
 * extra time — and that is exactly the v1 case this trigger cannot settle,
 * because the full-time stat keys exclude shootout goals. So this deliberately
 * ignores winnerId and compares the GOAL columns: a level scoreline is not a
 * win here no matter who lifted the trophy.
 */
function isFullTimeWinner(rule, row) {
  const score = row && row.score;
  if (!score) return false;
  const { p1, p2 } = score;
  if (typeof p1 !== 'number' || typeof p2 !== 'number') return false;
  if (p1 === p2) return false; // draw at full time (incl. shootout-decided) — never fires
  const p1Won = p1 > p2;
  const winnerParticipant = p1Won ? row.participant1_id : row.participant2_id;
  return Number(winnerParticipant) === Number(rule.teamId);
}

module.exports = {
  init,
  getOpenWinRules,
  decodeTeamWinVerifiedRule,
  isFullTimeWinner,
  RULE_DISC,
  TRIGGER_TEAM_WIN_VERIFIED,
};

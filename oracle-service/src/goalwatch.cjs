// GoalScored keeper — on-chain reads + keeper keypair for execute_rule_verified.
//
// TRUST MODEL: this keeper is UNPRIVILEGED. execute_rule_verified trusts no
// signer — the Txoracle validate_stat_v2 CPI verdict is the only gate. The
// keeper is just a fee-payer that races to submit a proof. If it is down, late,
// or compromised, the worst case is that a rule fires late (or that the
// keeper's own SOL is wasted on fees). It can never move or steal user funds,
// and it is never a signer over any user's wallet.
//
// This is deliberately SEPARATE from onchain.cjs, which owns the TeamWin
// read path and is left untouched. (See RULE LAYOUT below: onchain.cjs's Rule
// layout constants are stale — its RULE_SIZE=128 predates the match_id /
// match_end_ts fields. Reported, not silently changed, since it sits on the
// TeamWin/self-claim path.)
const fs = require('fs');
const crypto = require('crypto');

let PublicKey, Keypair;
try {
  ({ PublicKey, Keypair } = require('@solana/web3.js'));
} catch {
  /* injected via init() in contexts where web3.js isn't on the resolution path */
}
function init(deps) {
  if (deps && deps.PublicKey) PublicKey = deps.PublicKey;
  if (deps && deps.Keypair) Keypair = deps.Keypair;
}

const anchorDisc = (kind, name) =>
  crypto.createHash('sha256').update(`${kind}:${name}`).digest().subarray(0, 8);

const RULE_DISC = anchorDisc('account', 'Rule');

// ---------------------------------------------------------------------------
// RULE LAYOUT — derived from the compiled struct, NOT guessed.
//
// TriggerType is a BORSH-TAGGED ENUM, so it is VARIABLE LENGTH: every field
// after `trigger_type` sits at a DIFFERENT offset depending on the variant.
// There is no single set of offsets that works for both variants.
//
//   TeamWin    { team_id: u32 }                              -> 1 + 4 = 5 bytes
//   GoalScored { team_id: u32, stat_key: u32, threshold: u8 } -> 1 + 9 = 10 bytes
//
// Verified against `Rule::INIT_SPACE` and a real borsh round-trip of the
// compiled struct (2026-07-13):
//   TriggerType::INIT_SPACE = 10   ActionType::INIT_SPACE = 43
//   Rule::INIT_SPACE = 133  ->  allocated account size = 8 + 133 = 141
//
// IMPORTANT — DO NOT FILTER ON dataSize. Anchor allocates every Rule at the
// MAX variant size, so after this program is redeployed BOTH variants allocate
// 141 bytes (a TeamWin rule serializes to 136 and leaves 5 trailing zero bytes).
// Meanwhile devnet still holds older, smaller Rule accounts (136-byte current
// gen, 128-byte pre-self-claim gen). A dataSize filter therefore silently drops
// whole generations of rules. Filter on the DISCRIMINATOR instead.
//
//                                 TeamWin   GoalScored
//   disc                0..8        yes       yes
//   vault (32)          8..40       yes       yes
//   rule_id (u16)       40..42      yes       yes
//   trigger tag         42          0         1
//     team_id (u32)     43..47      43..47    43..47
//     stat_key (u32)    --          --        47..51
//     threshold (u8)    --          --        51
//   action tag                      47        52
//     amount_usdc(u64)              48..56    53..61
//     target_mint(32)               56..88    61..93
//     slippage (u16)                88..90    93..95
//   match_id (u64)                  90..98    95..103
//   match_end_ts (i64)              98..106   103..111
//   max_executions(u16)             106..108  111..113
//   executions_done(u16)            108..110  113..115
//   is_active (bool)                110       115
//   bump (u8)                       111       116
//   reserved (24)                   112..136  117..141
// ---------------------------------------------------------------------------
const TRIGGER_TAG_OFF = 42;
const TRIGGER_TEAM_WIN = 0;
const TRIGGER_GOAL_SCORED = 1;

// GoalScored-variant offsets only. Never apply these to a TeamWin account.
const GS = {
  teamId: 43,
  statKey: 47,
  threshold: 51,
  actionTag: 52,
  amountUsdc: 53,
  targetMint: 61,
  slippageBps: 93,
  matchId: 95,
  matchEndTs: 103,
  maxExecutions: 111,
  executionsDone: 113,
  isActive: 115,
  bump: 116,
  end: 141,
};

function decodeGoalScoredRule(pubkey, data) {
  if (data.length < GS.end) return null;
  if (!data.subarray(0, 8).equals(RULE_DISC)) return null;
  if (data[TRIGGER_TAG_OFF] !== TRIGGER_GOAL_SCORED) return null;
  if (data[GS.actionTag] !== 0) return null; // 0 = SwapAndSave (only action variant)

  return {
    rulePda: pubkey.toBase58(),
    vault: new PublicKey(data.subarray(8, 40)).toBase58(),
    ruleId: data.readUInt16LE(40),
    teamId: data.readUInt32LE(GS.teamId),
    statKey: data.readUInt32LE(GS.statKey),
    threshold: data[GS.threshold],
    amountUsdc: data.readBigUInt64LE(GS.amountUsdc).toString(),
    targetMint: new PublicKey(data.subarray(GS.targetMint, GS.targetMint + 32)).toBase58(),
    maxSlippageBps: data.readUInt16LE(GS.slippageBps),
    matchId: Number(data.readBigUInt64LE(GS.matchId)),
    matchEndTs: Number(data.readBigInt64LE(GS.matchEndTs)),
    maxExecutions: data.readUInt16LE(GS.maxExecutions),
    executionsDone: data.readUInt16LE(GS.executionsDone),
    isActive: data[GS.isActive] === 1,
  };
}

/**
 * Every on-chain Rule with trigger_type=GoalScored that is still claimable
 * (is_active && executions_done < max_executions), grouped by match_id.
 *
 * Returns: Map<matchId:number, Array<decodedRule>>
 *
 * Server-side filters (cheap, done by the RPC):
 *   - memcmp @0  = Rule discriminator  (NOT dataSize — see RULE LAYOUT above)
 *   - memcmp @42 = trigger tag 1       (GoalScored)
 *   - memcmp @115 = is_active == 1
 * `executions_done < max_executions` is a comparison, not an equality, so it
 * cannot be expressed as a memcmp — it is filtered client-side after decode.
 *
 * Needs a gPA-capable RPC (Helius). Fine here: this runs on Railway, never on
 * a user-facing request path.
 */
async function getOpenGoalWatchRules(connection, programId) {
  const bs58 = require('bs58');
  const enc = bs58.encode || (bs58.default && bs58.default.encode);

  const accts = await connection.getProgramAccounts(new PublicKey(programId), {
    filters: [
      { memcmp: { offset: 0, bytes: enc(RULE_DISC) } },
      { memcmp: { offset: TRIGGER_TAG_OFF, bytes: enc(Buffer.from([TRIGGER_GOAL_SCORED])) } },
      { memcmp: { offset: GS.isActive, bytes: enc(Buffer.from([1])) } },
    ],
  });

  const byMatch = new Map();
  for (const a of accts) {
    const r = decodeGoalScoredRule(a.pubkey, a.account.data);
    if (!r) continue;
    if (!r.isActive) continue; // belt-and-braces; the memcmp already covers it
    if (r.executionsDone >= r.maxExecutions) continue; // cap reached
    if (!byMatch.has(r.matchId)) byMatch.set(r.matchId, []);
    byMatch.get(r.matchId).push(r);
  }
  return byMatch;
}

/**
 * Re-read ONE rule and return it only if it is still claimable. Guards the
 * race between enumerating open rules and actually submitting: another keeper,
 * or the owner themself, may have claimed it in between. Returns null if the
 * rule is gone, inactive, at its cap, or no longer GoalScored.
 */
async function getRuleIfClaimable(connection, rulePubkey) {
  const info = await connection.getAccountInfo(new PublicKey(rulePubkey));
  if (!info) return null;
  const r = decodeGoalScoredRule(new PublicKey(rulePubkey), info.data);
  if (!r) return null;
  if (!r.isActive || r.executionsDone >= r.maxExecutions) return null;
  return r;
}

/** UserVault.owner — needed to derive the owner's ATAs for the tx. Layout: 8 disc + owner(32). */
async function getVaultOwner(connection, vaultPubkey) {
  const info = await connection.getAccountInfo(new PublicKey(vaultPubkey));
  if (!info) return null;
  return new PublicKey(info.data.subarray(8, 40)).toBase58();
}

// ---------------------------------------------------------------------------
// Keeper keypair
// ---------------------------------------------------------------------------

/**
 * Load the dedicated keeper keypair. FEE-PAYER ONLY: never a user wallet, holds
 * no user funds, no privilege in the program.
 *
 * Two sources, because platforms like Railway have no file mounts:
 *   1. `secretKey` — a JSON array string of the secret key bytes (KEEPER_SECRET_KEY).
 *      PREFERRED; wins when both are supplied.
 *   2. `keypairPath` — a keypair file on disk (KEEPER_KEYPAIR_PATH). Local dev.
 *
 * Accepts (config) or a bare path string, so existing callers keep working.
 */
function loadKeeper(source) {
  const { secretKey, keypairPath } =
    typeof source === 'string'
      ? { secretKey: null, keypairPath: source }
      : { secretKey: source?.keeperSecretKey, keypairPath: source?.keeperKeypairPath };

  let raw;
  if (secretKey) {
    // Inline secret. Never log or echo this value.
    let parsed;
    try {
      parsed = JSON.parse(secretKey);
    } catch {
      throw new Error(
        'KEEPER_SECRET_KEY is not valid JSON. It must be the secret key as a JSON array ' +
          'string, e.g. "[12,34,...]" (the same bytes as a solana-keygen file).',
      );
    }
    if (!Array.isArray(parsed) || (parsed.length !== 64 && parsed.length !== 32)) {
      throw new Error(
        `KEEPER_SECRET_KEY must be a JSON array of 64 (or 32) bytes; got ${
          Array.isArray(parsed) ? `${parsed.length} elements` : typeof parsed
        }.`,
      );
    }
    raw = Uint8Array.from(parsed);
  } else {
    if (!keypairPath || !fs.existsSync(keypairPath)) {
      throw new Error(
        `no keeper identity: KEEPER_SECRET_KEY unset and no keypair file at ${keypairPath}.\n` +
          `  Local dev:  solana-keygen new --no-bip39-passphrase -o ${keypairPath}\n` +
          `  Railway:    set KEEPER_SECRET_KEY to the JSON array of the key's bytes\n` +
          `Then fund it: solana airdrop 2 <PUBKEY> --url devnet`,
      );
    }
    raw = Uint8Array.from(JSON.parse(fs.readFileSync(keypairPath, 'utf8')));
  }

  return raw.length === 32 ? Keypair.fromSeed(raw) : Keypair.fromSecretKey(raw);
}

/**
 * Refuse to start the loop with an unfunded keeper — otherwise every
 * execute_rule_verified submission fails at fee payment and the failure looks
 * like an oracle/proof problem when it is really an empty wallet.
 */
async function assertKeeperFunded(connection, keeper, minLamports = 10_000_000 /* 0.01 SOL */) {
  const bal = await connection.getBalance(keeper.publicKey);
  if (bal < minLamports) {
    throw new Error(
      `keeper ${keeper.publicKey.toBase58()} has ${bal / 1e9} SOL — needs at least ` +
        `${minLamports / 1e9} SOL to pay tx fees. Fund it:\n` +
        `  solana airdrop 2 ${keeper.publicKey.toBase58()} --url devnet`,
    );
  }
  return bal;
}

module.exports = {
  init,
  anchorDisc,
  RULE_DISC,
  TRIGGER_TAG_OFF,
  TRIGGER_TEAM_WIN,
  TRIGGER_GOAL_SCORED,
  GS,
  decodeGoalScoredRule,
  getOpenGoalWatchRules,
  getRuleIfClaimable,
  getVaultOwner,
  loadKeeper,
  assertKeeperFunded,
};

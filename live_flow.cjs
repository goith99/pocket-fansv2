/* Live devnet flow for pocket_fans — SELF-CLAIM MODEL (no oracle, no admin).
   Stages: source devUSDC (Orca SOL->USDC) -> init_vault -> create_rule
   (fixes match_id + match_end_ts) -> [wait for the time guard] -> execute_rule
   (signed by the OWNER, Orca USDC->SOL via CPI) -> withdraw_from_vault.

   "Saving" = Victory DCA into $SOL: the wallet's own devUSDC is swapped to
   wSOL and held in the wallet's own vault PDA. Nothing here can lose funds.

   The flow deliberately sets match_end_ts a few seconds in the future and
   FIRST PROVES the on-chain time guard rejects an early claim, then waits it
   out and claims for real. Idempotent where possible; logs & confirms every
   signature.

   Env: RPC_URL required (paid devnet RPC, e.g. Alchemy/Helius). No keys or
   secrets are embedded in this file. */
const {
  Connection, PublicKey, Keypair, Transaction, TransactionInstruction,
  SystemProgram, ComputeBudgetProgram,
} = require('@solana/web3.js');
const {
  getAssociatedTokenAddressSync, createAssociatedTokenAccountIdempotentInstruction,
  createSyncNativeInstruction, TOKEN_PROGRAM_ID,
} = require('@solana/spl-token');
const crypto = require('crypto');
const fs = require('fs');

const RPC = process.env.RPC_URL;
if (!RPC) { console.error('Set RPC_URL to a paid devnet RPC endpoint first.'); process.exit(1); }
const conn = new Connection(RPC, 'confirmed');

const PROGRAM_ID = new PublicKey('4f74EBY7KMe8mUP9MpNzRnPzW6LojYX8wm56ZZz3iDgB');
const WHIRLPOOL_PROGRAM = new PublicKey('whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc');
const WHIRLPOOL = new PublicKey('3KBZiL2g8C7tiJ32hTv5v3KM7aK9htpqTw4cTXz1HvPt');
const VAULT_A = new PublicKey('C9zLV5zWF66j3rZj3uuhDqvfuA8esJyWnruGzDW9qEj2'); // wSOL pool vault
const VAULT_B = new PublicKey('7DM3RMz2yzUB8yPRQM3FMZgdFrwZGMsabsfsKopWktoX'); // devUSDC pool vault
const DEVUSDC = new PublicKey('BRjpCHtyQLNCo8gqRUr8jtdAj5AjPYQaoqbvcZiHok1k');
const WSOL = new PublicKey('So11111111111111111111111111111111111111112');
const SWAP_DISC = Buffer.from([248, 198, 158, 145, 225, 117, 135, 200]);
const MIN_SQRT_PRICE = 4295048016n;
const AMOUNT_USDC = 1_000_000n;   // 1.00 devUSDC per execution
const MAX_EXEC = 3;
const SLIPPAGE_BPS = 1500;
const WRAP_LAMPORTS = 120_000_000n; // 0.12 SOL -> wSOL to source ~2.6 devUSDC
const GUARD_SECS = 20;              // match_end_ts = now + this; proves the guard live

const wallet = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(process.env.HOME + '/.config/solana/id.json'))));

// --- encoders ---
const disc = (name) => crypto.createHash('sha256').update('global:' + name).digest().subarray(0, 8);
const u16 = (n) => { const b = Buffer.alloc(2); b.writeUInt16LE(n); return b; };
const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
const u64 = (n) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };
const i64 = (n) => { const b = Buffer.alloc(8); b.writeBigInt64LE(BigInt(n)); return b; };
const u128 = (n) => { const b = Buffer.alloc(16); b.writeBigUInt64LE(BigInt(n) & 0xffffffffffffffffn, 0); b.writeBigUInt64LE(BigInt(n) >> 64n, 8); return b; };
const meta = (pk, s, w) => ({ pubkey: pk, isSigner: s, isWritable: w });
const pda = (seeds, prog) => PublicKey.findProgramAddressSync(seeds, prog)[0];

// HTTP-only send + confirm (some devnet RPC WS endpoints don't serve signatureSubscribe).
async function send(label, ixs, extraSigners = [], expectFail = false) {
  const tx = new Transaction().add(...ixs);
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash('confirmed');
  tx.recentBlockhash = blockhash;
  tx.feePayer = wallet.publicKey;
  tx.sign(wallet, ...extraSigners);
  let sig;
  try {
    sig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: false, preflightCommitment: 'confirmed' });
  } catch (e) {
    if (expectFail) { console.log(`  ${label}: rejected as expected (${(e.message || '').slice(0, 120)}…)`); return null; }
    throw e;
  }
  while (true) {
    const s = (await conn.getSignatureStatuses([sig])).value[0];
    if (s) {
      if (s.err) {
        if (expectFail) { console.log(`  ${label}: failed on-chain as expected (${JSON.stringify(s.err)})`); return null; }
        throw new Error(`tx ${label} failed: ${JSON.stringify(s.err)}`);
      }
      if (s.confirmationStatus === 'confirmed' || s.confirmationStatus === 'finalized') break;
    }
    if ((await conn.getBlockHeight('confirmed')) > lastValidBlockHeight) throw new Error(`tx ${label} expired (${sig})`);
    await new Promise(r => setTimeout(r, 1200));
  }
  if (expectFail) throw new Error(`tx ${label} SUCCEEDED but was expected to fail — time guard is not enforcing!`);
  console.log(`  ${label}: ${sig}`);
  return sig;
}
async function exists(pk) { return (await conn.getAccountInfo(pk)) !== null; }
async function bal(ata) { try { return BigInt((await conn.getTokenAccountBalance(ata)).value.amount); } catch { return -1n; } }

function tickArrayPda(startIndex) {
  return pda([Buffer.from('tick_array'), WHIRLPOOL.toBuffer(), Buffer.from(String(startIndex))], WHIRLPOOL_PROGRAM);
}

(async () => {
  console.log('wallet:', wallet.publicKey.toBase58());
  const sigs = {};

  // PDAs / ATAs — NOTE: no oracle_authority PDA anywhere anymore.
  const vaultPda = pda([Buffer.from('vault'), wallet.publicKey.toBuffer()], PROGRAM_ID);
  const poolOracle = pda([Buffer.from('oracle'), WHIRLPOOL.toBuffer()], WHIRLPOOL_PROGRAM); // Orca's own pool PDA, unrelated to match results
  const ownerUsdc = getAssociatedTokenAddressSync(DEVUSDC, wallet.publicKey);
  const ownerWsol = getAssociatedTokenAddressSync(WSOL, wallet.publicKey);
  const vaultUsdc = getAssociatedTokenAddressSync(DEVUSDC, vaultPda, true);
  const vaultWsol = getAssociatedTokenAddressSync(WSOL, vaultPda, true);
  console.log('vaultPda:', vaultPda.toBase58());

  // live tick -> tick arrays
  const wp = await conn.getAccountInfo(WHIRLPOOL);
  const tickSpacing = wp.data.readUInt16LE(41);
  const tickCurrent = wp.data.readInt32LE(81);
  const span = tickSpacing * 88;
  const ta0Start = Math.floor(tickCurrent / span) * span;
  const ta0 = tickArrayPda(ta0Start);
  const taUp = tickArrayPda(ta0Start + span);     // b_to_a (USDC->SOL) neighbor
  const taDown = tickArrayPda(ta0Start - span);   // a_to_b (SOL->USDC) neighbor
  const taUpOk = await exists(taUp), taDownOk = await exists(taDown);
  console.log(`tick=${tickCurrent} spacing=${tickSpacing} ta0Start=${ta0Start} ta0=${ta0.toBase58()}`);
  console.log(`  taUp ${taUp.toBase58()} exists=${taUpOk} | taDown ${taDown.toBase58()} exists=${taDownOk}`);

  const swapData = (amt, thresh, sqrtLimit, isInput, aToB) =>
    Buffer.concat([SWAP_DISC, u64(amt), u64(thresh), u128(sqrtLimit), Buffer.from([isInput ? 1 : 0]), Buffer.from([aToB ? 1 : 0])]);
  const swapAccounts = (ownerA, ownerB, t0, t1, t2) => [
    meta(TOKEN_PROGRAM_ID, false, false), meta(wallet.publicKey, true, false), meta(WHIRLPOOL, false, true),
    meta(ownerA, false, true), meta(VAULT_A, false, true), meta(ownerB, false, true), meta(VAULT_B, false, true),
    meta(t0, false, true), meta(t1, false, true), meta(t2, false, true), meta(poolOracle, false, true),
  ];

  // ---------- Stage A: source devUSDC via Orca SOL->USDC ----------
  console.log('\n[A] source devUSDC');
  const preUsdc = await bal(ownerUsdc);
  if (preUsdc >= AMOUNT_USDC) {
    console.log(`  already have ${preUsdc} devUSDC, skipping sourcing`);
  } else {
    // ensure ATAs exist (idempotent; only send a tx if some are missing)
    const haveAll = (await exists(ownerUsdc)) && (await exists(ownerWsol)) && (await exists(vaultUsdc)) && (await exists(vaultWsol));
    if (!haveAll) {
      await send('create ATAs', [
        createAssociatedTokenAccountIdempotentInstruction(wallet.publicKey, ownerUsdc, wallet.publicKey, DEVUSDC),
        createAssociatedTokenAccountIdempotentInstruction(wallet.publicKey, ownerWsol, wallet.publicKey, WSOL),
        createAssociatedTokenAccountIdempotentInstruction(wallet.publicKey, vaultUsdc, vaultPda, DEVUSDC),
        createAssociatedTokenAccountIdempotentInstruction(wallet.publicKey, vaultWsol, vaultPda, WSOL),
      ]);
    } else console.log('  ATAs already exist');
    // ensure wrapped wSOL (idempotent: only wrap the shortfall)
    let wsolBal = await bal(ownerWsol);
    if (wsolBal < WRAP_LAMPORTS) {
      await send('wrap SOL', [
        SystemProgram.transfer({ fromPubkey: wallet.publicKey, toPubkey: ownerWsol, lamports: Number(WRAP_LAMPORTS - wsolBal) }),
        createSyncNativeInstruction(ownerWsol),
      ]);
      wsolBal = await bal(ownerWsol);
    }
    console.log(`  wSOL available to swap: ${wsolBal}`);
    const t1 = taDownOk ? taDown : ta0;
    sigs.source = await send('Orca SOL->USDC swap', [
      ComputeBudgetProgram.setComputeUnitLimit({ units: 400000 }),
      new TransactionInstruction({ programId: WHIRLPOOL_PROGRAM, keys: swapAccounts(ownerWsol, ownerUsdc, ta0, t1, ta0), data: swapData(wsolBal, 0, MIN_SQRT_PRICE, true, true) }),
    ]);
    console.log(`  devUSDC balance now: ${await bal(ownerUsdc)}`);
  }

  // ---------- Stage B: init_vault, create_rule (self-claim fields) ----------
  console.log('\n[B] program setup');
  if (!(await exists(vaultPda))) {
    sigs.initVault = await send('initialize_vault', [new TransactionInstruction({
      programId: PROGRAM_ID,
      keys: [meta(wallet.publicKey, true, true), meta(vaultPda, false, true), meta(SystemProgram.programId, false, false)],
      data: disc('initialize_vault'),
    })]);
  } else console.log('  vault exists, skip');

  // next rule_id = current vault.total_rules (u16 at offset 40)
  const vaultInfo = await conn.getAccountInfo(vaultPda);
  const ruleId = vaultInfo.data.readUInt16LE(40);
  const rulePda = pda([Buffer.from('rule'), vaultPda.toBuffer(), u16(ruleId)], PROGRAM_ID);
  console.log(`  next ruleId=${ruleId} rulePda=${rulePda.toBase58()}`);

  const matchId = BigInt(Date.now());                              // stand-in fixture id
  const matchEndTs = BigInt(Math.floor(Date.now() / 1000) + GUARD_SECS); // claimable in ~GUARD_SECS
  const trigger = Buffer.concat([Buffer.from([0]), u32(42)]); // TeamWin{team_id:42}
  const action = Buffer.concat([Buffer.from([0]), u64(AMOUNT_USDC), WSOL.toBuffer(), u16(SLIPPAGE_BPS)]); // SwapAndSave
  sigs.createRule = await send('create_rule', [new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [meta(wallet.publicKey, true, true), meta(vaultPda, false, true), meta(rulePda, false, true),
      meta(DEVUSDC, false, false), meta(ownerUsdc, false, true), meta(TOKEN_PROGRAM_ID, false, false), meta(SystemProgram.programId, false, false)],
    data: Buffer.concat([disc('create_rule'), trigger, action, u16(MAX_EXEC), u64(matchId), i64(matchEndTs)]),
  })]);
  console.log(`  match_id=${matchId} match_end_ts=${matchEndTs} (claimable in ~${GUARD_SECS}s)`);

  // ---------- Stage C: execute_rule — self-claimed by the OWNER ----------
  console.log('\n[C] execute_rule (self-claim)');
  const execKeys = [
    meta(wallet.publicKey, true, true),        // owner (signer + fee payer) — NOT an oracle
    meta(vaultPda, false, false),              // vault
    meta(rulePda, false, true),                // rule
    meta(DEVUSDC, false, false), meta(WSOL, false, false),
    meta(ownerUsdc, false, true), meta(vaultUsdc, false, true), meta(vaultWsol, false, true),
    meta(WHIRLPOOL, false, true), meta(VAULT_A, false, true), meta(VAULT_B, false, true),
    meta(ta0, false, true), meta(taUpOk ? taUp : ta0, false, true), meta(ta0, false, true),
    meta(poolOracle, false, true), meta(WHIRLPOOL_PROGRAM, false, false), meta(TOKEN_PROGRAM_ID, false, false),
  ];
  const execData = Buffer.concat([disc('execute_rule'), u16(ruleId)]);
  const execIxs = [
    ComputeBudgetProgram.setComputeUnitLimit({ units: 400000 }),
    new TransactionInstruction({ programId: PROGRAM_ID, keys: execKeys, data: execData }),
  ];

  // C1: prove the time guard — an immediate claim MUST be rejected on-chain.
  console.log('  proving time guard (early claim must fail)…');
  await send('execute_rule (early — expect MatchNotFinished)', execIxs, [], /* expectFail */ true);

  // C2: wait out the guard, then claim for real.
  console.log(`  waiting ${GUARD_SECS + 5}s for match_end_ts to pass…`);
  await new Promise(r => setTimeout(r, (GUARD_SECS + 5) * 1000));

  const usdcBefore = await bal(ownerUsdc), wsolVaultBefore = await bal(vaultWsol);
  sigs.execute = await send('execute_rule (self-claim)', execIxs);
  const usdcAfter = await bal(ownerUsdc), wsolVaultAfter = await bal(vaultWsol);
  console.log(`  owner devUSDC: ${usdcBefore} -> ${usdcAfter} (pulled ${usdcBefore - usdcAfter})`);
  console.log(`  vault wSOL: ${wsolVaultBefore} -> ${wsolVaultAfter} (saved ${wsolVaultAfter - wsolVaultBefore} — this is the "saving": DCA into $SOL)`);

  // ---------- Stage D: withdraw_from_vault ----------
  console.log('\n[D] withdraw_from_vault');
  const wsolAmt = wsolVaultAfter;
  const ownerWsolBefore = await bal(ownerWsol);
  sigs.withdraw = await send('withdraw_from_vault', [new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [meta(wallet.publicKey, true, true), meta(vaultPda, false, false), meta(WSOL, false, false),
      meta(vaultWsol, false, true), meta(ownerWsol, false, true), meta(TOKEN_PROGRAM_ID, false, false)],
    data: Buffer.concat([disc('withdraw_from_vault'), u64(wsolAmt)]),
  })]);
  console.log(`  owner wSOL: ${ownerWsolBefore} -> ${await bal(ownerWsol)} | vault wSOL now: ${await bal(vaultWsol)}`);

  console.log('\n=== SIGNATURES ===');
  for (const [k, v] of Object.entries(sigs)) console.log(`${k}: ${v}`);
})().catch(e => { console.error('FLOW ERROR:', e.message || e); if (e.logs) console.error(e.logs.join('\n')); process.exit(1); });

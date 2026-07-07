// SERVER ONLY. Bridges to the existing oracle-service (single source of truth for
// TxLINE fetch/auth + winner determination). Still used by read-only endpoints:
// /api/schedule (getTxline) and /api/challenges/results (getTxline, getResolve).
//
// SELF-CLAIM MODEL: the execute_rule instruction builder that used to live here
// (buildExecuteIx, used by the now-removed /admin + /api/oracle/build-execute)
// has been removed. execute_rule is now built client-side by the rule owner —
// see app/src/lib/pf.ts (ixExecuteRuleSelfClaim) and useFanApp.ts
// (claimChallenge). getOnchain is kept only in case other read-only tooling
// still wants active-rule introspection; it is no longer required by the main
// user flow.
//
// The oracle-service modules are CommonJS OUTSIDE this app; we load them at
// runtime via dynamic import with `webpackIgnore` so Next's bundler leaves them
// to Node (which resolves their deps from the repo root node_modules).
import "server-only";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { PublicKey } from "@solana/web3.js";

const ORACLE_SRC = () => path.resolve(process.cwd(), "../oracle-service/src");

interface OracleMods {
  txline: { getFixtures: () => Promise<any[]>; getFinishedResult: (id: number) => Promise<any | null> };
  resolveMod: { resolveWinner: (r: any, k: boolean) => { winningTeamId: number; reason: string } };
  onchain: {
    // web3.js does not resolve from the sibling oracle-service dir on Vercel, so we
    // inject PublicKey (bundled with this app) before any onchain call. See onchain.cjs.
    init: (deps: { PublicKey: typeof PublicKey }) => void;
    getActiveTeamWinRules: (conn: any, programId: string) => Promise<any[]>;
  };
}
let cached: OracleMods | null = null;

async function load(): Promise<OracleMods> {
  if (cached) return cached;
  const imp = async (file: string) => {
    const url = pathToFileURL(path.join(ORACLE_SRC(), file)).href;
    const m = await import(/* webpackIgnore: true */ url);
    return m.default ?? m;
  };
  cached = {
    txline: await imp("txline.cjs"),
    resolveMod: await imp("resolve.cjs"),
    onchain: await imp("onchain.cjs"),
  };
  // onchain.cjs can't resolve @solana/web3.js from its sibling dir on Vercel; hand it
  // the PublicKey this app already bundles, before any onchain method is called.
  cached.onchain.init({ PublicKey });
  return cached;
}

export const getTxline = async () => (await load()).txline;
export const getResolve = async () => (await load()).resolveMod;
export const getOnchain = async () => (await load()).onchain;

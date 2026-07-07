// SERVER ONLY. Resolves a getProgramAccounts-capable devnet RPC (Helius) without
// exposing its key to the browser, and reads shroudline/.env as a fallback.
import "server-only";
import dns from "node:dns";
import fs from "node:fs";
import path from "node:path";
import { Connection } from "@solana/web3.js";

dns.setDefaultResultOrder("ipv4first"); // WSL/IPv6: some RPC hosts fail otherwise

function fromShroudlineEnv(key: string): string | undefined {
  try {
    const txt = fs.readFileSync(path.resolve(process.cwd(), "../../shroudline/.env"), "utf8");
    const m = txt.match(new RegExp(`^${key}=(.+)$`, "m"));
    return m ? m[1].trim().replace(/^["']|["']$/g, "") : undefined;
  } catch {
    return undefined;
  }
}

export function heliusUrl(): string {
  return process.env.HELIUS_RPC_URL || fromShroudlineEnv("HELIUS_RPC_URL") || "https://api.devnet.solana.com";
}

export function serverConnection(): Connection {
  return new Connection(heliusUrl(), "confirmed");
}

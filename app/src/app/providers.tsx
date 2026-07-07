"use client";
// Buffer polyfill for @solana/web3.js in the browser + conditional Privy.
// When NEXT_PUBLIC_PRIVY_APP_ID is unset, we render children WITHOUT PrivyProvider
// so the Schedule and /admin screens still work; user login shows a notice.
import { Buffer } from "buffer";
import { PrivyProvider } from "@privy-io/react-auth";
import { ReactNode } from "react";

if (typeof window !== "undefined" && !(window as any).Buffer) {
  (window as any).Buffer = Buffer;
}

export const PRIVY_APP_ID = process.env.NEXT_PUBLIC_PRIVY_APP_ID || "";

export function Providers({ children }: { children: ReactNode }) {
  if (!PRIVY_APP_ID) return <>{children}</>;
  return (
    <PrivyProvider
      appId={PRIVY_APP_ID}
      config={{
        // Devnet only. NOTE: verify these keys against your installed Privy
        // version once the App ID is set — Solana config keys shift across
        // Privy releases. Intent: Google login + auto embedded Solana wallet.
        loginMethods: ["google"],
        // Solana-explicit embedded wallet (top-level createOnLogin defaults to EVM).
        embeddedWallets: { solana: { createOnLogin: "users-without-wallets" } },
        appearance: { theme: "dark", accentColor: "#6366f1", walletChainType: "solana-only" },
        solanaClusters: [{ name: "devnet", rpcUrl: "https://api.devnet.solana.com" }],
      } as any}
    >
      {children}
    </PrivyProvider>
  );
}

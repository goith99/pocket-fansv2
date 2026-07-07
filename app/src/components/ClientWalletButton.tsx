"use client";
import dynamic from "next/dynamic";

// The wallet-adapter button detects installed wallet extensions at render time,
// so its markup (e.g. the wallet icon <i>) differs between the server and the
// client and triggers a React hydration mismatch. Render it client-side only.
export const ClientWalletButton = dynamic(
  () => import("@solana/wallet-adapter-react-ui").then((m) => m.WalletMultiButton),
  { ssr: false },
);

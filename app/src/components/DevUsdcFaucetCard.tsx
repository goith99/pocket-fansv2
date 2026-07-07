"use client";
import { useState } from "react";
import { Droplets, ChevronDown, ChevronUp } from "lucide-react";

// Devnet-only helper: there's no public devUSDC faucet, since this mint only
// exists paired with the whirlpool this program swaps against. This card lets
// a new user get some without leaving the app or running a script — wraps SOL
// and swaps it to devUSDC via a real Orca CPI, signed by the user themselves.
export default function DevUsdcFaucetCard({
  solAmount, onSolAmountChange, onGet, busy, solBalance,
}: {
  solAmount: string;
  onSolAmountChange: (v: string) => void;
  onGet: () => void;
  busy: boolean;
  solBalance: number | null;
}) {
  const [open, setOpen] = useState(false);
  const canGet = Number(solAmount) > 0 && !busy && (solBalance == null || solBalance >= Number(solAmount));

  return (
    <div className="card overflow-hidden">
      <button
        className="flex w-full items-center gap-2.5 p-3.5 text-left"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        <span className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-accent/10">
          <Droplets size={15} className="text-accent" />
        </span>
        <span className="flex-1 text-[14px] font-semibold text-ink">Get devUSDC here</span>
        {open ? <ChevronUp size={16} className="text-faint" /> : <ChevronDown size={16} className="text-faint" />}
      </button>

      {open && (
        <div className="border-t border-line p-3.5 pt-3">
          <p className="text-[13px] leading-relaxed text-muted">
            There's no public faucet for this devnet token — it only exists paired
            with the pool this app swaps against. Swap a little devnet SOL for
            devUSDC here (real Orca swap, signed by you).
          </p>
          <div className="mt-3 flex items-center gap-3">
            <div className="relative w-28">
              <input
                className="input pr-10 font-mono font-bold tabular-nums"
                value={solAmount}
                onChange={(e) => onSolAmountChange(e.target.value)}
                inputMode="decimal"
                aria-label="SOL amount to swap"
              />
              <span className="pointer-events-none absolute right-3.5 top-1/2 -translate-y-1/2 text-sm font-semibold text-muted">SOL</span>
            </div>
            <button className="btn-primary !w-auto flex-1 px-4" disabled={!canGet} onClick={onGet}>
              {busy ? "Working…" : "Get devUSDC"}
            </button>
          </div>
          {solBalance != null && Number(solAmount) > solBalance && (
            <p className="mt-2 text-[12px] font-medium text-danger">
              Not enough devnet SOL — airdrop some at faucet.solana.com first.
            </p>
          )}
        </div>
      )}
    </div>
  );
}

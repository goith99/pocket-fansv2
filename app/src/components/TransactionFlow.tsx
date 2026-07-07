"use client";
import { useCallback, useState } from "react";
import { CheckCircle2, XCircle, Wallet, Loader2, ExternalLink, X } from "lucide-react";

export type TxPhase = "idle" | "awaiting" | "confirming" | "confirmed" | "error";
export interface TxState {
  phase: TxPhase;
  label: string;
  sig?: string;
  error?: string;
}

// Drives the 4-state feedback. `run(label, exec)` sets "awaiting" (wallet popup
// open); exec calls `onSent(sig)` after broadcast → "confirming"; returning →
// "confirmed"; throwing → "error" with the real message (never swallowed).
export function useTxFlow() {
  const [state, setState] = useState<TxState>({ phase: "idle", label: "" });
  const reset = useCallback(() => setState({ phase: "idle", label: "" }), []);
  const run = useCallback(
    async (label: string, exec: (onSent: (sig: string) => void) => Promise<string>) => {
      setState({ phase: "awaiting", label });
      try {
        const sig = await exec((s) => setState({ phase: "confirming", label, sig: s }));
        setState({ phase: "confirmed", label, sig });
        return sig;
      } catch (e: any) {
        setState({ phase: "error", label, error: e?.message || String(e) });
        return null;
      }
    },
    [],
  );
  return { state, run, reset };
}

// Reassuring bottom sheet, sitting just above the mobile tab bar so it's visible
// without scrolling. Consumer language; the signature only ever appears as a
// discreet "View receipt" link after success.
export default function TransactionFlow({ state, onDismiss }: { state: TxState; onDismiss: () => void }) {
  if (state.phase === "idle") return null;
  const pending = state.phase === "awaiting" || state.phase === "confirming";

  const tone =
    state.phase === "confirmed" ? "border-green/50" : state.phase === "error" ? "border-danger/50" : "border-accent/50";

  const title =
    state.phase === "awaiting" ? "Confirm in your wallet"
    : state.phase === "confirming" ? "Finishing up…"
    : state.phase === "confirmed" ? "Done!"
    : "That didn’t go through";

  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-[74px] z-40 px-3 sm:bottom-4">
      <div className={`pointer-events-auto mx-auto flex w-full max-w-2xl items-start gap-3 rounded-2xl border-2 bg-card p-4 shadow-pop ${tone}`} role="status" aria-live="polite">
        <span className="mt-0.5 shrink-0">
          {state.phase === "awaiting" && <Wallet size={22} className="text-accent" />}
          {state.phase === "confirming" && <Loader2 size={22} className="animate-spin text-accent" />}
          {state.phase === "confirmed" && <CheckCircle2 size={22} className="text-green" />}
          {state.phase === "error" && <XCircle size={22} className="text-danger" />}
        </span>

        <div className="min-w-0 flex-1">
          <div className="font-display text-lg font-bold uppercase tracking-wide leading-tight">{title}</div>
          <div className="mt-0.5 text-[14px] text-muted">{state.label}</div>

          {state.phase === "awaiting" && <div className="mt-1 text-[13px] text-muted">Approve it in the popup to continue.</div>}
          {state.phase === "error" && <div className="mt-1 break-words text-[13px] text-danger">{state.error}</div>}

          {state.phase === "confirmed" && state.sig && (
            <a
              href={`https://solscan.io/tx/${state.sig}?cluster=devnet`}
              target="_blank"
              rel="noopener noreferrer"
              className="mt-2 inline-flex items-center gap-1.5 text-[14px] font-semibold text-accent"
            >
              View receipt <ExternalLink size={14} />
            </a>
          )}
        </div>

        {!pending && (
          <button onClick={onDismiss} aria-label="Dismiss" className="-mr-1 shrink-0 rounded-lg p-1 text-faint transition hover:text-ink">
            <X size={18} />
          </button>
        )}
      </div>
    </div>
  );
}

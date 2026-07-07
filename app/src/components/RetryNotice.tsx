"use client";
import { AlertCircle, RefreshCw } from "lucide-react";

// Calm inline notice for a transient read failure (RPC hiccup). Lets the user
// retry without a page crash. Neutral treatment — not an error/danger state.
export default function RetryNotice({ message = "Couldn’t load your balance.", onRetry }: { message?: string; onRetry: () => void }) {
  return (
    <div className="card flex items-center justify-between gap-3 p-3.5">
      <div className="flex items-center gap-2 text-[14px] text-muted">
        <AlertCircle size={16} className="shrink-0 text-faint" />
        <span>{message} <span className="text-faint">Just a hiccup.</span></span>
      </div>
      <button onClick={onRetry} className="btn-ghost !min-h-[40px] shrink-0 gap-1.5 px-3 text-sm">
        <RefreshCw size={14} /> Retry
      </button>
    </div>
  );
}

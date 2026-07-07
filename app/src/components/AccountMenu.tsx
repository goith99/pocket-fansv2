"use client";
import { useEffect, useRef, useState } from "react";
import { usePrivy, useSolanaWallets } from "@privy-io/react-auth";
import { User, Copy, Check, LogOut, Wallet } from "lucide-react";
import { PRIVY_APP_ID } from "@/app/providers";

// Wallet address lives BEHIND this menu — never headline content. When Privy
// isn't configured the whole control is absent.
export default function AccountMenu() {
  if (!PRIVY_APP_ID) return null;
  return <AccountMenuInner />;
}

function AccountMenuInner() {
  const { ready, authenticated, login, logout, user } = usePrivy();
  const { wallets } = useSolanaWallets();
  const address = wallets[0]?.address;
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, []);

  if (!ready) return <div className="h-9 w-9 animate-pulse rounded-full bg-line" />;

  if (!authenticated) {
    return (
      <button onClick={login} className="rounded-full bg-accent px-4 py-2 text-sm font-semibold text-white transition hover:bg-accent-dark">
        Log in
      </button>
    );
  }

  const email = user?.google?.email ?? user?.email?.address ?? "Account";
  const copy = async () => {
    if (!address) return;
    try {
      await navigator.clipboard.writeText(address);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {}
  };

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen((v) => !v)}
        aria-label="Account"
        className="grid h-9 w-9 place-items-center rounded-full border border-line bg-card text-muted transition hover:text-ink"
      >
        <User size={18} />
      </button>
      {open && (
        <div className="absolute right-0 top-11 z-40 w-64 animate-fade-in rounded-2xl border border-line bg-card p-3 shadow-pop">
          <div className="px-1 pb-2">
            <div className="text-[11px] font-semibold uppercase tracking-wide text-faint">Signed in</div>
            <div className="truncate text-sm font-medium text-ink">{email}</div>
          </div>
          {address && (
            <button
              onClick={copy}
              className="flex w-full items-center gap-2 rounded-xl border border-line px-3 py-2.5 text-left transition hover:border-accent"
            >
              <Wallet size={16} className="shrink-0 text-muted" />
              <div className="min-w-0 flex-1">
                <div className="text-[11px] font-semibold uppercase tracking-wide text-faint">Account</div>
                <div className="truncate font-mono text-xs text-ink">{address.slice(0, 8)}…{address.slice(-6)}</div>
              </div>
              {copied ? <Check size={15} className="text-green" /> : <Copy size={15} className="text-faint" />}
            </button>
          )}
          <button
            onClick={() => { setOpen(false); logout(); }}
            className="mt-2 flex w-full items-center gap-2 rounded-xl px-3 py-2.5 text-sm font-medium text-ink transition hover:bg-black/[0.03]"
          >
            <LogOut size={16} className="text-muted" /> Log out
          </button>
          <div className="mt-2 border-t border-line px-1 pt-2 text-[11px] text-faint">Devnet demo · test funds only</div>
        </div>
      )}
    </div>
  );
}

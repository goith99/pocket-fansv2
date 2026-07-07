"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Home, CalendarDays, Flag } from "lucide-react";
import AccountMenu from "./AccountMenu";

const TABS = [
  { href: "/", label: "Home", icon: Home },
  { href: "/schedule", label: "Matches", icon: CalendarDays },
  { href: "/my-challenges", label: "My Challenges", icon: Flag },
];

function isActive(path: string, href: string) {
  return href === "/" ? path === "/" : path.startsWith(href);
}

function BallMark() {
  return (
    <span className="grid h-8 w-8 place-items-center rounded-xl bg-green shadow-soft" aria-hidden>
      <svg viewBox="0 0 24 24" width="17" height="17" fill="none">
        <circle cx="12" cy="12" r="9" fill="#fff" />
        <path d="M12 8.2l2.4 1.75-.92 2.85h-2.96l-.92-2.85z" fill="#0e8a46" />
        <path d="M12 3.4v2.1M5.2 9.3l1.9 1.35M18.8 9.3l-1.9 1.35M7.6 18.2l1.2-2M16.4 18.2l-1.2-2" stroke="#0e8a46" strokeWidth="1.3" strokeLinecap="round" />
      </svg>
    </span>
  );
}

export function TopBar() {
  const path = usePathname();
  // /admin keeps its own technical framing — no consumer chrome there
  if (path.startsWith("/admin")) return null;
  return (
    <header className="sticky top-0 z-30 border-b border-line bg-bg/85 backdrop-blur">
      <div className="mx-auto flex w-full max-w-2xl items-center gap-3 px-4 py-2.5">
        <Link href="/" className="flex items-center gap-2">
          <BallMark />
          <span className="font-display text-lg font-bold tracking-wide text-ink">
            Pocket <span className="text-green">Fans</span>
          </span>
        </Link>
        <nav className="ml-auto hidden items-center gap-1 sm:flex">
          {TABS.map((t) => {
            const active = isActive(path, t.href);
            return (
              <Link
                key={t.href}
                href={t.href}
                className={`rounded-lg px-3 py-2 text-sm font-semibold transition ${active ? "text-accent" : "text-muted hover:text-ink"}`}
              >
                {t.label}
              </Link>
            );
          })}
        </nav>
        <div className="ml-auto sm:ml-1">
          <AccountMenu />
        </div>
      </div>
    </header>
  );
}

export function Footer() {
  const path = usePathname();
  if (path.startsWith("/admin")) return null;
  return (
    <footer className="mt-10 border-t border-line pt-5 text-center">
      <p className="text-[12px] text-faint">
        Live match data · Powered by <span className="font-semibold text-muted">TxLINE</span>
      </p>
    </footer>
  );
}

export function BottomNav() {
  const path = usePathname();
  if (path.startsWith("/admin")) return null;
  return (
    <nav className="fixed inset-x-0 bottom-0 z-30 border-t border-line bg-card/95 backdrop-blur sm:hidden">
      <div className="mx-auto grid max-w-2xl grid-cols-3">
        {TABS.map((t) => {
          const active = isActive(path, t.href);
          const Icon = t.icon;
          return (
            <Link
              key={t.href}
              href={t.href}
              className={`flex min-h-[58px] flex-col items-center justify-center gap-1 pb-[max(env(safe-area-inset-bottom),0.4rem)] pt-2 text-[11px] font-semibold transition ${
                active ? "text-accent" : "text-muted"
              }`}
            >
              <Icon size={22} strokeWidth={active ? 2.5 : 2} className={active ? "fill-accent/10" : ""} />
              {t.label}
            </Link>
          );
        })}
      </div>
    </nav>
  );
}

"use client";
import { useMemo, useState } from "react";
import { ArrowLeft, Search, Check } from "lucide-react";
import TeamFlag from "./TeamFlag";
import type { Team } from "@/lib/useFanApp";

// Full-screen "pick your side" sheet — a searchable grid of big flag cards,
// like choosing your team in a fantasy app. Not a <select>.
export default function TeamPickerSheet({
  open,
  teams,
  value,
  onSelect,
  onClose,
}: {
  open: boolean;
  teams: Team[];
  value: number | null;
  onSelect: (id: number) => void;
  onClose: () => void;
}) {
  const [q, setQ] = useState("");
  const filtered = useMemo(() => {
    const s = q.trim().toLowerCase();
    return s ? teams.filter((t) => t.name.toLowerCase().includes(s)) : teams;
  }, [q, teams]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-bg animate-sheet-up">
      <div className="sticky top-0 z-10 border-b border-line bg-bg/95 backdrop-blur">
        <div className="mx-auto w-full max-w-2xl px-4">
          <div className="flex items-center gap-2 py-3">
            <button onClick={onClose} aria-label="Back" className="grid h-10 w-10 place-items-center rounded-full text-ink transition hover:bg-black/[0.04]">
              <ArrowLeft size={20} />
            </button>
            <h2 className="font-display text-2xl font-bold tracking-wide">Pick your team</h2>
          </div>
          <div className="relative pb-3">
            <Search size={18} className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-faint" />
            <input
              autoFocus
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search teams…"
              className="input pl-11"
            />
          </div>
        </div>
      </div>

      <div className="mx-auto w-full max-w-2xl flex-1 overflow-y-auto px-4 py-4">
        {filtered.length === 0 && <div className="py-12 text-center text-sm text-muted">No teams match “{q}”.</div>}
        <div className="grid grid-cols-3 gap-2.5 sm:grid-cols-4">
          {filtered.map((t) => {
            const selected = value === t.id;
            return (
              <button
                key={t.id}
                onClick={() => { onSelect(t.id); onClose(); }}
                className={`relative flex min-h-[116px] flex-col items-center justify-center gap-2 rounded-2xl border bg-card p-2 text-center transition active:scale-[0.97] ${
                  selected ? "border-green ring-2 ring-green/40" : "border-line hover:border-accent"
                }`}
              >
                {selected && (
                  <span className="absolute right-1.5 top-1.5 grid h-5 w-5 place-items-center rounded-full bg-green text-white">
                    <Check size={13} strokeWidth={3} />
                  </span>
                )}
                <TeamFlag name={t.name} size="text-[40px]" />
                <span className="line-clamp-2 font-display text-sm font-semibold uppercase leading-tight tracking-wide text-ink">{t.name}</span>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}

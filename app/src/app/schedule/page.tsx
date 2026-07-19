"use client";
import { useEffect, useMemo, useState } from "react";
import { AlertTriangle } from "lucide-react";
import FixtureCard, { Fixture } from "@/components/FixtureCard";

export default function SchedulePage() {
  const [fixtures, setFixtures] = useState<Fixture[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/schedule")
      .then((r) => r.json())
      .then((d) => (d.error ? setError(d.error) : setFixtures(d.fixtures)))
      .catch((e) => setError(String(e)));
  }, []);

  // /api/schedule returns every fixture ordered by start_time ASCENDING, which
  // put the OLDEST finished match first and buried the next real kickoff at the
  // bottom of the page. Reorder into two runs, still one flat list:
  //   1. not-yet-finished (upcoming/live), soonest kickoff FIRST — the whole
  //      point of the page is "what's next", so that belongs on top
  //   2. finished below, MOST RECENT first — as history, the latest result is
  //      the interesting one, so this run is deliberately descending
  // No section headers needed: FixtureCard already renders a StatusBadge and the
  // final score for finished fixtures, so the boundary is self-evident.
  const sorted = useMemo(() => {
    if (!fixtures) return null;
    const isDone = (f: Fixture) => f.status === "finished";
    return [...fixtures].sort((a, b) => {
      if (isDone(a) !== isDone(b)) return isDone(a) ? 1 : -1;
      return isDone(a) ? b.startTime - a.startTime : a.startTime - b.startTime;
    });
  }, [fixtures]);

  return (
    <div>
      <header className="mb-4">
        <h1 className="font-display text-3xl font-bold tracking-wide">Matches</h1>
        <p className="mt-0.5 text-[15px] text-muted">World Cup — pick a match, back your team.</p>
      </header>

      {error && (
        <div className="card flex items-start gap-2.5 border-danger/30 p-4 text-sm text-danger">
          <AlertTriangle size={16} className="mt-0.5 shrink-0" />
          <span className="break-words">Couldn&apos;t load matches: {error}</span>
        </div>
      )}

      {!sorted && !error && (
        <div className="space-y-3" aria-hidden>
          {[0, 1, 2].map((i) => (
            <div key={i} className="card h-[150px] animate-pulse bg-black/[0.02]" />
          ))}
        </div>
      )}

      {sorted?.length === 0 && <div className="py-12 text-center text-sm text-muted">No matches right now.</div>}

      <div className="space-y-3">
        {sorted?.map((f) => (
          <FixtureCard key={f.fixtureId} fixture={f} />
        ))}
      </div>
    </div>
  );
}

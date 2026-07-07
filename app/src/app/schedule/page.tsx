"use client";
import { useEffect, useState } from "react";
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

      {!fixtures && !error && (
        <div className="space-y-3" aria-hidden>
          {[0, 1, 2].map((i) => (
            <div key={i} className="card h-[150px] animate-pulse bg-black/[0.02]" />
          ))}
        </div>
      )}

      {fixtures?.length === 0 && <div className="py-12 text-center text-sm text-muted">No matches right now.</div>}

      <div className="space-y-3">
        {fixtures?.map((f) => (
          <FixtureCard key={f.fixtureId} fixture={f} />
        ))}
      </div>
    </div>
  );
}

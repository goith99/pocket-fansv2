import { CheckCircle2 } from "lucide-react";
import StatusBadge, { FixtureStatus } from "./StatusBadge";
import TeamFlag from "./TeamFlag";

export interface Fixture {
  fixtureId: number;
  startTime: number;
  competition?: string;
  participant1: { id: number; name: string };
  participant2: { id: number; name: string };
  participant1IsHome?: boolean;
  status: FixtureStatus;
  // real final score, present only for finished fixtures (no live feed exists)
  score?: { p1: number; p2: number; winnerId: number } | null;
}

function kickoff(ms: number): string {
  const d = new Date(ms);
  // localized to the browser's timezone; rendered client-side so no SSR skew
  const day = d.toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" });
  const time = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return `${day} · ${time}`;
}

function TeamRow({ name, goals, emphasis, showScore, winner }: { name: string; goals?: number; emphasis: "win" | "loss" | "neutral"; showScore: boolean; winner: boolean }) {
  const color = emphasis === "win" ? "text-green-deep" : emphasis === "loss" ? "text-muted" : "text-ink";
  return (
    <div className="flex items-center gap-3">
      <TeamFlag name={name} size="text-[30px]" />
      <span className={`font-display text-xl font-semibold leading-tight tracking-wide ${color}`}>{name}</span>
      {showScore && (
        <span className={`ml-auto flex items-center gap-1.5 font-mono text-2xl font-bold tabular-nums ${color}`}>
          {winner && <CheckCircle2 size={14} strokeWidth={2.5} className="text-green" />}
          {goals}
        </span>
      )}
    </div>
  );
}

export default function FixtureCard({ fixture: f }: { fixture: Fixture }) {
  const finished = f.status === "finished" && !!f.score;
  const decided = finished && (f.score?.winnerId ?? 0) > 0;
  const p1Win = decided && f.score!.winnerId === f.participant1.id;
  const p2Win = decided && f.score!.winnerId === f.participant2.id;
  const emph = (isWin: boolean): "win" | "loss" | "neutral" => (!decided ? "neutral" : isWin ? "win" : "loss");

  return (
    <div className="card p-4">
      <div className="flex items-center justify-between gap-3">
        <time className="text-[13px] font-semibold uppercase tracking-wide text-muted">{kickoff(f.startTime)}</time>
        <StatusBadge status={f.status} />
      </div>

      <div className="mt-3 space-y-2.5 border-t border-line pt-3">
        <TeamRow name={f.participant1.name} goals={f.score?.p1} emphasis={emph(p1Win)} showScore={finished} winner={p1Win} />
        <TeamRow name={f.participant2.name} goals={f.score?.p2} emphasis={emph(p2Win)} showScore={finished} winner={p2Win} />
      </div>

      <div className="mt-3 flex items-center gap-2 border-t border-line pt-2.5 text-[12px] text-faint">
        {f.competition && <span>{f.competition}</span>}
        {finished && (
          <span className="ml-auto inline-flex items-center gap-1 font-semibold text-green" title="Result confirmed by the match-data feed">
            <CheckCircle2 size={13} strokeWidth={2.5} /> Result confirmed
          </span>
        )}
      </div>
    </div>
  );
}

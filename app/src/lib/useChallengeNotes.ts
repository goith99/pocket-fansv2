"use client";
import { useEffect, useState } from "react";
import type { RuleView } from "@/lib/pf";

export interface ChallengeNote {
  team: string;
  opponent: string;
  opponentId: number;
  date: number;
  teamGoals: number;
  oppGoals: number;
  outcome: "loss" | "draw";
}

// Read-only: for the ACTIVE challenges' teams, fetches the most recent finished
// fixture each team didn't win (if any). Returns a teamId → note|null map.
export function useChallengeNotes(challenges: RuleView[]): Record<number, ChallengeNote | null> {
  const [notes, setNotes] = useState<Record<number, ChallengeNote | null>>({});
  const key = Array.from(new Set(challenges.filter((c) => c.isActive && c.teamId != null).map((c) => c.teamId!)))
    .sort((a, b) => a - b)
    .join(",");

  useEffect(() => {
    if (!key) { setNotes({}); return; }
    let cancelled = false;
    fetch(`/api/challenges/results?teams=${key}`)
      .then((r) => r.json())
      .then((d) => { if (!cancelled && d.results) setNotes(d.results); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [key]);

  return notes;
}

"use client";
import { ChevronRight, Check, Trophy, Coins, PiggyBank } from "lucide-react";
import Link from "next/link";
import TeamFlag from "./TeamFlag";
import RetryNotice from "./RetryNotice";
import DevUsdcFaucetCard from "./DevUsdcFaucetCard";
import type { RuleView } from "@/lib/pf";

// Goal scored is DISABLED in the UI: GoalScored rules are claimed by the
// permissionless keeper (execute_rule_verified), which pulls USDC via the same
// single shared SPL delegation every other rule uses. When that delegation is
// overwritten/exhausted/revoked by another rule, a keeper claim fails silently
// with no user-facing signal. Re-enable only once create_rule/revoke_rule's
// shared-delegation model is properly fixed. Existing on-chain GoalScored rules
// are untouched — this only stops the UI creating new ones.
const WHEN = [
  { label: "Team wins", state: "active" as const },
  { label: "Goal scored", state: "soon" as const },
  { label: "Corner", state: "soon" as const },
  { label: "Yellow card", state: "soon" as const },
];
export type SaveAction = "dca" | "stake";
/**
 * How the challenge settles once the team wins.
 *   "auto"   -> TriggerType::TeamWinVerified. A permissionless keeper proves the
 *               full-time result via the Txoracle CPI and the payout lands in
 *               the user's wallet. They sign ONCE, at creation, and never again.
 *   "manual" -> TriggerType::TeamWin. The original self-claim model: the owner
 *               taps "Start Saving" after the match. Kept because it needs no
 *               keeper to be running, so it always works.
 */
export type SettleMode = "auto" | "manual";

function Chip({ label, state }: { label: string; state: "active" | "soon" }) {
  if (state === "soon") {
    return (
      <div className="chip chip-soon" aria-disabled>
        {label}
        <span className="chip-soon-tag">Soon</span>
      </div>
    );
  }
  return (
    <div className="chip chip-active">
      <Check size={14} strokeWidth={3} className="text-green" />
      {label}
    </div>
  );
}

// The "Then save" action is now a real choice (Auto DCA -> wSOL, Auto Stake ->
// mSOL). Selectable chip: green/checked when picked, idle otherwise.
function SelectableChip({ label, selected, onClick }: { label: string; selected: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={selected}
      className={`chip ${selected ? "chip-active" : "chip-idle"} transition active:scale-[0.98]`}
    >
      {selected && <Check size={14} strokeWidth={3} className="text-green" />}
      {label}
    </button>
  );
}

function BalanceCard({ label, icon, value, unit }: { label: string; icon: React.ReactNode; value: string; unit?: string }) {
  return (
    <div className="card p-4">
      <div className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-[0.1em] text-faint">{icon}{label}</div>
      <div className="mt-1.5 flex items-baseline gap-1">
        <span className="font-mono text-[26px] font-bold tabular-nums text-ink">{value}</span>
        {unit && <span className="text-sm font-semibold text-muted">{unit}</span>}
      </div>
    </div>
  );
}

// Two-line savings summary, SOL amounts only (no dollar figures anywhere).
//
//  · Staking = the vault's live mSOL balance. mSOL is shown as SOL: it's a
//    1:1-ish liquid staking derivative and the exchange rate is not worth
//    surfacing to a consumer here.
//  · DCA = a LIFETIME ESTIMATE reconstructed from rule history at today's pool
//    price (see savedDcaSol in useFanApp). It is NOT a balance and NOT exact,
//    which is why it carries a "~" and the caption below.
function SavedCard({ stakingSol, dcaSol, celebrate }: { stakingSol: string; dcaSol: string; celebrate: boolean }) {
  return (
    <div className={`card relative overflow-hidden p-4 ${celebrate ? "animate-pop-in ring-2 ring-gold" : ""}`}>
      {celebrate && (
        <div className="pointer-events-none absolute inset-0" aria-hidden>
          {["#FFB020", "#2F6BFF", "#0E8A46", "#FF5A3C", "#FFB020", "#0E8A46"].map((c, i) => (
            <span
              key={i}
              className="absolute top-2 h-2 w-1.5 rounded-sm"
              style={{ left: `${12 + i * 15}%`, background: c, animation: `confetti-fall 1.1s ${i * 90}ms ease-in forwards` }}
            />
          ))}
        </div>
      )}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-[0.1em] text-faint"><PiggyBank size={13} />Saved</div>
        <Trophy size={15} className="text-gold" />
      </div>

      <div className="mt-1.5 text-[11px] font-semibold uppercase tracking-[0.08em] text-faint">Staking</div>
      <div className="flex items-baseline gap-1">
        <span className="font-mono text-[22px] font-bold tabular-nums text-green-deep">{stakingSol}</span>
        <span className="text-xs font-semibold text-muted">SOL</span>
      </div>

      <div className="mt-1.5 text-[11px] font-semibold uppercase tracking-[0.08em] text-faint">DCA</div>
      <div className="flex items-baseline gap-1">
        <span className="font-mono text-[22px] font-bold tabular-nums text-green-deep">~{dcaSol}</span>
        <span className="text-xs font-semibold text-muted">SOL</span>
      </div>
      <div className="mt-0.5 text-[10px] leading-tight text-faint">estimated at today’s rate</div>
    </div>
  );
}

export default function HomeView({
  greetingName, balanceUsd, savedMsol, savedDcaSol, selectedTeam, amount, onAmountChange, onOpenPicker, onCreate, creating, challenges, teamName, celebrate, loadError, onRetry,
  solBalance, faucetSolAmount, onFaucetSolAmountChange, onGetDevUsdc, faucetBusy,
  saveAction, onSaveActionChange,
  settleMode, onSettleModeChange,
}: {
  greetingName: string;
  balanceUsd: number | null;
  savedMsol: number | null;
  savedDcaSol: number | null;
  selectedTeam: { id: number; name: string } | null;
  amount: string;
  onAmountChange: (v: string) => void;
  onOpenPicker: () => void;
  onCreate: () => void;
  creating: boolean;
  saveAction: SaveAction;
  onSaveActionChange: (a: SaveAction) => void;
  settleMode: SettleMode;
  onSettleModeChange: (m: SettleMode) => void;
  challenges: RuleView[];
  teamName: (id: number) => string;
  celebrate: boolean;
  loadError?: boolean;
  onRetry?: () => void;
  solBalance: number | null;
  faucetSolAmount: string;
  onFaucetSolAmountChange: (v: string) => void;
  onGetDevUsdc: () => void;
  faucetBusy: boolean;
}) {
  const canCreate = !!selectedTeam && Number(amount) > 0 && !creating;
  // Home shows just the single most-recent challenge; full list lives under "See all".
  const recent = challenges.slice(0, 1);

  return (
    <div className="space-y-4">
      {/* green pitch hero */}
      <div
        className="-mx-4 -mt-4 px-4 pb-12 pt-6 text-white sm:mx-0 sm:mt-0 sm:rounded-3xl"
        style={{
          backgroundImage:
            "repeating-linear-gradient(90deg, rgba(255,255,255,0.05) 0 1px, transparent 1px 68px), linear-gradient(160deg,#0e8a46,#0a6b37)",
        }}
      >
        <div className="text-sm font-medium text-white/85">Hi, {greetingName} 👋</div>
        <h1 className="mt-1 font-display text-[34px] font-bold leading-[0.98] tracking-wide">
          Back your team.<br />Save when they win.
        </h1>
      </div>

      {/* balances float over the hero */}
      <div className="-mt-11 grid grid-cols-2 gap-3">
        <BalanceCard label="Balance" icon={<Coins size={13} />} value={balanceUsd != null ? `$${balanceUsd.toFixed(2)}` : loadError ? "—" : "…"} />
        <SavedCard
          stakingSol={savedMsol != null ? savedMsol.toFixed(4) : loadError ? "—" : "…"}
          dcaSol={savedDcaSol != null ? savedDcaSol.toFixed(4) : loadError ? "—" : "…"}
          celebrate={celebrate}
        />
      </div>

      {loadError && onRetry && <RetryNotice onRetry={onRetry} />}

      {/* devnet-only: no public devUSDC faucet, so offer the same swap live_flow.cjs does, from the browser */}
      <DevUsdcFaucetCard
        solAmount={faucetSolAmount}
        onSolAmountChange={onFaucetSolAmountChange}
        onGet={onGetDevUsdc}
        busy={faucetBusy}
        solBalance={solBalance}
      />

      {/* create a challenge */}
      <div className="card p-4">
        <h2 className="font-display text-xl font-bold uppercase tracking-wide">Create a challenge</h2>

        <div className="label mb-2 mt-3">When</div>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          {WHEN.map((c) => <Chip key={c.label} {...c} />)}
        </div>

        <button
          onClick={onOpenPicker}
          className="mt-2.5 flex w-full items-center gap-3 rounded-2xl border border-line bg-card p-3 text-left transition hover:border-accent active:scale-[0.99]"
        >
          {selectedTeam ? (
            <>
              <TeamFlag name={selectedTeam.name} size="text-[34px]" />
              <span className="flex-1 font-display text-lg font-semibold tracking-wide">{selectedTeam.name}</span>
              <span className="text-sm font-semibold text-accent">Change</span>
            </>
          ) : (
            <>
              <span className="grid h-9 w-9 place-items-center rounded-full bg-green-tint text-lg">⚽</span>
              <span className="flex-1 font-semibold text-muted">Choose your team</span>
              <ChevronRight size={18} className="text-faint" />
            </>
          )}
        </button>

        <div className="label mb-2 mt-4">Then save</div>
        <div className="grid grid-cols-3 gap-2">
          <SelectableChip label="Auto DCA" selected={saveAction === "dca"} onClick={() => onSaveActionChange("dca")} />
          <SelectableChip label="Auto Stake" selected={saveAction === "stake"} onClick={() => onSaveActionChange("stake")} />
          <Chip label="Round up" state="soon" />
        </div>
        <p className="mt-1.5 text-[13px] text-muted">
          {saveAction === "stake"
            ? "Your winnings are staked into SOL (mSOL) — earns staking yield while saved."
            : "Your winnings are swapped into SOL and paid straight into your wallet."}
        </p>

        <div className="label mb-2 mt-4">Settling</div>
        <div className="grid grid-cols-2 gap-2">
          <SelectableChip label="Automatic" selected={settleMode === "auto"} onClick={() => onSettleModeChange("auto")} />
          <SelectableChip label="I&rsquo;ll tap it" selected={settleMode === "manual"} onClick={() => onSettleModeChange("manual")} />
        </div>
        <p className="mt-1.5 text-[13px] text-muted">
          {settleMode === "auto"
            ? "Saves itself the moment the result is final — you never tap anything again. Draws and penalty shootouts don\u2019t count as a win."
            : "You tap \u201cStart Saving\u201d yourself once the match is over."}
        </p>

        <div className="mt-2.5 flex items-center gap-3">
          <div className="relative w-32">
            <span className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 font-mono text-base font-bold text-ink">$</span>
            <input className="input pl-7 font-mono font-bold tabular-nums" value={amount} onChange={(e) => onAmountChange(e.target.value)} inputMode="decimal" aria-label="amount to save" />
          </div>
          <span className="text-[15px] text-muted">each time they win</span>
        </div>

        <button className="btn-primary mt-3" disabled={!canCreate} onClick={onCreate}>
          {creating ? "Working…" : selectedTeam ? `Create challenge · ${selectedTeam.name} wins` : "Create challenge"}
        </button>
      </div>

      {/* recent challenges */}
      {recent.length > 0 && (
        <div className="card p-4">
          <div className="mb-2 flex items-center justify-between">
            <h2 className="font-display text-xl font-bold uppercase tracking-wide">Your challenges</h2>
            <Link href="/my-challenges" className="text-sm font-semibold text-accent">See all</Link>
          </div>
          <div className="space-y-2">
            {recent.map((r) => {
              const name = teamName(r.teamId ?? 0);
              return (
                <Link key={r.pubkey} href="/my-challenges" className="flex items-center gap-3 rounded-xl border border-line px-3 py-2.5 transition hover:border-accent">
                  <TeamFlag name={name} size="text-2xl" />
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-semibold">
                      {name} wins → save ${(Number(r.amountUsdc) / 1e6).toFixed(2)}
                    </div>
                    <div className="text-[13px] text-muted">{r.isActive ? "Active" : "Cancelled"} · saved {r.executionsDone}/{r.maxExecutions} times</div>
                  </div>
                  <ChevronRight size={18} className="text-faint" />
                </Link>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

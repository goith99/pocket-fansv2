"use client";
// Landing page — what a logged-out visitor sees at "/". Pure presentation; the
// only wire is onLogin. Everything here reuses the app's existing token system
// (green pitch / blue CTA / gold win / Barlow Condensed display / mono numbers)
// so the marketing page and the product are visibly the same thing.
//
// Layout notes:
// - Sections use a full-bleed breakout (left-1/2 w-screen -translate-x-1/2) to
//   escape the app shell's max-w-2xl column on desktop; html/body carry
//   overflow-x: clip (globals.css) so w-screen can't cause a horizontal scroll.
// - The hero is a football pitch seen from above: the app's existing stripe
//   motif plus real pitch markings (halfway line, centre circle, boxes) drawn
//   as one quiet SVG. The phone mockup "stands" on the centre spot and shows
//   the real product UI — that mockup IS the mobile view of the app.
import { Trophy, Coins, PiggyBank, KeyRound, ShieldCheck, Wallet, Check, PartyPopper } from "lucide-react";

/* ---------------------------------------------------------------- helpers */

function Bleed({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return <section className={`relative left-1/2 w-screen -translate-x-1/2 ${className}`}>{children}</section>;
}

/* Pitch markings, viewed from above. Kept to hairline white strokes at low
   opacity so the copy stays readable — the markings are texture, not content. */
function PitchMarkings() {
  return (
    <svg
      aria-hidden
      className="pointer-events-none absolute inset-0 h-full w-full opacity-[0.14]"
      viewBox="0 0 1200 640"
      preserveAspectRatio="xMidYMid slice"
      fill="none"
      stroke="#fff"
      strokeWidth="2"
    >
      {/* touchlines */}
      <rect x="30" y="24" width="1140" height="592" rx="2" />
      {/* halfway line + centre circle + spot */}
      <line x1="600" y1="24" x2="600" y2="616" />
      <circle cx="600" cy="320" r="92" />
      <circle cx="600" cy="320" r="3" fill="#fff" stroke="none" />
      {/* left penalty box + arc */}
      <rect x="30" y="176" width="150" height="288" />
      <rect x="30" y="252" width="56" height="136" />
      <path d="M180 254 A 92 92 0 0 1 180 386" />
      {/* right penalty box + arc */}
      <rect x="1020" y="176" width="150" height="288" />
      <rect x="1114" y="252" width="56" height="136" />
      <path d="M1020 254 A 92 92 0 0 0 1020 386" />
    </svg>
  );
}

/* A hand-built miniature of the actual app home screen. Static by design —
   it is a picture of the product, not a second implementation of it. */
function PhoneMockup() {
  return (
    <div className="mx-auto w-[272px] shrink-0 rounded-[2.4rem] border-[6px] border-ink bg-bg shadow-pop sm:w-[300px]">
      {/* speaker notch */}
      <div className="mx-auto mt-2 h-1.5 w-20 rounded-full bg-ink/15" />

      <div className="space-y-2.5 px-3 pb-5 pt-3">
        {/* mini top bar */}
        <div className="flex items-center gap-1.5 px-0.5">
          <span className="grid h-5 w-5 place-items-center rounded-md bg-green">
            <span className="block h-2.5 w-2.5 rounded-full bg-white" />
          </span>
          <span className="font-display text-[13px] font-bold tracking-wide text-ink">
            Pocket <span className="text-green">Fans</span>
          </span>
        </div>

        {/* mini pitch hero */}
        <div
          className="rounded-2xl px-3 pb-6 pt-3 text-white"
          style={{
            backgroundImage:
              "repeating-linear-gradient(90deg, rgba(255,255,255,0.05) 0 1px, transparent 1px 34px), linear-gradient(160deg,#0e8a46,#0a6b37)",
          }}
        >
          <div className="text-[10px] text-white/85">Hi, Dela 👋</div>
          <div className="mt-0.5 font-display text-[17px] font-bold leading-[1.02] tracking-wide">
            Back your team.<br />Save when they win.
          </div>
        </div>

        {/* balance / saved */}
        <div className="-mt-6 grid grid-cols-2 gap-2">
          <div className="card p-2.5">
            <div className="flex items-center gap-1 text-[8px] font-semibold uppercase tracking-[0.1em] text-faint">
              <Coins size={9} /> Balance
            </div>
            <div className="mt-1 font-mono text-[15px] font-bold tabular-nums text-ink">$12.40</div>
          </div>
          <div className="card p-2.5">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-1 text-[8px] font-semibold uppercase tracking-[0.1em] text-faint">
                <PiggyBank size={9} /> Saved
              </div>
              <Trophy size={10} className="text-gold" />
            </div>
            <div className="mt-1 font-mono text-[15px] font-bold tabular-nums text-green-deep">
              0.0231 <span className="text-[9px] font-semibold text-muted">SOL</span>
            </div>
          </div>
        </div>

        {/* claimable challenge card */}
        <div className="card p-2.5">
          <div className="flex items-center gap-2">
            <span className="text-[22px] leading-none">🇧🇷</span>
            <div className="min-w-0 flex-1">
              <div className="truncate font-display text-[12px] font-semibold tracking-wide">
                Brazil wins → save $2.00
              </div>
              <div className="mt-0.5 flex items-center gap-1 text-[9px] text-muted">
                <span className="inline-flex items-center gap-0.5 font-semibold text-green">
                  <span className="h-1 w-1 rounded-full bg-green" /> Active
                </span>
                <span>·</span>
                <span>saved 1/3</span>
              </div>
            </div>
            <span className="inline-flex items-center gap-1 rounded-lg bg-accent px-2 py-1.5 text-[10px] font-semibold text-white">
              <PartyPopper size={10} /> Claim
            </span>
          </div>
          <p className="mt-2 flex items-start gap-1 rounded-lg bg-green-tint px-2 py-1.5 text-[9px] leading-snug text-green-deep">
            <PartyPopper size={10} className="mt-px shrink-0" />
            Match day has passed — tap Claim to move your savings.
          </p>
        </div>

        {/* second challenge, waiting */}
        <div className="card flex items-center gap-2 p-2.5 opacity-80">
          <span className="text-[22px] leading-none">🇲🇦</span>
          <div className="min-w-0 flex-1">
            <div className="truncate font-display text-[12px] font-semibold tracking-wide">
              Morocco wins → save $1.00
            </div>
            <div className="mt-0.5 text-[9px] text-muted">Next match · Sat 21:00</div>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ page */

const STEPS = [
  {
    icon: <Trophy size={18} className="text-green" />,
    title: "Pick your team",
    body: "Choose who you're backing. Your challenge locks onto their next fixture.",
  },
  {
    icon: <Coins size={18} className="text-green" />,
    title: "Set an amount",
    body: "Decide how much to save per match — you approve one capped allowance, up to 3 saves.",
  },
  {
    icon: <PiggyBank size={18} className="text-green" />,
    title: "Match ends, you claim",
    body: "After the final whistle, tap Claim. Your USDC becomes SOL in your own vault.",
  },
];

const TRUST = [
  {
    icon: <KeyRound size={18} className="text-green-deep" />,
    title: "You sign everything",
    body: "There is no admin key. Only your wallet can move your money — every save is a transaction you approve.",
  },
  {
    icon: <ShieldCheck size={18} className="text-green-deep" />,
    title: "No oracle in your funds",
    body: "Match results are shown for you to see, never used to control your money. Nothing is staked on an outcome.",
  },
  {
    icon: <Wallet size={18} className="text-green-deep" />,
    title: "Withdraw anytime",
    body: "Your savings sit in a vault only you can open. Take them back to your wallet whenever you like.",
  },
];

export default function LandingPage({ onLogin }: { onLogin: () => void }) {
  return (
    <div className="-mt-4">
      {/* ---------------- hero: the pitch ---------------- */}
      <Bleed>
        <div
          className="relative overflow-hidden text-white"
          style={{
            backgroundImage:
              "repeating-linear-gradient(90deg, rgba(255,255,255,0.04) 0 1px, transparent 1px 88px), linear-gradient(165deg,#0e8a46 0%,#0a6b37 70%,#095e30 100%)",
          }}
        >
          <PitchMarkings />
          <div className="relative mx-auto grid w-full max-w-6xl items-center gap-10 px-5 pb-14 pt-12 sm:px-8 lg:grid-cols-[1.05fr_0.95fr] lg:gap-6 lg:pb-20 lg:pt-16">
            {/* copy */}
            <div>
              <span className="inline-flex items-center gap-1.5 rounded-full border border-white/25 bg-white/10 px-3 py-1 text-[11px] font-bold uppercase tracking-[0.1em]">
                <Check size={12} strokeWidth={3} /> It’s saving, not betting
              </span>
              <h1 className="mt-4 font-display text-[52px] font-bold leading-[0.95] tracking-wide sm:text-[64px] lg:text-[72px]">
                Back your team.
                <br />
                Save when they win.
              </h1>
              <p className="mt-4 max-w-md text-[16px] leading-relaxed text-white/85 sm:text-[17px]">
                Every match day, a small amount of your own money moves from USDC into{" "}
                <b className="text-white">$SOL</b> savings — a habit set to your team’s
                fixtures, claimed by you, held by you.
              </p>

              <div className="mt-6 flex flex-col gap-3 sm:flex-row sm:items-center">
                <button className="btn-primary sm:!w-auto sm:px-7" onClick={onLogin}>
                  Log in with Google
                </button>
                <a
                  href="#how-it-works"
                  className="inline-flex min-h-[52px] items-center justify-center rounded-2xl border border-white/30 px-6 text-[15px] font-semibold text-white transition hover:bg-white/10"
                >
                  See how it works
                </a>
              </div>
              <p className="mt-3 text-[13px] text-white/70">
                No seed phrase · wallet created at login · you approve every transaction
              </p>
            </div>

            {/* the product, on the centre spot */}
            <div className="lg:justify-self-end">
              <PhoneMockup />
            </div>
          </div>
        </div>
      </Bleed>

      {/* ---------------- how it works ---------------- */}
      <Bleed className="bg-bg">
        <div id="how-it-works" className="mx-auto w-full max-w-5xl scroll-mt-20 px-5 py-12 sm:px-8 lg:py-16">
          <h2 className="font-display text-3xl font-bold uppercase tracking-wide sm:text-4xl">How it works</h2>
          <p className="mt-1.5 max-w-lg text-[15px] text-muted">
            Three taps to a savings habit. The match is the rhythm — your money never rides on the result.
          </p>
          <ol className="mt-6 grid gap-3 sm:grid-cols-3">
            {STEPS.map((s, i) => (
              <li key={s.title} className="card p-5">
                <div className="flex items-center gap-2.5">
                  <span className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-green-tint font-display text-base font-bold text-green-deep">
                    {i + 1}
                  </span>
                  {s.icon}
                </div>
                <div className="mt-3 font-display text-lg font-semibold uppercase tracking-wide">{s.title}</div>
                <p className="mt-1 text-[15px] leading-relaxed text-muted">{s.body}</p>
              </li>
            ))}
          </ol>
        </div>
      </Bleed>

      {/* ---------------- what "saving" means ---------------- */}
      <Bleed>
        <div className="mx-auto w-full max-w-5xl px-5 pb-12 sm:px-8 lg:pb-16">
          <div className="card overflow-hidden">
            <div className="grid lg:grid-cols-[1fr_auto]">
              <div className="p-6 sm:p-8">
                <h2 className="font-display text-3xl font-bold uppercase tracking-wide sm:text-4xl">
                  Saving = <span className="text-green">match-day DCA</span> into $SOL
                </h2>
                <p className="mt-3 max-w-xl text-[15px] leading-relaxed text-muted">
                  Each claim swaps a fixed amount of your own USDC into SOL and drops it in your
                  savings vault — dollar-cost averaging where the calendar is your team’s
                  fixture list. Nothing is wagered, nobody takes the other side, and there is
                  no losing outcome: the only thing a match decides is <i>when</i> you save.
                </p>
                <ul className="mt-5 space-y-2.5">
                  {[
                    "A capped allowance you set — never more than amount × 3",
                    "Slippage-protected swap on a public DEX, visible on-chain",
                    "Cancel the challenge or withdraw the savings at any moment",
                  ].map((t) => (
                    <li key={t} className="flex items-start gap-2.5 text-[15px] text-ink">
                      <span className="mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded-full bg-green-tint">
                        <Check size={12} strokeWidth={3} className="text-green" />
                      </span>
                      {t}
                    </li>
                  ))}
                </ul>
              </div>

              {/* the flow, in scoreline mono */}
              <div className="flex items-center justify-center border-t border-line bg-green-tint/50 p-6 sm:p-8 lg:border-l lg:border-t-0">
                <div className="text-center">
                  <div className="rounded-2xl border border-line bg-card px-5 py-3 font-mono text-[15px] font-bold tabular-nums text-ink shadow-soft">
                    $2.00 <span className="font-sans text-[12px] font-semibold text-muted">USDC</span>
                  </div>
                  <div className="my-2.5 text-[13px] font-semibold text-muted">⚽ match day · you claim</div>
                  <div className="rounded-2xl border border-green/30 bg-card px-5 py-3 font-mono text-[15px] font-bold tabular-nums text-green-deep shadow-soft">
                    +0.0114 <span className="font-sans text-[12px] font-semibold text-muted">SOL saved</span>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </Bleed>

      {/* ---------------- trust ---------------- */}
      <Bleed>
        <div className="mx-auto w-full max-w-5xl px-5 pb-12 sm:px-8 lg:pb-16">
          <h2 className="font-display text-3xl font-bold uppercase tracking-wide sm:text-4xl">
            Nobody between you and your money
          </h2>
          <div className="mt-6 grid gap-3 sm:grid-cols-3">
            {TRUST.map((t) => (
              <div key={t.title} className="card p-5">
                <span className="grid h-10 w-10 place-items-center rounded-xl bg-green-tint">{t.icon}</span>
                <div className="mt-3 font-display text-lg font-semibold uppercase tracking-wide">{t.title}</div>
                <p className="mt-1 text-[15px] leading-relaxed text-muted">{t.body}</p>
              </div>
            ))}
          </div>
        </div>
      </Bleed>

      {/* ---------------- final whistle ---------------- */}
      <Bleed>
        <div className="mx-auto w-full max-w-5xl px-5 pb-4 sm:px-8">
          <div
            className="relative overflow-hidden rounded-3xl px-6 py-10 text-center text-white sm:py-12"
            style={{
              backgroundImage:
                "repeating-linear-gradient(90deg, rgba(255,255,255,0.05) 0 1px, transparent 1px 68px), linear-gradient(160deg,#0e8a46,#0a6b37)",
            }}
          >
            <h2 className="font-display text-4xl font-bold uppercase tracking-wide sm:text-5xl">
              Ready for match day?
            </h2>
            <p className="mx-auto mt-2 max-w-md text-[15px] text-white/85">
              Set your first challenge before kickoff — it takes about a minute.
            </p>
            <button className="btn-primary mx-auto mt-6 !w-auto px-8" onClick={onLogin}>
              Log in with Google
            </button>
          </div>
        </div>
      </Bleed>
    </div>
  );
}

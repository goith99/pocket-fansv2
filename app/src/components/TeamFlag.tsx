import { isoForName, initialsFor } from "@/lib/flags";

// Real SVG flag (flag-icons) for a nation, sized via the `size` font-size class
// (flag-icons scales to 1em tall). Falls back to a neutral initials chip when the
// nation isn't in the map — never a wrong flag, never a bare country code.
export default function TeamFlag({ name, iso, className = "", size = "text-2xl" }: { name: string; iso?: string | null; className?: string; size?: string }) {
  const code = iso ?? isoForName(name);
  if (code) {
    return (
      <span
        className={`fi fi-${code} ${size} shrink-0 rounded-[3px] shadow-[inset_0_0_0_1px_rgba(0,0,0,0.08)] ${className}`}
        role="img"
        aria-label={`${name} flag`}
      />
    );
  }
  return (
    <span
      className={`inline-flex h-7 w-7 items-center justify-center rounded-md border border-line bg-black/[0.04] text-[11px] font-bold text-muted ${className}`}
      aria-label={name}
    >
      {initialsFor(name)}
    </span>
  );
}

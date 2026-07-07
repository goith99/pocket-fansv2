import type { Config } from "tailwindcss";

// Pocket Fans — consumer sports-fintech theme. LIGHT, day-match energy.
// green = brand / pitch structure · blue = CTAs · gold = the win/celebration
// moment · red = live. Mono is reserved for scorelines only.
const config: Config = {
  content: ["./src/**/*.{js,ts,jsx,tsx,mdx}"],
  theme: {
    extend: {
      colors: {
        bg: "#F3F6F1",
        card: "#FFFFFF",
        line: "#E5EBE1",
        ink: "#12211A",
        muted: "#5B6B62",
        faint: "#8A968E",
        green: { DEFAULT: "#0E8A46", deep: "#0A6B37", tint: "#E4F3E9" },
        accent: { DEFAULT: "#2F6BFF", dark: "#1E52D6", tint: "#E8EEFF" },
        gold: { DEFAULT: "#FFB020", deep: "#E09000", tint: "#FFF3DC" },
        live: "#E23B3B",
        // aliases used by shared status components
        verified: { DEFAULT: "#0E8A46", bright: "#0A6B37" },
        danger: "#E23B3B",
      },
      fontFamily: {
        display: ["var(--font-display)", "system-ui", "sans-serif"],
        sans: ["var(--font-body)", "system-ui", "sans-serif"],
        mono: ["var(--font-mono)", "ui-monospace", "monospace"],
      },
      boxShadow: {
        soft: "0 1px 2px rgba(18,33,26,0.04), 0 6px 20px -8px rgba(18,33,26,0.10)",
        card: "0 1px 3px rgba(18,33,26,0.05), 0 10px 30px -12px rgba(18,33,26,0.12)",
        cta: "0 8px 20px -8px rgba(47,107,255,0.45)",
        pop: "0 12px 40px -10px rgba(18,33,26,0.22)",
      },
      keyframes: {
        "pulse-live": { "0%,100%": { opacity: "1", transform: "scale(1)" }, "50%": { opacity: "0.35", transform: "scale(0.7)" } },
        spin: { to: { transform: "rotate(360deg)" } },
        "sheet-up": { from: { transform: "translateY(100%)" }, to: { transform: "translateY(0)" } },
        "fade-in": { from: { opacity: "0" }, to: { opacity: "1" } },
        "pop-in": { "0%": { transform: "scale(0.8)", opacity: "0" }, "60%": { transform: "scale(1.06)" }, "100%": { transform: "scale(1)", opacity: "1" } },
        "confetti-fall": { "0%": { transform: "translateY(-10px) rotate(0)", opacity: "1" }, "100%": { transform: "translateY(120px) rotate(320deg)", opacity: "0" } },
      },
      animation: {
        "pulse-live": "pulse-live 1.3s ease-in-out infinite",
        spin: "spin 0.8s linear infinite",
        "sheet-up": "sheet-up 0.28s cubic-bezier(0.2,0.8,0.2,1)",
        "fade-in": "fade-in 0.2s ease-out",
        "pop-in": "pop-in 0.5s cubic-bezier(0.2,0.8,0.3,1.2)",
      },
    },
  },
  plugins: [],
};
export default config;

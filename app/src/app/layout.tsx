import type { Metadata } from "next";
import { Barlow_Condensed, Inter, JetBrains_Mono } from "next/font/google";
import "flag-icons/css/flag-icons.min.css";
import "./globals.css";
import { Providers } from "./providers";
import { TopBar, BottomNav, Footer } from "@/components/AppChrome";

// Headings — condensed, sporty. Body/UI — Inter, comfortable sizes. Mono is
// reserved for scorelines only.
const display = Barlow_Condensed({ variable: "--font-display", subsets: ["latin"], weight: ["600", "700"] });
const body = Inter({ variable: "--font-body", subsets: ["latin"] });
const mono = JetBrains_Mono({ variable: "--font-mono", subsets: ["latin"], weight: ["500", "700"] });

export const metadata: Metadata = {
  title: "Pocket Fans — Back your team. Save when they win.",
  description: "Automated match-day savings for football fans.",
  other: {
    "ory-verify": "orynth-708a58c31b72447296fcae3b92100873",
  },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${display.variable} ${body.variable} ${mono.variable}`}>
      <body>
        <Providers>
          <TopBar />
          <main className="mx-auto w-full max-w-2xl px-4 pb-28 pt-4 sm:pb-12">
            {children}
            <Footer />
          </main>
          <BottomNav />
        </Providers>
      </body>
    </html>
  );
}

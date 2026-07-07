"use client";
import Link from "next/link";
import { CalendarDays } from "lucide-react";
import { PRIVY_APP_ID } from "./providers";
import UserDashboard from "@/components/UserDashboard";

export default function Home() {
  if (!PRIVY_APP_ID) {
    return (
      <div>
        <div
          className="-mx-4 -mt-4 px-4 pb-8 pt-9 text-white sm:mx-0 sm:mt-0 sm:rounded-3xl"
          style={{ backgroundImage: "repeating-linear-gradient(90deg, rgba(255,255,255,0.05) 0 1px, transparent 1px 68px), linear-gradient(160deg,#0e8a46,#0a6b37)" }}
        >
          <h1 className="font-display text-[40px] font-bold leading-[0.98] tracking-wide">Back your team.<br />Save when they win.</h1>
        </div>
        <div className="card mt-5 p-5">
          <p className="text-[15px] text-muted">Login isn’t set up in this environment yet. You can still browse the matches.</p>
          <Link className="btn-primary mt-4" href="/schedule"><CalendarDays size={16} /> View matches</Link>
        </div>
      </div>
    );
  }
  return <UserDashboard />;
}

// Same-origin RPC proxy → keeps the Helius API key server-side. The browser
// points its Connection at /api/rpc.
import { NextRequest, NextResponse } from "next/server";
import { heliusUrl } from "@/lib/serverRpc";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const body = await req.text();
  const res = await fetch(heliusUrl(), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
  });
  const text = await res.text();
  return new NextResponse(text, { status: res.status, headers: { "Content-Type": "application/json" } });
}

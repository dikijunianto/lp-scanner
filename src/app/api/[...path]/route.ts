import { NextRequest, NextResponse } from "next/server";
export const dynamic = "force-dynamic";
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ path: string[] }> },
) {
  const { path } = await params;
  const allowed =
    (path.length === 1 && ["health", "pools", "alerts", "watchlist"].includes(path[0])) ||
    (path.length === 2 && path[0] === "pools" && path[1].length <= 180) ||
    (path.length === 2 && path[0] === "diagnostics" && path[1] === "data-health") ||
    (path.length === 3 && path[0] === "diagnostics" && path[1] === "pool-freshness" && path[2].length <= 180) ||
    (path.length === 2 && path[0] === "research" && ["signals", "summary", "coverage"].includes(path[1])) ||
    (path.length === 3 && path[0] === "research" && path[1] === "signals" && /^\d+$/.test(path[2]));
  if (!allowed) return NextResponse.json({ error: "Not found" }, { status: 404 });
  try {
    const response = await fetch(
      `http://127.0.0.1:${process.env.API_PORT || 3001}/${path.map(encodeURIComponent).join("/")}`,
      { cache: "no-store", signal: AbortSignal.timeout(60000) },
    );
    return new NextResponse(await response.text(), {
      status: response.status,
      headers: { "content-type": "application/json", "cache-control": "no-store" },
    });
  } catch {
    return NextResponse.json(
      { error: "Scanner service unavailable. Start both services with pnpm dev or pnpm start." },
      { status: 503 },
    );
  }
}
export async function POST(request: NextRequest, { params }: { params: Promise<{ path: string[] }> }) {
  const { path } = await params;
  if (path.length !== 1 || path[0] !== "watchlist") return NextResponse.json({ error: "Not found" }, { status: 404 });
  const origin = request.headers.get("origin");
  if (origin && !["http://localhost:3000", "http://127.0.0.1:3000"].includes(origin))
    return NextResponse.json({ error: "Local origin required" }, { status: 403 });
  try {
    const body = await request.text();
    if (body.length > 1000) return NextResponse.json({ error: "Request too large" }, { status: 413 });
    const response = await fetch(`http://127.0.0.1:${process.env.API_PORT || 3001}/watchlist`, {
      method: "POST", headers: { "content-type": "application/json" }, body,
      signal: AbortSignal.timeout(10000),
    });
    return new NextResponse(await response.text(), { status: response.status,
      headers: { "content-type": "application/json", "cache-control": "no-store" } });
  } catch { return NextResponse.json({ error: "Scanner service unavailable" }, { status: 503 }); }
}

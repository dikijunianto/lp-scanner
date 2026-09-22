import { NextRequest, NextResponse } from "next/server";
export const dynamic = "force-dynamic";
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ path: string[] }> },
) {
  const { path } = await params;
  const allowed =
    (path.length === 1 && ["health", "pools", "alerts"].includes(path[0])) ||
    (path.length === 2 && path[0] === "pools" && path[1].length <= 180);
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

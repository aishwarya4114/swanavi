import { NextRequest, NextResponse } from "next/server";

const API = process.env.SWANAVI_API_URL || "http://127.0.0.1:8791";

async function proxy(request: NextRequest, path: string[]) {
  const target = `${API}/api/${path.join("/")}`;
  const headers = new Headers();
  headers.set("Accept", "application/json");
  headers.set("X-Swanavi-Actor", process.env.SWANAVI_DEMO_ACTOR || "traveler_ada");
  const init: RequestInit = { method: request.method, headers, cache: "no-store" };
  if (request.method !== "GET" && request.method !== "HEAD") {
    init.body = await request.text();
    headers.set("Content-Type", "application/json");
  }
  try {
    const response = await fetch(target, init);
    if (path.at(-1) === "events" && response.body) {
      return new NextResponse(response.body, {
        status: response.status,
        headers: {
          "Content-Type": "text/event-stream; charset=utf-8",
          "Cache-Control": "no-store",
          "X-Accel-Buffering": "no",
        },
      });
    }
    const text = await response.text();
    return new NextResponse(text, {
      status: response.status,
      headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
    });
  } catch {
    return NextResponse.json(
      { error: "dashboard_api_unreachable", offline_fallback: true },
      { status: 502 },
    );
  }
}

export async function GET(request: NextRequest, context: { params: Promise<{ path: string[] }> }) {
  const { path } = await context.params;
  return proxy(request, path);
}

export async function POST(request: NextRequest, context: { params: Promise<{ path: string[] }> }) {
  const { path } = await context.params;
  return proxy(request, path);
}

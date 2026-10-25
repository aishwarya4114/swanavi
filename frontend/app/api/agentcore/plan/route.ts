import { BedrockAgentCoreClient, InvokeAgentRuntimeCommand } from "@aws-sdk/client-bedrock-agentcore";
import { GetCallerIdentityCommand, STSClient } from "@aws-sdk/client-sts";
import { NextResponse } from "next/server";
import { parseAgentStream } from "@/lib/agentcore-stream";
import { novaPlanRequest } from "@/lib/plan-prompt";

const REGION = "us-west-2";
const ACCOUNT = "970644448349";
const RUNTIME_ARN =
  process.env.SWANAVI_RUNTIME_ARN ||
  "arn:aws:bedrock-agentcore:us-west-2:970644448349:runtime/swanavi_default_agent-60kXN42fLi";

function sessionId(): string {
  const stamp = `${Date.now().toString(16)}${Math.random().toString(16).slice(2)}`;
  return `swanavi-browser-${stamp}`.slice(0, 80).padEnd(33, "0");
}

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "The trip details could not be read." }, { status: 400 });
  }
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "The trip details could not be read.", invoked: false }, { status: 400 });
  }
  const plan = novaPlanRequest(body as Record<string, unknown>);
  if (!plan.ok) {
    return NextResponse.json({ error: plan.error, invoked: false }, { status: plan.status });
  }

  const sts = new STSClient({ region: REGION });
  let account = "";
  try {
    const identity = await sts.send(new GetCallerIdentityCommand({}));
    account = identity.Account || "";
  } catch {
    return NextResponse.json(
      { error: "The server cannot reach AWS with its local credentials." },
      { status: 503 },
    );
  }
  if (account !== ACCOUNT) {
    return NextResponse.json({ error: "AWS credentials are not for the Swanavi sandbox." }, { status: 403 });
  }

  const client = new BedrockAgentCoreClient({ region: REGION });
  let raw = "";
  try {
    const response = await client.send(new InvokeAgentRuntimeCommand({
      agentRuntimeArn: RUNTIME_ARN,
      qualifier: "DEFAULT",
      runtimeSessionId: sessionId(),
      contentType: "application/json",
      accept: "text/event-stream",
      payload: new TextEncoder().encode(JSON.stringify({
        prompt: plan.prompt,
        actorId: "traveler_ada",
      })),
    }));
    raw = await response.response?.transformToString() ?? "";
  } catch (caught) {
    const message = caught instanceof Error ? caught.name : "InvokeFailed";
    return NextResponse.json(
      { error: `The runtime request failed (${message}). It was not retried.` },
      { status: 502 },
    );
  }

  const parsed = parseAgentStream(raw);
  if (!parsed.itinerary) {
    return NextResponse.json(
      { error: parsed.streamError || "The runtime returned no itinerary. It was not retried." },
      { status: 502 },
    );
  }
  let recorded = false;
  try {
    const desk = await fetch(`${process.env.SWANAVI_API_URL || "http://127.0.0.1:8791"}/api/live/runs/${plan.runId}/nova`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Swanavi-Actor": "traveler_ada" },
      body: JSON.stringify({
        confirm: "record-nova-evidence",
        modelCalls: parsed.modelCalls,
        delegatedToPlanner: parsed.delegatedToPlanner,
        itinerary: parsed.itinerary,
        budgetReadFailed: parsed.budgetReadFailed,
      }),
      cache: "no-store",
    });
    recorded = desk.ok;
  } catch {
    recorded = false;
  }
  return NextResponse.json({
    itinerary: parsed.itinerary,
    modelCalls: parsed.modelCalls,
    delegatedToPlanner: parsed.delegatedToPlanner,
    budgetReadFailed: parsed.budgetReadFailed,
    recorded,
  });
}

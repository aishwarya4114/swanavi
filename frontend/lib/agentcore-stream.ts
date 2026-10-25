export type ParsedAgentStream = {
  itinerary: string;
  modelCalls: number;
  delegatedToPlanner: boolean;
  budgetReadFailed: boolean;
  streamError: string | null;
};

type StreamEvent = {
  event?: {
    contentBlockDelta?: { delta?: { text?: string } };
    contentBlockStart?: { start?: { toolUse?: { name?: string } } };
    messageStop?: { stopReason?: string };
    metadata?: { usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number } };
  };
  error?: string;
};

function parseEvent(line: string): StreamEvent | null {
  const trimmed = line.trim();
  const jsonText = trimmed.startsWith("data:") ? trimmed.slice(5).trim() : trimmed;
  if (!jsonText.startsWith("{")) return null;
  try {
    return JSON.parse(jsonText) as StreamEvent;
  } catch {
    return null;
  }
}

export function parseAgentStream(raw: string): ParsedAgentStream {
  const finalText: string[] = [];
  let current: string[] = [];
  let modelCalls = 0;
  let delegated = false;
  let streamError: string | null = null;

  for (const line of raw.split(/\r?\n/)) {
    const parsed = parseEvent(line);
    if (!parsed) continue;
    if (typeof parsed.error === "string" && parsed.error.trim()) streamError = parsed.error.trim();
    const event = parsed.event;
    if (!event) continue;
    const text = event.contentBlockDelta?.delta?.text;
    if (typeof text === "string") current.push(text);
    if (event.contentBlockStart?.start?.toolUse?.name === "delegateToPlanner") delegated = true;
    if (event.metadata?.usage) modelCalls += 1;
    const stop = event.messageStop?.stopReason;
    if (stop === "tool_use") current = [];
    if (stop === "end_turn") finalText.push(current.join(""));
  }

  const itinerary = (finalText.at(-1) ?? "")
    .replace(/<thinking>[\s\S]*?<\/thinking>/gi, "")
    .trim();
  const budgetReadFailed = /budget/i.test(raw) && /fail|error|unable|530/i.test(raw);
  return {
    itinerary,
    modelCalls: Math.max(modelCalls, delegated ? 1 : 0),
    delegatedToPlanner: delegated,
    budgetReadFailed,
    streamError: itinerary ? null : streamError,
  };
}

import assert from "node:assert/strict";
import test from "node:test";
import { parseAgentStream } from "./agentcore-stream.ts";

const sample = [
  'data: {"event":{"contentBlockDelta":{"delta":{"text":"<thinking>delegate</thinking>"}}}}',
  'data: {"event":{"contentBlockStart":{"start":{"toolUse":{"name":"delegateToPlanner"}}}}}',
  'data: {"event":{"messageStop":{"stopReason":"tool_use"}}}',
  'data: {"event":{"metadata":{"usage":{"inputTokens":10,"outputTokens":4,"totalTokens":14}}}}',
  'data: {"event":{"contentBlockDelta":{"delta":{"text":"1. Central Park. A suggestion, not a reservation."}}}}',
  'data: {"event":{"contentBlockDelta":{"delta":{"text":" The budget check failed."}}}}',
  'data: {"event":{"messageStop":{"stopReason":"end_turn"}}}',
  'data: {"event":{"metadata":{"usage":{"inputTokens":20,"outputTokens":8,"totalTokens":28}}}}',
].join("\n");

test("keeps the itinerary when the budget read fails", () => {
  const parsed = parseAgentStream(sample);
  assert.equal(parsed.modelCalls, 2);
  assert.equal(parsed.delegatedToPlanner, true);
  assert.equal(parsed.budgetReadFailed, true);
  assert.equal(parsed.streamError, null);
  assert.match(parsed.itinerary, /Central Park/);
  assert.doesNotMatch(parsed.itinerary, /thinking/);
});

test("reports a stream error when no itinerary was produced", () => {
  const parsed = parseAgentStream('data: {"error":"AccessDeniedException"}');
  assert.equal(parsed.itinerary, "");
  assert.equal(parsed.delegatedToPlanner, false);
  assert.equal(parsed.streamError, "AccessDeniedException");
});

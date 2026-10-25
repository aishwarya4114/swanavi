import assert from "node:assert/strict";
import test from "node:test";
import { novaPlanRequest } from "./plan-prompt.ts";

const runId = `run_${"ab".repeat(8)}`;

test("refuses to plan without explicit approval or a destination", () => {
  const unapproved = novaPlanRequest({ city: "Paris", confirm: "no" });
  assert.equal(unapproved.ok, false);
  const missing = novaPlanRequest({ confirm: "approve-nova-plan", runId, city: "  " });
  assert.equal(missing.ok, false);
  if (!missing.ok) assert.match(missing.error, /destination/i);
});

test("keeps the traveler destination, party size, preferences, and budget", () => {
  const planned = novaPlanRequest({
    confirm: "approve-nova-plan",
    runId,
    city: "Paris",
    startDate: "2026-11-01",
    endDate: "2026-11-03",
    travelers: 2,
    preferences: "museums",
    budgetRlusd: "15",
    hotel: "A hotel",
    attractions: ["Louvre"],
  });
  assert.equal(planned.ok, true);
  if (!planned.ok) return;
  assert.match(planned.prompt, /Paris/);
  assert.match(planned.prompt, /2 travelers/);
  assert.match(planned.prompt, /museums/);
  assert.match(planned.prompt, /15 RLUSD/);
  assert.match(planned.prompt, /Do not create bookings/);
  assert.doesNotMatch(planned.prompt, /New York/);
});

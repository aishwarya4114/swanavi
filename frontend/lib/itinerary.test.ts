import assert from "node:assert/strict";
import test from "node:test";
import { daysFromItinerary } from "./itinerary.ts";
import { sameTripIdentity } from "./live-inputs.ts";

test("a Paris plan does not keep a New York run", () => {
  const paris = { city: { title: "Paris" }, startDate: "2026-10-26", endDate: "2026-10-29", travelers: 2 };
  const york = { destination: "New York", start_date: "2026-10-26", end_date: "2026-10-29", travelers: 2 };
  assert.equal(sameTripIdentity(york, paris), false);
  assert.equal(sameTripIdentity({ ...york, destination: "Paris" }, paris), true);
});

test("parsed days come from the returned text", () => {
  const days = daysFromItinerary("Day 1\nLouvre Museum\nDay 2\nMusée d'Orsay", "2026-10-26");
  const titles = days.flatMap((day) => day.blocks.flatMap((block) => block.kind === "stop" ? [block.stop.title] : []));
  assert.deepEqual(titles, ["Louvre Museum", "Musée d'Orsay"]);
  assert.equal(titles.some((title) => /new york|nashville/i.test(title)), false);
  assert.equal(days[0]?.label, "Oct 26");
});

test("markdown day headings become the returned places", () => {
  const days = daysFromItinerary("**Day 1:**\n- **Morning:** Visit the **Art Gallery of New South Wales**.", "2026-10-26");
  const titles = days.flatMap((day) => day.blocks.flatMap((block) => block.kind === "stop" ? [block.stop.title] : []));
  assert.equal(titles[0], "Morning: Visit the Art Gallery of New South Wales.");
  assert.equal(titles.some((title) => /paris|new york/i.test(title)), false);
});

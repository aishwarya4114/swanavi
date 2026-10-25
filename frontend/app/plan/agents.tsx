"use client";

import { useEffect, useRef, useState } from "react";
import {
  LIVE_RUN_KEY,
  forgetRun,
  readRunId,
  readTripInputs,
  sameTripIdentity,
  tripRunKey,
  writeRunId,
  writeTripInputs,
} from "@/lib/live-inputs";
import type { StoredTrip } from "@/lib/trip";

type LiveEvent = { event_id: string; step: string; message: string };
type LiveRun = {
  run_id: string;
  destination: string;
  start_date: string;
  end_date: string;
  travelers: number;
  preferences: string;
  budget_rlusd: string;
  hotel: string;
  attractions: string[];
  itinerary?: string | null;
  bedrock_invoked?: boolean;
  mastercard_mutated?: boolean;
  gate?: { seller_id?: string; amount?: string; status?: string } | null;
  escrow?: { escrowId?: string; sellerId?: string; amount?: string; status?: string; badge?: string } | null;
  budget_before?: { remaining?: string; spent?: string; total?: string } | null;
  simulations?: Record<string, { verified?: boolean }>;
  events: LiveEvent[];
};

const HOTEL_QUOTE = "4";
const PAYMENT_TIP = "Test-mode integration; no real RLUSD transferred or settled on XRPL.";

const VOICE: Record<string, string> = {
  request_received: "Trip",
  nova_approval_required: "Master",
  master_started: "Master",
  delegated_to_planner: "Planner",
  planner_itinerary: "Planner",
  booking_authorization_required: "Booking",
  mastercard_escrow_requested: "Booking",
  escrow_confirmed: "Booking",
  escrow_rejected: "Booking",
  monitoring_detected: "Recovery",
  recovery_invoked: "Recovery",
  recovery_decision: "Recovery",
  trip_status: "Trip",
};

type Payload = { run?: LiveRun; error?: string; itinerary?: string; recorded?: boolean };

async function post(path: string, body: unknown) {
  const response = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  let payload: Payload = {};
  try {
    payload = JSON.parse(text) as Payload;
  } catch {
    payload = { error: "The server sent an unreadable response." };
  }
  return { ok: response.ok, payload };
}

function hasStep(run: LiveRun | null, step: string) {
  return !!run?.events?.some((event) => event.step === step);
}

function latestPayment(run: LiveRun | null) {
  const steps = ["escrow_confirmed", "escrow_rejected", "booking_authorization_required"];
  return [...(run?.events ?? [])].reverse().find((event) => steps.includes(event.step))?.step ?? "";
}

function useLiveRun(trip: StoredTrip | null) {
  const [run, setRun] = useState<LiveRun | null>(null);
  const [busy, setBusy] = useState("");
  const [notice, setNotice] = useState("");
  const [restored, setRestored] = useState(false);
  const key = trip ? tripRunKey(trip) : "";

  useEffect(() => {
    setRun(null);
    setRestored(false);
    setNotice("");
    if (!trip || !key) return;
    let stop = false;
    const accept = (next: LiveRun, saved: boolean) => {
      if (stop) return;
      if (!sameTripIdentity(next, trip)) {
        forgetRun(key);
        setRun(null);
        return;
      }
      if (saved && next.events?.some((event) => event.step === "planner_itinerary")) setRestored(true);
      setRun(next);
    };
    const pull = (id: string, saved: boolean) => {
      void fetch(`/api/swanavi/live/runs/${id}`, { cache: "no-store" })
        .then((response) => response.json())
        .then((payload: { run?: LiveRun }) => { if (payload.run) accept(payload.run, saved); })
        .catch(() => undefined);
    };
    let id = readRunId(key);
    if (!id) {
      const legacy = sessionStorage.getItem(LIVE_RUN_KEY) || "";
      if (/^run_[a-f0-9]{16}$/.test(legacy)) {
        void fetch(`/api/swanavi/live/runs/${legacy}`, { cache: "no-store" })
          .then((response) => response.json())
          .then((payload: { run?: LiveRun }) => {
            if (stop || !payload.run || !sameTripIdentity(payload.run, trip)) return;
            writeRunId(key, payload.run.run_id);
            accept(payload.run, true);
            id = payload.run.run_id;
          })
          .catch(() => undefined);
      }
    } else {
      pull(id, true);
    }
    const timer = window.setInterval(() => {
      const current = readRunId(key);
      if (current) pull(current, false);
    }, 2000);
    return () => {
      stop = true;
      window.clearInterval(timer);
    };
  }, [key]);

  async function ensure(currentTrip: StoredTrip, budget: string, preferences: string) {
    if (run && sameTripIdentity(run, currentTrip)) return run;
    const result = await post("/api/swanavi/live/runs", {
      destination: currentTrip.city.title,
      startDate: currentTrip.startDate,
      endDate: currentTrip.endDate,
      travelers: currentTrip.travelers,
      preferences,
      budgetRlusd: budget,
      hotel: currentTrip.hotel?.title ?? "",
      attractions: (currentTrip.attractions ?? []).map((place) => place.title),
    });
    if (!result.payload.run) {
      setNotice(result.payload.error || "The trip could not be prepared.");
      return null;
    }
    writeRunId(tripRunKey(currentTrip), result.payload.run.run_id);
    setRun(result.payload.run);
    setRestored(false);
    return result.payload.run;
  }

  async function refresh(runId: string) {
    const response = await fetch(`/api/swanavi/live/runs/${runId}`, { cache: "no-store" }).catch(() => null);
    if (!response?.ok || !trip) return;
    const payload = await response.json() as { run?: LiveRun };
    if (payload.run && sameTripIdentity(payload.run, trip)) setRun(payload.run);
  }

  return { run, setRun, busy, setBusy, notice, setNotice, restored, ensure, refresh };
}

export function useNovaItinerary(trip: StoredTrip | null): string {
  const live = useLiveRun(trip);
  if (!trip || !live.run || !sameTripIdentity(live.run, trip)) return "";
  if (!hasStep(live.run, "planner_itinerary")) return "";
  return live.run.itinerary?.trim() ?? "";
}

export function useStayStatus(trip: StoredTrip | null) {
  const live = useLiveRun(trip);
  const run = trip && live.run && sameTripIdentity(live.run, trip) ? live.run : null;
  const replaced = run?.simulations?.rebook?.verified === true;
  const held = !!run?.escrow?.escrowId;
  const refused = latestPayment(run) === "escrow_rejected" && !held;
  return {
    held,
    refused,
    hotelLine: held ? "Test escrow" : refused || replaced ? "Unconfirmed" : null,
    alternativeLine: replaced ? "Alternative tour" : null,
  };
}

function spoken(event: LiveEvent): string {
  if (event.step === "nova_approval_required") return "Waiting for planning approval.";
  return event.message
    .replace(/spend_ceiling/gi, "the sandbox limit")
    .replace(/txHash\s+\S+/gi, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

export function TripGuide({ trip }: { trip: StoredTrip | null }) {
  const live = useLiveRun(trip);
  const [budget, setBudget] = useState("");
  const [preferences, setPreferences] = useState("");
  const [hidden, setHidden] = useState("");
  const prepared = useRef("");
  const key = trip ? tripRunKey(trip) : "";
  const run = trip && live.run && sameTripIdentity(live.run, trip) ? live.run : null;

  useEffect(() => {
    if (!key) return;
    const inputs = readTripInputs(key);
    setBudget(inputs.budgetRlusd);
    setPreferences(inputs.preferences);
  }, [key]);

  useEffect(() => {
    if (!trip || !run || !hasStep(run, "planner_itinerary")) return;
    if (run.gate?.status === "awaiting_approval" || run.escrow?.escrowId || latestPayment(run) === "escrow_rejected") return;
    if (prepared.current === run.run_id || live.busy) return;
    if (!budget.trim()) return;
    prepared.current = run.run_id;
    live.setBusy("Budget");
    void post(`/api/swanavi/live/runs/${run.run_id}/booking/prepare`, {
      sellerId: "hotel",
      amount: HOTEL_QUOTE,
    }).then((result) => {
      if (result.payload.run && sameTripIdentity(result.payload.run, trip)) live.setRun(result.payload.run);
      if (!result.ok) live.setNotice(result.payload.error || "The hotel quote was not accepted.");
    }).finally(() => live.setBusy(""));
  }, [budget, live, run, trip]);

  if (!trip) return null;
  const plannedTrip = trip;
  const masterDone = hasStep(run, "master_started");
  const plannerDone = hasStep(run, "planner_itinerary");
  const held = !!run?.escrow?.escrowId;
  const quoted = run?.gate?.status === "awaiting_approval" && run.gate.seller_id === "hotel" && run.gate.amount === HOTEL_QUOTE;
  const replaced = run?.simulations?.rebook?.verified === true;
  const payment = latestPayment(run);

  const refused = payment === "escrow_rejected" && !held;

  function saveInputs(nextBudget: string, nextPreferences: string) {
    writeTripInputs(tripRunKey(plannedTrip), { budgetRlusd: nextBudget, preferences: nextPreferences });
  }

  async function approveNova() {
    const spend = budget.trim();
    if (!spend) {
      live.setNotice("Add a budget under Details.");
      return;
    }
    live.setBusy("Nova");
    live.setNotice("");
    saveInputs(spend, preferences);
    const current = await live.ensure(plannedTrip, spend, preferences);
    if (!current || !sameTripIdentity(current, plannedTrip)) {
      live.setBusy("");
      return;
    }
    const result = await post("/api/agentcore/plan", {
      confirm: "approve-nova-plan",
      runId: current.run_id,
      city: plannedTrip.city.title,
      startDate: plannedTrip.startDate,
      endDate: plannedTrip.endDate,
      travelers: plannedTrip.travelers,
      preferences,
      budgetRlusd: spend,
      hotel: plannedTrip.hotel?.title ?? "",
      attractions: (plannedTrip.attractions ?? []).map((place) => place.title),
    }).catch(() => null);
    if (!result?.ok) {
      live.setBusy("");
      live.setNotice(result?.payload.error || "Nova planning did not run.");
      return;
    }
    if (result.payload.recorded === false) live.setNotice("Nova answered. The checklist is catching up.");
    await live.refresh(current.run_id);
    live.setBusy("");
  }

  async function checkHold() {
    live.setBusy("Budget");
    live.setNotice("");
    const spend = budget.trim();
    if (!spend) {
      live.setBusy("");
      live.setNotice("Add a budget under Details.");
      return;
    }
    saveInputs(spend, preferences);
    const current = await live.ensure(plannedTrip, spend, preferences);
    if (!current) {
      live.setBusy("");
      return;
    }
    const result = await post(`/api/swanavi/live/runs/${current.run_id}/booking/prepare`, {
      sellerId: "hotel",
      amount: HOTEL_QUOTE,
    }).catch(() => null);
    live.setBusy("");
    if (result?.payload.run && sameTripIdentity(result.payload.run, plannedTrip)) live.setRun(result.payload.run);
    if (!result?.ok) live.setNotice(result?.payload.error || "The hotel quote was not accepted.");
  }

  async function approveHold() {
    if (!run) return;
    live.setBusy("Hold");
    live.setNotice("");
    const result = await post(`/api/swanavi/live/runs/${run.run_id}/booking/approve`, {
      confirm: "approve-mock-escrow",
      sellerId: "hotel",
      amount: HOTEL_QUOTE,
    }).catch(() => null);
    live.setBusy("");
    if (result?.payload.run && sameTripIdentity(result.payload.run, plannedTrip)) live.setRun(result.payload.run);
    if (!result?.ok) live.setNotice(result?.payload.error || "The sandbox did not create an escrow.");
  }

  async function showRebook() {
    live.setBusy("rebook");
    live.setNotice("");
    const spend = budget.trim();
    if (!spend) {
      live.setBusy("");
      live.setNotice("Add a budget under Details.");
      return;
    }
    const current = run ?? await live.ensure(plannedTrip, spend, preferences);
    if (!current) {
      live.setBusy("");
      return;
    }
    const result = await post(`/api/swanavi/live/runs/${current.run_id}/disruptions/rebook`, {}).catch(() => null);
    live.setBusy("");
    if (result?.payload.run && sameTripIdentity(result.payload.run, plannedTrip)) live.setRun(result.payload.run);
    else live.setNotice(result?.payload.error || "The hotel refusal did not finish.");
  }

  if (run && hidden === run.run_id) return null;

  const steps: Array<{ label: string; state: "done" | "now" }> = [];
  if (run || live.busy) {
    steps.push({ label: "Master Agent coordinating", state: masterDone ? "done" : "now" });
    if (masterDone) steps.push({ label: "Planner Agent generating itinerary", state: plannerDone ? "done" : "now" });
    if (plannerDone) steps.push({ label: "Itinerary generated", state: "done" });
    if (plannerDone) steps.push({ label: "Booking Agent checking supported quote", state: quoted || held || refused ? "done" : "now" });
    if ((quoted || live.busy === "Hold") && !held && !refused) steps.push({ label: "Mastercard payment authorization", state: held ? "done" : "now" });
    if (held || refused) steps.push({ label: refused ? "Payment refused" : "Test escrow placed", state: "done" });
    if (plannerDone && (held || refused)) steps.push({ label: "Final itinerary ready", state: "done" });
  }

  const title = refused ? "Hotel hold refused" : held ? "Test escrow" : quoted && !held ? "Approve the hotel hold" : run || live.busy ? "Planning" : "Plan my trip";
  const spent = run?.budget_before?.spent;
  const remaining = run?.budget_before?.remaining;

  return (
    <aside className="guide-card" aria-label="Trip guide">
      <h2>{title}</h2>
      {live.restored && plannerDone ? <p className="note">Saved plan</p> : null}
      {steps.length > 0 ? (
        <ol className="guide-steps">
          {steps.map((step) => (
            <li className={step.state === "now" ? "is-now" : ""} key={step.label}>
              <span>{step.label}</span>
              <span>{step.state === "done" ? "Done" : "Now"}</span>
            </li>
          ))}
        </ol>
      ) : null}
      {refused ? (
        <p className="note">
          The hotel hold was refused. Another 4 RLUSD hold does not fit the test environment spending ceiling
          {spent ? ` because ${spent} RLUSD is already spent` : ""}.
          {run?.budget_rlusd ? ` The trip budget was ${run.budget_rlusd} RLUSD.` : ""}
          {remaining ? ` ${remaining} RLUSD was still available.` : ""}
          {" "}No escrow was created. The hotel stays unconfirmed.
        </p>
      ) : null}
      {held ? <p className="note">A test hold exists for this trip. It is not a confirmed hotel reservation, and no RLUSD was settled on XRPL.</p> : null}
      {quoted && !held && !refused ? <p className="note">The 4 RLUSD hotel quote passed the check. Approving places one test hold. It is not a reservation.</p> : null}
      {live.notice ? <p className="note">{live.notice}</p> : null}
      {!run && !live.busy ? (
        <>
          <label className="field">
            <span>Budget</span>
            <input aria-label="Budget in RLUSD" placeholder="RLUSD" value={budget} onChange={(event) => { setBudget(event.target.value); saveInputs(event.target.value, preferences); }} />
          </label>
          <label className="field">
            <span>Interests</span>
            <input aria-label="Traveler interests" placeholder="Museums, food, music" value={preferences} onChange={(event) => { setPreferences(event.target.value); saveInputs(budget, event.target.value); }} />
          </label>
        </>
      ) : null}
      {!masterDone ? (
        <button type="button" className="pill" disabled={!!live.busy} onClick={() => void approveNova()}>
          {live.busy === "Nova" ? "Planning…" : "Plan my trip"}
        </button>
      ) : null}
      {quoted && !held && !refused ? (
        <button type="button" className="pill" disabled={!!live.busy} onClick={() => void approveHold()}>
          {live.busy === "Hold" ? "Placing hold…" : "Approve hotel hold"}
        </button>
      ) : null}
      {refused ? (
        <button type="button" className="pill" onClick={() => run && setHidden(run.run_id)}>Continue without booking</button>
      ) : null}
      {held ? (
        <button type="button" className="pill" onClick={() => run && setHidden(run.run_id)}>View itinerary</button>
      ) : null}
      <p className="note" title={PAYMENT_TIP}>Mastercard AP4M · Test environment</p>
      <details className="agent-more">
        <summary>Developer details</summary>
        <label className="field">
          <span>Budget</span>
          <input aria-label="Budget in RLUSD" placeholder="RLUSD" value={budget} onChange={(event) => { setBudget(event.target.value); saveInputs(event.target.value, preferences); }} />
        </label>
        <label className="field">
          <span>Interests</span>
          <input aria-label="Traveler interests" placeholder="Museums, food, music" value={preferences} onChange={(event) => { setPreferences(event.target.value); saveInputs(budget, event.target.value); }} />
        </label>
        <div className="agent-actions">
          <button type="button" className="pill" disabled={!!live.busy || replaced || !plannerDone} onClick={() => void showRebook()}>
            {replaced ? "Disruption already shown" : "Demo a disruption"}
          </button>
        </div>
        {run?.events?.length ? (
          <ol className="agent-log">
            {run.events.map((event) => (
              <li key={event.event_id}>
                <strong>{VOICE[event.step] ?? "Trip"}</strong>
                <span>{spoken(event)}</span>
              </li>
            ))}
          </ol>
        ) : null}
      </details>
    </aside>
  );
}

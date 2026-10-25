"use client";

import { useEffect, useState } from "react";
import { LIVE_RUN_KEY, readLiveInputs, writeLiveInputs } from "@/lib/live-inputs";
import { parseStoredTrip, readTripRaw } from "@/lib/trip";

type LiveEvent = { event_id: string; step: string; message: string; evidence: string };
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
  nova?: { model_calls?: number; delegated_to_planner?: boolean } | null;
  gate?: { seller_id?: string; amount?: string; status?: string } | null;
  escrow?: { escrowId?: string; sellerId?: string; amount?: string; status?: string; badge?: string; live?: boolean; txHash?: string | null } | null;
  budget_before?: { remaining?: string; reserved?: string; spent?: string } | null;
  budget_after?: { remaining?: string; reserved?: string; spent?: string } | null;
  labels?: { bedrock?: string; mastercard?: string; injection?: string; recovery?: string };
  quotes?: Record<string, string>;
  simulations?: Record<string, { summary?: string; verified?: boolean; label?: string }>;
  events: LiveEvent[];
};

const SELLERS = ["hotel", "tour", "cab", "food"] as const;

async function post(path: string, body: unknown) {
  const response = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const payload = await response.json() as { run?: LiveRun; error?: string; itinerary?: string };
  return { ok: response.ok, payload };
}

export default function LiveDesk() {
  const [destination, setDestination] = useState("");
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const [travelers, setTravelers] = useState("2");
  const [preferences, setPreferences] = useState("");
  const [budget, setBudget] = useState("");
  const [hotel, setHotel] = useState("");
  const [attractions, setAttractions] = useState("");
  const [seller, setSeller] = useState<(typeof SELLERS)[number]>("hotel");
  const [run, setRun] = useState<LiveRun | null>(null);
  const [busy, setBusy] = useState("");
  const [notice, setNotice] = useState("");

  useEffect(() => {
    const stored = parseStoredTrip(readTripRaw());
    const extras = readLiveInputs();
    if (stored) {
      setDestination(stored.city.title);
      setStartDate(stored.startDate);
      setEndDate(stored.endDate);
      setTravelers(String(stored.travelers));
      setHotel(stored.hotel?.title ?? "");
      setAttractions((stored.attractions ?? []).map((place) => place.title).join(", "));
    }
    setPreferences(extras.preferences);
    setBudget(extras.budgetRlusd);
    const params = new URLSearchParams(window.location.search);
    const existing = params.get("run") || sessionStorage.getItem(LIVE_RUN_KEY) || "";
    if (/^run_[a-f0-9]{16}$/.test(existing)) {
      sessionStorage.setItem(LIVE_RUN_KEY, existing);
      void fetch(`/api/swanavi/live/runs/${existing}`, { cache: "no-store" })
        .then((response) => response.json())
        .then((payload: { run?: LiveRun }) => { if (payload.run) setRun(payload.run); })
        .catch(() => setNotice("The live desk is not running."));
    }
  }, []);

  useEffect(() => {
    if (!run?.run_id) return;
    let stop = false;
    const pull = () => {
      void fetch(`/api/swanavi/live/runs/${run.run_id}`, { cache: "no-store" })
        .then((response) => response.json())
        .then((payload: { run?: LiveRun }) => { if (!stop && payload.run) setRun(payload.run); })
        .catch(() => undefined);
    };
    const timer = window.setInterval(pull, 1500);
    const source = new EventSource(`/api/swanavi/live/runs/${run.run_id}/events`);
    source.onmessage = (message) => {
      try {
        const event = JSON.parse(message.data) as LiveEvent;
        setRun((current) => {
          if (!current || current.events.some((item) => item.event_id === event.event_id)) return current;
          return { ...current, events: [...current.events, event] };
        });
      } catch {
        return;
      }
    };
    return () => {
      stop = true;
      window.clearInterval(timer);
      source.close();
    };
  }, [run?.run_id]);

  function remember(nextPreferences: string, nextBudget: string) {
    writeLiveInputs({ preferences: nextPreferences, budgetRlusd: nextBudget });
  }

  async function startRun() {
    setBusy("Starting");
    setNotice("");
    remember(preferences, budget);
    const names = attractions.split(",").map((item) => item.trim()).filter(Boolean);
    const result = await post("/api/swanavi/live/runs", {
      destination,
      startDate,
      endDate,
      travelers: Number(travelers),
      preferences,
      budgetRlusd: budget,
      hotel,
      attractions: names,
    }).catch(() => null);
    setBusy("");
    if (!result?.payload.run) {
      setNotice(result?.payload.error || "The live run did not start.");
      return;
    }
    sessionStorage.setItem(LIVE_RUN_KEY, result.payload.run.run_id);
    window.history.replaceState(null, "", `/dashboard?run=${result.payload.run.run_id}`);
    setRun(result.payload.run);
  }

  async function approveNova() {
    if (!run) return;
    setBusy("Nova approval is being sent");
    setNotice("");
    const result = await post("/api/agentcore/plan", {
      confirm: "approve-nova-plan",
      runId: run.run_id,
      city: run.destination,
      startDate: run.start_date,
      endDate: run.end_date,
      travelers: run.travelers,
      preferences: run.preferences,
      budgetRlusd: run.budget_rlusd,
      hotel: run.hotel,
      attractions: run.attractions,
    }).catch(() => null);
    setBusy("");
    if (!result?.ok) setNotice(result?.payload.error || "Nova planning did not run.");
  }

  async function checkQuote() {
    if (!run) return;
    setBusy("Checking quote");
    setNotice("");
    const result = await post(`/api/swanavi/live/runs/${run.run_id}/booking/prepare`, {
      sellerId: seller,
      amount: run.quotes?.[seller],
    }).catch(() => null);
    setBusy("");
    if (result?.payload.run) setRun(result.payload.run);
    if (!result?.ok) setNotice(result?.payload.error || "The quote check did not finish.");
  }

  async function approveEscrow() {
    if (!run) return;
    setBusy("Escrow approval is being sent");
    setNotice("");
    const result = await post(`/api/swanavi/live/runs/${run.run_id}/booking/approve`, {
      confirm: "approve-mock-escrow",
      sellerId: seller,
      amount: run.quotes?.[seller],
    }).catch(() => null);
    setBusy("");
    if (result?.payload.run) setRun(result.payload.run);
    if (!result?.ok) setNotice(result?.payload.error || "The escrow was not created.");
  }

  async function disrupt(kind: "rain" | "overcharge" | "timeout") {
    if (!run) return;
    setBusy(kind);
    setNotice("");
    const result = await post(`/api/swanavi/live/runs/${run.run_id}/disruptions/${kind}`, {}).catch(() => null);
    setBusy("");
    if (result?.payload.run) setRun(result.payload.run);
    else setNotice("The offline simulation did not finish.");
  }

  const quote = run?.quotes?.[seller];
  const gateReady = run?.gate?.status === "awaiting_approval" && run.gate.seller_id === seller && run.gate.amount === quote;

  return (
    <section>
      <h2>Live run</h2>
      <p className="note">Events appear only after the desk records them. Nova and escrow do not run until you approve them.</p>
      <div className="pills">
        <span className="pill">{run?.labels?.bedrock ?? "BEDROCK AI — CLOUD"}</span>
        <span className="pill">{run?.labels?.mastercard ?? "MASTERCARD API — MOCK"}</span>
        <span className="pill">{run?.labels?.injection ?? "DEMO INJECTION — SIMULATED"}</span>
        <span className="pill">{run?.labels?.recovery ?? "RECOVERY — waiting"}</span>
      </div>
      <p className="note">
        {run?.bedrock_invoked ? `Nova evidence is recorded (${run.nova?.model_calls ?? 0} usage records).` : "Nova has not been invoked."}
        {" "}
        {run?.mastercard_mutated ? "A MOCK escrow exists for this run." : "No escrow has been created for this run."}
      </p>
      {run ? (
        <p>{run.destination} · {run.start_date} to {run.end_date} · {run.travelers} travelers · budget {run.budget_rlusd} RLUSD{run.preferences ? ` · ${run.preferences}` : ""}</p>
      ) : (
        <div className="live-grid">
          <label className="field"><input aria-label="Destination" placeholder="Destination" value={destination} onChange={(event) => setDestination(event.target.value)} /></label>
          <label className="field"><input aria-label="Start date" placeholder="Start date" value={startDate} onChange={(event) => setStartDate(event.target.value)} /></label>
          <label className="field"><input aria-label="End date" placeholder="End date" value={endDate} onChange={(event) => setEndDate(event.target.value)} /></label>
          <label className="field"><input aria-label="Party size" placeholder="Party size" value={travelers} onChange={(event) => setTravelers(event.target.value)} /></label>
          <label className="field"><input aria-label="Preferences" placeholder="Preferences" value={preferences} onChange={(event) => { setPreferences(event.target.value); remember(event.target.value, budget); }} /></label>
          <label className="field"><input aria-label="Budget in RLUSD" placeholder="Budget RLUSD" value={budget} onChange={(event) => { setBudget(event.target.value); remember(preferences, event.target.value); }} /></label>
          <label className="field"><input aria-label="Hotel" placeholder="Hotel" value={hotel} onChange={(event) => setHotel(event.target.value)} /></label>
        </div>
      )}
      <div className="actions">
        <button className="continue" type="button" disabled={!!busy || !!run} onClick={() => void startRun()}>Start live run</button>
        <button className="continue secondary" type="button" disabled={!!busy || !run || run.bedrock_invoked} onClick={() => void approveNova()}>Approve Nova planning</button>
        <label className="field">
          <select aria-label="Mastercard seller" value={seller} onChange={(event) => setSeller(event.target.value as (typeof SELLERS)[number])}>
            {SELLERS.map((item) => <option key={item} value={item}>{item} · {run?.quotes?.[item] ?? "quote"} RLUSD</option>)}
          </select>
        </label>
        <button className="continue secondary" type="button" disabled={!!busy || !run} onClick={() => void checkQuote()}>Check Mastercard quote</button>
        <button className="continue" type="button" disabled={!!busy || !gateReady || run?.mastercard_mutated} onClick={() => void approveEscrow()}>Approve MOCK escrow</button>
      </div>
      <p className="note">Approve Nova planning sends one billable Master request. Approve MOCK escrow sends one POST /escrows. Neither runs on page load.</p>
      <div className="actions">
        <button className="continue secondary" type="button" disabled={!!busy || !run} onClick={() => void disrupt("rain")}>Simulated rain</button>
        <button className="continue secondary" type="button" disabled={!!busy || !run} onClick={() => void disrupt("overcharge")}>Simulated overcharge</button>
        <button className="continue secondary" type="button" disabled={!!busy || !run} onClick={() => void disrupt("timeout")}>Simulated uncertain payment</button>
      </div>
      <p className="note">These three buttons are OFFLINE SIMULATION. They do not call Bedrock or the live Mastercard server.</p>
      {busy ? <p className="note">{busy}</p> : null}
      {notice ? <p className="banner">{notice}</p> : null}
      {run?.itinerary ? (
        <>
          <h2>Itinerary</h2>
          {run.itinerary.split(/\n+/).filter(Boolean).map((paragraph) => <p className="note" key={paragraph.slice(0, 40)}>{paragraph}</p>)}
        </>
      ) : null}
      <h2>Mastercard quote</h2>
      {run?.gate ? <p>{run.gate.seller_id} · {run.gate.amount} RLUSD · {run.gate.status}</p> : <p className="note">No quote has been checked for this run.</p>}
      {run?.budget_before ? <p>Budget before remaining {run.budget_before.remaining} · reserved {run.budget_before.reserved} · spent {run.budget_before.spent}</p> : null}
      {run?.budget_after ? <p>Budget after remaining {run.budget_after.remaining} · reserved {run.budget_after.reserved} · spent {run.budget_after.spent}</p> : null}
      {run?.escrow ? (
        <p>Escrow {run.escrow.escrowId} · {run.escrow.sellerId} · {run.escrow.amount} RLUSD · {run.escrow.status} · {run.escrow.badge} · live {String(run.escrow.live)} · txHash {run.escrow.txHash ?? "null"}</p>
      ) : <p className="note">No escrow is attached to this run.</p>}
      <h2>Agent activity</h2>
      <ol className="live-log">
        {(run?.events ?? []).map((event) => (
          <li key={event.event_id}><strong>{event.step}</strong> — {event.message} <span className="note">{event.evidence}</span></li>
        ))}
      </ol>
    </section>
  );
}

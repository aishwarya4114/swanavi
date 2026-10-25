"use client";

import { useEffect, useState } from "react";
import LiveDesk from "./live";

type Booking = {
  booking_id?: string;
  seller_id?: string;
  amount?: string;
  status?: string;
  badge?: string;
  receipt_url?: string | null;
  evidence?: { badge?: string; tx_hash?: string | null };
};

type Offline = {
  transport?: string;
  payment_badge?: string;
  weather?: { kind?: string; note?: string };
  trip?: { title?: string; destination?: string; trip_id?: string } | null;
  activities?: { activity_id: string; title: string; indoor?: boolean; seller_id?: string; amount?: string; booking_id?: string | null }[];
  bookings?: Booking[];
  budget?: { total?: string; remaining?: string; reserved?: string; spent?: string; badge?: string; mode?: string; drift?: unknown } | null;
  incidents?: { incident_id: string; status: string; incident_type?: string; summary?: string }[];
  pending_approvals?: { request_id: string; status: string; description?: string }[];
  timeline?: { entry_id: string; step: string; message: string }[];
  trip_health?: string;
  summary?: { additional_cost?: string | null; delivered?: number; refunded?: number; resolution?: string | null };
  honesty?: string;
  error?: string;
};

type Mastercard = {
  configured?: boolean;
  mutated?: boolean;
  halted?: boolean;
  error?: string;
  health?: { mode?: string; live?: boolean; badge?: string };
  budget?: { total?: string; remaining?: string; reserved?: string; spent?: string; badge?: string; mode?: string; drift?: unknown };
  escrow?: {
    escrowId?: string;
    sellerId?: string;
    amount?: string;
    finalBill?: string;
    status?: string;
    badge?: string;
    live?: boolean;
    txHash?: string | null;
    receipt_url?: string | null;
  };
};

type Payload = { offline?: Offline; mastercard?: Mastercard; error?: string };

async function call(path: string, method = "GET"): Promise<Payload> {
  const response = await fetch(path, { method, cache: "no-store" });
  return response.json();
}

export default function DashboardPage() {
  const [data, setData] = useState<Payload | null>(null);
  const [busy, setBusy] = useState("");
  const [failed, setFailed] = useState("");

  async function load(path = "/api/swanavi/dashboard", method = "GET") {
    setBusy(method === "GET" ? "Loading" : "Working");
    setFailed("");
    try {
      setData(await call(path, method));
    } catch {
      setFailed("The local desk API is not running. Start it, then use the offline demo.");
    } finally {
      setBusy("");
    }
  }

  useEffect(() => {
    load();
  }, []);

  const offline = data?.offline;
  const card = data?.mastercard;
  const approvals = offline?.pending_approvals ?? [];

  return (
    <main className="stage">
      <section className="sheet desk">
        <p className="mark"><a href="/">Swanavi</a> · Trip desk</p>
        <h1 className="title">Trip desk</h1>
        <p className="region">The live run uses the destination you chose. The offline fixture below stays separate.</p>
        <LiveDesk />

        <div className="pills">
          <span className="pill">{offline?.transport ?? "OFFLINE"}</span>
          <span className="pill">{offline?.payment_badge ?? "MOCK"} payments</span>
          <span className="pill">{offline?.weather?.kind === "SIMULATED" ? "SIMULATED rain" : "No simulated rain"}</span>
          <span className="pill">Local desk · cloud runtime is separate</span>
        </div>

        {failed ? <p className="banner">{failed}</p> : null}
        {offline?.honesty ? <p className="note">{offline.honesty}</p> : null}
        {offline?.weather?.kind === "SIMULATED" ? <p className="banner">{offline.weather.note}</p> : null}

        <div className="actions">
          <button className="continue" type="button" disabled={!!busy} onClick={() => load("/api/swanavi/demo/plan", "POST")}>
            Offline NYC fixture
          </button>
          <button className="continue secondary" type="button" disabled={!!busy || !offline?.trip} onClick={() => load("/api/swanavi/demo/rain", "POST")}>
            Simulated rain — not a forecast
          </button>
        </div>
        {busy ? <p className="note">{busy}</p> : null}

        <h2>Traveler trip</h2>
        {offline?.trip ? (
          <p>{offline.trip.title} · {offline.trip.destination} · health {offline.trip_health}</p>
        ) : <p className="note">No offline trip yet.</p>}

        <h2>Itinerary</h2>
        <ul className="plain">
          {(offline?.activities ?? []).map((item) => (
            <li key={item.activity_id}>
              {item.title} · {item.indoor ? "indoor" : "outdoor"} · {item.seller_id} · {item.amount} RLUSD
            </li>
          ))}
        </ul>

        <h2>Offline booking status</h2>
        <ul className="plain">
          {(offline?.bookings ?? []).map((item) => (
            <li key={item.booking_id}>
              {item.seller_id} · {item.amount} RLUSD · {item.status} · {item.badge ?? item.evidence?.badge ?? "MOCK"}
              {item.receipt_url ? <a href={item.receipt_url}> receipt</a> : " · no chain receipt"}
            </li>
          ))}
        </ul>
        <p>Additional cost {offline?.summary?.additional_cost ?? "—"} RLUSD · delivered {offline?.summary?.delivered ?? 0} · refunded {offline?.summary?.refunded ?? 0}</p>

        <h2>Offline budget</h2>
        {offline?.budget ? (
          <p>MOCK · total {offline.budget.total} · remaining {offline.budget.remaining} · reserved {offline.budget.reserved} · spent {offline.budget.spent}</p>
        ) : <p className="note">Budget appears after the trip is planned.</p>}

        <h2>Recovery</h2>
        <ul className="plain">
          {(offline?.incidents ?? []).map((item) => (
            <li key={item.incident_id}>{item.incident_type} · {item.status}</li>
          ))}
        </ul>
        <p>Human approval: {approvals.length ? approvals.map((item) => item.status).join(", ") : "none pending"}</p>
        <ol className="plain">
          {(offline?.timeline ?? []).map((item) => (
            <li key={item.entry_id}><strong>{item.step}</strong> — {item.message}</li>
          ))}
        </ol>

        <h2>Mastercard MOCK</h2>
        {!card?.configured ? <p className="note">Remote payment server is not configured in this process.</p> : null}
        {card?.error ? <p className="banner">Mastercard read failed ({card.error}). Offline demo still works.</p> : null}
        {card?.halted ? <p className="banner">Remote server is not MOCK. No further payment calls.</p> : null}
        {card?.health ? <p>Health {card.health.badge} · mode {card.health.mode} · live {String(card.health.live)} · mutated {String(card?.mutated)}</p> : null}
        {card?.budget ? (
          <p>Budget {card.budget.badge} · total {card.budget.total} · remaining {card.budget.remaining} · reserved {card.budget.reserved} · spent {card.budget.spent} · drift {card.budget.drift == null ? "none" : "present"}</p>
        ) : null}
        {card?.escrow ? (
          <p>
            Escrow {card.escrow.escrowId} · {card.escrow.sellerId} · {card.escrow.finalBill ?? card.escrow.amount} RLUSD · {card.escrow.status} · {card.escrow.badge}
            {card.escrow.receipt_url ? <a href={card.escrow.receipt_url}> receipt</a> : " · txHash null, no chain receipt"}
          </p>
        ) : <p className="note">No remote escrow is attached to this read.</p>}
      </section>
    </main>
  );
}

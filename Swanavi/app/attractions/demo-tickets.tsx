"use client";

import { useEffect, useState } from "react";
import { cancelDemo, confirmDemoQuote, loadDemoOffers, loadDemoSlots, quoteDemo, refreshDemoOrder } from "./ticket-actions";
import type { TicketOffer, TicketOrder, TicketQuote, TicketSlot } from "@/lib/server/tickets";

const LABEL = "Demo ticket — not valid for admission";

function upcomingDates(now: Date) {
  const today = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
  const [year, month, day] = today.split("-").map(Number);
  return Array.from({ length: 7 }, (_item, index) => new Date(Date.UTC(year, month - 1, day + index + 1)).toISOString().slice(0, 10));
}

function statusCopy(order: TicketOrder) {
  if (order.status === "quoted") return "Reserving this seat until the quote expires.";
  if (order.status === "payment_pending") return "Paying. This is not a ticket yet.";
  if (order.status === "ticket_pending") return "Payment received. The ticket is still pending.";
  if (order.status === "issued") return "Demo ticket issued.";
  if (order.status === "failed") return order.error?.message || "The purchase failed. No ticket was issued.";
  if (order.status === "cancelled") return "The hold was cancelled.";
  if (order.status === "expired") return "The quote expired.";
  return "Waiting for the order.";
}

export default function DemoTickets() {
  const [dates, setDates] = useState<string[]>([]);
  const [offers, setOffers] = useState<TicketOffer[]>([]);
  const [offerId, setOfferId] = useState("");
  const [date, setDate] = useState("");
  const [slots, setSlots] = useState<TicketSlot[]>([]);
  const [slotId, setSlotId] = useState("");
  const [quote, setQuote] = useState<TicketQuote | null>(null);
  const [orderId, setOrderId] = useState<string | null>(null);
  const [order, setOrder] = useState<TicketOrder | null>(null);
  const [approved, setApproved] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const offer = offers.find((item) => item.attractionId === offerId) ?? null;

  useEffect(() => {
    const next = upcomingDates(new Date());
    setDates(next);
    setDate(next[0] ?? "");
  }, []);

  useEffect(() => {
    let cancelled = false;
    void loadDemoOffers().then((result) => {
      if (cancelled) return;
      if (!result.ok) {
        setMessage(result.message);
        return;
      }
      setOffers(result.data.offers);
      setOfferId(result.data.offers[0]?.attractionId ?? "");
    });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!offerId || !date) return;
    let cancelled = false;
    void loadDemoSlots(offerId, date).then((result) => {
      if (cancelled) return;
      if (!result.ok) {
        setSlots([]);
        setMessage(result.message);
        return;
      }
      setSlots(result.data.slots);
      setSlotId(result.data.slots[0]?.slotId ?? "");
    });
    return () => {
      cancelled = true;
    };
  }, [offerId, date]);

  async function review() {
    if (!offer || !slotId) return;
    setBusy(true);
    setMessage(null);
    const result = await quoteDemo({ attractionId: offer.attractionId, sku: offer.sku, slotId });
    setBusy(false);
    if (!result.ok) {
      setMessage(result.message);
      return;
    }
    setQuote(result.data.quote);
    setOrderId(result.data.orderId);
    setOrder(null);
    setApproved(false);
  }

  async function confirm() {
    if (!quote) return;
    setBusy(true);
    const result = await confirmDemoQuote(quote.quoteId);
    setBusy(false);
    if (!result.ok) {
      setMessage(result.message);
      return;
    }
    setApproved(true);
    setMessage("Confirmed. The booking agent can purchase this quote. This screen does not pay by itself.");
    await refresh(result.data.orderId);
  }

  async function refresh(nextOrderId = orderId) {
    if (!nextOrderId) return;
    setBusy(true);
    const result = await refreshDemoOrder(nextOrderId);
    setBusy(false);
    if (!result.ok) {
      setMessage(result.message);
      return;
    }
    setOrder(result.data.order);
  }

  async function cancel() {
    if (!quote || !orderId) return;
    setBusy(true);
    const result = await cancelDemo(orderId);
    setBusy(false);
    if (!result.ok) {
      setMessage(result.message);
      return;
    }
    setOrder(result.data.order);
    setQuote(null);
    setApproved(false);
  }

  return (
    <section className="demo-tickets" aria-label="Bookable demo attractions">
      <p className="mark">Bookable demo attractions</p>
      <h2>NYC demo tickets</h2>
      <p className="demo-note">{LABEL}</p>
      {offers.length === 0 ? <p className="empty">Demo offers are not loaded.</p> : null}
      <div className="demo-grid">
        <label>
          Attraction
          <select value={offerId} onChange={(event) => { setOfferId(event.target.value); setQuote(null); setOrderId(null); setApproved(false); }}>
            {offers.map((item) => (
              <option key={item.attractionId} value={item.attractionId}>{item.title}</option>
            ))}
          </select>
        </label>
        <label>
          Date
          <select value={date} onChange={(event) => { setDate(event.target.value); setQuote(null); setOrderId(null); setApproved(false); }}>
            {dates.map((item) => <option key={item} value={item}>{item}</option>)}
          </select>
        </label>
        <label>
          Time
          <select value={slotId} onChange={(event) => { setSlotId(event.target.value); setQuote(null); setOrderId(null); setApproved(false); }}>
            {slots.map((slot) => (
              <option key={slot.slotId} value={slot.slotId}>{slot.localTime}, {slot.available} left</option>
            ))}
          </select>
        </label>
      </div>
      {offer ? (
        <p className="demo-meta">{offer.indoor ? "Indoor" : "Outdoor"} · {offer.unitAmount} {offer.currency}</p>
      ) : null}
      <div className="demo-actions">
        <button type="button" className="pill" disabled={busy || !slotId} onClick={() => void review()}>Review quote</button>
      </div>
      {quote ? (
        <div className="demo-review">
          <p>{offer?.title}</p>
          <p>{quote.date} {quote.localTime} {quote.timezone}</p>
          <p>Quantity {quote.quantity} · {quote.amount} {quote.currency}</p>
          <p>Expires {new Date(quote.expiresAt).toLocaleString()}</p>
          <p>{LABEL}</p>
          <div className="demo-actions">
            <button type="button" className="pill" disabled={busy || approved} onClick={() => void confirm()}>Confirm</button>
            <button type="button" className="pill" disabled={busy} onClick={() => void cancel()}>Cancel</button>
            {approved ? <button type="button" className="pill" disabled={busy} onClick={() => void refresh()}>Refresh status</button> : null}
          </div>
        </div>
      ) : null}
      {order ? (
        <div className="demo-status">
          <p>{statusCopy(order)}</p>
          <p>Order {order.orderId}</p>
          {order.status === "issued" && order.ticket ? (
            <>
              <p>{order.ticket.label}</p>
              <p>Confirmation {order.ticket.confirmationCode}</p>
              {order.payment?.receiptUrl ? <p>Receipt {order.payment.receiptUrl}</p> : null}
            </>
          ) : null}
        </div>
      ) : null}
      {message ? <p className="demo-note">{message}</p> : null}
    </section>
  );
}

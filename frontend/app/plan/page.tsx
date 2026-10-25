"use client";

import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { formatRange } from "@/lib/civil";
import { daysFromItinerary } from "@/lib/itinerary";
import { forgetRun, tripRunKey } from "@/lib/live-inputs";
import { formatLeg, type PlanDay } from "@/lib/plan";
import { clearStoredTrip, getTripRawServerSnapshot, parseStoredTrip, readTripRaw, subscribeTrip } from "@/lib/trip";
import { TripGuide, useNovaItinerary, useStayStatus } from "./agents";
import { DAY_COLORS, TripMap } from "./map";

function subscribeNothing() {
  return () => {};
}

function near(lat1: number, lng1: number, lat2: number, lng2: number) {
  const toRad = (value: number) => (value * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.min(1, Math.sqrt(a))) < 80;
}

export default function PlanPage() {
  const router = useRouter();
  const raw = useSyncExternalStore(subscribeTrip, readTripRaw, getTripRawServerSnapshot);
  const isClient = useSyncExternalStore(subscribeNothing, () => true, () => false);
  const trip = useMemo(() => (isClient ? parseStoredTrip(raw) : null), [isClient, raw]);
  const narrative = useNovaItinerary(trip);
  const stay = useStayStatus(trip);
  const [focus, setFocus] = useState<number | null>(null);
  const [padding, setPadding] = useState({ top: 80, right: 56, bottom: 56, left: 460 });
  const draft = useMemo(() => (trip && narrative ? daysFromItinerary(narrative, trip.startDate) : []), [narrative, trip]);
  const [days, setDays] = useState<PlanDay[]>([]);

  useEffect(() => {
    if (!isClient || !trip) return;
    if (!trip.attractions || trip.attractions.length === 0) router.replace("/attractions");
    else if (!trip.hotel) router.replace("/hotels");
  }, [isClient, trip, router]);

  useEffect(() => {
    setDays(draft);
    if (!trip || draft.length === 0 || trip.city.lat == null || trip.city.lng == null) return;
    const token = process.env.NEXT_PUBLIC_MAPBOX_TOKEN;
    if (!token) return;
    const controller = new AbortController();
    const titles = [...new Set(draft.flatMap((day) => day.blocks.flatMap((block) => (block.kind === "stop" ? [block.stop.title] : []))))].slice(0, 8);
    const city = trip.city;
    void (async () => {
      const found = new Map<string, { lat: number; lng: number }>();
      for (const title of titles) {
        if (title.length > 80) continue;
        try {
          const url = new URL(`https://api.mapbox.com/geocoding/v5/mapbox.places/${encodeURIComponent(`${title}, ${city.title}`)}.json`);
          url.searchParams.set("proximity", `${city.lng},${city.lat}`);
          url.searchParams.set("limit", "1");
          url.searchParams.set("types", "poi,address,place");
          url.searchParams.set("access_token", token);
          const response = await fetch(url, { signal: controller.signal });
          const payload = await response.json() as { features?: Array<{ center?: number[]; relevance?: number }> };
          const feature = payload.features?.[0];
          const center = feature?.center;
          if (!center || (feature?.relevance ?? 0) < 0.5 || city.lat == null || city.lng == null) continue;
          const [lng, lat] = center;
          if (!near(city.lat, city.lng, lat, lng)) continue;
          found.set(title, { lat, lng });
        } catch {
          if (controller.signal.aborted) return;
        }
      }
      if (controller.signal.aborted) return;
      setDays(draft.map((day) => ({
        ...day,
        blocks: day.blocks.map((block) => {
          if (block.kind !== "stop") return block;
          const point = found.get(block.stop.title);
          if (!point) return block;
          return { ...block, stop: { ...block.stop, lat: point.lat, lng: point.lng, role: "sight" as const } };
        }),
      })));
    })();
    return () => controller.abort();
  }, [draft, trip]);

  useEffect(() => {
    const apply = () => {
      const narrow = window.innerWidth < 800;
      setPadding(narrow
        ? { top: 96, right: 88, bottom: Math.round(window.innerHeight * 0.48), left: 48 }
        : { top: 96, right: 88, bottom: 72, left: 460 });
    };
    apply();
    window.addEventListener("resize", apply);
    return () => window.removeEventListener("resize", apply);
  }, []);

  function toggleDay(index: number) {
    setFocus((current) => (current === index ? null : index));
  }

  function startFresh() {
    if (trip) forgetRun(tripRunKey(trip));
    clearStoredTrip();
    router.push("/");
  }

  const home = trip && trip.city.lat != null && trip.city.lng != null ? { lat: trip.city.lat, lng: trip.city.lng } : null;
  const hotelTitle = trip?.hotel?.title.toLowerCase() ?? "";

  return (
    <main className="plan-shell">
      {home ? (
        <TripMap
          days={days}
          focus={focus}
          padding={padding}
          home={home}
          onSelect={(day) => setFocus((current) => (day != null && current === day ? null : day))}
        />
      ) : (
        <div className="plan-map" />
      )}
      <TripGuide trip={trip} />
      <section className="plan-panel">
        <header className="gallery-head">
          <div>
            <p className="mark">Swanavi</p>
            <h1 className="title">{trip?.city.title ?? "Your days"}</h1>
            <p className="region">
              {trip ? `${formatRange(trip.startDate, trip.endDate)} · ${trip.hotel?.title ?? "Your hotel"}` : "The days, in order."}
            </p>
          </div>
          <div className="gallery-actions">
            <button type="button" className="change" onClick={startFresh}>New trip</button>
            <button type="button" className="change" onClick={() => router.push("/attractions")}>Places</button>
            <button type="button" className="change" onClick={() => router.push("/hotels")}>Hotel</button>
          </div>
        </header>
        {narrative && stay.hotelLine ? <p className="note" title="Test-mode integration; no real RLUSD transferred or settled on XRPL.">{trip?.hotel?.title ?? "Hotel"} · {stay.hotelLine}</p> : null}
        {days.length > 0 ? (
          <div className="plan-board">
            {days.map((day, index) => (
              <article className={focus === index ? "day-column is-on" : "day-column"} key={day.date}>
                <button type="button" className="day-focus" onClick={() => toggleDay(index)}>
                  <i className="day-swatch" style={{ background: DAY_COLORS[index % DAY_COLORS.length] }} />
                  <span>{day.weekday}</span>
                  <span className="day-focus-date">{day.label}</span>
                </button>
                {day.blocks.map((block, blockIndex) =>
                  block.kind === "leg" ? (
                    <p className="leg-row" key={`${day.date}-leg-${blockIndex}`}>{formatLeg(block.leg)}</p>
                  ) : (
                    <div className="stop-row" key={`${day.date}-stop-${blockIndex}`}>
                      {block.stop.time ? <time>{block.stop.time}</time> : <time />}
                      <div>
                        <strong>{block.stop.title}</strong>
                        {block.stop.detail ? <span>{block.stop.detail}</span> : null}
                        {hotelTitle && block.stop.title.toLowerCase().includes(hotelTitle) && stay.hotelLine ? <span title="Test-mode integration; no real RLUSD transferred or settled on XRPL.">{stay.hotelLine}</span> : null}
                        {hotelTitle && block.stop.title.toLowerCase().includes(hotelTitle) && stay.alternativeLine ? <span>{stay.alternativeLine}</span> : null}
                      </div>
                    </div>
                  ),
                )}
              </article>
            ))}
          </div>
        ) : null}
      </section>
    </main>
  );
}

"use client";

import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { formatRange } from "@/lib/civil";
import { buildPlan, formatLeg, type PlanDay, type SightInput } from "@/lib/plan";
import { placesErrorCopy, requestPlaces } from "@/lib/places";
import { getTripRawServerSnapshot, parseStoredTrip, readTripRaw, subscribeTrip, type TripPlace } from "@/lib/trip";
import { DAY_COLORS, TripMap } from "./map";

function subscribeNothing() {
  return () => {};
}

function located(place: TripPlace, coords: Map<string, { lat: number; lng: number }>): { lat: number; lng: number } | null {
  if (place.lat != null && place.lng != null) return { lat: place.lat, lng: place.lng };
  return coords.get(place.placeId) ?? null;
}

export default function PlanPage() {
  const router = useRouter();
  const raw = useSyncExternalStore(subscribeTrip, readTripRaw, getTripRawServerSnapshot);
  const isClient = useSyncExternalStore(subscribeNothing, () => true, () => false);
  const trip = useMemo(() => (isClient ? parseStoredTrip(raw) : null), [isClient, raw]);
  const [coords, setCoords] = useState<Map<string, { lat: number; lng: number }>>(new Map());
  const [resolved, setResolved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [focus, setFocus] = useState<number | null>(null);
  const [padding, setPadding] = useState({ top: 80, right: 56, bottom: 56, left: 460 });

  useEffect(() => {
    if (!isClient || !trip) return;
    if (!trip.attractions || trip.attractions.length === 0) router.replace("/attractions");
    else if (!trip.hotel) router.replace("/hotels");
  }, [isClient, trip, router]);

  useEffect(() => {
    if (!trip?.hotel || !trip.attractions?.length) return;
    const wanted = [trip.hotel, ...trip.attractions, trip.arrivalAirport, trip.departureAirport] as TripPlace[];
    const missing = wanted.filter((place, index, list) => {
      if (place.lat != null && place.lng != null) return false;
      return list.findIndex((item) => item.placeId === place.placeId) === index;
    });
    if (missing.length === 0) return;
    const controller = new AbortController();
    let cancelled = false;
    void (async () => {
      try {
        const data = await requestPlaces<{ locations: Array<{ placeId: string; lat: number; lng: number }> }>(
          { intent: "locations", placeIds: missing.map((place) => place.placeId) },
          controller.signal,
        );
        if (cancelled) return;
        setCoords(new Map(data.locations.map((place) => [place.placeId, { lat: place.lat, lng: place.lng }])));
        setResolved(true);
        setError(null);
      } catch (caught) {
        if (cancelled || (caught instanceof DOMException && caught.name === "AbortError")) return;
        setResolved(true);
        if (trip.hotel?.lat == null || trip.hotel?.lng == null) setError(placesErrorCopy(caught));
      }
    })();
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [trip]);

  const missingCoords = trip?.hotel && trip.attractions?.length ? [trip.hotel, ...trip.attractions].some((place) => place.lat == null || place.lng == null) : false;
  const status = error ? "error" : missingCoords && !resolved ? "loading" : "ready";

  const days = useMemo<PlanDay[]>(() => {
    if (!trip?.hotel || !trip.attractions?.length || status !== "ready") return [];
    const hotelPoint = located(trip.hotel, coords);
    if (!hotelPoint) return [];
    const sights = trip.attractions.flatMap((place) => {
      const point = located(place, coords);
      if (!point) return [];
      const sight: SightInput = { title: place.title, category: place.category ?? "", lat: point.lat, lng: point.lng };
      return [sight];
    });
    if (sights.length === 0) return [];
    return buildPlan({
      startDate: trip.startDate,
      endDate: trip.endDate,
      arrivalTime: trip.arrivalTime,
      departureTime: trip.departureTime,
      arrivalAirport: trip.arrivalAirport.title,
      departureAirport: trip.departureAirport.title,
      arrivalPoint: coords.get(trip.arrivalAirport.placeId) ?? null,
      departurePoint: coords.get(trip.departureAirport.placeId) ?? null,
      hotel: { title: trip.hotel.title, ...hotelPoint },
      sights,
    });
  }, [trip, coords, status]);

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

  return (
    <main className="plan-shell">
      {days.length > 0 ? (
        <TripMap
          days={days}
          focus={focus}
          padding={padding}
          onSelect={(day) => setFocus((current) => (day != null && current === day ? null : day))}
        />
      ) : (
        <div className="plan-map" />
      )}
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
            <button type="button" className="change" onClick={() => router.push("/attractions")}>
              Places
            </button>
            <button type="button" className="change" onClick={() => router.push("/hotels")}>
              Hotel
            </button>
          </div>
        </header>

        {status === "loading" ? (
          <div className="place-skeletons" aria-hidden="true">
            <span />
            <span />
          </div>
        ) : null}
        {status === "error" ? <p className="empty">{error}</p> : null}
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
                      <time>{block.stop.time}</time>
                      <div>
                        <strong>{block.stop.title}</strong>
                        {block.stop.detail ? <span>{block.stop.detail}</span> : null}
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

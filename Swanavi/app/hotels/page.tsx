"use client";

import Image from "next/image";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { placeLine, placesErrorCopy, requestPlaces, type Attraction } from "@/lib/places";
import { getTripRawServerSnapshot, parseStoredTrip, readTripRaw, subscribeTrip, writeStoredTrip } from "@/lib/trip";
import Mark from "../mark";

function subscribeNothing() {
  return () => {};
}

function reviewCount(count: number): string {
  if (count < 1000) return String(count);
  const thousands = count / 1000;
  return thousands < 10 ? `${thousands.toFixed(1).replace(".0", "")}k` : `${Math.round(thousands)}k`;
}

function distanceLabel(meters: number): string {
  if (meters < 950) return `${Math.max(50, Math.round(meters / 10) * 10)} m from your places`;
  return `${(meters / 1000).toFixed(meters < 10000 ? 1 : 0)} km from your places`;
}

export default function HotelsPage() {
  const router = useRouter();
  const raw = useSyncExternalStore(subscribeTrip, readTripRaw, getTripRawServerSnapshot);
  const isClient = useSyncExternalStore(subscribeNothing, () => true, () => false);
  const trip = useMemo(() => (isClient ? parseStoredTrip(raw) : null), [isClient, raw]);
  const [hotels, setHotels] = useState<Attraction[]>([]);
  const [status, setStatus] = useState<"loading" | "ready" | "empty" | "error">("loading");
  const [error, setError] = useState<string | null>(null);
  const [picked, setPicked] = useState<string | null>(null);

  const selected = picked ?? trip?.hotel?.placeId ?? "";
  const originKey = useMemo(() => {
    if (!trip?.attractions?.length || trip.city.lat == null || trip.city.lng == null) return "";
    return JSON.stringify({
      lat: trip.city.lat,
      lng: trip.city.lng,
      places: trip.attractions.map((place) => [place.placeId, place.lat ?? null, place.lng ?? null]),
    });
  }, [trip]);

  useEffect(() => {
    if (!isClient || !trip) return;
    if (!trip.attractions || trip.attractions.length === 0) router.replace("/attractions");
  }, [isClient, trip, router]);

  useEffect(() => {
    if (!originKey) return;
    const parsed = JSON.parse(originKey) as { lat: number; lng: number; places: Array<[string, number | null, number | null]> };
    const controller = new AbortController();
    let cancelled = false;
    void (async () => {
      try {
        let points = parsed.places.flatMap(([, lat, lng]) => (lat != null && lng != null ? [{ lat, lng }] : []));
        if (points.length === 0) {
          const located = await requestPlaces<{ locations: Array<{ lat: number; lng: number }> }>(
            { intent: "locations", placeIds: parsed.places.map(([placeId]) => placeId) },
            controller.signal,
          );
          points = located.locations;
        }
        const origin = points.length
          ? {
              lat: points.reduce((sum, point) => sum + point.lat, 0) / points.length,
              lng: points.reduce((sum, point) => sum + point.lng, 0) / points.length,
            }
          : { lat: parsed.lat, lng: parsed.lng };
        const data = await requestPlaces<{ hotels: Attraction[] }>({ intent: "hotels", lat: origin.lat, lng: origin.lng }, controller.signal);
        if (cancelled) return;
        setHotels(data.hotels);
        setStatus(data.hotels.length ? "ready" : "empty");
        setError(null);
      } catch (caught) {
        if (cancelled || (caught instanceof DOMException && caught.name === "AbortError")) return;
        setHotels([]);
        setStatus("error");
        setError(placesErrorCopy(caught));
      }
    })();
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [originKey]);

  function saveHotel(place: Attraction | null) {
    if (!trip) return;
    setPicked(place?.placeId ?? "");
    if (!place || place.lat == null || place.lng == null) {
      writeStoredTrip({ ...trip, hotel: undefined });
      return;
    }
    writeStoredTrip({
      ...trip,
      hotel: {
        placeId: place.placeId,
        title: place.title,
        subtitle: place.subtitle,
        lat: place.lat,
        lng: place.lng,
        ...(place.category ? { category: place.category } : {}),
      },
    });
  }

  function choose(placeId: string) {
    if (selected === placeId) {
      saveHotel(null);
      return;
    }
    saveHotel(hotels.find((hotel) => hotel.placeId === placeId) ?? null);
  }

  function chooseForTrip() {
    const best = [...hotels].sort((a, b) => (b.rating ?? 0) - (a.rating ?? 0) || (b.reviews ?? 0) - (a.reviews ?? 0))[0];
    if (best) saveHotel(best);
  }

  const cityLine = trip ? [trip.city.title, placeLine(trip.city.subtitle)].filter(Boolean).join(", ") : "";

  return (
    <main className="stage full">
      <section className="sheet gallery">
        <header className="gallery-head">
          <div>
            <Mark />
            <h1 className="title">{trip?.city.title ?? "Hotel"}</h1>
            <p className="region">{cityLine ? `Stay near what you picked in ${trip?.city.title}.` : "Where you sleep."}</p>
          </div>
          <div className="gallery-actions">
            {status === "ready" ? (
              <button type="button" className="pill" onClick={chooseForTrip}>
                Let Swanavi choose
              </button>
            ) : null}
            <button type="button" className="change" onClick={() => router.push("/attractions")}>
              Places
            </button>
            <button type="button" className="continue header-continue" disabled={!selected} onClick={() => router.push("/plan")}>
              Continue
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
        {status === "empty" ? <p className="empty">No hotels came back near these places.</p> : null}

        {hotels.length > 0 ? (
          <div className="gallery-list" role="listbox" aria-label="Hotels">
            {hotels.map((place, index) => {
              const on = selected === place.placeId;
              return (
                <button type="button" className="place-card" role="option" aria-selected={on} key={place.placeId} onClick={() => choose(place.placeId)}>
                  <span className="place-photo">
                    {place.photo ? <Image src={place.photo} alt="" fill sizes="(max-width: 720px) 100vw, (max-width: 1200px) 50vw, 33vw" priority={index < 3} referrerPolicy="no-referrer" /> : null}
                    {place.photoCredit ? <span className="place-credit">Photo · {place.photoCredit}</span> : null}
                    <span className="place-mark" aria-hidden="true">{on ? <Check /> : null}</span>
                    <span className="place-shade">
                      {place.category ? <span className="place-kicker">{place.category}</span> : null}
                      <span className="place-name-row">
                        <span className="place-name">{place.title}</span>
                        {place.rating != null ? <span className="place-score">{place.rating.toFixed(1)}</span> : null}
                      </span>
                      {place.rating != null || place.reviews ? (
                        <span className="place-stars-row">
                          {place.rating != null ? <Stars rating={place.rating} /> : null}
                          {place.reviews ? <span>{reviewCount(place.reviews)} reviews</span> : null}
                        </span>
                      ) : null}
                    </span>
                  </span>
                  <span className="place-copy">
                    {place.distanceMeters != null ? <span className="place-summary">{distanceLabel(place.distanceMeters)}</span> : null}
                    {place.subtitle ? <span className="place-summary">{place.subtitle}</span> : null}
                    {place.quote ? (
                      <span className="place-quote">
                        <q>{place.quote}</q>
                        {place.quoteAuthor ? <span>{place.quoteAuthor}</span> : null}
                      </span>
                    ) : null}
                  </span>
                </button>
              );
            })}
          </div>
        ) : null}
        {hotels.length > 0 ? <p className="attrib">Powered by Google</p> : null}
      </section>
    </main>
  );
}

function Stars({ rating }: { rating: number }) {
  const width = `${(Math.max(0, Math.min(5, rating)) / 5) * 100}%`;
  return (
    <span className="stars on-dark" aria-hidden="true">
      <span className="stars-base">★★★★★</span>
      <span className="stars-fill" style={{ width }}>★★★★★</span>
    </span>
  );
}

function Check() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
      <path d="M3.2 8.4 L6.5 11.6 L12.8 4.6" fill="none" stroke="#fff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

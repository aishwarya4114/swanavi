"use client";

import Image from "next/image";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { inclusiveDays } from "@/lib/civil";
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

function blankAttraction(place: { placeId: string; title: string; subtitle: string }): Attraction {
  return { ...place, rating: null, reviews: null, category: "", quote: "", quoteAuthor: "", photo: "", photoCredit: "", lat: null, lng: null, distanceMeters: null };
}

export default function AttractionsPage() {
  const router = useRouter();
  const raw = useSyncExternalStore(subscribeTrip, readTripRaw, getTripRawServerSnapshot);
  const isClient = useSyncExternalStore(subscribeNothing, () => true, () => false);
  const trip = useMemo(() => (isClient ? parseStoredTrip(raw) : null), [isClient, raw]);
  const [places, setPlaces] = useState<Attraction[]>([]);
  const [status, setStatus] = useState<"loading" | "ready" | "empty" | "error">("loading");
  const [error, setError] = useState<string | null>(null);
  const [picked, setPicked] = useState<string[] | null>(null);

  const selected = picked ?? trip?.attractions?.map((place) => place.placeId) ?? [];
  const cityId = trip?.city.placeId ?? null;
  const lat = trip?.city.lat ?? null;
  const lng = trip?.city.lng ?? null;
  const query = trip ? [trip.city.title, placeLine(trip.city.subtitle)].filter(Boolean).join(", ") : "";

  useEffect(() => {
    if (isClient && !trip) router.replace("/");
  }, [isClient, trip, router]);

  useEffect(() => {
    if (!cityId || lat == null || lng == null || !query) return;
    const controller = new AbortController();
    let cancelled = false;
    void (async () => {
      try {
        const data = await requestPlaces<{ attractions: Attraction[] }>(
          { intent: "attractions", query, lat, lng },
          controller.signal,
        );
        if (cancelled) return;
        setPlaces(data.attractions);
        setStatus(data.attractions.length ? "ready" : "empty");
        setError(null);
      } catch (caught) {
        if (cancelled || (caught instanceof DOMException && caught.name === "AbortError")) return;
        setPlaces([]);
        setStatus("error");
        setError(placesErrorCopy(caught));
      }
    })();
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [cityId, lat, lng, query]);

  useEffect(() => {
    if (!trip || places.length === 0 || !trip.attractions?.length) return;
    const known = new Map(places.map((place) => [place.placeId, place]));
    const incomplete = trip.attractions.some((place) => {
      const live = known.get(place.placeId);
      return live != null && (place.lat == null || place.lng == null || (Boolean(live.category) && place.category !== live.category));
    });
    if (!incomplete) return;
    const attractions = trip.attractions.map((place) => {
      const live = known.get(place.placeId);
      if (!live || live.lat == null || live.lng == null) return place;
      return { ...place, lat: live.lat, lng: live.lng, ...(live.category ? { category: live.category } : {}) };
    });
    writeStoredTrip({ ...trip, attractions });
  }, [places, trip]);

  function remember(ids: string[]) {
    if (!trip) return;
    const known = new Map(places.map((place) => [place.placeId, place]));
    for (const place of trip.attractions ?? []) {
      if (!known.has(place.placeId)) known.set(place.placeId, blankAttraction(place));
    }
    const attractions = ids.flatMap((id) => {
      const place = known.get(id);
      return place
        ? [{
            placeId: place.placeId,
            title: place.title,
            subtitle: place.subtitle,
            ...(place.lat != null && place.lng != null ? { lat: place.lat, lng: place.lng } : {}),
            ...(place.category ? { category: place.category } : {}),
          }]
        : [];
    });
    writeStoredTrip({ ...trip, attractions });
    setPicked(ids);
  }

  function toggle(placeId: string) {
    const next = selected.includes(placeId) ? selected.filter((id) => id !== placeId) : [...selected, placeId];
    remember(next);
  }

  function chooseForTrip() {
    if (!trip || places.length === 0) return;
    const days = inclusiveDays(trip.startDate, trip.endDate);
    const count = Math.min(places.length, Math.max(12, days * 6));
    remember(places.slice(0, count).map((place) => place.placeId));
  }

  const pickedLabel = selected.length === 0 ? "Nothing picked yet" : selected.length === 1 ? "1 place picked" : `${selected.length} places picked`;

  return (
    <main className="stage full">
      <section className="sheet gallery">
        <header className="gallery-head">
          <div>
            <Mark />
            {trip ? (
              <>
                <h1 className="title">{trip.city.title}</h1>
                <p className="region">What do you want to see?</p>
              </>
            ) : (
              <h1 className="title">Places</h1>
            )}
          </div>
          <div className="gallery-actions">
            {status === "ready" ? <p>{pickedLabel}</p> : null}
            {status === "ready" ? (
              <button type="button" className="pill" onClick={chooseForTrip}>
                Let Swanavi choose
              </button>
            ) : null}
            {trip ? (
              <button type="button" className="change" onClick={() => router.push("/")}>
                Trip
              </button>
            ) : null}
            <button type="button" className="continue header-continue" disabled={selected.length === 0} onClick={() => router.push("/hotels")}>
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
        {status === "empty" ? <p className="empty">No attractions came back for this city.</p> : null}

        {places.length > 0 ? (
          <div className="gallery-list" role="listbox" aria-label="Attractions" aria-multiselectable="true">
            {places.map((place, index) => {
              const on = selected.includes(place.placeId);
              return (
                <button type="button" className="place-card" role="option" aria-selected={on} key={place.placeId} onClick={() => toggle(place.placeId)}>
                  <span className="place-photo">
                    {place.photo ? (
                      <Image src={place.photo} alt="" fill sizes="(max-width: 720px) 100vw, (max-width: 1200px) 50vw, 33vw" priority={index < 3} referrerPolicy="no-referrer" />
                    ) : null}
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
                  {place.subtitle || place.quote ? (
                    <span className="place-copy">
                      {place.subtitle ? <span className="place-summary">{place.subtitle}</span> : null}
                      {place.quote ? (
                        <span className="place-quote">
                          <q>{place.quote}</q>
                          {place.quoteAuthor ? <span>{place.quoteAuthor}</span> : null}
                        </span>
                      ) : null}
                    </span>
                  ) : null}
                </button>
              );
            })}
          </div>
        ) : null}
        {places.length > 0 ? <p className="attrib">Powered by Google</p> : null}
      </section>
    </main>
  );
}

function Stars({ rating }: { rating: number }) {
  const width = `${(Math.max(0, Math.min(5, rating)) / 5) * 100}%`;
  return (
    <span className="stars on-dark" aria-hidden="true">
      <span className="stars-base">★★★★★</span>
      <span className="stars-fill" style={{ width }} >★★★★★</span>
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

import { NextResponse } from "next/server";
import { localityLine, type Attraction, type Suggestion } from "@/lib/places";

const PLACES = "https://places.googleapis.com/v1";
const AUTOCOMPLETE_MASK = "suggestions.placePrediction.placeId,suggestions.placePrediction.text,suggestions.placePrediction.structuredFormat";
const DETAILS_MASK = "id,displayName,location";
const AIRPORT_MASK = "places.id,places.displayName,places.shortFormattedAddress,places.formattedAddress,places.primaryType";
const ATTRACTION_MASK = [
  "places.id",
  "places.displayName",
  "places.editorialSummary",
  "places.rating",
  "places.userRatingCount",
  "places.shortFormattedAddress",
  "places.location",
  "places.primaryType",
  "places.primaryTypeDisplayName",
  "places.photos.name",
  "places.photos.authorAttributions.displayName",
  "places.reviews.rating",
  "places.reviews.text",
  "places.reviews.relativePublishTimeDescription",
  "places.reviews.authorAttribution.displayName",
].join(",");

type GoogleFailure = { ok: false; error: "missing_key" | "denied" | "failed"; status: number };
type GoogleSuccess = { ok: true; payload: unknown };

function cleanText(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const text = value.replace(/[\u0000-\u001F\u007F]/g, " ").replace(/\s+/g, " ").trim();
  if (!text || text.length > max) return null;
  return text;
}

function cleanPlaceId(value: unknown): string | null {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{8,255}$/.test(value)) return null;
  return value;
}

function cleanToken(value: unknown): string | null {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{8,36}$/.test(value)) return null;
  return value;
}

function cleanCoordinate(value: unknown, min: number, max: number): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) return null;
  return value;
}

function bias(lat: number | null, lng: number | null) {
  if (lat === null || lng === null) return undefined;
  return { circle: { center: { latitude: lat, longitude: lng }, radius: 50000 } };
}

async function google(url: string, method: "GET" | "POST", fieldMask: string | null, body?: unknown): Promise<GoogleFailure | GoogleSuccess> {
  const key = process.env.GOOGLE_MAPS_API_KEY?.trim();
  if (!key) return { ok: false, error: "missing_key", status: 500 };

  try {
    const response = await fetch(url, {
      method,
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": key,
        ...(fieldMask ? { "X-Goog-FieldMask": fieldMask } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      cache: "no-store",
      signal: AbortSignal.timeout(8000),
    });
    const payload = (await response.json().catch(() => null)) as { error?: { status?: string } } | null;
    if (!response.ok) {
      const status = payload?.error?.status;
      if (response.status === 403 || status === "PERMISSION_DENIED" || status === "REQUEST_DENIED") {
        return { ok: false, error: "denied", status: 403 };
      }
      return { ok: false, error: "failed", status: 502 };
    }
    return { ok: true, payload };
  } catch {
    return { ok: false, error: "failed", status: 502 };
  }
}

function textOf(value: unknown): string {
  if (!value || typeof value !== "object" || !("text" in value)) return "";
  const text = (value as { text?: unknown }).text;
  return typeof text === "string" ? text : "";
}

function suggestionsFrom(payload: unknown): Suggestion[] {
  if (!payload || typeof payload !== "object" || !("suggestions" in payload)) return [];
  const suggestions = (payload as { suggestions?: unknown }).suggestions;
  if (!Array.isArray(suggestions)) return [];
  const places: Suggestion[] = [];
  for (const item of suggestions) {
    if (!item || typeof item !== "object" || !("placePrediction" in item)) continue;
    const prediction = (item as { placePrediction?: unknown }).placePrediction;
    if (!prediction || typeof prediction !== "object") continue;
    const record = prediction as {
      placeId?: unknown;
      text?: unknown;
      structuredFormat?: { mainText?: unknown; secondaryText?: unknown };
    };
    const placeId = cleanPlaceId(record.placeId);
    const title = textOf(record.structuredFormat?.mainText) || textOf(record.text);
    if (!placeId || !title) continue;
    places.push({ placeId, title, subtitle: textOf(record.structuredFormat?.secondaryText) });
    if (places.length === 5) break;
  }
  return places;
}

function airportsFrom(payload: unknown): Suggestion[] {
  if (!payload || typeof payload !== "object" || !("places" in payload)) return [];
  const places = (payload as { places?: unknown }).places;
  if (!Array.isArray(places)) return [];
  const airports: Suggestion[] = [];
  for (const place of places) {
    if (!place || typeof place !== "object") continue;
    const record = place as {
      id?: unknown;
      displayName?: unknown;
      shortFormattedAddress?: unknown;
      formattedAddress?: unknown;
      primaryType?: unknown;
    };
    const placeId = cleanPlaceId(record.id);
    const title = textOf(record.displayName);
    const airportType = record.primaryType === "airport" || record.primaryType === "international_airport";
    const airportName = /airport|aeroporto|aéroport|aeropuerto|flughafen|luchthaven/i.test(title) && !/in the city/i.test(title);
    if (!placeId || !title || !airportType || !airportName) continue;
    const subtitle = typeof record.shortFormattedAddress === "string" ? record.shortFormattedAddress : typeof record.formattedAddress === "string" ? record.formattedAddress : "";
    airports.push({ placeId, title, subtitle });
    if (airports.length === 3) break;
  }
  return airports;
}

const SKIP_TYPES = new Set(["shopping_mall", "department_store", "store", "supermarket", "restaurant", "cafe", "bar", "lodging", "hotel", "casino", "stadium", "arena", "sports_complex", "athletic_field"]);

function metersBetween(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 6371000 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(Math.max(0, 1 - a)));
}

function clip(value: string, max: number): string {
  const text = value.replace(/\s+/g, " ").trim();
  if (text.length <= max) return text;
  const cut = text.slice(0, max - 1);
  const last = cut.lastIndexOf(" ");
  return `${(last > 48 ? cut.slice(0, last) : cut).trim()}…`;
}

function photoNameOf(value: unknown): { name: string; credit: string } {
  if (!Array.isArray(value)) return { name: "", credit: "" };
  for (const photo of value) {
    if (!photo || typeof photo !== "object" || !("name" in photo)) continue;
    const name = (photo as { name?: unknown }).name;
    if (typeof name !== "string" || !/^places\/[A-Za-z0-9_-]{8,255}\/photos\/[A-Za-z0-9_-]{8,900}$/.test(name)) continue;
    const credits = (photo as { authorAttributions?: unknown }).authorAttributions;
    const credit = Array.isArray(credits) ? cleanText((credits[0] as { displayName?: unknown } | undefined)?.displayName, 80) ?? "" : "";
    return { name, credit };
  }
  return { name: "", credit: "" };
}

function quoteOf(value: unknown): { quote: string; quoteAuthor: string } {
  if (!Array.isArray(value)) return { quote: "", quoteAuthor: "" };
  const reviews = value.flatMap((review) => {
    if (!review || typeof review !== "object") return [];
    const record = review as {
      rating?: unknown;
      text?: unknown;
      relativePublishTimeDescription?: unknown;
      authorAttribution?: { displayName?: unknown };
    };
    const quote = clip(textOf(record.text), 180);
    if (!quote) return [];
    const author = cleanText(record.authorAttribution?.displayName, 48) ?? "";
    const when = cleanText(record.relativePublishTimeDescription, 40) ?? "";
    const quoteAuthor = [author, when].filter(Boolean).join(" · ");
    const rating = typeof record.rating === "number" ? record.rating : 0;
    return [{ quote, quoteAuthor, rating }];
  });
  reviews.sort((a, b) => b.rating - a.rating || b.quote.length - a.quote.length);
  const best = reviews[0];
  return best ? { quote: best.quote, quoteAuthor: best.quoteAuthor } : { quote: "", quoteAuthor: "" };
}

function safePhotoUri(value: unknown): string {
  if (typeof value !== "string" || value.length > 2000) return "";
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || !url.hostname.endsWith("googleusercontent.com")) return "";
    return url.toString();
  } catch {
    return "";
  }
}

type AttractionDraft = Attraction & { photoName: string };

const HOTEL_TYPES = new Set(["hotel", "lodging", "resort_hotel", "extended_stay_hotel", "guest_house", "bed_and_breakfast", "motel", "private_guest_room"]);

function attractionsFrom(payload: unknown, originLat: number, originLng: number, mode: "sights" | "hotels" = "sights"): AttractionDraft[] {
  if (!payload || typeof payload !== "object" || !("places" in payload)) return [];
  const places = (payload as { places?: unknown }).places;
  if (!Array.isArray(places)) return [];
  const attractions: Array<AttractionDraft & { meters: number }> = [];
  for (const place of places) {
    if (!place || typeof place !== "object") continue;
    const record = place as {
      id?: unknown;
      displayName?: unknown;
      editorialSummary?: unknown;
      shortFormattedAddress?: unknown;
      rating?: unknown;
      userRatingCount?: unknown;
      primaryTypeDisplayName?: unknown;
      location?: { latitude?: unknown; longitude?: unknown };
      primaryType?: unknown;
      photos?: unknown;
      reviews?: unknown;
    };
    const placeId = cleanPlaceId(record.id);
    const title = textOf(record.displayName);
    const primary = typeof record.primaryType === "string" ? record.primaryType : "";
    if (!placeId || !title) continue;
    if (mode === "sights" && primary && SKIP_TYPES.has(primary)) continue;
    if (mode === "hotels" && primary && !HOTEL_TYPES.has(primary)) continue;
    const summary = textOf(record.editorialSummary);
    const address = typeof record.shortFormattedAddress === "string" ? localityLine(record.shortFormattedAddress) : "";
    const photo = photoNameOf(record.photos);
    const quote = quoteOf(record.reviews);
    const placeLat = cleanCoordinate(record.location?.latitude, -90, 90);
    const placeLng = cleanCoordinate(record.location?.longitude, -180, 180);
    attractions.push({
      placeId,
      title,
      subtitle: clip(summary || address, 220),
      rating: typeof record.rating === "number" ? record.rating : null,
      reviews: typeof record.userRatingCount === "number" ? record.userRatingCount : null,
      category: textOf(record.primaryTypeDisplayName),
      quote: quote.quote,
      quoteAuthor: quote.quoteAuthor,
      photo: "",
      photoCredit: photo.credit,
      photoName: photo.name,
      lat: placeLat,
      lng: placeLng,
      distanceMeters: null,
      meters: placeLat === null || placeLng === null ? Number.POSITIVE_INFINITY : metersBetween(originLat, originLng, placeLat, placeLng),
    });
  }
  const limit = mode === "hotels" ? 8000 : 12000;
  const minimum = mode === "hotels" ? 3 : 5;
  const near = attractions.filter((place) => place.meters <= limit && (mode === "sights" || (place.lat != null && place.lng != null)));
  return (near.length >= minimum ? near : attractions).slice(0, mode === "hotels" ? 8 : 20).map((place) => ({
    placeId: place.placeId,
    title: place.title,
    subtitle: place.subtitle,
    rating: place.rating,
    reviews: place.reviews,
    category: place.category,
    quote: place.quote,
    quoteAuthor: place.quoteAuthor,
    photo: place.photo,
    photoCredit: place.photoCredit,
    photoName: place.photoName,
    lat: place.lat,
    lng: place.lng,
    distanceMeters: Number.isFinite(place.meters) ? Math.round(place.meters) : null,
  }));
}

async function coverPhoto(name: string): Promise<string> {
  if (!name) return "";
  const result = await google(`${PLACES}/${name}/media?maxHeightPx=1000&maxWidthPx=1400&skipHttpRedirect=true`, "GET", null);
  if (!result.ok || !result.payload || typeof result.payload !== "object") return "";
  return safePhotoUri((result.payload as { photoUri?: unknown }).photoUri);
}

function rankCities(places: Suggestion[], input: string): Suggestion[] {
  const query = input.trim().toLowerCase();
  return places
    .map((place, index) => {
      const exact = place.title.toLowerCase() === query ? 2 : 0;
      const broad = /,\s*usa$/i.test(place.subtitle) ? 0 : 1;
      return { place, index, score: exact + broad };
    })
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map((item) => item.place);
}

function fail(result: GoogleFailure) {
  return NextResponse.json({ error: result.error }, { status: result.status });
}

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "failed" }, { status: 400 });
  }
  if (!body || typeof body !== "object") return NextResponse.json({ error: "failed" }, { status: 400 });

  const record = body as Record<string, unknown>;
  const lat = cleanCoordinate(record.lat, -90, 90);
  const lng = cleanCoordinate(record.lng, -180, 180);

  if (record.intent === "cities" || record.intent === "airportSuggest") {
    const input = cleanText(record.input, 80);
    const sessionToken = cleanToken(record.sessionToken);
    if (!input || !sessionToken) return NextResponse.json({ error: "failed" }, { status: 400 });
    const result = await google(`${PLACES}/places:autocomplete`, "POST", AUTOCOMPLETE_MASK, {
      input,
      includedPrimaryTypes: record.intent === "cities" ? ["(cities)"] : ["airport"],
      includeQueryPredictions: false,
      languageCode: "en",
      sessionToken,
      locationBias: record.intent === "airportSuggest" ? bias(lat, lng) : undefined,
    });
    if (!result.ok) return fail(result);
    const suggestions = suggestionsFrom(result.payload);
    return NextResponse.json({ suggestions: record.intent === "cities" ? rankCities(suggestions, input) : suggestions });
  }

  if (record.intent === "details") {
    const placeId = cleanPlaceId(record.placeId);
    const sessionToken = cleanToken(record.sessionToken);
    if (!placeId || !sessionToken) return NextResponse.json({ error: "failed" }, { status: 400 });
    const result = await google(`${PLACES}/places/${placeId}?sessionToken=${encodeURIComponent(sessionToken)}`, "GET", DETAILS_MASK);
    if (!result.ok) return fail(result);
    const place = result.payload as { location?: { latitude?: unknown; longitude?: unknown }; displayName?: unknown } | null;
    const latitude = cleanCoordinate(place?.location?.latitude, -90, 90);
    const longitude = cleanCoordinate(place?.location?.longitude, -180, 180);
    if (latitude === null || longitude === null) return NextResponse.json({ error: "failed" }, { status: 502 });
    return NextResponse.json({ lat: latitude, lng: longitude, name: textOf(place?.displayName) });
  }

  if (record.intent === "airports") {
    const query = cleanText(record.query, 160);
    if (!query) return NextResponse.json({ error: "failed" }, { status: 400 });
    const result = await google(`${PLACES}/places:searchText`, "POST", AIRPORT_MASK, {
      textQuery: `Airports in ${query}`,
      includedType: "airport",
      strictTypeFiltering: true,
      pageSize: 10,
      languageCode: "en",
      locationBias: bias(lat, lng),
    });
    if (!result.ok) return fail(result);
    return NextResponse.json({ suggestions: airportsFrom(result.payload) });
  }

  if (record.intent === "attractions") {
    if (lat === null || lng === null) return NextResponse.json({ error: "failed" }, { status: 400 });
    const result = await google(`${PLACES}/places:searchNearby`, "POST", ATTRACTION_MASK, {
      includedTypes: ["tourist_attraction"],
      maxResultCount: 20,
      rankPreference: "POPULARITY",
      languageCode: "en",
      locationRestriction: { circle: { center: { latitude: lat, longitude: lng }, radius: 20000 } },
    });
    if (!result.ok) return fail(result);
    const drafts = attractionsFrom(result.payload, lat, lng);
    const attractions = await Promise.all(
      drafts.map(async ({ photoName, ...place }) => ({ ...place, photo: await coverPhoto(photoName) })),
    );
    return NextResponse.json({ attractions });
  }

  if (record.intent === "hotels") {
    if (lat === null || lng === null) return NextResponse.json({ error: "failed" }, { status: 400 });
    const searchHotels = (radius: number) =>
      google(`${PLACES}/places:searchNearby`, "POST", ATTRACTION_MASK, {
        includedTypes: ["lodging"],
        maxResultCount: 12,
        rankPreference: "POPULARITY",
        languageCode: "en",
        locationRestriction: { circle: { center: { latitude: lat, longitude: lng }, radius } },
      });
    let result = await searchHotels(4000);
    if (!result.ok) return fail(result);
    let drafts = attractionsFrom(result.payload, lat, lng, "hotels");
    if (drafts.length < 4) {
      result = await searchHotels(12000);
      if (!result.ok) return fail(result);
      drafts = attractionsFrom(result.payload, lat, lng, "hotels");
    }
    const hotels = await Promise.all(drafts.map(async ({ photoName, ...place }) => ({ ...place, photo: await coverPhoto(photoName) })));
    return NextResponse.json({ hotels });
  }

  if (record.intent === "locations") {
    const rawIds = Array.isArray(record.placeIds) ? record.placeIds : [];
    const placeIds = rawIds.flatMap((value) => {
      const placeId = cleanPlaceId(value);
      return placeId ? [placeId] : [];
    }).slice(0, 12);
    if (placeIds.length === 0) return NextResponse.json({ error: "failed" }, { status: 400 });
    const locations = (
      await Promise.all(
        placeIds.map(async (placeId) => {
          const result = await google(`${PLACES}/places/${placeId}`, "GET", "id,location");
          if (!result.ok || !result.payload || typeof result.payload !== "object") return null;
          const location = (result.payload as { location?: { latitude?: unknown; longitude?: unknown } }).location;
          const latitude = cleanCoordinate(location?.latitude, -90, 90);
          const longitude = cleanCoordinate(location?.longitude, -180, 180);
          if (latitude === null || longitude === null) return null;
          return { placeId, lat: latitude, lng: longitude };
        }),
      )
    ).filter((place) => place !== null);
    return NextResponse.json({ locations });
  }

  return NextResponse.json({ error: "failed" }, { status: 400 });
}

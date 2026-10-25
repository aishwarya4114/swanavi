import { inclusiveDays, isIsoDate, isTimeValue, MAX_TRAVELERS, MAX_TRIP_DAYS, MIN_TRAVELERS } from "@/lib/civil";
import type { Suggestion } from "@/lib/places";

export type TripPlace = Suggestion & {
  lat?: number;
  lng?: number;
  category?: string;
};

export const TRIP_STORAGE_KEY = "swanavi.trip";

export type CitySelection = Suggestion & {
  lat: number | null;
  lng: number | null;
};

export type StoredTrip = {
  version: 1;
  city: CitySelection;
  startDate: string;
  endDate: string;
  arrivalAirport: Suggestion;
  departureAirport: Suggestion;
  arrivalTime: string;
  departureTime: string;
  travelers: number;
  attractions?: TripPlace[];
  hotel?: TripPlace;
};

function isSuggestion(value: unknown): value is Suggestion {
  if (!value || typeof value !== "object") return false;
  const place = value as Partial<Suggestion>;
  return typeof place.placeId === "string" && typeof place.title === "string" && typeof place.subtitle === "string" && place.title.length > 0;
}

function tripPlace(value: unknown): TripPlace | null {
  if (!isSuggestion(value)) return null;
  const record = value as TripPlace;
  const place: TripPlace = { placeId: record.placeId, title: record.title, subtitle: record.subtitle };
  if (typeof record.lat === "number" && Number.isFinite(record.lat) && typeof record.lng === "number" && Number.isFinite(record.lng)) {
    place.lat = record.lat;
    place.lng = record.lng;
  }
  if (typeof record.category === "string" && record.category.length > 0 && record.category.length <= 80) place.category = record.category;
  return place;
}

function isCity(value: unknown): value is CitySelection {
  if (!isSuggestion(value)) return false;
  const city = value as CitySelection;
  return (typeof city.lat === "number" && Number.isFinite(city.lat) && typeof city.lng === "number" && Number.isFinite(city.lng)) || (city.lat === null && city.lng === null);
}

const tripListeners = new Set<() => void>();

export function subscribeTrip(onStoreChange: () => void) {
  tripListeners.add(onStoreChange);
  window.addEventListener("storage", onStoreChange);
  return () => {
    tripListeners.delete(onStoreChange);
    window.removeEventListener("storage", onStoreChange);
  };
}

export function readTripRaw(): string | null {
  return localStorage.getItem(TRIP_STORAGE_KEY);
}

export function getTripRawServerSnapshot(): string | null {
  return null;
}

export function writeStoredTrip(trip: StoredTrip) {
  localStorage.setItem(TRIP_STORAGE_KEY, JSON.stringify(trip));
  tripListeners.forEach((listener) => listener());
}

export function parseStoredTrip(raw: string | null): StoredTrip | null {
  if (!raw) return null;
  try {
    const data = JSON.parse(raw) as Partial<StoredTrip>;
    if (data.version !== 1 || !isCity(data.city) || data.city.lat === null || data.city.lng === null) return null;
    if (typeof data.startDate !== "string" || typeof data.endDate !== "string" || !isIsoDate(data.startDate) || !isIsoDate(data.endDate)) return null;
    if (data.endDate < data.startDate || inclusiveDays(data.startDate, data.endDate) > MAX_TRIP_DAYS) return null;
    if (!isSuggestion(data.arrivalAirport) || !isSuggestion(data.departureAirport)) return null;
    if (typeof data.arrivalTime !== "string" || typeof data.departureTime !== "string" || !isTimeValue(data.arrivalTime) || !isTimeValue(data.departureTime)) return null;
    if (data.startDate === data.endDate && data.departureTime <= data.arrivalTime) return null;
    if (typeof data.travelers !== "number" || !Number.isInteger(data.travelers) || data.travelers < MIN_TRAVELERS || data.travelers > MAX_TRAVELERS) return null;
    const attractions = Array.isArray(data.attractions) ? data.attractions.flatMap((place) => { const parsed = tripPlace(place); return parsed ? [parsed] : []; }) : undefined;
    const hotel = tripPlace(data.hotel);
    return {
      version: 1,
      city: data.city,
      startDate: data.startDate,
      endDate: data.endDate,
      arrivalAirport: data.arrivalAirport,
      departureAirport: data.departureAirport,
      arrivalTime: data.arrivalTime,
      departureTime: data.departureTime,
      travelers: data.travelers,
      ...(attractions && attractions.length > 0 ? { attractions } : {}),
      ...(hotel?.lat != null && hotel.lng != null ? { hotel } : {}),
    };
  } catch {
    return null;
  }
}

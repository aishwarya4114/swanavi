export function placeLine(subtitle: string): string {
  const parts = subtitle.split(",").map((part) => part.trim()).filter(Boolean);
  if (parts.length < 2) return subtitle;
  const head = parts.slice(0, -1).join(", ");
  if (head.length > 22) return parts[parts.length - 1];
  return parts.join(", ");
}

export function localityLine(subtitle: string): string {
  const parts = subtitle.split(",").map((part) => part.trim()).filter(Boolean);
  return parts.length > 0 ? parts[parts.length - 1] : subtitle;
}

export type Suggestion = {
  placeId: string;
  title: string;
  subtitle: string;
};

export type Attraction = Suggestion & {
  rating: number | null;
  reviews: number | null;
  category: string;
  quote: string;
  quoteAuthor: string;
  photo: string;
  photoCredit: string;
  lat: number | null;
  lng: number | null;
  distanceMeters: number | null;
};

export type PlacesErrorCode = "missing_key" | "denied" | "failed";

export class PlacesRequestError extends Error {
  code: PlacesErrorCode;

  constructor(code: PlacesErrorCode) {
    super(code);
    this.name = "PlacesRequestError";
    this.code = code;
  }
}

export function placesErrorCopy(error: unknown): string {
  const code = error instanceof PlacesRequestError ? error.code : "failed";
  if (code === "missing_key") return "Add GOOGLE_MAPS_API_KEY to .env.local, then restart.";
  if (code === "denied") return "Google refused this key. Enable Places API (New) and billing.";
  return "Search did not respond. Try again.";
}

export async function requestPlaces<T>(body: unknown, signal?: AbortSignal): Promise<T> {
  let response: Response;
  try {
    response = await fetch("/api/places", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal,
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    throw new PlacesRequestError("failed");
  }

  const data = (await response.json().catch(() => null)) as { error?: string } | T | null;
  if (!response.ok) {
    const code = data && typeof data === "object" && "error" in data ? data.error : null;
    throw new PlacesRequestError(code === "missing_key" || code === "denied" ? code : "failed");
  }
  return data as T;
}

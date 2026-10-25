export const LIVE_INPUTS_KEY = "swanavi.live-inputs";
export const LIVE_RUN_KEY = "swanavi.live-run";

export type LiveInputs = {
  preferences: string;
  budgetRlusd: string;
};

export function readLiveInputs(): LiveInputs {
  try {
    const raw = localStorage.getItem(LIVE_INPUTS_KEY);
    const data = raw ? JSON.parse(raw) as Partial<LiveInputs> : {};
    return {
      preferences: typeof data.preferences === "string" ? data.preferences.slice(0, 240) : "",
      budgetRlusd: typeof data.budgetRlusd === "string" ? data.budgetRlusd.slice(0, 12) : "",
    };
  } catch {
    return { preferences: "", budgetRlusd: "" };
  }
}

export function writeLiveInputs(inputs: LiveInputs) {
  localStorage.setItem(LIVE_INPUTS_KEY, JSON.stringify({
    preferences: inputs.preferences.slice(0, 240),
    budgetRlusd: inputs.budgetRlusd.slice(0, 12),
  }));
}

const RUNS_KEY = "swanavi.live-runs";
const INPUTS_KEY = "swanavi.live-inputs-by-trip";

export type TripIdentity = {
  city: { title: string };
  startDate: string;
  endDate: string;
  travelers: number;
};

export type RunIdentity = {
  destination: string;
  start_date: string;
  end_date: string;
  travelers: number;
};

export function tripRunKey(trip: TripIdentity): string {
  return [trip.city.title.trim().toLowerCase(), trip.startDate, trip.endDate, String(trip.travelers)].join("\u001f");
}

export function sameTripIdentity(run: RunIdentity, trip: TripIdentity): boolean {
  return run.destination.trim().toLowerCase() === trip.city.title.trim().toLowerCase()
    && run.start_date === trip.startDate
    && run.end_date === trip.endDate
    && run.travelers === trip.travelers;
}

function readMap(storage: Storage, key: string): Record<string, string> {
  try {
    const data = JSON.parse(storage.getItem(key) || "{}") as Record<string, unknown>;
    const out: Record<string, string> = {};
    for (const [name, value] of Object.entries(data)) {
      if (typeof value === "string") out[name] = value;
    }
    return out;
  } catch {
    return {};
  }
}

export function readRunId(key: string): string {
  const id = readMap(sessionStorage, RUNS_KEY)[key] || "";
  return /^run_[a-f0-9]{16}$/.test(id) ? id : "";
}

export function writeRunId(key: string, runId: string) {
  const map = readMap(sessionStorage, RUNS_KEY);
  map[key] = runId;
  sessionStorage.setItem(RUNS_KEY, JSON.stringify(map));
}

export function forgetRun(key: string) {
  const map = readMap(sessionStorage, RUNS_KEY);
  delete map[key];
  sessionStorage.setItem(RUNS_KEY, JSON.stringify(map));
}

export function readTripInputs(key: string): LiveInputs {
  try {
    const data = JSON.parse(localStorage.getItem(INPUTS_KEY) || "{}") as Record<string, Partial<LiveInputs>>;
    const item = data[key] || {};
    return {
      preferences: typeof item.preferences === "string" ? item.preferences.slice(0, 240) : "",
      budgetRlusd: typeof item.budgetRlusd === "string" ? item.budgetRlusd.slice(0, 12) : "",
    };
  } catch {
    return { preferences: "", budgetRlusd: "" };
  }
}

export function writeTripInputs(key: string, inputs: LiveInputs) {
  let data: Record<string, LiveInputs> = {};
  try {
    data = JSON.parse(localStorage.getItem(INPUTS_KEY) || "{}") as Record<string, LiveInputs>;
  } catch {
    data = {};
  }
  data[key] = {
    preferences: inputs.preferences.slice(0, 240),
    budgetRlusd: inputs.budgetRlusd.slice(0, 12),
  };
  localStorage.setItem(INPUTS_KEY, JSON.stringify(data));
}

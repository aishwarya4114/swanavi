import { formatDay, inclusiveDays, shiftIso } from "@/lib/civil";

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

export type PlanLeg = {
  mode: "walk" | "transit";
  minutes: number;
  meters: number | null;
};

export type StopRole = "airport" | "hotel" | "sight";

export type PlanStop = {
  time: string;
  title: string;
  detail: string;
  lat?: number;
  lng?: number;
  role?: StopRole;
};

export type PlanBlock = { kind: "stop"; stop: PlanStop } | { kind: "leg"; leg: PlanLeg };

export type PlanDay = {
  date: string;
  weekday: string;
  label: string;
  blocks: PlanBlock[];
};

export type SightInput = {
  title: string;
  category: string;
  lat: number;
  lng: number;
};

export type PlanInput = {
  startDate: string;
  endDate: string;
  arrivalTime: string;
  departureTime: string;
  arrivalAirport: string;
  departureAirport: string;
  arrivalPoint?: { lat: number; lng: number } | null;
  departurePoint?: { lat: number; lng: number } | null;
  hotel: { title: string; lat: number; lng: number };
  sights: SightInput[];
};

function minutesOf(value: string): number {
  const [hour, minute] = value.split(":").map(Number);
  return hour * 60 + minute;
}

function clockOf(minutes: number): string {
  const wrapped = ((minutes % 1440) + 1440) % 1440;
  const hour24 = Math.floor(wrapped / 60);
  const minute = wrapped % 60;
  const period = hour24 >= 12 ? "PM" : "AM";
  const hour = hour24 % 12 === 0 ? 12 : hour24 % 12;
  return `${hour}:${String(minute).padStart(2, "0")} ${period}`;
}

function durationLabel(minutes: number): string {
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  if (hours <= 0) return `${mins} min`;
  if (mins === 0) return hours === 1 ? "1 hr" : `${hours} hr`;
  return `${hours} hr ${mins} min`;
}

export function formatLeg(leg: PlanLeg): string {
  const distance = leg.meters == null ? "" : leg.meters < 950 ? ` · ${Math.max(50, Math.round(leg.meters / 10) * 10)} m` : ` · ${(leg.meters / 1000).toFixed(leg.meters < 10000 ? 1 : 0)} km`;
  return `${durationLabel(leg.minutes)}${distance} · ${leg.mode === "walk" ? "walk" : "transit"}`;
}

function metersBetween(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 6371000 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(Math.max(0, 1 - a)));
}

function travel(from: { lat: number; lng: number }, to: { lat: number; lng: number }): PlanLeg {
  const meters = Math.round(metersBetween(from.lat, from.lng, to.lat, to.lng) * 1.25);
  if (meters <= 1300) return { mode: "walk", minutes: Math.max(5, Math.round(meters / 75)), meters };
  return { mode: "transit", minutes: Math.max(12, Math.round(8 + meters / 280)), meters };
}

function visitMinutes(category: string): number {
  const value = category.toLowerCase();
  if (value.includes("museum")) return 150;
  if (value.includes("park") || value.includes("garden")) return 90;
  if (value.includes("bridge") || value.includes("observation") || value.includes("viewpoint")) return 70;
  if (value.includes("plaza") || value.includes("square")) return 60;
  return 90;
}

function stayLabel(minutes: number, category: string): string {
  return category ? `${category} · ${durationLabel(minutes)}` : durationLabel(minutes);
}

type DaySlot = {
  date: string;
  start: number;
  end: number;
  first: boolean;
  last: boolean;
  sights: SightInput[];
};

function daySlots(input: PlanInput): DaySlot[] {
  const count = inclusiveDays(input.startDate, input.endDate);
  const dates = Array.from({ length: count }, (_, index) => shiftIso(input.startDate, index));
  const arrival = minutesOf(input.arrivalTime);
  const departure = minutesOf(input.departureTime);
  return dates.map((date, index) => {
    const first = index === 0;
    const last = index === dates.length - 1;
    let start = 9 * 60;
    let end = 21 * 60;
    if (first) start = Math.max(start, arrival + 75);
    if (last) end = Math.min(end, departure - 150);
    return { date, start, end, first, last, sights: [] };
  });
}

function orderSights(hotel: PlanInput["hotel"], sights: SightInput[]): SightInput[] {
  const pending = [...sights];
  const ordered: SightInput[] = [];
  let current = { lat: hotel.lat, lng: hotel.lng };
  while (pending.length > 0) {
    let bestIndex = 0;
    let bestDistance = Number.POSITIVE_INFINITY;
    pending.forEach((sight, index) => {
      const distance = metersBetween(current.lat, current.lng, sight.lat, sight.lng);
      if (distance < bestDistance) {
        bestDistance = distance;
        bestIndex = index;
      }
    });
    const next = pending.splice(bestIndex, 1)[0];
    ordered.push(next);
    current = next;
  }
  return ordered;
}

function pack(days: DaySlot[], sights: SightInput[], hotel: { lat: number; lng: number }) {
  const open = days.filter((day) => day.end - day.start >= 90);
  let cursor = 0;
  open.forEach((day, index) => {
    const later = open.length - index - 1;
    let clock = day.start;
    let position = { lat: hotel.lat, lng: hotel.lng };
    let hadLunch = false;
    const chosen: SightInput[] = [];
    while (cursor < sights.length) {
      const untouched = sights.slice(cursor).reduce((sum, sight) => sum + visitMinutes(sight.category), 0);
      const nextSight = sights[cursor];
      if (later > 0 && untouched - visitMinutes(nextSight.category) < later * 270) break;
      let next = clock;
      if (!hadLunch && !day.last && next >= 12 * 60 + 15 && next <= 15 * 60 && day.end - next >= 90) {
        next += 83;
        hadLunch = true;
      }
      const leg = travel(position, nextSight);
      if (next + leg.minutes + 40 > day.end) break;
      const room = Math.max(40, Math.min(visitMinutes(nextSight.category), day.end - next - leg.minutes - 15));
      chosen.push(nextSight);
      clock = next + leg.minutes + room;
      position = nextSight;
      cursor += 1;
    }
    day.sights = chosen;
  });
}

function pushStop(blocks: PlanBlock[], time: number, title: string, detail: string, place?: { lat: number; lng: number; role: StopRole }) {
  blocks.push({
    kind: "stop",
    stop: { time: clockOf(time), title, detail, ...(place ? { lat: place.lat, lng: place.lng, role: place.role } : {}) },
  });
}

function schedule(day: DaySlot, input: PlanInput): PlanBlock[] {
  const blocks: PlanBlock[] = [];
  const hotel = input.hotel;
  const departure = minutesOf(input.departureTime);
  const leave = departure - 150;

  if (day.last && day.end <= day.start) {
    if (leave >= 8 * 60 + 15) pushStop(blocks, leave - 40, "Breakfast", "At the hotel, then head out");
    blocks.push({ kind: "leg", leg: { mode: "transit", minutes: 120, meters: null } });
    const airport = input.departurePoint ? { ...input.departurePoint, role: "airport" as const } : undefined;
    pushStop(blocks, leave, `Leave for ${input.departureAirport}`, "About two hours before takeoff", airport);
    pushStop(blocks, departure, `Take off from ${input.departureAirport}`, "", airport);
    return blocks;
  }

  if (day.first) {
    pushStop(blocks, minutesOf(input.arrivalTime), `Land at ${input.arrivalAirport}`, "Then straight to the hotel", input.arrivalPoint ? { ...input.arrivalPoint, role: "airport" } : undefined);
    blocks.push({ kind: "leg", leg: { mode: "transit", minutes: 60, meters: null } });
  } else if (day.start >= 9 * 60) {
    pushStop(blocks, day.start - 45, "Breakfast", "At the hotel");
  }

  let clock = day.start;
  const stay = { lat: hotel.lat, lng: hotel.lng, role: "hotel" as const };
  pushStop(blocks, clock, hotel.title, day.first ? "Drop your bags" : day.sights.length > 0 ? "Head out" : "The morning is open", stay);

  let position: { lat: number; lng: number } = hotel;
  let hadLunch = false;
  let hadDinner = false;
  for (const sight of day.sights) {
    if (!hadLunch && !day.last && clock >= 12 * 60 + 15 && clock <= 15 * 60 && day.end - clock >= 90) {
      blocks.push({ kind: "leg", leg: { mode: "walk", minutes: 8, meters: 400 } });
      clock += 8;
      pushStop(blocks, clock, "Lunch", "Sit-down, near where you are");
      clock += 75;
      hadLunch = true;
    }
    const leg = travel(position, sight);
    if (clock + leg.minutes + 40 > day.end) break;
    blocks.push({ kind: "leg", leg });
    clock += leg.minutes;
    const room = Math.max(40, Math.min(visitMinutes(sight.category), day.end - clock - 15));
    pushStop(blocks, clock, sight.title, stayLabel(room, sight.category), { lat: sight.lat, lng: sight.lng, role: "sight" });
    clock += room;
    position = sight;
  }

  if (!day.last && !hadLunch && clock < 15 * 60 && day.end - clock >= 90) {
    const lunchAt = Math.max(clock, 12 * 60 + 15);
    if (lunchAt - clock >= 30) pushStop(blocks, clock, "Free time", "Nothing else booked nearby");
    blocks.push({ kind: "leg", leg: { mode: "walk", minutes: 8, meters: 400 } });
    clock = lunchAt + 8;
    pushStop(blocks, clock, "Lunch", "Sit-down, near where you are");
    clock += 75;
  }

  if (!day.last && clock < 18 * 60 && day.end - clock >= 120) {
    pushStop(blocks, clock, "Free time", "The afternoon is open");
    clock = 18 * 60 + 30;
  }

  if (!day.last && clock >= 17 * 60 && day.end - clock >= 80) {
    blocks.push({ kind: "leg", leg: { mode: "walk", minutes: 8, meters: 400 } });
    clock += 8;
    pushStop(blocks, clock, "Dinner", "Sit-down, near the last stop");
    clock += 90;
    hadDinner = true;
  }

  if (!day.last && day.sights.length > 0) {
    const back = travel(position, hotel);
    blocks.push({ kind: "leg", leg: back });
    clock += back.minutes;
    const home = hadDinner ? "Back for the night" : "Dinner at the hotel";
    pushStop(blocks, clock, hotel.title, home, stay);
  }

  if (day.last) {
    blocks.push({ kind: "leg", leg: { mode: "transit", minutes: Math.max(40, departure - Math.max(clock, leave)), meters: null } });
    const fly = input.departurePoint ? { ...input.departurePoint, role: "airport" as const } : undefined;
    pushStop(blocks, Math.max(clock, leave), `Leave for ${input.departureAirport}`, "About two hours before takeoff", fly);
    pushStop(blocks, departure, `Take off from ${input.departureAirport}`, "", fly);
  }

  return blocks;
}

export function buildPlan(input: PlanInput): PlanDay[] {
  const days = daySlots(input);
  pack(days, orderSights(input.hotel, input.sights), input.hotel);
  return days.map((day) => ({
    date: day.date,
    weekday: WEEKDAYS[new Date(Number(day.date.slice(0, 4)), Number(day.date.slice(5, 7)) - 1, Number(day.date.slice(8, 10))).getDay()],
    label: formatDay(day.date, false),
    blocks: schedule(day, input),
  }));
}

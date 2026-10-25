export const MAX_TRIP_DAYS = 16;
export const MIN_TRAVELERS = 1;
export const MAX_TRAVELERS = 8;

const SHORT_MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const FULL_MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

export type Clock = {
  hour: number;
  minute: number;
  period: "AM" | "PM";
};

export type MonthPoint = {
  year: number;
  month: number;
};

export function toIso(year: number, month: number, day: number): string {
  return `${year}-${String(month + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

export function todayIso(now = new Date()): string {
  return toIso(now.getFullYear(), now.getMonth(), now.getDate());
}

export function isIsoDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return false;
  const date = new Date(year, month - 1, day);
  return date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day;
}

export function monthPoint(iso: string): MonthPoint {
  const [year, month] = iso.split("-").map(Number);
  return { year, month: month - 1 };
}

export function shiftMonth(point: MonthPoint, delta: number): MonthPoint {
  const date = new Date(point.year, point.month + delta, 1);
  return { year: date.getFullYear(), month: date.getMonth() };
}

export function shiftIso(iso: string, days: number): string {
  const [year, month, day] = iso.split("-").map(Number);
  const date = new Date(year, month - 1, day + days);
  return toIso(date.getFullYear(), date.getMonth(), date.getDate());
}

export function addMonthsIso(iso: string, months: number): string {
  const [year, month, day] = iso.split("-").map(Number);
  const date = new Date(year, month - 1 + months, day);
  return toIso(date.getFullYear(), date.getMonth(), date.getDate());
}

export function daysApart(start: string, end: string): number {
  const [startYear, startMonth, startDay] = start.split("-").map(Number);
  const [endYear, endMonth, endDay] = end.split("-").map(Number);
  const startUtc = Date.UTC(startYear, startMonth - 1, startDay);
  const endUtc = Date.UTC(endYear, endMonth - 1, endDay);
  return Math.round((endUtc - startUtc) / 86_400_000);
}

export function inclusiveDays(start: string, end: string): number {
  return daysApart(start, end) + 1;
}

export function buildMonth(point: MonthPoint): Array<{ iso: string; day: number } | null> {
  const firstWeekday = new Date(point.year, point.month, 1).getDay();
  const count = new Date(point.year, point.month + 1, 0).getDate();
  const cells: Array<{ iso: string; day: number } | null> = [];
  for (let index = 0; index < firstWeekday; index += 1) cells.push(null);
  for (let day = 1; day <= count; day += 1) {
    cells.push({ iso: toIso(point.year, point.month, day), day });
  }
  while (cells.length % 7 !== 0) cells.push(null);
  return cells;
}

export function fullMonthLabel(point: MonthPoint): string {
  return `${FULL_MONTHS[point.month]} ${point.year}`;
}

function dayNumber(iso: string): number {
  return Number(iso.slice(8, 10));
}

function shortMonth(iso: string): string {
  return SHORT_MONTHS[Number(iso.slice(5, 7)) - 1];
}

function yearNumber(iso: string): number {
  return Number(iso.slice(0, 4));
}

export function formatDay(iso: string, withYear: boolean): string {
  const label = `${shortMonth(iso)} ${dayNumber(iso)}`;
  return withYear ? `${label}, ${yearNumber(iso)}` : label;
}

export function formatRange(start: string, end: string, now = new Date()): string {
  if (start === end) return formatDay(start, yearNumber(start) !== now.getFullYear());
  const sameYear = yearNumber(start) === yearNumber(end);
  const sameMonth = start.slice(0, 7) === end.slice(0, 7);
  const currentYear = sameYear && yearNumber(start) === now.getFullYear();
  if (sameMonth && currentYear) return `${shortMonth(start)} ${dayNumber(start)} – ${dayNumber(end)}`;
  if (sameMonth) return `${shortMonth(start)} ${dayNumber(start)} – ${dayNumber(end)}, ${yearNumber(start)}`;
  if (currentYear) return `${formatDay(start, false)} – ${formatDay(end, false)}`;
  return `${formatDay(start, true)} – ${formatDay(end, true)}`;
}

export function to24(clock: Clock): string {
  const hour = clock.period === "AM" ? clock.hour % 12 : (clock.hour % 12) + 12;
  return `${String(hour).padStart(2, "0")}:${String(clock.minute).padStart(2, "0")}`;
}

export function from24(value: string): Clock {
  const [hourText, minuteText] = value.split(":");
  const hour24 = Number(hourText);
  const minute = Number(minuteText);
  return {
    hour: hour24 % 12 === 0 ? 12 : hour24 % 12,
    minute,
    period: hour24 >= 12 ? "PM" : "AM",
  };
}

export function formatClock(clock: Clock): string {
  return `${clock.hour}:${String(clock.minute).padStart(2, "0")} ${clock.period}`;
}

export function clockMinutes(clock: Clock): number {
  const hour = clock.period === "AM" ? clock.hour % 12 : (clock.hour % 12) + 12;
  return hour * 60 + clock.minute;
}

export function isTimeValue(value: string): boolean {
  const match = /^(\d{2}):(\d{2})$/.exec(value);
  if (!match) return false;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  return hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59 && minute % 5 === 0;
}

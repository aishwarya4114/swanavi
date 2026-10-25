const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const DAY_HEAD = /^(?:day\s+\d+|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b[:\-\s,]*/i;

type PlanStop = { time: string; title: string; detail: string; lat?: number; lng?: number; role?: "sight" };
type PlanDay = {
  date: string;
  weekday: string;
  label: string;
  blocks: Array<{ kind: "stop"; stop: PlanStop }>;
};

function shiftIso(iso: string, days: number): string {
  const [year, month, day] = iso.split("-").map(Number);
  const date = new Date(year, month - 1, day + days);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function dayLabel(iso: string): string {
  const [, month, day] = iso.split("-").map(Number);
  return `${MONTHS[month - 1]} ${day}`;
}

function weekday(iso: string): string {
  const [year, month, day] = iso.split("-").map(Number);
  return WEEKDAYS[new Date(year, month - 1, day).getDay()] ?? "";
}

function plain(line: string): string {
  return line.replace(/\*\*/g, "").replace(/^\s*[-*•]\s+/, "").replace(/\s+/g, " ").trim();
}

function cleanItem(line: string): string {
  return plain(line).replace(/^\d+[.)]\s+/, "").trim();
}

function linesOf(text: string): string[] {
  const trimmed = text.trim();
  if (!trimmed) return [];
  if (trimmed.includes("\n")) return trimmed.split(/\n/).map((line) => line.trim()).filter(Boolean);
  return trimmed.split(/(?=(?:Day\s+\d+|\d+\.\s))/).map((line) => line.trim()).filter(Boolean);
}

export function daysFromItinerary(text: string, startDate: string): PlanDay[] {
  const groups: Array<{ items: string[] }> = [];
  const before: string[] = [];
  let current: { items: string[] } | null = null;
  let sawDay = false;
  for (const line of linesOf(text)) {
    const text = plain(line);
    if (DAY_HEAD.test(text) && text.length < 60) {
      sawDay = true;
      current = { items: [] };
      groups.push(current);
      const rest = cleanItem(text.replace(DAY_HEAD, ""));
      if (rest) current.items.push(rest);
      continue;
    }
    const item = cleanItem(text);
    if (!item) continue;
    if (!current) before.push(item.slice(0, 180));
    else current.items.push(item.slice(0, 180));
  }
  if (!sawDay && before.length > 0) groups.push({ items: before });
  return groups.filter((group) => group.items.length > 0).slice(0, 12).map((group, index) => {
    const date = shiftIso(startDate, index);
    return {
      date,
      weekday: weekday(date),
      label: dayLabel(date),
      blocks: group.items.slice(0, 8).map((item) => ({
        kind: "stop" as const,
        stop: { time: "", title: item, detail: "" },
      })),
    };
  });
}

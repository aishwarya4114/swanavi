"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, useSyncExternalStore, type FormEvent, type KeyboardEvent, type PointerEvent } from "react";
import {
  MAX_TRAVELERS,
  MAX_TRIP_DAYS,
  MIN_TRAVELERS,
  addMonthsIso,
  buildMonth,
  clockMinutes,
  formatClock,
  formatDay,
  formatRange,
  from24,
  fullMonthLabel,
  inclusiveDays,
  isIsoDate,
  monthPoint,
  shiftIso,
  shiftMonth,
  todayIso,
  to24,
  type Clock,
  type MonthPoint,
} from "@/lib/civil";
import { localityLine, placeLine, placesErrorCopy, requestPlaces, type Suggestion } from "@/lib/places";
import { getTripRawServerSnapshot, parseStoredTrip, readTripRaw, subscribeTrip, writeStoredTrip, type CitySelection, type StoredTrip } from "@/lib/trip";

function subscribeNothing() {
  return () => {};
}

type Panel = "dates" | "arrival-time" | "departure-time" | "arrival-search" | "departure-airports" | null;
type TimeDraft = { hour: number | null; minute: number | null; period: "AM" | "PM" };
type AirportStatus = "idle" | "loading" | "ready" | "empty" | "error";

const HOURS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];
const MINUTES = [0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55];
const WEEKDAYS = [
  { id: "sun", label: "S" },
  { id: "mon", label: "M" },
  { id: "tue", label: "T" },
  { id: "wed", label: "W" },
  { id: "thu", label: "T" },
  { id: "fri", label: "F" },
  { id: "sat", label: "S" },
];

function newSessionToken(): string {
  const bytes = new Uint8Array(27);
  crypto.getRandomValues(bytes);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function withSelected(options: Suggestion[], selected: Suggestion | null): Suggestion[] {
  if (!selected || options.some((option) => option.placeId === selected.placeId)) return options;
  return [selected, ...options].slice(0, 5);
}

function Chevron({ direction = "down" }: { direction?: "down" | "up" | "left" | "right" }) {
  return (
    <svg className={`chevron ${direction}`} width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
      <path d="M2.5 4.5 L6 8 L9.5 4.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function Check() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
      <path d="M3.5 8.4 L6.4 11.3 L12.6 4.8" fill="none" stroke="#007aff" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function ClearIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
      <circle cx="8" cy="8" r="7" fill="#c7c7cc" />
      <path d="M5.6 5.6 L10.4 10.4 M10.4 5.6 L5.6 10.4" stroke="#fff" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}

function SkeletonRows() {
  return (
    <div className="skeletons" aria-hidden="true">
      <span />
      <span className="sub" />
      <span />
      <span className="sub" />
    </div>
  );
}

function SuggestionList({
  items,
  highlight,
  onHighlight,
  onSelect,
  empty,
  error,
  loading,
  id,
}: {
  items: Suggestion[];
  highlight: number;
  onHighlight: (index: number) => void;
  onSelect: (place: Suggestion) => void;
  empty: string;
  error: string | null;
  loading: boolean;
  id: string;
}) {
  if (loading && items.length === 0) return <p className="empty">Searching</p>;
  if (error) return <p className="empty">{error}</p>;
  if (!loading && items.length === 0) return <p className="empty">{empty}</p>;
  return (
    <div className="list" id={id} role="listbox">
      {items.map((item, index) => (
        <button
          type="button"
          role="option"
          id={`${id}-${item.placeId}`}
          aria-selected={index === highlight}
          className="row"
          key={item.placeId}
          onMouseEnter={() => onHighlight(index)}
          onPointerDown={(event) => event.preventDefault()}
          onClick={() => onSelect(item)}
        >
          <span className="primary">{item.title}</span>
          {item.subtitle ? <span className="secondary">{placeLine(item.subtitle)}</span> : null}
        </button>
      ))}
      <p className="attrib">Powered by Google</p>
    </div>
  );
}

function AirportQuery({ lat, lng, onSelect }: { lat: number | null; lng: number | null; onSelect: (airport: Suggestion) => void }) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<Suggestion[]>([]);
  const [status, setStatus] = useState<"idle" | "loading" | "empty" | "error">("idle");
  const [error, setError] = useState<string | null>(null);
  const [highlight, setHighlight] = useState(0);
  const session = useRef("");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    const trimmed = query.trim();
    if (trimmed.length < 2) return;
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      void (async () => {
        try {
          if (!session.current) session.current = newSessionToken();
          const data = await requestPlaces<{ suggestions: Suggestion[] }>(
            { intent: "airportSuggest", input: trimmed, sessionToken: session.current, lat, lng },
            controller.signal,
          );
          setResults(data.suggestions);
          setHighlight(0);
          setError(null);
          setStatus(data.suggestions.length ? "idle" : "empty");
        } catch (caught) {
          if (controller.signal.aborted) return;
          setResults([]);
          setStatus("error");
          setError(placesErrorCopy(caught));
        }
      })();
    }, 180);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [query, lat, lng]);

  return (
    <div>
      <div className="field">
        <input
          ref={inputRef}
          value={query}
          placeholder="Airport name"
          aria-label="Search airports"
          autoComplete="off"
          autoCorrect="off"
          spellCheck={false}
          onChange={(event) => {
            const value = event.target.value;
            setQuery(value);
            setError(null);
            if (value.trim().length < 2) {
              setResults([]);
              setStatus("idle");
            } else setStatus("loading");
          }}
          onKeyDown={(event) => {
            if (event.key === "ArrowDown") {
              event.preventDefault();
              setHighlight((index) => Math.min(index + 1, Math.max(results.length - 1, 0)));
            } else if (event.key === "ArrowUp") {
              event.preventDefault();
              setHighlight((index) => Math.max(index - 1, 0));
            } else if (event.key === "Enter") {
              event.preventDefault();
              if (results[highlight]) onSelect(results[highlight]);
            }
          }}
        />
      </div>
      {query.trim().length >= 2 ? (
        <SuggestionList
          id="airport-results"
          items={results}
          highlight={highlight}
          onHighlight={setHighlight}
          onSelect={onSelect}
          empty="No airports found."
          error={error}
          loading={status === "loading"}
        />
      ) : null}
    </div>
  );
}

function AirportChoices({ options, selectedId, onSelect, label }: { options: Suggestion[]; selectedId: string | null; onSelect: (airport: Suggestion) => void; label: string }) {
  if (options.length === 0) return null;
  return (
    <div className="choices" role="listbox" aria-label={label}>
      {options.map((airport) => {
        const selected = airport.placeId === selectedId;
        return (
          <button type="button" className="choice" aria-pressed={selected} key={airport.placeId} onClick={() => onSelect(airport)}>
            <span className="choice-copy">
              <span>{airport.title}</span>
              {airport.subtitle ? <span className="secondary">{localityLine(airport.subtitle)}</span> : null}
            </span>
            <span className="check">{selected ? <Check /> : null}</span>
          </button>
        );
      })}
      <p className="attrib">Powered by Google</p>
    </div>
  );
}

function TimePicker({ draft, onChange }: { draft: TimeDraft; onChange: (patch: Partial<TimeDraft>) => void }) {
  return (
    <div className="time">
      <div className="segment" role="group" aria-label="Morning or evening">
        {(["AM", "PM"] as const).map((period) => (
          <button type="button" key={period} aria-pressed={draft.period === period} onClick={() => onChange({ period })}>
            {period}
          </button>
        ))}
      </div>
      <div>
        <p className="tick-label">Hour</p>
        <div className="ticks" role="group" aria-label="Hour">
          {HOURS.map((hour) => (
            <button type="button" className="tick" key={hour} aria-pressed={draft.hour === hour} onClick={() => onChange({ hour })}>
              {hour}
            </button>
          ))}
        </div>
      </div>
      <div>
        <p className="tick-label">Minute</p>
        <div className="ticks" role="group" aria-label="Minute">
          {MINUTES.map((minute) => (
            <button type="button" className="tick" key={minute} aria-pressed={draft.minute === minute} onClick={() => onChange({ minute })}>
              {String(minute).padStart(2, "0")}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

function Calendar({
  month,
  today,
  start,
  end,
  focusIso,
  onMonth,
  onPick,
  onMove,
}: {
  month: MonthPoint;
  today: string;
  start: string | null;
  end: string | null;
  focusIso: string | null;
  onMonth: (month: MonthPoint) => void;
  onPick: (iso: string) => void;
  onMove: (iso: string, delta: number) => void;
}) {
  const cells = buildMonth(month);
  const limit = addMonthsIso(today, 18);
  const maxMonth = monthPoint(limit);
  const currentMonth = monthPoint(today);
  const previousDisabled = month.year < currentMonth.year || (month.year === currentMonth.year && month.month <= currentMonth.month);
  const nextDisabled = month.year > maxMonth.year || (month.year === maxMonth.year && month.month >= maxMonth.month);
  const visibleFocus = cells.some((cell) => cell?.iso === focusIso) ? focusIso : cells.find((cell) => cell && cell.iso >= today && cell.iso <= limit)?.iso;

  return (
    <div className="cal">
      <div className="cal-head">
        <button type="button" className="nav" aria-label="Previous month" disabled={previousDisabled} onClick={() => onMonth(shiftMonth(month, -1))}>
          <Chevron direction="left" />
        </button>
        <div className="cal-title">{fullMonthLabel(month)}</div>
        <button type="button" className="nav" aria-label="Next month" disabled={nextDisabled} onClick={() => onMonth(shiftMonth(month, 1))}>
          <Chevron direction="right" />
        </button>
      </div>
      <div className="week" aria-hidden="true">
        {WEEKDAYS.map((day) => (
          <span key={day.id}>{day.label}</span>
        ))}
      </div>
      <div className="days" role="grid" aria-label="Trip dates">
        {cells.map((cell, index) => {
          if (!cell) return <div className="cell" key={`empty-${month.year}-${month.month}-${index}`} />;
          const disabled = !isIsoDate(cell.iso) || cell.iso < today || cell.iso > limit;
          const isStart = cell.iso === start;
          const isEnd = cell.iso === end;
          const inRange = Boolean(start && end && start !== end && cell.iso >= start && cell.iso <= end);
          const className = ["day", cell.iso === today ? "today" : "", isStart || isEnd ? "edge" : ""].filter(Boolean).join(" ");
          const cellClass = ["cell", inRange ? "in" : "", isStart ? "start" : "", isEnd ? "end" : ""].filter(Boolean).join(" ");
          return (
            <div className={cellClass} key={cell.iso} role="gridcell">
              <button
                type="button"
                id={`day-${cell.iso}`}
                className={className}
                disabled={disabled}
                tabIndex={cell.iso === visibleFocus ? 0 : -1}
                aria-label={formatDay(cell.iso, true)}
                aria-pressed={isStart || isEnd}
                onClick={() => onPick(cell.iso)}
                onKeyDown={(event) => {
                  const delta = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: 7, ArrowUp: -7 }[event.key];
                  if (!delta) return;
                  event.preventDefault();
                  onMove(cell.iso, delta);
                }}
              >
                {cell.day}
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export default function Home() {
  const router = useRouter();
  const [editingCity, setEditingCity] = useState(true);
  const [cityQuery, setCityQuery] = useState("");
  const [citySuggestions, setCitySuggestions] = useState<Suggestion[]>([]);
  const [cityStatus, setCityStatus] = useState<"idle" | "loading" | "empty" | "error">("idle");
  const [cityError, setCityError] = useState<string | null>(null);
  const [highlight, setHighlight] = useState(0);
  const [city, setCity] = useState<CitySelection | null>(null);
  const [startDate, setStartDate] = useState<string | null>(null);
  const [endDate, setEndDate] = useState<string | null>(null);
  const [rangeNote, setRangeNote] = useState<string | null>(null);
  const [calendarMonth, setCalendarMonth] = useState<MonthPoint | null>(null);
  const [today, setToday] = useState<string | null>(null);
  const [focusIso, setFocusIso] = useState<string | null>(null);
  const [airports, setAirports] = useState<Suggestion[]>([]);
  const [airportStatus, setAirportStatus] = useState<AirportStatus>("idle");
  const [airportError, setAirportError] = useState<string | null>(null);
  const [arrivalAirport, setArrivalAirport] = useState<Suggestion | null>(null);
  const [departureAirport, setDepartureAirport] = useState<Suggestion | null>(null);
  const [arrivalTime, setArrivalTime] = useState<Clock | null>(null);
  const [departureTime, setDepartureTime] = useState<Clock | null>(null);
  const [timeDraft, setTimeDraft] = useState<TimeDraft | null>(null);
  const [travelers, setTravelers] = useState(2);
  const [open, setOpen] = useState<Panel>(null);
  const [savedMark, setSavedMark] = useState<string | null>(null);
  const [departureLocked, setDepartureLocked] = useState(false);
  const [seenRaw, setSeenRaw] = useState<string | null | undefined>(undefined);

  const cityInput = useRef<HTMLInputElement>(null);
  const citySession = useRef("");
  const cityRequest = useRef(0);
  const departureTouched = useRef(false);
  const shouldFocusDay = useRef(false);
  const storedRaw = useSyncExternalStore(subscribeTrip, readTripRaw, getTripRawServerSnapshot);
  const isClient = useSyncExternalStore(subscribeNothing, () => true, () => false);

  if (isClient && storedRaw !== seenRaw) {
    setSeenRaw(storedRaw);
    if (seenRaw === undefined && storedRaw) {
      const storedTrip = parseStoredTrip(storedRaw);
      if (storedTrip) {
        setCity(storedTrip.city);
        setStartDate(storedTrip.startDate);
        setEndDate(storedTrip.endDate);
        setArrivalAirport(storedTrip.arrivalAirport);
        setDepartureAirport(storedTrip.departureAirport);
        setArrivalTime(from24(storedTrip.arrivalTime));
        setDepartureTime(from24(storedTrip.departureTime));
        setTravelers(storedTrip.travelers);
        setEditingCity(false);
        setAirportStatus("loading");
        setDepartureLocked(true);
      }
    }
  }

  const fingerprint = JSON.stringify({
    city: city?.placeId ?? null,
    startDate,
    endDate,
    arrival: arrivalAirport?.placeId ?? null,
    departure: departureAirport?.placeId ?? null,
    arrivalTime: arrivalTime ? to24(arrivalTime) : null,
    departureTime: departureTime ? to24(departureTime) : null,
    travelers,
  });
  const saved = savedMark === fingerprint;

  useEffect(() => {
    departureTouched.current = departureLocked;
  }, [departureLocked]);

  useEffect(() => {
    if (!isClient || storedRaw) return;
    if (window.matchMedia("(pointer: fine)").matches) cityInput.current?.focus();
  }, [isClient, storedRaw]);

  useEffect(() => {
    if (!editingCity) return;
    const trimmed = cityQuery.trim();
    if (trimmed.length < 2) return;
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      void (async () => {
        try {
          if (!citySession.current) citySession.current = newSessionToken();
          const data = await requestPlaces<{ suggestions: Suggestion[] }>(
            { intent: "cities", input: trimmed, sessionToken: citySession.current },
            controller.signal,
          );
          setCitySuggestions(data.suggestions);
          setHighlight(0);
          setCityError(null);
          setCityStatus(data.suggestions.length ? "idle" : "empty");
        } catch (error) {
          if (controller.signal.aborted) return;
          setCitySuggestions([]);
          setCityError(placesErrorCopy(error));
          setCityStatus("error");
        }
      })();
    }, 180);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [cityQuery, editingCity]);

  useEffect(() => {
    if (!city || city.lat == null || city.lng == null) return;
    const controller = new AbortController();
    let cancelled = false;
    const { title, subtitle, lat, lng } = city;
    void (async () => {
      try {
        const data = await requestPlaces<{ suggestions: Suggestion[] }>(
          { intent: "airports", query: [title, subtitle].filter(Boolean).join(", "), lat, lng },
          controller.signal,
        );
        if (cancelled) return;
        setAirportError(null);
        setAirports(data.suggestions);
        setAirportStatus(data.suggestions.length ? "ready" : "empty");
        setArrivalAirport((current) => current ?? data.suggestions[0] ?? null);
        setDepartureAirport((current) => (departureTouched.current ? current : (current ?? data.suggestions[0] ?? null)));
      } catch (error) {
        if (cancelled || (error instanceof DOMException && error.name === "AbortError")) return;
        setAirports([]);
        setAirportStatus("error");
        setAirportError(placesErrorCopy(error));
      }
    })();
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [city]);

  useEffect(() => {
    if (!shouldFocusDay.current || open !== "dates" || !focusIso) return;
    shouldFocusDay.current = false;
    document.getElementById(`day-${focusIso}`)?.focus();
  }, [focusIso, calendarMonth, open]);

  const showPlan = Boolean(city && !editingCity);
  const timeOrderInvalid = Boolean(startDate && endDate && startDate === endDate && arrivalTime && departureTime && clockMinutes(departureTime) <= clockMinutes(arrivalTime));
  const canContinue = Boolean(city && city.lat != null && city.lng != null && startDate && endDate && arrivalAirport && departureAirport && arrivalTime && departureTime && !timeOrderInvalid);
  const arrivalChoices = withSelected(airports, arrivalAirport);
  const departureChoices = withSelected(airports, departureAirport);

  function onCityChange(value: string) {
    setCityQuery(value);
    setCityError(null);
    setHighlight(0);
    setCitySuggestions([]);
    setCityStatus(value.trim().length < 2 ? "idle" : "loading");
  }

  async function chooseCity(suggestion: Suggestion) {
    const requestId = ++cityRequest.current;
    const token = citySession.current || newSessionToken();
    citySession.current = "";
    setEditingCity(false);
    setCityQuery("");
    setCitySuggestions([]);
    setCityError(null);
    setOpen(null);
    setAirports([]);
    setArrivalAirport(null);
    setDepartureAirport(null);
    setDepartureLocked(false);
    setAirportStatus("loading");
    setAirportError(null);
    setCity({ ...suggestion, lat: null, lng: null });
    try {
      const details = await requestPlaces<{ lat: number; lng: number }>({ intent: "details", placeId: suggestion.placeId, sessionToken: token });
      if (requestId !== cityRequest.current) return;
      setCity({ ...suggestion, lat: details.lat, lng: details.lng });
    } catch (error) {
      if (requestId !== cityRequest.current) return;
      setCityError(placesErrorCopy(error));
      setAirportStatus("idle");
    }
  }

  function beginEdit() {
    setEditingCity(true);
    setCityQuery(city?.title ?? "");
    setCitySuggestions([]);
    setCityStatus("idle");
    setCityError(null);
    setOpen(null);
    citySession.current = "";
    requestAnimationFrame(() => {
      cityInput.current?.focus();
      cityInput.current?.select();
    });
  }

  function chooseArrival(airport: Suggestion) {
    setArrivalAirport(airport);
    if (!departureTouched.current) setDepartureAirport(airport);
    setOpen(null);
  }

  function chooseDeparture(airport: Suggestion) {
    setDepartureLocked(true);
    setDepartureAirport(airport);
    setOpen(null);
  }

  function toggleDates() {
    if (open === "dates") {
      setOpen(null);
      return;
    }
    const now = todayIso();
    setToday(now);
    setCalendarMonth((current) => current ?? monthPoint(startDate ?? now));
    setFocusIso(endDate ?? startDate ?? now);
    setOpen("dates");
  }

  function pickDay(iso: string) {
    setRangeNote(null);
    if (!startDate || endDate) {
      setStartDate(iso);
      setEndDate(null);
      return;
    }
    if (iso < startDate) {
      setStartDate(iso);
      setEndDate(null);
      return;
    }
    if (iso === startDate) {
      setEndDate(iso);
      setOpen(null);
      return;
    }
    if (inclusiveDays(startDate, iso) > MAX_TRIP_DAYS) {
      setRangeNote("Trips can run up to 16 days.");
      return;
    }
    setEndDate(iso);
    setOpen(null);
  }

  function moveDay(iso: string, delta: number) {
    const now = today ?? todayIso();
    const limit = addMonthsIso(now, 18);
    let next = shiftIso(iso, delta);
    if (next < now) next = now;
    if (next > limit) next = limit;
    shouldFocusDay.current = true;
    setCalendarMonth(monthPoint(next));
    setFocusIso(next);
  }

  function toggleTime(which: "arrival" | "departure") {
    const panel: Panel = which === "arrival" ? "arrival-time" : "departure-time";
    if (open === panel) {
      setOpen(null);
      return;
    }
    const current = which === "arrival" ? arrivalTime : departureTime;
    setTimeDraft(current ?? { hour: null, minute: null, period: which === "arrival" ? "PM" : "AM" });
    setOpen(panel);
  }

  function updateDraft(patch: Partial<TimeDraft>) {
    const base = timeDraft ?? { hour: null, minute: null, period: open === "departure-time" ? "AM" : "PM" };
    const next = { ...base, ...patch };
    setTimeDraft(next);
    if (next.hour == null || next.minute == null) return;
    const clock: Clock = { hour: next.hour, minute: next.minute, period: next.period };
    if (open === "arrival-time") setArrivalTime(clock);
    if (open === "departure-time") setDepartureTime(clock);
  }

  function onFormPointerDown(event: PointerEvent<HTMLFormElement>) {
    const target = event.target as HTMLElement;
    if (target.closest("[data-keepopen], [data-submit]")) return;
    if (open) setOpen(null);
    setCitySuggestions((current) => (current.length === 0 ? current : []));
    if (city && editingCity) setEditingCity(false);
  }

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canContinue || !city || city.lat == null || city.lng == null || !startDate || !endDate || !arrivalAirport || !departureAirport || !arrivalTime || !departureTime) return;
    const existing = parseStoredTrip(readTripRaw());
    const trip: StoredTrip = {
      version: 1,
      city,
      startDate,
      endDate,
      arrivalAirport,
      departureAirport,
      arrivalTime: to24(arrivalTime),
      departureTime: to24(departureTime),
      travelers,
      ...(existing?.city.placeId === city.placeId && existing.attractions ? { attractions: existing.attractions } : {}),
      ...(existing?.city.placeId === city.placeId && existing.hotel ? { hotel: existing.hotel } : {}),
    };
    writeStoredTrip(trip);
    setSavedMark(fingerprint);
    setOpen(null);
    router.push("/attractions");
  }

  const dateLabel = !startDate ? "Add dates" : !endDate ? `${formatDay(startDate, false)} –` : startDate === endDate ? formatDay(startDate, new Date().getFullYear() !== Number(startDate.slice(0, 4))) : formatRange(startDate, endDate);
  const cityListOpen = editingCity && cityQuery.trim().length >= 2 && (cityStatus === "loading" || cityStatus === "empty" || cityStatus === "error" || citySuggestions.length > 0);

  return (
    <main className="stage">
      <form className="sheet" onSubmit={onSubmit} onPointerDown={onFormPointerDown} autoComplete="off">
        <p className="mark">Swanavi</p>
        <div className="title-row">
          <div>
            <h1 className="title">{showPlan && city ? city.title : "Where to?"}</h1>
            {showPlan && city?.subtitle ? <p className="region">{placeLine(city.subtitle)}</p> : null}
          </div>
          {showPlan ? (
            <button type="button" className="change" onClick={beginEdit}>
              Change
            </button>
          ) : null}
        </div>
        {cityError && city && city.lat == null && !editingCity ? <p className="note">{cityError}</p> : null}

        {editingCity ? (
          <div className="search" data-keepopen="" data-panel="city">
            <div className="field">
              <input
                ref={cityInput}
                value={cityQuery}
                placeholder="City"
                aria-label="City"
                role="combobox"
                aria-autocomplete="list"
                aria-expanded={cityListOpen}
                aria-controls="city-results"
                aria-activedescendant={citySuggestions[highlight] ? `city-results-${citySuggestions[highlight].placeId}` : undefined}
                autoComplete="off"
                autoCorrect="off"
                autoCapitalize="words"
                spellCheck={false}
                onChange={(event) => onCityChange(event.target.value)}
                onKeyDown={(event: KeyboardEvent<HTMLInputElement>) => {
                  if (event.key === "ArrowDown") {
                    event.preventDefault();
                    setHighlight((index) => Math.min(index + 1, Math.max(citySuggestions.length - 1, 0)));
                  } else if (event.key === "ArrowUp") {
                    event.preventDefault();
                    setHighlight((index) => Math.max(index - 1, 0));
                  } else if (event.key === "Enter") {
                    event.preventDefault();
                    if (citySuggestions[highlight]) void chooseCity(citySuggestions[highlight]);
                  } else if (event.key === "Escape") {
                    event.preventDefault();
                    if (city) {
                      setEditingCity(false);
                      setCitySuggestions([]);
                    } else onCityChange("");
                  }
                }}
              />
              {cityQuery ? (
                <button type="button" className="clear" aria-label="Clear city" onClick={() => onCityChange("")}>
                  <ClearIcon />
                </button>
              ) : null}
            </div>
            {cityListOpen ? (
              <SuggestionList
                id="city-results"
                items={citySuggestions}
                highlight={highlight}
                onHighlight={setHighlight}
                onSelect={(place) => void chooseCity(place)}
                empty="No cities found."
                error={cityStatus === "error" ? cityError : null}
                loading={cityStatus === "loading"}
              />
            ) : null}
          </div>
        ) : null}

        <div className={`rest${showPlan ? " show" : ""}`}>
          <div className="rest-inner" inert={showPlan ? undefined : true}>
            <div className="block" data-keepopen={open === "dates" ? "" : undefined}>
              <div className="label-row">
                <span className="label" id="dates-label">Dates</span>
              </div>
              <button type="button" className={startDate ? "field field-button" : "field field-button placeholder"} aria-label={startDate ? `Dates, ${dateLabel}` : "Add dates"} aria-expanded={open === "dates"} onClick={toggleDates}>
                <span className="field-text">{dateLabel}</span>
                <span className="chevron-slot">
                  <Chevron direction={open === "dates" ? "up" : "down"} />
                </span>
              </button>
              {open === "dates" && calendarMonth && today ? (
                <Calendar month={calendarMonth} today={today} start={startDate} end={endDate} focusIso={focusIso} onMonth={setCalendarMonth} onPick={pickDay} onMove={moveDay} />
              ) : null}
              {rangeNote ? <p className="note">{rangeNote}</p> : null}
            </div>

            <div className="block" data-keepopen={open === "arrival-time" || open === "arrival-search" ? "" : undefined}>
              <div className="label-row">
                <span className="label">Land</span>
                <span className="hint">Local time</span>
              </div>
              <div className="stack">
                {airportStatus === "loading" && arrivalChoices.length === 0 ? <SkeletonRows /> : null}
                {airportStatus === "error" ? <p className="empty">{airportError}</p> : null}
                {airportStatus === "empty" ? <p className="empty">No airports found. Search by name.</p> : null}
                <AirportChoices options={arrivalChoices} selectedId={arrivalAirport?.placeId ?? null} onSelect={chooseArrival} label="Arrival airports" />
                {open === "arrival-search" ? (
                  <AirportQuery lat={city?.lat ?? null} lng={city?.lng ?? null} onSelect={chooseArrival} />
                ) : airportStatus === "loading" && arrivalChoices.length === 0 ? null : (
                  <button type="button" className="text-button" onClick={() => setOpen("arrival-search")}>
                    Other airport
                  </button>
                )}
                <button type="button" className={arrivalTime ? "field field-button" : "field field-button placeholder"} aria-expanded={open === "arrival-time"} onClick={() => toggleTime("arrival")}>
                  <span className="field-text">{arrivalTime ? formatClock(arrivalTime) : "Add time"}</span>
                  <span className="chevron-slot">
                    <Chevron direction={open === "arrival-time" ? "up" : "down"} />
                  </span>
                </button>
                {open === "arrival-time" && timeDraft ? <TimePicker draft={timeDraft} onChange={updateDraft} /> : null}
              </div>
            </div>

            <div className="block" data-keepopen={open === "departure-time" || open === "departure-airports" ? "" : undefined}>
              <div className="label-row">
                <span className="label">Take off</span>
                <span className="hint">Local time</span>
              </div>
              <div className="stack">
                <button
                  type="button"
                  className={departureAirport ? "field field-button" : "field field-button placeholder"}
                  aria-expanded={open === "departure-airports"}
                  onClick={() => setOpen(open === "departure-airports" ? null : "departure-airports")}
                >
                  <span className="field-text">{departureAirport?.title ?? "Airport"}</span>
                  <span className="chevron-slot">
                    <Chevron direction={open === "departure-airports" ? "up" : "down"} />
                  </span>
                </button>
                {open === "departure-airports" ? (
                  <>
                    <AirportChoices options={departureChoices} selectedId={departureAirport?.placeId ?? null} onSelect={chooseDeparture} label="Departure airports" />
                    <AirportQuery lat={city?.lat ?? null} lng={city?.lng ?? null} onSelect={chooseDeparture} />
                  </>
                ) : null}
                <button type="button" className={departureTime ? "field field-button" : "field field-button placeholder"} aria-expanded={open === "departure-time"} onClick={() => toggleTime("departure")}>
                  <span className="field-text">{departureTime ? formatClock(departureTime) : "Add time"}</span>
                  <span className="chevron-slot">
                    <Chevron direction={open === "departure-time" ? "up" : "down"} />
                  </span>
                </button>
                {open === "departure-time" && timeDraft ? <TimePicker draft={timeDraft} onChange={updateDraft} /> : null}
                {timeOrderInvalid ? <p className="note">Takeoff has to be after you land.</p> : null}
              </div>
            </div>

            <div className="travelers">
              <p>{travelers === 1 ? "Traveler" : "Travelers"}</p>
              <div className="steps">
                <button type="button" className="step" aria-label="Fewer travelers" disabled={travelers <= MIN_TRAVELERS} onClick={() => setTravelers((count) => Math.max(MIN_TRAVELERS, count - 1))}>
                  −
                </button>
                <span className="count" aria-live="polite">
                  {travelers}
                </span>
                <button type="button" className="step" aria-label="More travelers" disabled={travelers >= MAX_TRAVELERS} onClick={() => setTravelers((count) => Math.min(MAX_TRAVELERS, count + 1))}>
                  +
                </button>
              </div>
            </div>

            <button type="submit" data-submit="" className="continue" disabled={!canContinue}>
              Continue
            </button>
            <p className="saved" aria-live="polite">
              {saved ? "Saved on this device." : ""}
            </p>
          </div>
        </div>
      </form>
    </main>
  );
}

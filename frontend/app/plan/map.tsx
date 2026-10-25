"use client";

import { useEffect, useRef } from "react";
import type { Map as MapboxMap, Marker } from "mapbox-gl";
import "mapbox-gl/dist/mapbox-gl.css";
import type { PlanDay, StopRole } from "@/lib/plan";

export const DAY_COLORS = ["#1d1d1f", "#007aff", "#5856d6", "#ff9f0a", "#248a3d", "#ff375f", "#5ac8fa", "#ac8e68"];

type Padding = { top: number; right: number; bottom: number; left: number };
type Mapbox = typeof import("mapbox-gl").default;

type Pin = {
  title: string;
  lat: number;
  lng: number;
  role: StopRole;
  day: number;
  number?: number;
};

type Box = { x: number; y: number; w: number; h: number };

function overlaps(a: Box, b: Box) {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

function model(days: PlanDay[], focus: number | null) {
  const pins: Pin[] = [];
  const seen = new Set<string>();
  const routes: Array<Array<[number, number]>> = days.map(() => []);
  let count = 0;
  days.forEach((day, dayIndex) => {
    if (focus != null && dayIndex !== focus) return;
    const line: Array<[number, number]> = [];
    for (const block of day.blocks) {
      if (block.kind !== "stop" || block.stop.lat == null || block.stop.lng == null || !block.stop.role) continue;
      line.push([block.stop.lng, block.stop.lat]);
      const key = `${block.stop.role}:${block.stop.lat.toFixed(4)}:${block.stop.lng.toFixed(4)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      pins.push({
        title: block.stop.title,
        lat: block.stop.lat,
        lng: block.stop.lng,
        role: block.stop.role,
        day: dayIndex,
        number: block.stop.role === "sight" ? ++count : undefined,
      });
    }
    routes[dayIndex] = line.filter((point, index) => index === 0 || point[0] !== line[index - 1][0] || point[1] !== line[index - 1][1]);
  });
  const hotel = pins.find((pin) => pin.role === "hotel");
  const last = focus == null ? routes[routes.length - 1] : routes[focus];
  if (hotel && last && last.length > 0 && (last[0][0] !== hotel.lng || last[0][1] !== hotel.lat)) last.unshift([hotel.lng, hotel.lat]);
  return { pins, routes };
}

const PITCH = 64;
const BEARING = -28;
const BUILDING_ZOOM = 15.7;

function pinButton(pin: Pin) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = `map-pin ${pin.role} label-n`;
  button.style.setProperty("--pin", DAY_COLORS[pin.day % DAY_COLORS.length]);
  const pill = document.createElement("span");
  pill.className = "map-pin-pill";
  const mark = document.createElement("span");
  mark.className = "map-pin-mark";
  mark.textContent = pin.role === "sight" ? String(pin.number ?? "") : pin.role === "hotel" ? "H" : "✈";
  const name = document.createElement("span");
  name.className = "map-pin-name";
  name.textContent = pin.title.replace(/^(Land at |Take off from |Leave for )/, "");
  pill.append(mark, name);
  button.append(pill);
  return button;
}

function layoutPins(map: MapboxMap, markers: Marker[]) {
  const boxes: Box[] = [];
  const directions = [
    { cls: "label-n", ox: (w: number) => -w / 2, oy: () => -58 },
    { cls: "label-e", ox: () => 22, oy: (h: number) => -h / 2 },
    { cls: "label-w", ox: (w: number) => -w - 22, oy: (h: number) => -h / 2 },
    { cls: "label-s", ox: (w: number) => -w / 2, oy: () => 18 },
  ];
  for (const marker of markers) {
    marker.setOffset([0, 0]);
    const point = map.project(marker.getLngLat());
    const button = marker.getElement();
    const text = button.querySelector(".map-pin-name")?.textContent ?? "";
    const w = Math.min(188, Math.max(108, 46 + text.length * 6.6));
    const h = 36;
    let pick = { cls: "label-n", x: point.x - w / 2, y: point.y - 58 };
    for (let ring = 0; ring < 4; ring += 1) {
      const found = directions
        .map((direction) => {
          const spread = ring * 42;
          const x = point.x + direction.ox(w) + (direction.cls === "label-e" ? spread : direction.cls === "label-w" ? -spread : 0);
          const y = point.y + direction.oy(h) + (direction.cls === "label-n" ? -spread : direction.cls === "label-s" ? spread : 0);
          return { cls: direction.cls, x, y };
        })
        .find((choice) => boxes.every((box) => !overlaps(box, { x: choice.x, y: choice.y, w, h })));
      if (found) {
        pick = found;
        break;
      }
    }
    boxes.push({ x: pick.x, y: pick.y, w, h });
    button.classList.remove("label-n", "label-e", "label-w", "label-s");
    button.classList.add(pick.cls);
  }
}

function lineWidth(active: boolean, near: number, far: number): ["interpolate", ["linear"], ["zoom"], number, number, number, number] {
  return ["interpolate", ["linear"], ["zoom"], 12, active ? near : near * 0.55, 16.5, active ? far : far * 0.5];
}

export function TripMap({
  days,
  focus,
  padding,
  onSelect,
  home,
}: {
  days: PlanDay[];
  focus: number | null;
  padding: Padding;
  onSelect: (day: number | null) => void;
  home: { lat: number; lng: number } | null;
}) {
  const holder = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MapboxMap | null>(null);
  const libRef = useRef<Mapbox | null>(null);
  const markers = useRef<Marker[]>([]);
  const onSelectRef = useRef(onSelect);
  const homeRef = useRef(home);
  const drawRef = useRef<() => void>(() => {});
  homeRef.current = home;

  useEffect(() => {
    onSelectRef.current = onSelect;
  });

  useEffect(() => {
    const container = holder.current;
    if (!container || mapRef.current) return;
    const token = process.env.NEXT_PUBLIC_MAPBOX_TOKEN;
    if (!token) return;
    let cancelled = false;
    let map: MapboxMap | null = null;
    let observer: ResizeObserver | null = null;
    void (async () => {
      const mapbox = (await import("mapbox-gl")).default;
      if (cancelled || !holder.current) return;
      mapbox.accessToken = token;
      libRef.current = mapbox;
      const here = homeRef.current;
      map = new mapbox.Map({
        container: holder.current,
        accessToken: token,
        style: "mapbox://styles/mapbox/standard",
        config: {
          basemap: {
            lightPreset: "day",
            show3dObjects: true,
            showPointOfInterestLabels: false,
            showTransitLabels: false,
          },
        },
        center: here ? [here.lng, here.lat] : [0, 20],
        zoom: here ? BUILDING_ZOOM : 1.5,
        pitch: PITCH,
        bearing: BEARING,
        antialias: true,
        fadeDuration: 180,
      });
      map.addControl(new mapbox.NavigationControl({ showCompass: true, visualizePitch: true }), "top-right");
      map.on("load", () => drawRef.current());
      map.on("click", () => onSelectRef.current(null));
      observer = new ResizeObserver(() => map?.resize());
      observer.observe(holder.current);
      mapRef.current = map;
      drawRef.current();
    })();
    return () => {
      cancelled = true;
      observer?.disconnect();
      markers.current.forEach((marker) => marker.remove());
      markers.current = [];
      map?.remove();
      mapRef.current = null;
      libRef.current = null;
    };
  }, []);

  useEffect(() => {
    drawRef.current = () => {
      const map = mapRef.current;
      const mapbox = libRef.current;
      if (!map || !mapbox || !map.isStyleLoaded()) return;
      markers.current.forEach((marker) => marker.remove());
      markers.current = [];
      for (const id of ["stop-dot", "stop-halo"]) {
        if (map.getLayer(id)) map.removeLayer(id);
      }
      if (map.getSource("stop-dots")) map.removeSource("stop-dots");
      for (let index = 0; index < 12; index += 1) {
        for (const id of [`route-${index}`, `casing-${index}`, `glow-${index}`]) {
          if (map.getLayer(id)) map.removeLayer(id);
        }
        if (map.getSource(`route-${index}`)) map.removeSource(`route-${index}`);
      }
      const { pins, routes } = model(days, focus);
      const bounds = new mapbox.LngLatBounds();
      routes.forEach((line, index) => {
        const active = true;
        if (line.length >= 2) {
          const color = DAY_COLORS[index % DAY_COLORS.length];
          map.addSource(`route-${index}`, {
            type: "geojson",
            lineMetrics: true,
            data: { type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: line } },
          });
          const caps = { "line-cap": "round", "line-join": "round" } as const;
          map.addLayer({
            id: `glow-${index}`,
            type: "line",
            source: `route-${index}`,
            slot: "top",
            layout: caps,
            paint: { "line-color": color, "line-width": lineWidth(active, 8, 22), "line-blur": active ? 6 : 3, "line-opacity": active ? 0.34 : 0.1 },
          });
          map.addLayer({
            id: `casing-${index}`,
            type: "line",
            source: `route-${index}`,
            slot: "top",
            layout: caps,
            paint: { "line-color": "#ffffff", "line-width": lineWidth(active, 4.5, 9), "line-opacity": active ? 0.96 : 0.28 },
          });
          map.addLayer({
            id: `route-${index}`,
            type: "line",
            source: `route-${index}`,
            slot: "top",
            layout: caps,
            paint: {
              "line-width": lineWidth(active, 2.4, 4.6),
              "line-opacity": active ? 1 : 0.34,
              "line-gradient": ["interpolate", ["linear"], ["line-progress"], 0, color, 1, color],
            },
          });
        }
        line.forEach((point) => bounds.extend(point));
      });
      const ordered = [...pins.filter((pin) => pin.role === "sight"), ...pins.filter((pin) => pin.role !== "sight")];
      for (const pin of ordered) {
        const button = pinButton(pin);
        button.addEventListener("click", (event) => {
          event.stopPropagation();
          onSelectRef.current(pin.day);
        });
        const marker = new mapbox.Marker({ element: button, anchor: "center" }).setLngLat([pin.lng, pin.lat]).addTo(map);
        markers.current.push(marker);
        bounds.extend([pin.lng, pin.lat]);
      }
      map.addSource("stop-dots", {
        type: "geojson",
        data: {
          type: "FeatureCollection",
          features: pins.map((pin) => ({
            type: "Feature",
            properties: {
              color: DAY_COLORS[pin.day % DAY_COLORS.length],
              dim: 0,
            },
            geometry: { type: "Point", coordinates: [pin.lng, pin.lat] },
          })),
        },
      });
      map.addLayer({
        id: "stop-halo",
        type: "circle",
        source: "stop-dots",
        slot: "top",
        paint: {
          "circle-radius": ["interpolate", ["linear"], ["zoom"], 13, 7, 16.5, 16],
          "circle-color": ["get", "color"],
          "circle-opacity": ["case", ["==", ["get", "dim"], 1], 0.08, 0.28],
          "circle-blur": 0.85,
          "circle-pitch-alignment": "map",
        },
      });
      map.addLayer({
        id: "stop-dot",
        type: "circle",
        source: "stop-dots",
        slot: "top",
        paint: {
          "circle-radius": ["interpolate", ["linear"], ["zoom"], 13, 3.5, 16.5, 6],
          "circle-color": ["get", "color"],
          "circle-stroke-width": 2,
          "circle-stroke-color": "#ffffff",
          "circle-opacity": ["case", ["==", ["get", "dim"], 1], 0.35, 1],
          "circle-pitch-alignment": "map",
        },
      });
      if (!bounds.isEmpty()) {
        map.fitBounds(bounds, { padding, maxZoom: focus == null ? 15.2 : 16.2, duration: 0, pitch: PITCH, bearing: BEARING });
        if (focus == null && map.getZoom() < BUILDING_ZOOM) {
          const hotel = pins.find((pin) => pin.role === "hotel");
          const center = hotel ? ([hotel.lng, hotel.lat] as [number, number]) : bounds.getCenter();
          map.jumpTo({ center, zoom: BUILDING_ZOOM, pitch: PITCH, bearing: BEARING, padding });
        }
        layoutPins(map, markers.current);
      } else if (homeRef.current) {
        map.jumpTo({
          center: [homeRef.current.lng, homeRef.current.lat],
          zoom: BUILDING_ZOOM,
          pitch: PITCH,
          bearing: BEARING,
          padding,
        });
      }
    };
    drawRef.current();
  }, [days, focus, padding, home]);

  return <div ref={holder} className="plan-map" />;
}

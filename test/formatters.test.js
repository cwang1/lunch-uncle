import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CT_HUB_2,
  formatForecast,
  formatBusArrivals,
  formatPlaces,
  haversineMetres,
} from "../src/tools.js";

const LAVENDER_MRT = { latitude: 1.3073, longitude: 103.8631 };
const BEDOK = { latitude: 1.3236, longitude: 103.9273 };

test("formatForecast picks the requested area", () => {
  const payload = {
    data: {
      items: [
        {
          update_timestamp: "2026-11-11T11:30:00+08:00",
          valid_period: {
            start: "2026-11-11T12:00:00+08:00",
            end: "2026-11-11T14:00:00+08:00",
            text: "12 pm to 2 pm",
          },
          forecasts: [
            { area: "Geylang", forecast: "Fair" },
            { area: "Kallang", forecast: "Light Rain" },
          ],
        },
      ],
    },
  };

  assert.deepEqual(formatForecast(payload, "Kallang"), {
    area: "Kallang",
    forecast: "Light Rain",
    valid_period: "12 pm to 2 pm",
    valid_from: "2026-11-11T12:00:00+08:00",
    valid_to: "2026-11-11T14:00:00+08:00",
    updated_at: "2026-11-11T11:30:00+08:00",
  });
});

test("formatForecast returns an error instead of throwing on a bad payload", () => {
  assert.deepEqual(formatForecast({ data: { items: [{}] } }, "Kallang"), {
    error: "No forecast available",
  });
  assert.deepEqual(formatForecast(null, "Kallang"), { error: "No forecast available" });
});

test("formatBusArrivals converts durations to whole minutes", () => {
  const payload = {
    services: [
      {
        no: "13",
        next: { duration_ms: 100_798 },
        subsequent: { duration_ms: 1_210_000 },
      },
      { no: "107M", next: { duration_ms: 30_000 }, subsequent: null },
    ],
  };

  assert.deepEqual(formatBusArrivals(payload, "07371"), {
    stop_code: "07371",
    services: [
      { service: "13", next_min: 2, subsequent_min: 20 },
      { service: "107M", next_min: 1, subsequent_min: null },
    ],
  });
});

test("formatBusArrivals filters to one service and notes when it is missing", () => {
  const payload = {
    services: [
      { no: "13", next: { duration_ms: 60_000 } },
      { no: "107M", next: { duration_ms: 120_000 } },
    ],
  };

  assert.deepEqual(formatBusArrivals(payload, "07361", "107m").services, [
    { service: "107M", next_min: 2, subsequent_min: null },
  ]);
  assert.match(formatBusArrivals(payload, "07361", "980").note, /980/);
});

test("haversineMetres measures CT Hub 2 to Lavender MRT at about 500 m", () => {
  const distance = haversineMetres(CT_HUB_2, LAVENDER_MRT);
  assert.ok(distance > 450 && distance < 550, `got ${distance}`);
});

test("formatPlaces measures from CT Hub 2 and reports open status", () => {
  const places = [
    {
      displayName: { text: "Near and open" },
      rating: 4.3,
      location: LAVENDER_MRT,
      currentOpeningHours: { openNow: true },
    },
    {
      displayName: { text: "Near and closed" },
      location: CT_HUB_2,
      currentOpeningHours: { openNow: false },
    },
    { displayName: { text: "Near, hours unknown" }, location: CT_HUB_2 },
  ];

  assert.deepEqual(formatPlaces(places, CT_HUB_2), [
    { name: "Near and open", rating: 4.3, distance_m: 500, walk_min: 6, open_now: true },
    { name: "Near and closed", rating: null, distance_m: 0, walk_min: 1, open_now: false },
    { name: "Near, hours unknown", rating: null, distance_m: 0, walk_min: 1, open_now: null },
  ]);
});

test("formatPlaces drops places with no location or beyond walking distance", () => {
  const places = [
    { displayName: { text: "No location" } },
    { displayName: { text: "Bedok" }, location: BEDOK },
    { displayName: { text: "Here" }, location: CT_HUB_2 },
  ];

  assert.deepEqual(
    formatPlaces(places, CT_HUB_2).map((p) => p.name),
    ["Here"],
  );
});

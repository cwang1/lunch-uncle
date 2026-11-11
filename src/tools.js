/**
 * Tool definitions and implementations for Lunch Uncle.
 *
 * Each tool is split in two: a fetch function that talks to the network,
 * and a pure format function that shapes the response for the model.
 * The format functions are the ones covered by tests.
 */

// CT Hub 2, 114 Lavender Street.
export const CT_HUB_2 = { latitude: 1.3115, longitude: 103.8615 };

// Bus stops on Lavender Street closest to CT Hub 2 (from data.busrouter.sg).
export const NEARBY_BUS_STOPS = [
  { code: "07361", name: "Bef Kallang Bahru", distance_m: 50 },
  { code: "07369", name: "Aft Kallang Bahru", distance_m: 100 },
];

const SEARCH_RADIUS_METRES = 800;
// Places further than this are not walking distance and are dropped.
export const MAX_WALK_METRES = 1500;
const WALK_METRES_PER_MINUTE = 80;
const MAX_PLACES = 10;
const FORECAST_AREA = "Kallang";
const TOOL_TIMEOUT_MS = 8_000;
const PLACES_CACHE_TTL_MS = 10 * 60_000;

const PLACES_URL = "https://places.googleapis.com/v1/places:searchText";
const FORECAST_URL =
  "https://api-open.data.gov.sg/v2/real-time/api/two-hr-forecast";
const BUS_URL = "https://arrivelah2.busrouter.sg/";

// ---------------------------------------------------------------------------
// Definitions sent to the model
// ---------------------------------------------------------------------------

export const toolDefinitions = [
  {
    type: "function",
    function: {
      name: "find_lunch_places",
      description:
        "Search for places to eat within walking distance of CT Hub 2. Returns name, rating, distance, walking minutes and whether it is open now.",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description:
              'What to search for, e.g. "chicken rice", "japanese", "cheap lunch".',
          },
          open_now: {
            type: "boolean",
            description: "Only return places that are open right now.",
          },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_rain_forecast",
      description:
        "Get the two-hour weather forecast for the Kallang area, which covers CT Hub 2.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "get_bus_arrivals",
      description:
        "Get live next-bus arrivals at a Singapore bus stop, by five-digit stop code. The stops nearest CT Hub 2 are 07361 and 07369 on Lavender Street.",
      parameters: {
        type: "object",
        properties: {
          stop_code: {
            type: "string",
            description: 'Five-digit bus stop code, e.g. "07361".',
          },
          service: {
            type: "string",
            description:
              'Optional bus service number to filter to, e.g. "857" or "107M".',
          },
        },
        required: ["stop_code"],
      },
    },
  },
];

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

/**
 * Run one tool call requested by the model and return the result as a string.
 * Never throws: any failure is returned to the model as {error}.
 */
export async function executeTool(name, args, env) {
  try {
    if (!args || typeof args !== "object" || Array.isArray(args)) {
      return JSON.stringify({ error: "Tool arguments must be a JSON object." });
    }
    switch (name) {
      case "find_lunch_places":
        return JSON.stringify(await findLunchPlaces(args, env));
      case "get_rain_forecast":
        return JSON.stringify(await getRainForecast());
      case "get_bus_arrivals":
        return JSON.stringify(await getBusArrivals(args));
      default:
        return JSON.stringify({ error: `Unknown tool: ${name}` });
    }
  } catch (err) {
    console.error(`tool ${name} failed:`, err);
    return JSON.stringify({ error: `${name} failed: ${err.message}` });
  }
}

async function fetchJson(url, init = {}) {
  const res = await fetch(url, {
    ...init,
    signal: AbortSignal.timeout(TOOL_TIMEOUT_MS),
  });
  if (!res.ok) {
    return { ok: false, status: res.status };
  }
  return { ok: true, data: await res.json() };
}

// ---------------------------------------------------------------------------
// find_lunch_places
// ---------------------------------------------------------------------------

// Per-isolate cache so follow-up questions don't pay for the same search twice.
const placesCache = new Map();

async function findLunchPlaces({ query, open_now = false }, env) {
  if (typeof query !== "string" || query.trim() === "") {
    return { error: "query must be a non-empty string" };
  }
  if (!env.GOOGLE_PLACES_API_KEY) {
    return { error: "Place search is not configured (no Places API key)." };
  }

  const openNow = open_now === true;
  const cacheKey = `${query.trim().toLowerCase()}|${openNow}`;
  const cached = placesCache.get(cacheKey);
  if (cached && cached.expires > Date.now()) {
    return cached.value;
  }

  const body = {
    textQuery: query,
    includedType: "restaurant",
    openNow,
    pageSize: MAX_PLACES,
    locationBias: {
      circle: { center: CT_HUB_2, radius: SEARCH_RADIUS_METRES },
    },
  };

  const res = await fetchJson(PLACES_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "X-Goog-Api-Key": env.GOOGLE_PLACES_API_KEY,
      "X-Goog-FieldMask":
        "places.displayName,places.location,places.rating,places.currentOpeningHours",
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    return { error: `Places API returned ${res.status}` };
  }

  const places = formatPlaces(res.data?.places ?? [], CT_HUB_2);
  const value = places.length
    ? { places }
    : { places, note: "No places found within walking distance of CT Hub 2." };
  placesCache.set(cacheKey, { value, expires: Date.now() + PLACES_CACHE_TTL_MS });
  return value;
}

/**
 * Shape Places API results into the fields Uncle needs.
 * Places without a location, or beyond walking distance, are dropped.
 */
export function formatPlaces(places, origin, maxMetres = MAX_WALK_METRES) {
  return places
    .filter((p) => isLatLng(p?.location))
    .map(({ displayName, rating, location, currentOpeningHours }) => {
      const distance = Math.round(haversineMetres(origin, location));
      return {
        name: displayName?.text ?? "Unnamed",
        rating: rating ?? null,
        distance_m: distance,
        walk_min: Math.max(1, Math.round(distance / WALK_METRES_PER_MINUTE)),
        open_now:
          typeof currentOpeningHours?.openNow === "boolean"
            ? currentOpeningHours.openNow
            : null,
      };
    })
    .filter((p) => p.distance_m <= maxMetres);
}

function isLatLng(p) {
  return (
    p != null &&
    typeof p.latitude === "number" &&
    typeof p.longitude === "number"
  );
}

/**
 * Great-circle distance between two {latitude, longitude} points, in metres.
 */
export function haversineMetres(a, b) {
  const R = 6371000;
  const toRad = (deg) => (deg * Math.PI) / 180;
  const dLat = toRad(b.latitude - a.latitude);
  const dLon = toRad(b.longitude - a.longitude);
  const lat1 = toRad(a.latitude);
  const lat2 = toRad(b.latitude);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

// ---------------------------------------------------------------------------
// get_rain_forecast
// ---------------------------------------------------------------------------

// The forecast only changes every two hours, so reuse it until it expires.
let forecastCache = null;

async function getRainForecast() {
  if (forecastCache && forecastCache.expires > Date.now()) {
    return forecastCache.value;
  }
  const res = await fetchJson(FORECAST_URL);
  if (!res.ok) {
    return { error: `Forecast API returned ${res.status}` };
  }
  const value = formatForecast(res.data, FORECAST_AREA);
  if (!value.error) {
    const end = Date.parse(value.valid_to ?? "");
    const expires = Number.isFinite(end) ? end : Date.now() + 30 * 60_000;
    forecastCache = { value, expires };
  }
  return value;
}

/**
 * Pull one area's forecast out of the data.gov.sg two-hour forecast payload.
 */
export function formatForecast(payload, area) {
  const item = payload?.data?.items?.[0];
  if (!item || !Array.isArray(item.forecasts)) {
    return { error: "No forecast available" };
  }
  const entry = item.forecasts.find((f) => f?.area === area);
  return {
    area,
    forecast: entry?.forecast ?? "Unknown",
    valid_period: item.valid_period?.text ?? null,
    valid_from: item.valid_period?.start ?? null,
    valid_to: item.valid_period?.end ?? null,
    updated_at: item.update_timestamp ?? null,
  };
}

// ---------------------------------------------------------------------------
// get_bus_arrivals
// ---------------------------------------------------------------------------

async function getBusArrivals({ stop_code, service }) {
  const code = String(stop_code ?? "").trim();
  if (!/^\d{5}$/.test(code)) {
    return { error: "stop_code must be a five-digit bus stop code" };
  }
  const res = await fetchJson(`${BUS_URL}?id=${code}`);
  if (!res.ok) {
    return { error: `Bus API returned ${res.status}` };
  }
  const result = formatBusArrivals(res.data, code, service);

  // A service missing from one nearby stop often stops across the road,
  // so check the other stops near CT Hub 2 before giving up.
  const nearby = NEARBY_BUS_STOPS.map((s) => s.code);
  if (result.note && nearby.includes(code)) {
    for (const other of nearby.filter((c) => c !== code)) {
      const alt = await fetchJson(`${BUS_URL}?id=${other}`);
      if (!alt.ok) continue;
      const altResult = formatBusArrivals(alt.data, other, service);
      if (altResult.services.length) {
        return { ...altResult, note: `Not at ${code}; found at nearby stop ${other} instead.` };
      }
    }
  }
  return result;
}

/**
 * Reduce an arrivelah response to service numbers and minutes to arrival.
 * If service is given, only that service is returned.
 */
export function formatBusArrivals(payload, stopCode, service) {
  const all = Array.isArray(payload?.services) ? payload.services : [];
  const wanted =
    typeof service === "string" && service.trim()
      ? service.trim().toUpperCase()
      : null;
  const services = wanted
    ? all.filter((s) => String(s.no).toUpperCase() === wanted)
    : all;
  const result = {
    stop_code: stopCode,
    services: services.map((s) => ({
      service: s.no,
      next_min: minutesFromNow(s.next),
      subsequent_min: minutesFromNow(s.subsequent),
    })),
  };
  if (wanted && services.length === 0) {
    result.note = `Service ${wanted} has no arrivals listed at stop ${stopCode}.`;
  }
  return result;
}

function minutesFromNow(arrival) {
  if (!arrival || typeof arrival.duration_ms !== "number") {
    return null;
  }
  return Math.max(0, Math.round(arrival.duration_ms / 60000));
}

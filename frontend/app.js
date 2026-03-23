import React, { useEffect, useRef, useState } from "https://esm.sh/react@18";
import { createRoot } from "https://esm.sh/react-dom@18/client";

const MIN_LOAD_DURATION_MINUTES = 30;
const MAX_LOAD_DURATION_MINUTES = 120;
const DEFAULT_CENTER = [24.7136, 46.6753];
const BASE_PLAYBACK_SECONDS = 40;
const HISTORY_STORAGE_KEY = "rigsync-plan-history";
const ALLOWED_SCREENS = new Set(["login", "home", "planner", "history", "compare"]);

function Stat({ label, value, tone = "default" }) {
  return React.createElement(
    "div",
    { className: `stat-card tone-${tone}` },
    React.createElement("span", { className: "stat-label" }, label),
    React.createElement("strong", { className: "stat-value" }, value ?? "-"),
  );
}

function formatMinutes(totalMinutes) {
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;

  if (hours === 0) {
    return `${minutes} min`;
  }

  if (minutes === 0) {
    return `${hours} hr`;
  }

  return `${hours} hr ${minutes} min`;
}

function formatCoordinate(latlng) {
  if (!latlng) {
    return "Not selected";
  }

  return `${latlng.lat.toFixed(5)}, ${latlng.lng.toFixed(5)}`;
}

function parseCoordinateString(value) {
  if (!value || typeof value !== "string") {
    return null;
  }

  const [lat, lng] = value.split(",").map((item) => Number.parseFloat(item.trim()));
  if (Number.isNaN(lat) || Number.isNaN(lng)) {
    return null;
  }

  return { lat, lng };
}

function haversineKilometers(start, end) {
  if (!start || !end) {
    return 0;
  }

  const earthRadiusKm = 6371;
  const dLat = ((end.lat - start.lat) * Math.PI) / 180;
  const dLng = ((end.lng - start.lng) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((start.lat * Math.PI) / 180) *
      Math.cos((end.lat * Math.PI) / 180) *
      Math.sin(dLng / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

  return earthRadiusKm * c;
}

function buildDashboardSnapshot({ history, simulation, currentMinute, loadCount }) {
  const latestHistory = history[0] || null;
  const startPoint = simulation?.startPoint || parseCoordinateString(latestHistory?.start) || { lat: 26.4207, lng: 50.0888 };
  const endPoint = simulation?.endPoint || parseCoordinateString(latestHistory?.end) || { lat: 25.3632, lng: 49.5856 };
  const routeKm = Math.max(1, Math.round(haversineKilometers(startPoint, endPoint) * 10) / 10);
  const totalMinutes = simulation?.bestPlan?.totalMinutes || 514;
  const elapsedMinutes = simulation?.bestPlan ? Math.min(totalMinutes, Math.round(currentMinute)) : Math.round(totalMinutes * 0.38);
  const completion = Math.min(100, Math.max(0, Math.round((elapsedMinutes / Math.max(totalMinutes, 1)) * 100)));
  const truckCount = simulation?.truckCount || Number.parseInt(latestHistory?.trucks, 10) || 4;
  const workerCount = simulation?.workerCount || Number.parseInt(latestHistory?.workers, 10) || 6;
  const savedPlans = history.length;
  const activeTrips = simulation?.bestPlan?.playback?.trips?.filter((trip) => elapsedMinutes < (trip.returnToSource ?? trip.arrivalAtDestination)).length || Math.min(truckCount, 3);
  const routeTime = simulation?.routeMinutes || latestHistory?.routeTime || formatMinutes(Math.round(routeKm * 3.1));
  const eta = simulation?.bestPlan ? formatMinutes(totalMinutes) : latestHistory?.eta || "14 hr 22 min";

  return {
    startPoint,
    endPoint,
    routeKm,
    totalMinutes,
    elapsedMinutes,
    completion,
    truckCount,
    workerCount,
    savedPlans,
    activeTrips,
    routeTime,
    eta,
    loadCount: loadCount || 24,
    planName: simulation?.bestPlan?.name || latestHistory?.planName || "Plan A",
    routeTitle: latestHistory?.title || `${formatCoordinate(startPoint)} to ${formatCoordinate(endPoint)}`,
    routeSource: simulation?.routeSource || "Operational estimate",
  };
}

function buildNavigationItems(activeScreen) {
  return [
    { id: "planner", label: "planning", active: activeScreen === "planner" || activeScreen === "home" },
    { id: "compare", label: "comparing", active: activeScreen === "compare" || activeScreen === "history" },
  ];
}

function getInitialScreen() {
  const params = new URLSearchParams(window.location.search);
  const requestedScreen = params.get("screen");
  if (!ALLOWED_SCREENS.has(requestedScreen)) {
    return "login";
  }
  if (requestedScreen === "home") {
    return "planner";
  }
  if (requestedScreen === "history") {
    return "compare";
  }
  return requestedScreen;
}

function DashboardTopbar({ activeScreen, title, subtitle, onNavigate }) {
  const navigationItems = buildNavigationItems(activeScreen);

  return React.createElement(
    "header",
    { className: "dashboard-topbar" },
    React.createElement(
      "div",
      { className: "dashboard-brand" },
      React.createElement("p", { className: "eyebrow" }, "RigSync"),
      React.createElement("h1", null, title),
      subtitle ? React.createElement("p", { className: "panel-note dashboard-subtitle" }, subtitle) : null,
    ),
    React.createElement(
      "div",
      { className: "dashboard-nav" },
      navigationItems.map((item) =>
        React.createElement(
          "button",
          {
            key: item.id,
            type: "button",
            className: `dashboard-nav-button${item.active ? " active" : ""}`,
            onClick: () => onNavigate(item.id),
          },
          item.label,
        ),
      ),
    ),
    React.createElement(
      "div",
      { className: "dashboard-user" },
      React.createElement("span", { className: "dashboard-user-dot" }),
      React.createElement("span", null, "Operations"),
    ),
  );
}

function getLoadDurationMinutes(loadId) {
  const seeded = (loadId * 37) % (MAX_LOAD_DURATION_MINUTES - MIN_LOAD_DURATION_MINUTES + 1);
  return MIN_LOAD_DURATION_MINUTES + seeded;
}

function buildLogicalLoads(rawLoads) {
  const grouped = new Map();

  rawLoads.forEach((load) => {
    const key = [load.category, load.description, load.priority, load.truck_type].join("||");
    if (!grouped.has(key)) {
      grouped.set(key, []);
    }
    grouped.get(key).push(load);
  });

  const logicalLoads = [];
  const rawToLogical = new Map();

  grouped.forEach((groupLoads, key) => {
    const downLoads = groupLoads
      .filter((load) => load.phase === "Rig Down")
      .sort((a, b) => a.id - b.id);
    const upLoads = groupLoads
      .filter((load) => load.phase === "Rig Up")
      .sort((a, b) => a.id - b.id);
    const count = Math.max(downLoads.length, upLoads.length);

    for (let index = 0; index < count; index += 1) {
      const downLoad = downLoads[index] || null;
      const upLoad = upLoads[index] || null;
      const base = downLoad || upLoad;
      const logicalId = downLoad?.id ?? upLoad?.id;

      const logicalLoad = {
        id: logicalId,
        key: `${key}::${index}`,
        description: base.description,
        category: base.category,
        priority: base.priority,
        truck_type: base.truck_type,
        rig_down_id: downLoad?.id ?? null,
        rig_up_id: upLoad?.id ?? null,
        rig_down_duration: downLoad ? getLoadDurationMinutes(downLoad.id) : 0,
        rig_up_duration: upLoad ? getLoadDurationMinutes(upLoad.id) : 0,
        dependency_ids: [],
      };

      logicalLoads.push(logicalLoad);
      if (downLoad) {
        rawToLogical.set(downLoad.id, logicalId);
      }
      if (upLoad) {
        rawToLogical.set(upLoad.id, logicalId);
      }
    }
  });

  const logicalById = new Map(logicalLoads.map((load) => [load.id, load]));
  rawLoads.forEach((load) => {
    const logicalId = rawToLogical.get(load.id);
    if (!logicalId) {
      return;
    }

    const logicalLoad = logicalById.get(logicalId);
    const dependencies = (load.dependency_ids || [])
      .map((dependencyId) => rawToLogical.get(dependencyId))
      .filter((dependencyId) => dependencyId && dependencyId !== logicalId);

    logicalLoad.dependency_ids.push(...dependencies);
  });

  logicalLoads.forEach((load) => {
    load.dependency_ids = [...new Set(load.dependency_ids)].sort((a, b) => a - b);
  });

  return logicalLoads.sort((a, b) => a.id - b.id);
}

function haversineMinutes(start, end) {
  if (!start || !end) {
    return 0;
  }

  const earthRadiusKm = 6371;
  const dLat = ((end.lat - start.lat) * Math.PI) / 180;
  const dLng = ((end.lng - start.lng) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((start.lat * Math.PI) / 180) *
      Math.cos((end.lat * Math.PI) / 180) *
      Math.sin(dLng / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  const distanceKm = earthRadiusKm * c;
  const averageTruckSpeedKmh = 45;

  return Math.max(15, Math.round((distanceKm / averageTruckSpeedKmh) * 60));
}

async function fetchRouteData(start, end) {
  const coordinates = `${start.lng},${start.lat};${end.lng},${end.lat}`;
  const response = await fetch(
    `https://router.project-osrm.org/route/v1/driving/${coordinates}?overview=full&geometries=geojson`,
  );

  if (!response.ok) {
    throw new Error(`Routing request failed with ${response.status}`);
  }

  const payload = await response.json();
  const route = payload?.routes?.[0];
  const seconds = route?.duration;

  if (!seconds || !route?.geometry?.coordinates?.length) {
    throw new Error("No route duration returned");
  }

  return {
    minutes: Math.max(1, Math.round(seconds / 60)),
    geometry: route.geometry.coordinates.map(([lng, lat]) => [lat, lng]),
    source: "OSRM driving route",
  };
}

function fallbackRouteData(start, end) {
  return {
    minutes: haversineMinutes(start, end),
    geometry: [
      [start.lat, start.lng],
      [end.lat, end.lng],
    ],
    source: "Estimated from straight-line distance",
  };
}

function buildSchedules(loads) {
  const loadMap = new Map(loads.map((load) => [load.id, load]));
  const dependentsMap = new Map(loads.map((load) => [load.id, []]));
  const indegree = new Map(loads.map((load) => [load.id, load.dependency_ids.length]));

  loads.forEach((load) => {
    load.dependency_ids.forEach((dependencyId) => {
      if (dependentsMap.has(dependencyId)) {
        dependentsMap.get(dependencyId).push(load.id);
      }
    });
  });

  const roots = loads
    .filter((load) => load.dependency_ids.length === 0)
    .map((load) => load.id)
    .sort((a, b) => a - b);

  function simulate(rootOrder, capacity) {
    const localIndegree = new Map(indegree);
    const ready = [...rootOrder];
    const completed = new Set();
    const started = new Set();
    const waves = [];

    while (completed.size < loads.length) {
      const batch = [];
      ready.sort((a, b) => a - b);

      while (ready.length && batch.length < capacity) {
        const candidate = ready.shift();
        if (started.has(candidate) || completed.has(candidate)) {
          continue;
        }

        batch.push(candidate);
        started.add(candidate);
      }

      if (batch.length === 0) {
        break;
      }

      batch.forEach((loadId) => {
        completed.add(loadId);
        const dependents = dependentsMap.get(loadId) || [];
        dependents.forEach((dependentId) => {
          localIndegree.set(dependentId, localIndegree.get(dependentId) - 1);
          if (localIndegree.get(dependentId) === 0) {
            ready.push(dependentId);
          }
        });
      });

      waves.push(batch.map((loadId) => loadMap.get(loadId)).filter(Boolean));
    }

    return waves;
  }

  const variants = [];
  const candidateRootOrders = [];

  if (roots.length) {
    candidateRootOrders.push([...roots]);
    candidateRootOrders.push([...roots].reverse());
    candidateRootOrders.push([
      ...roots.filter((id) => id % 2 === 0),
      ...roots.filter((id) => id % 2 !== 0),
    ]);
  }

  candidateRootOrders.forEach((rootOrder, index) => {
    const key = rootOrder.join(",");
    if (variants.some((variant) => variant.key === key)) {
      return;
    }

    variants.push({
      key,
      name: `Plan ${String.fromCharCode(65 + index)}`,
      rootOrder,
    });
  });

  return variants.map((variant) => ({
    ...variant,
    wavesForCapacity: (capacity) => simulate(variant.rootOrder, capacity),
  }));
}

function buildScenarioPlans(logicalLoads, routeData, workerCount, truckCount) {
  const scenarios = [
    { name: "Plan A", workerCount, truckCount },
    { name: "Plan B", workerCount: workerCount + 2, truckCount: truckCount + 1 },
    { name: "Plan C", workerCount: workerCount + 3, truckCount: truckCount + 2 },
  ];

  const plannerVariants = buildSchedules(logicalLoads);

  return scenarios.map((scenario) => {
    const capacity = Math.max(1, Math.min(scenario.workerCount, scenario.truckCount));
    const variantPlans = plannerVariants.map((variant) => {
      const waves = variant.wavesForCapacity(capacity);
      const playback = buildPlayback({ routeMinutes: routeData.minutes, waves }, scenario.truckCount);

      return {
        name: variant.name,
        waves,
        routeMinutes: routeData.minutes,
        processingMinutes: Math.max(0, playback.totalMinutes - routeData.minutes),
        totalMinutes: playback.totalMinutes,
        playback,
      };
    });

    variantPlans.sort((a, b) => a.totalMinutes - b.totalMinutes);
    const bestVariant = variantPlans[0] || null;

    return {
      name: scenario.name,
      workerCount: scenario.workerCount,
      truckCount: scenario.truckCount,
      capacity,
      routeMinutes: routeData.minutes,
      routeSource: routeData.source,
      routeGeometry: routeData.geometry,
      variantPlans,
      bestVariant,
      totalMinutes: bestVariant?.totalMinutes ?? 0,
      processingMinutes: bestVariant?.processingMinutes ?? 0,
      playback: bestVariant?.playback ?? null,
      waves: bestVariant?.waves ?? [],
    };
  });
}

function buildComparisonRows(scenarioPlans) {
  if (!scenarioPlans?.length) {
    return [];
  }

  const stages = [
    {
      key: "routeMinutes",
      label: "Travel time",
      format: (plan) => formatMinutes(plan.routeMinutes),
      compare: "min",
    },
    {
      key: "processingMinutes",
      label: "Rig work",
      format: (plan) => formatMinutes(plan.processingMinutes),
      compare: "min",
    },
    {
      key: "totalMinutes",
      label: "Total ETA",
      format: (plan) => formatMinutes(plan.totalMinutes),
      compare: "min",
    },
    {
      key: "workerCount",
      label: "Workers",
      format: (plan) => String(plan.workerCount),
      compare: "none",
    },
    {
      key: "truckCount",
      label: "Trucks",
      format: (plan) => String(plan.truckCount),
      compare: "none",
    },
    {
      key: "capacity",
      label: "Parallel capacity",
      format: (plan) => String(plan.capacity),
      compare: "max",
    },
  ];

  return stages.map((row) => ({
    label: row.label,
    values: scenarioPlans.map((plan) => ({
      planName: plan.name,
      text: row.format(plan),
      best:
        row.compare === "min"
          ? plan[row.key] === Math.min(...scenarioPlans.map((candidate) => candidate[row.key]))
          : row.compare === "max"
            ? plan[row.key] === Math.max(...scenarioPlans.map((candidate) => candidate[row.key]))
            : false,
    })),
  }));
}

function buildPlayback(plan, truckCount) {
  const steps = [];
  const trucks = Array.from({ length: truckCount }, (_, index) => ({
    id: index + 1,
    availableAt: 0,
  }));
  const trips = [];
  let stageReadyAt = 0;

  steps.push({
    type: "dispatch",
    minute: 0,
    title: "Transfer operation starts",
    description: `${truckCount} truck${truckCount > 1 ? "s are" : " is"} ready at the source rig.`,
  });

  plan.waves.forEach((wave, waveIndex) => {
    const stageArrivals = [];

    wave.forEach((load) => {
      const truck = trucks.sort((a, b) => a.availableAt - b.availableAt)[0];
      const loadStart = Math.max(stageReadyAt, truck.availableAt);
      const rigDownFinish = loadStart + (load.rig_down_duration || 0);
      const arrivalAtDestination = rigDownFinish + plan.routeMinutes;
      const rigUpFinish = arrivalAtDestination + (load.rig_up_duration || 0);
      const returnToSource = rigUpFinish + plan.routeMinutes;

      trips.push({
        truckId: truck.id,
        loadId: load.id,
        description: load.description,
        loadStart,
        rigDownFinish,
        arrivalAtDestination,
        rigUpFinish,
        returnToSource,
      });

      steps.push({
        type: "load-start",
        minute: loadStart,
        title: `Truck ${truck.id} starts loading #${load.id}`,
        description: `${load.description} enters stage ${waveIndex + 1}.`,
      });
      steps.push({
        type: "arrival",
        minute: arrivalAtDestination,
        title: `Truck ${truck.id} delivers #${load.id}`,
        description: `${load.description} reaches the destination rig.`,
      });
      steps.push({
        type: "rig-up-finish",
        minute: rigUpFinish,
        title: `Rig up complete for #${load.id}`,
        description: `${load.description} is positioned at the destination.`,
      });

      truck.availableAt = returnToSource;
      stageArrivals.push(rigUpFinish);
    });

    stageReadyAt = Math.max(...stageArrivals);
    steps.push({
      type: "stage-complete",
      minute: stageReadyAt,
      title: `Stage ${waveIndex + 1} complete`,
      description: `All loads in stage ${waveIndex + 1} are complete.`,
    });
  });

  const lastTripByTruck = new Map();
  trips.forEach((trip) => lastTripByTruck.set(trip.truckId, trip));
  trips.forEach((trip) => {
    if (lastTripByTruck.get(trip.truckId) === trip) {
      trip.returnToSource = null;
    }
  });

  return {
    steps: steps.sort((a, b) => a.minute - b.minute),
    trips,
    totalMinutes: Math.max(...steps.map((step) => step.minute), 0),
  };
}

function reverseGeometry(geometry) {
  return [...geometry].reverse();
}

function interpolatePath(geometry, progress) {
  if (!geometry?.length) {
    return null;
  }

  if (geometry.length === 1) {
    const [lat, lng] = geometry[0];
    return { lat, lng };
  }

  const lengths = [];
  let totalLength = 0;

  for (let index = 1; index < geometry.length; index += 1) {
    const [lat1, lng1] = geometry[index - 1];
    const [lat2, lng2] = geometry[index];
    const segment = Math.hypot(lat2 - lat1, lng2 - lng1);
    lengths.push(segment);
    totalLength += segment;
  }

  if (totalLength === 0) {
    const [lat, lng] = geometry[0];
    return { lat, lng };
  }

  const targetLength = totalLength * Math.min(Math.max(progress, 0), 1);
  let traversed = 0;

  for (let index = 0; index < lengths.length; index += 1) {
    const segment = lengths[index];
    if (traversed + segment >= targetLength) {
      const ratio = (targetLength - traversed) / segment;
      const [lat1, lng1] = geometry[index];
      const [lat2, lng2] = geometry[index + 1];
      return {
        lat: lat1 + (lat2 - lat1) * ratio,
        lng: lng1 + (lng2 - lng1) * ratio,
      };
    }
    traversed += segment;
  }

  const [lat, lng] = geometry[geometry.length - 1];
  return { lat, lng };
}

function getTruckStatus(playback, currentMinute, truckId) {
  const truckTrips = playback.trips.filter((trip) => trip.truckId === truckId);
  const activeTrip = truckTrips.find((trip) => {
    const tripEnd = trip.returnToSource ?? trip.arrivalAtDestination;
    return currentMinute >= trip.loadStart && currentMinute <= tripEnd;
  });

  if (!activeTrip) {
    const deliveredTrip = [...truckTrips].reverse().find((trip) => currentMinute > trip.arrivalAtDestination);
    if (deliveredTrip) {
      return `Delivered #${deliveredTrip.loadId}`;
    }
    return "Waiting";
  }

  if (currentMinute < activeTrip.rigDownFinish) {
    return `Loading #${activeTrip.loadId}`;
  }
  if (currentMinute < activeTrip.arrivalAtDestination) {
    return `In transit #${activeTrip.loadId}`;
  }
  if (currentMinute < activeTrip.rigUpFinish) {
    return `Rig up #${activeTrip.loadId}`;
  }
  if (activeTrip.returnToSource && currentMinute < activeTrip.returnToSource) {
    return "Returning";
  }
  return `Delivered #${activeTrip.loadId}`;
}

function getTruckPosition(playback, geometry, currentMinute, truckId) {
  const truckTrips = playback.trips.filter((trip) => trip.truckId === truckId);
  const activeTrip = truckTrips.find((trip) => {
    const tripEnd = trip.returnToSource ?? trip.arrivalAtDestination;
    return currentMinute >= trip.loadStart && currentMinute <= tripEnd;
  });
  const outbound = geometry;
  const inbound = reverseGeometry(geometry);

  if (!outbound?.length) {
    return null;
  }

  if (!activeTrip) {
    const deliveredTrip = [...truckTrips].reverse().find((trip) => currentMinute > trip.arrivalAtDestination);
    const target = deliveredTrip && !deliveredTrip.returnToSource ? outbound[outbound.length - 1] : outbound[0];
    return { lat: target[0], lng: target[1] };
  }

  if (currentMinute < activeTrip.rigDownFinish) {
    return { lat: outbound[0][0], lng: outbound[0][1] };
  }
  if (currentMinute < activeTrip.arrivalAtDestination) {
    return interpolatePath(
      outbound,
      (currentMinute - activeTrip.rigDownFinish) / (activeTrip.arrivalAtDestination - activeTrip.rigDownFinish || 1),
    );
  }
  if (currentMinute < activeTrip.rigUpFinish) {
    return { lat: outbound[outbound.length - 1][0], lng: outbound[outbound.length - 1][1] };
  }
  if (activeTrip.returnToSource && currentMinute < activeTrip.returnToSource) {
    return interpolatePath(
      inbound,
      (currentMinute - activeTrip.rigUpFinish) / (activeTrip.returnToSource - activeTrip.rigUpFinish || 1),
    );
  }

  return { lat: outbound[outbound.length - 1][0], lng: outbound[outbound.length - 1][1] };
}

function createTruckIcon(truckId) {
  const svg = `
    <svg width="42" height="42" viewBox="0 0 42 42" fill="none" xmlns="http://www.w3.org/2000/svg">
      <circle cx="21" cy="21" r="20" fill="rgba(122,86,255,0.18)" stroke="#7a56ff" />
      <path d="M11 23.5C11 20.4624 13.4624 18 16.5 18H23.5C26.5376 18 29 20.4624 29 23.5V27H11V23.5Z" fill="#E8E4FF"/>
      <path d="M29 20H32.2C33.0233 20 33.7933 20.4021 34.2627 21.076L36.2 23.8571C36.7194 24.6027 37 25.4897 37 26.3983V27H29V20Z" fill="#A58DFF"/>
      <circle cx="16.5" cy="28.5" r="2.5" fill="#111013"/>
      <circle cx="30.5" cy="28.5" r="2.5" fill="#111013"/>
      <circle cx="31.5" cy="11" r="7" fill="#ff6d4d"/>
      <text x="31.5" y="13.5" text-anchor="middle" font-family="Space Grotesk, sans-serif" font-size="8" font-weight="700" fill="white">${truckId}</text>
    </svg>`;

  return window.L.divIcon({
    className: "truck-marker-icon",
    html: `<div class="truck-marker-body">${svg}</div>`,
    iconSize: [42, 42],
    iconAnchor: [21, 21],
  });
}

function buildRigTooltipHtml(simulation, currentMinute, side) {
  if (!simulation?.bestPlan?.playback?.trips?.length) {
    return `<div class="rig-tooltip"><strong>${side === "start" ? "Start rig" : "End rig"}</strong><p>No simulation running yet.</p></div>`;
  }

  const trips = simulation.bestPlan.playback.trips;
  const items =
    side === "start"
      ? trips.filter((trip) => currentMinute < trip.arrivalAtDestination)
      : trips.filter((trip) => currentMinute >= trip.arrivalAtDestination);

  const rows = items
    .slice(0, 6)
    .map((trip) => `<li><span>#${trip.loadId}</span><em>${trip.description}</em></li>`)
    .join("");

  return `<div class="rig-tooltip"><strong>${side === "start" ? "Loads at source" : "Loads at destination"}</strong>${items.length ? `<ul>${rows}</ul>` : "<p>None right now.</p>"}</div>`;
}

function saveHistoryEntry(entry) {
  const current = readHistoryEntries();
  const next = [entry, ...current].slice(0, 10);
  window.localStorage.setItem(HISTORY_STORAGE_KEY, JSON.stringify(next));
  return next;
}

function readHistoryEntries() {
  try {
    const raw = window.localStorage.getItem(HISTORY_STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function PhasePanel({ simulation, currentMinute }) {
  if (!simulation?.bestPlan) {
    return null;
  }

  const total = Math.max(simulation.bestPlan.totalMinutes, 1);
  const completion = Math.min(100, Math.round((currentMinute / total) * 100));

  return React.createElement(
    "section",
    { className: "panel-block" },
    React.createElement(
      "div",
      { className: "panel-header" },
      React.createElement("p", { className: "eyebrow" }, "Live Status"),
      React.createElement("h3", null, "Transfer progress"),
    ),
    React.createElement(
      "div",
      { className: "progress-shell" },
      React.createElement("div", {
        className: "progress-bar",
        style: { width: `${completion}%` },
      }),
    ),
    React.createElement("p", { className: "panel-note" }, `${completion}% complete at ${formatMinutes(Math.round(currentMinute))}`),
  );
}

function SimulationPlayback({ simulation, currentMinute }) {
  if (!simulation?.bestPlan) {
    return null;
  }

  const truckCards = Array.from({ length: simulation.truckCount }, (_, index) => index + 1);
  const steps = simulation.bestPlan.playback.steps
    .filter((step) => step.minute <= currentMinute)
    .slice(-5)
    .reverse();

  return React.createElement(
    React.Fragment,
    null,
    React.createElement(
      "section",
      { className: "panel-block" },
      React.createElement(
        "div",
        { className: "panel-header" },
        React.createElement("p", { className: "eyebrow" }, "Fleet"),
        React.createElement("h3", null, "Truck states"),
      ),
      React.createElement(
        "div",
        { className: "truck-grid" },
        truckCards.map((truckId) =>
          React.createElement(
            "article",
            { className: "truck-card", key: truckId },
            React.createElement("span", { className: "truck-label" }, `Truck ${truckId}`),
            React.createElement("strong", null, getTruckStatus(simulation.bestPlan.playback, currentMinute, truckId)),
          ),
        ),
      ),
    ),
    React.createElement(
      "section",
      { className: "panel-block" },
      React.createElement(
        "div",
        { className: "panel-header" },
        React.createElement("p", { className: "eyebrow" }, "Recent Events"),
        React.createElement("h3", null, "Operation log"),
      ),
      React.createElement(
        "div",
        { className: "event-list" },
        steps.map((step, index) =>
          React.createElement(
            "div",
            { className: "event-row", key: `${step.type}-${step.minute}-${index}` },
            React.createElement("span", { className: "event-time" }, formatMinutes(Math.round(step.minute))),
            React.createElement(
              "div",
              { className: "event-copy" },
              React.createElement("strong", null, step.title),
              React.createElement("p", null, step.description),
            ),
          ),
        ),
      ),
    ),
  );
}

function SpeedControl({ speed, onChange }) {
  return React.createElement(
    "label",
    { className: "control-field" },
    React.createElement("span", null, "Playback speed"),
    React.createElement(
      "select",
      {
        value: String(speed),
        onChange: (event) => onChange(Number(event.target.value)),
      },
      [0.5, 1, 2, 4, 8].map((option) =>
        React.createElement(
          "option",
          { key: option, value: String(option) },
          `${option}x`,
        ),
      ),
    ),
  );
}

function RealMap({ startPoint, endPoint, onSelectStart, onSelectEnd, simulation, currentMinute, readOnly = false }) {
  const mapElementRef = useRef(null);
  const mapRef = useRef(null);
  const markersRef = useRef({ start: null, end: null });
  const routeLineRef = useRef(null);
  const truckMarkersRef = useRef([]);

  useEffect(() => {
    if (!mapElementRef.current || mapRef.current || !window.L) {
      return undefined;
    }

    const map = window.L.map(mapElementRef.current, { zoomControl: false }).setView(DEFAULT_CENTER, 6);
    window.L.tileLayer("https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png", {
      maxZoom: 19,
      subdomains: "abcd",
      attribution: '&copy; OpenStreetMap contributors &copy; CARTO',
    }).addTo(map);

    mapRef.current = map;

    return () => {
      map.remove();
      mapRef.current = null;
    };
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !window.L) {
      return;
    }

    const { start, end } = markersRef.current;
    if (start) {
      start.remove();
    }
    if (end) {
      end.remove();
    }

    markersRef.current.start = startPoint
      ? window.L.marker([startPoint.lat, startPoint.lng]).addTo(map).bindTooltip(
          buildRigTooltipHtml(simulation, currentMinute, "start"),
          { direction: "top", offset: [0, -12], opacity: 0.96 },
        )
      : null;
    markersRef.current.end = endPoint
      ? window.L.marker([endPoint.lat, endPoint.lng]).addTo(map).bindTooltip(
          buildRigTooltipHtml(simulation, currentMinute, "end"),
          { direction: "top", offset: [0, -12], opacity: 0.96 },
        )
      : null;
  }, [startPoint, endPoint, simulation, currentMinute]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !window.L) {
      return;
    }

    if (routeLineRef.current) {
      routeLineRef.current.remove();
      routeLineRef.current = null;
    }

    if (!simulation?.routeGeometry?.length) {
      return;
    }

    routeLineRef.current = window.L.polyline(simulation.routeGeometry, {
      color: "#7a56ff",
      weight: 4,
      opacity: 0.9,
    }).addTo(map);

    map.fitBounds(routeLineRef.current.getBounds(), { padding: [30, 30] });
  }, [simulation]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !window.L) {
      return;
    }

    truckMarkersRef.current.forEach((marker) => marker.remove());
    truckMarkersRef.current = [];

    if (!simulation?.bestPlan?.playback?.trips?.length || !simulation?.routeGeometry?.length) {
      return;
    }

    for (let truckId = 1; truckId <= simulation.truckCount; truckId += 1) {
      const position = getTruckPosition(simulation.bestPlan.playback, simulation.routeGeometry, currentMinute, truckId);

      if (!position) {
        continue;
      }

      const marker = window.L.marker([position.lat, position.lng], {
        icon: createTruckIcon(truckId),
      })
        .addTo(map)
        .bindTooltip(`Truck ${truckId}: ${getTruckStatus(simulation.bestPlan.playback, currentMinute, truckId)}`);

      truckMarkersRef.current.push(marker);
    }
  }, [simulation, currentMinute]);

  return React.createElement(
    "div",
    { className: "map-shell" },
    React.createElement("div", { ref: mapElementRef, className: "real-map" }),
    React.createElement(
      "div",
      { className: "map-actions" },
      readOnly
        ? null
        : React.createElement(
            React.Fragment,
            null,
            React.createElement(
              "button",
              {
                type: "button",
                className: "secondary-button",
                onClick: () => {
                  const map = mapRef.current;
                  if (!map) {
                    return;
                  }

                  map.once("click", (event) => {
                    onSelectStart({ lat: event.latlng.lat, lng: event.latlng.lng });
                  });
                },
              },
              "Pick source rig",
            ),
            React.createElement(
              "button",
              {
                type: "button",
                className: "secondary-button secondary-orange",
                onClick: () => {
                  const map = mapRef.current;
                  if (!map) {
                    return;
                  }

                  map.once("click", (event) => {
                    onSelectEnd({ lat: event.latlng.lat, lng: event.latlng.lng });
                  });
                },
              },
              "Pick destination rig",
            ),
          ),
    ),
  );
}

function PlanCard({ plan, best }) {
  return React.createElement(
    "article",
    { className: `plan-card${best ? " best" : ""}` },
    React.createElement(
      "div",
      { className: "plan-card-head" },
      React.createElement(
        "div",
        null,
        React.createElement("p", { className: "eyebrow" }, plan.name),
        React.createElement("h3", null, best ? "Recommended plan" : "Alternative plan"),
      ),
      best ? React.createElement("span", { className: "plan-badge" }, "Best ETA") : null,
    ),
    React.createElement(
      "div",
      { className: "stats-grid compact" },
      React.createElement(Stat, { label: "Route", value: formatMinutes(plan.routeMinutes) }),
      React.createElement(Stat, { label: "Work", value: formatMinutes(plan.processingMinutes) }),
      React.createElement(Stat, { label: "ETA", value: formatMinutes(plan.totalMinutes), tone: best ? "accent" : "default" }),
    ),
    React.createElement(
      "div",
      { className: "wave-list" },
      plan.waves.slice(0, 3).map((wave, index) =>
        React.createElement(
          "div",
          { className: "wave-row", key: `${plan.name}-${index}` },
          React.createElement("strong", null, `Stage ${index + 1}`),
          React.createElement(
            "p",
            null,
            wave.map((load) => `#${load.id}`).join(" • "),
          ),
        ),
      ),
    ),
  );
}

function ScenarioCard({ plan, active, onSelect }) {
  return React.createElement(
    "button",
    {
      type: "button",
      className: `scenario-card${active ? " active" : ""}`,
      onClick: onSelect,
    },
    React.createElement("strong", null, plan.name),
    React.createElement("span", null, formatMinutes(plan.totalMinutes)),
    React.createElement("p", null, `${plan.workerCount} workers, ${plan.truckCount} trucks`),
  );
}

function CompareScreen({ simulation, routeMode, onNavigate }) {
  const scenarioPlans = simulation?.scenarioPlans || [];
  const comparisonRows = buildComparisonRows(scenarioPlans);
  const bestScenario = scenarioPlans.reduce(
    (best, plan) => (!best || plan.totalMinutes < best.totalMinutes ? plan : best),
    null,
  );

  return React.createElement(
    "main",
    { className: "screen dashboard-screen" },
    React.createElement("div", { className: "screen-grid" }),
    React.createElement(
      "section",
      { className: "dashboard-shell" },
      React.createElement(DashboardTopbar, {
        activeScreen: "compare",
        title: "Plan comparison",
        subtitle: "Compare the three generated scenarios and choose the best pre-move strategy.",
        onNavigate,
      }),
      React.createElement(
        "div",
        { className: "dashboard-layout compare-layout" },
        React.createElement(
          "aside",
          { className: "dashboard-panel dashboard-panel-left" },
          React.createElement("p", { className: "eyebrow" }, "Compare"),
          React.createElement("h2", null, "Scenario overview"),
          scenarioPlans.length
            ? React.createElement(
                "div",
                { className: "dashboard-metric-stack" },
                React.createElement(Stat, { label: "Best plan", value: bestScenario.name, tone: "accent" }),
                React.createElement(Stat, { label: "Best ETA", value: formatMinutes(bestScenario.totalMinutes), tone: "warm" }),
                React.createElement(Stat, { label: "Routing", value: routeMode === "live" ? "Live" : "Estimated" }),
              )
            : null,
          React.createElement(
            "div",
            { className: "dashboard-note-card compare-note" },
            React.createElement("span", { className: "dashboard-note-label" }, "Method"),
            React.createElement("strong", null, "Three generated plans"),
            React.createElement("p", null, "Plan A keeps your current staffing, while Plans B and C expand fleet and crew capacity to reduce the total move duration."),
          ),
        ),
        React.createElement(
          "section",
          { className: "dashboard-map-stage compare-stage" },
          scenarioPlans.length
            ? React.createElement(
                React.Fragment,
                null,
                React.createElement(
                  "div",
                  { className: "dashboard-map-header" },
                  React.createElement("p", { className: "eyebrow" }, "Plan comparison"),
                  React.createElement("h2", null, "Three-plan breakdown"),
                  React.createElement("p", { className: "hero-copy" }, "Generated from the same route with progressively larger crew and truck allocations."),
                ),
                React.createElement(
                  "div",
                  { className: "compare-grid" },
                  scenarioPlans.map((plan, index) =>
                    React.createElement(
                      "article",
                      { key: plan.name, className: `compare-plan-card${index === 0 ? " best" : ""}` },
                      React.createElement("p", { className: "eyebrow" }, plan.name),
                      React.createElement("h3", null, formatMinutes(plan.totalMinutes)),
                      React.createElement("p", { className: "panel-note" }, `${plan.workerCount} workers, ${plan.truckCount} trucks`),
                      React.createElement(
                        "div",
                        { className: "stats-grid compact" },
                        React.createElement(Stat, { label: "Travel", value: formatMinutes(plan.routeMinutes) }),
                        React.createElement(Stat, { label: "Work", value: formatMinutes(plan.processingMinutes) }),
                        React.createElement(Stat, { label: "Capacity", value: String(plan.capacity), tone: index === 0 ? "accent" : "default" }),
                      ),
                    ),
                  ),
                ),
                React.createElement(
                  "div",
                  { className: "compare-table" },
                  comparisonRows.map((row) =>
                    React.createElement(
                      "div",
                      { key: row.label, className: "compare-row" },
                      React.createElement("span", { className: "compare-label" }, row.label),
                      row.values.map((value) =>
                        React.createElement(
                          "span",
                          {
                            key: `${row.label}-${value.planName}`,
                            className: `compare-value${value.best ? " best" : ""}`,
                          },
                          value.text,
                        ),
                      ),
                    ),
                  ),
                ),
              )
            : React.createElement(
                "div",
                { className: "empty-card tall" },
                React.createElement("p", { className: "eyebrow" }, "No Comparison Yet"),
                React.createElement("h3", null, "Generate plans first"),
                React.createElement("p", null, "Open planning, select your route, and run the simulation. The compare page will then show the three generated scenarios."),
              ),
        ),
          React.createElement(
            "aside",
          { className: "dashboard-panel dashboard-panel-right" },
          React.createElement("p", { className: "eyebrow" }, "Recommendation"),
          scenarioPlans.length
            ? React.createElement(
                React.Fragment,
                null,
                React.createElement(
                  "div",
                  { className: "dashboard-output-card" },
                  React.createElement("span", { className: "dashboard-output-label" }, "Fastest option"),
                  React.createElement("strong", { className: "dashboard-output-value" }, bestScenario.name),
                ),
                React.createElement(
                  "div",
                  { className: "dashboard-note-card" },
                  React.createElement("span", { className: "dashboard-note-label" }, "Why it wins"),
                  React.createElement("p", null, `${bestScenario.workerCount} workers and ${bestScenario.truckCount} trucks produce the shortest total ETA of ${formatMinutes(bestScenario.totalMinutes)}.`),
                ),
                React.createElement(
                  "div",
                  { className: "dashboard-recent-list" },
                  scenarioPlans.map((plan, index) =>
                    React.createElement(ScenarioCard, {
                      key: plan.name,
                      plan,
                      active: plan.name === bestScenario.name,
                      onSelect: () => onNavigate("planner"),
                    }),
                  ),
                ),
              )
            : React.createElement(
                "div",
                { className: "dashboard-note-card" },
                React.createElement("span", { className: "dashboard-note-label" }, "Status"),
                React.createElement("p", null, "No scenario plans are available yet."),
              ),
        ),
      ),
    ),
  );
}

function LoginScreen({ email, password, onEmailChange, onPasswordChange, onSubmit }) {
  return React.createElement(
    "main",
    { className: "screen login-screen" },
    React.createElement("div", { className: "screen-grid" }),
    React.createElement(
      "section",
      { className: "login-card" },
      React.createElement("p", { className: "eyebrow" }, "RigSync Access"),
      React.createElement("h1", null, "Mission control for rig moves"),
      React.createElement(
        "p",
        { className: "hero-copy" },
        "A dark operations dashboard inspired by your references, with quick access to planning and saved transfer runs.",
      ),
      React.createElement(
        "form",
        {
          className: "login-form",
          onSubmit: (event) => {
            event.preventDefault();
            onSubmit();
          },
        },
        React.createElement(
          "label",
          { className: "control-field" },
          React.createElement("span", null, "Email"),
          React.createElement("input", {
            type: "email",
            value: email,
            placeholder: "operations@rigsync.io",
            onChange: (event) => onEmailChange(event.target.value),
          }),
        ),
        React.createElement(
          "label",
          { className: "control-field" },
          React.createElement("span", null, "Password"),
          React.createElement("input", {
            type: "password",
            value: password,
            placeholder: "Enter any password",
            onChange: (event) => onPasswordChange(event.target.value),
          }),
        ),
        React.createElement("button", { type: "submit", className: "primary-button" }, "Login"),
      ),
      React.createElement(
        "div",
        { className: "login-meta" },
        React.createElement(Stat, { label: "Access", value: "Prototype" }),
        React.createElement(Stat, { label: "Auth", value: "Bypass Enabled" }),
      ),
    ),
  );
}

function HomeScreen({ history, loadCount, simulation, currentMinute, onNavigate }) {
  const snapshot = buildDashboardSnapshot({
    history,
    simulation,
    currentMinute,
    loadCount,
  });
  const recentPlans = history.slice(0, 3);
  const stageData = [
    {
      label: "Rig down",
      percentage: Math.min(100, Math.max(18, snapshot.completion + 14)),
      tone: "warm",
      duration: `${Math.max(3, Math.round(snapshot.totalMinutes * 0.31 / 60))} hr window`,
    },
    {
      label: "Rig move",
      percentage: Math.min(100, Math.max(12, snapshot.completion)),
      tone: "accent",
      duration: snapshot.routeTime,
    },
    {
      label: "Rig up",
      percentage: Math.min(100, Math.max(8, snapshot.completion - 21)),
      tone: "ok",
      duration: `${Math.max(2, Math.round(snapshot.totalMinutes * 0.24 / 60))} hr window`,
    },
  ];

  return React.createElement(
    "main",
    { className: "screen home-screen dashboard-screen" },
    React.createElement("div", { className: "screen-grid" }),
    React.createElement(
      "section",
      { className: "dashboard-shell" },
      React.createElement(DashboardTopbar, {
        activeScreen: "home",
        title: "Futuristic logistics dashboard",
        subtitle: "Command deck for rig transfer planning, routing, and archival review.",
        onNavigate,
      }),
      React.createElement(
        "div",
        { className: "dashboard-layout" },
        React.createElement(
          "aside",
          { className: "dashboard-panel dashboard-panel-left" },
          React.createElement("p", { className: "eyebrow" }, "Simulation Inputs"),
          React.createElement("h2", null, "Post-login command deck"),
          React.createElement("p", { className: "panel-note" }, "Use the planner for new runs or jump into saved routes from the archive."),
          React.createElement(
            "div",
            { className: "dashboard-metric-stack" },
            React.createElement(Stat, { label: "Saved plans", value: String(snapshot.savedPlans).padStart(2, "0"), tone: "accent" }),
            React.createElement(Stat, { label: "Logical loads", value: String(snapshot.loadCount).padStart(2, "0") }),
            React.createElement(Stat, { label: "Fleet ready", value: `${snapshot.truckCount} trucks`, tone: "warm" }),
            React.createElement(Stat, { label: "Crew pool", value: `${snapshot.workerCount} workers` }),
          ),
          React.createElement(
            "div",
            { className: "dashboard-action-stack" },
            React.createElement(
              "button",
              { type: "button", className: "primary-button dashboard-launch", onClick: () => onNavigate("planner") },
              "Open planner",
            ),
            React.createElement(
              "button",
              { type: "button", className: "ghost-button dashboard-launch ghost", onClick: () => onNavigate("history") },
              "Review archive",
            ),
          ),
          React.createElement(
            "div",
            { className: "dashboard-note-card" },
            React.createElement("span", { className: "dashboard-note-label" }, "Scenario"),
            React.createElement("strong", null, snapshot.planName),
            React.createElement("p", null, `${snapshot.routeSource}. ${snapshot.activeTrips} active truck movements across the current route.`),
          ),
        ),
        React.createElement(
          "section",
          { className: "dashboard-map-stage" },
          React.createElement(
            "div",
            { className: "dashboard-map-header" },
            React.createElement("p", { className: "eyebrow" }, "Route Visualization"),
            React.createElement("h2", null, "Eastern Province rig corridor"),
            React.createElement("p", { className: "hero-copy" }, snapshot.routeTitle),
          ),
          React.createElement(
            "div",
            { className: "dashboard-map-canvas" },
            React.createElement(RealMap, {
              startPoint: snapshot.startPoint,
              endPoint: snapshot.endPoint,
              onSelectStart: () => {},
              onSelectEnd: () => {},
              simulation,
              currentMinute,
              readOnly: true,
            }),
            React.createElement(
              "div",
              { className: "dashboard-summary-card" },
              React.createElement("h3", null, "Route summary"),
              React.createElement(
                "div",
                { className: "dashboard-summary-grid" },
                React.createElement("span", null, "Distance"),
                React.createElement("strong", null, `${snapshot.routeKm} km`),
                React.createElement("span", null, "ETA"),
                React.createElement("strong", null, snapshot.eta),
                React.createElement("span", null, "Active trucks"),
                React.createElement("strong", null, `${snapshot.activeTrips} / ${snapshot.truckCount}`),
              ),
            ),
          ),
          React.createElement(
            "div",
            { className: "dashboard-bottom-strip" },
            React.createElement(
              "div",
              { className: "dashboard-mini-stat" },
              React.createElement("span", null, "Current time"),
              React.createElement("strong", null, formatMinutes(snapshot.elapsedMinutes)),
            ),
            React.createElement(
              "div",
              { className: "dashboard-mini-stat" },
              React.createElement("span", null, "Travel window"),
              React.createElement("strong", null, snapshot.routeTime),
            ),
            React.createElement(
              "button",
              { type: "button", className: "secondary-button", onClick: () => onNavigate("planner") },
              "Run simulation",
            ),
          ),
        ),
        React.createElement(
          "aside",
          { className: "dashboard-panel dashboard-panel-right" },
          React.createElement("p", { className: "eyebrow" }, "Simulation Output"),
          React.createElement(
            "div",
            { className: "dashboard-output-card" },
            React.createElement("span", { className: "dashboard-output-label" }, "Current time"),
            React.createElement("strong", { className: "dashboard-output-value" }, formatMinutes(snapshot.elapsedMinutes)),
          ),
          React.createElement(
            "div",
            { className: "dashboard-output-card" },
            React.createElement("span", { className: "dashboard-output-label" }, "Total distance"),
            React.createElement("strong", { className: "dashboard-output-value" }, `${snapshot.routeKm} km`),
          ),
          React.createElement(
            "div",
            { className: "dashboard-progress-stack" },
            stageData.map((item) =>
              React.createElement(
                "article",
                { key: item.label, className: "dashboard-progress-card" },
                React.createElement(
                  "div",
                  { className: "dashboard-progress-head" },
                  React.createElement("span", null, item.label),
                  React.createElement("strong", null, `${item.percentage}%`),
                ),
                React.createElement(
                  "div",
                  { className: "dashboard-progress-rail" },
                  React.createElement("div", {
                    className: `dashboard-progress-bar tone-${item.tone}`,
                    style: { width: `${item.percentage}%` },
                  }),
                ),
                React.createElement("p", { className: "panel-note" }, item.duration),
              ),
            ),
          ),
          React.createElement(
            "div",
            { className: "dashboard-note-card dashboard-note-card-right" },
            React.createElement("span", { className: "dashboard-note-label" }, "Simulation notes"),
            React.createElement(
              "p",
              null,
              "Current estimates assume normal convoy spacing and direct route access. Open the planner to place exact rigs and regenerate the live map.",
            ),
          ),
          React.createElement(
            "section",
            { className: "dashboard-recent-list" },
            React.createElement("span", { className: "dashboard-note-label" }, "Recent plans"),
            recentPlans.length
              ? recentPlans.map((entry) =>
                  React.createElement(
                    "button",
                    {
                      key: entry.id,
                      type: "button",
                      className: "dashboard-recent-card",
                      onClick: () => onNavigate("history"),
                    },
                    React.createElement("strong", null, entry.planName),
                    React.createElement("span", null, entry.routeTime),
                    React.createElement("p", null, entry.title),
                  ),
                )
              : React.createElement(
                  "div",
                  { className: "dashboard-recent-card empty" },
                  React.createElement("strong", null, "No saved plans yet"),
                  React.createElement("p", null, "Run your first simulation to populate the archive."),
                ),
          ),
        ),
      ),
    ),
  );
}

function HistoryScreen({ history, onNavigate }) {
  const latestEntry = history[0] || null;
  const stats = latestEntry
    ? [
        { label: "Best ETA", value: latestEntry.eta, tone: "accent" },
        { label: "Travel", value: latestEntry.routeTime },
        { label: "Fleet", value: `${latestEntry.workers}W / ${latestEntry.trucks}T`, tone: "warm" },
      ]
    : [
        { label: "Best ETA", value: "--" },
        { label: "Travel", value: "--" },
        { label: "Fleet", value: "--" },
      ];

  return React.createElement(
    "main",
    { className: "screen history-screen dashboard-screen" },
    React.createElement("div", { className: "screen-grid" }),
    React.createElement(
      "section",
      { className: "dashboard-shell" },
      React.createElement(DashboardTopbar, {
        activeScreen: "history",
        title: "Saved rig plans",
        subtitle: "Archive of generated routes, timings, and fleet allocations.",
        onNavigate,
      }),
      React.createElement(
        "div",
        { className: "dashboard-layout archive-layout" },
        React.createElement(
          "aside",
          { className: "dashboard-panel dashboard-panel-left" },
          React.createElement("p", { className: "eyebrow" }, "Archive Summary"),
          React.createElement("h2", null, "Stored operations"),
          React.createElement("p", { className: "panel-note" }, "Review generated plans and reopen planning from the same dashboard system."),
          React.createElement(
            "div",
            { className: "dashboard-metric-stack" },
            React.createElement(Stat, { label: "Saved plans", value: String(history.length).padStart(2, "0"), tone: "accent" }),
            stats.map((item) =>
              React.createElement(Stat, {
                key: item.label,
                label: item.label,
                value: item.value,
                tone: item.tone || "default",
              }),
            ),
          ),
          React.createElement(
            "div",
            { className: "dashboard-action-stack" },
            React.createElement(
              "button",
              { type: "button", className: "primary-button dashboard-launch", onClick: () => onNavigate("planner") },
              "Create new plan",
            ),
            React.createElement(
              "button",
              { type: "button", className: "ghost-button dashboard-launch ghost", onClick: () => onNavigate("home") },
              "Back to dashboard",
            ),
          ),
        ),
        React.createElement(
          "section",
          { className: "dashboard-map-stage archive-stage" },
          React.createElement(
            "div",
            { className: "dashboard-map-header" },
            React.createElement("p", { className: "eyebrow" }, "Archive"),
            React.createElement("h2", null, "Saved route plans"),
            React.createElement("p", { className: "hero-copy" }, "Historical runs captured from the planner, including ETA, route time, and crew / truck allocations."),
          ),
          React.createElement(
            "section",
            { className: "history-list dashboard-history-list" },
            history.length
              ? history.map((entry) =>
                  React.createElement(
                    "article",
                    { className: "history-card dashboard-history-card", key: entry.id },
                    React.createElement(
                      "div",
                      { className: "history-head" },
                      React.createElement(
                        "div",
                        null,
                        React.createElement("p", { className: "eyebrow" }, entry.planName),
                        React.createElement("h3", null, entry.title),
                      ),
                      React.createElement("span", { className: "history-date" }, entry.createdAt),
                    ),
                    React.createElement(
                      "div",
                      { className: "stats-grid compact" },
                      React.createElement(Stat, { label: "ETA", value: entry.eta }),
                      React.createElement(Stat, { label: "Travel", value: entry.routeTime }),
                      React.createElement(Stat, { label: "Fleet", value: `${entry.workers}W / ${entry.trucks}T` }),
                    ),
                    React.createElement("p", { className: "panel-note" }, `From ${entry.start} to ${entry.end}`),
                  ),
                )
              : React.createElement(
                  "div",
                  { className: "empty-card" },
                  React.createElement("h3", null, "No saved rig plans yet"),
                  React.createElement("p", null, "Create a plan first, then it will appear here automatically."),
                ),
          ),
        ),
        React.createElement(
          "aside",
          { className: "dashboard-panel dashboard-panel-right" },
          React.createElement("p", { className: "eyebrow" }, "Archive Notes"),
          React.createElement(
            "div",
            { className: "dashboard-note-card" },
            React.createElement("span", { className: "dashboard-note-label" }, "Retention"),
            React.createElement("strong", null, "10 recent plans"),
            React.createElement("p", null, "The archive is stored locally in browser history and updates automatically after each successful simulation."),
          ),
          React.createElement(
            "div",
            { className: "dashboard-note-card" },
            React.createElement("span", { className: "dashboard-note-label" }, "Latest route"),
            React.createElement("strong", null, latestEntry?.title || "No routes yet"),
            React.createElement("p", null, latestEntry ? `${latestEntry.planName} • ${latestEntry.routeTime}` : "Run the planner to create the first route record."),
          ),
        ),
      ),
    ),
  );
}

function PlannerScreen({
  loads,
  loading,
  error,
  routeMode,
  routingMessage,
  startPoint,
  endPoint,
  workers,
  trucks,
  simulation,
  currentMinute,
  playbackSpeed,
  onNavigate,
  onStartPoint,
  onEndPoint,
  onWorkers,
  onTrucks,
  onPlaybackSpeed,
  onRun,
}) {
  const scenarioPlans = simulation?.scenarioPlans || [];
  const bestScenario = scenarioPlans.reduce(
    (best, plan) => (!best || plan.totalMinutes < best.totalMinutes ? plan : best),
    null,
  );

  return React.createElement(
    "main",
    { className: "screen planner-screen dashboard-screen" },
    React.createElement("div", { className: "screen-grid" }),
    React.createElement(
      "section",
      { className: "dashboard-shell" },
      React.createElement(DashboardTopbar, {
        activeScreen: "planner",
        title: "Pre-move planing",
        subtitle: "",
        onNavigate,
      }),
      React.createElement(
        "div",
        { className: "dashboard-layout" },
        React.createElement(
          "aside",
          { className: "dashboard-panel dashboard-panel-left" },
          React.createElement("p", { className: "eyebrow" }, "Simulation Inputs"),
          React.createElement("h2", null, "Post-login command deck"),
          React.createElement(
            "div",
            { className: "dashboard-metric-stack planning-input-stack" },
            React.createElement(Stat, {
              label: "Start location",
              value: startPoint ? formatCoordinate(startPoint) : "Not selected",
              tone: "accent",
            }),
            React.createElement(Stat, {
              label: "Destination",
              value: endPoint ? formatCoordinate(endPoint) : "Not selected",
            }),
            React.createElement(Stat, {
              label: "Number of trucks",
              value: `${trucks} trucks`,
              tone: "warm",
            }),
            React.createElement(Stat, {
              label: "Number of workers",
              value: `${workers} workers`,
            }),
          ),
          React.createElement(
            "div",
            { className: "planning-field-stack" },
            React.createElement(
              "label",
              { className: "control-field" },
              React.createElement("span", null, "Workers"),
              React.createElement("input", {
                type: "number",
                min: "1",
                value: workers,
                onChange: (event) => onWorkers(event.target.value),
              }),
            ),
            React.createElement(
              "label",
              { className: "control-field" },
              React.createElement("span", null, "Trucks"),
              React.createElement("input", {
                type: "number",
                min: "1",
                value: trucks,
                onChange: (event) => onTrucks(event.target.value),
              }),
            ),
            React.createElement(SpeedControl, { speed: playbackSpeed, onChange: onPlaybackSpeed }),
          ),
          React.createElement("button", { type: "button", className: "primary-button dashboard-launch", onClick: onRun }, "Generate plan"),
          React.createElement("p", { className: "panel-note" }, "Use the map buttons to pick the source and destination rigs."),
          routingMessage ? React.createElement("p", { className: "panel-note" }, routingMessage) : null,
          loading ? React.createElement("p", { className: "panel-note" }, "Loading load dataset...") : null,
          error ? React.createElement("p", { className: "panel-note error-text" }, error) : null,
        ),
        React.createElement(
          "section",
          { className: "dashboard-map-stage planner-map-stage" },
          React.createElement(
            "div",
            { className: "dashboard-map-header" },
            React.createElement("p", { className: "eyebrow" }, "Route Visualization"),
            React.createElement("h2", null, "Live route map"),
            React.createElement("p", { className: "hero-copy" }, "Set the two rig points on the map, run the planner, and watch the recommended move play out."),
          ),
          React.createElement(
            "div",
            { className: "dashboard-map-canvas live-map-canvas" },
            React.createElement(RealMap, {
              startPoint,
              endPoint,
              onSelectStart: onStartPoint,
              onSelectEnd: onEndPoint,
              simulation,
              currentMinute,
            }),
          ),
          React.createElement(
            "div",
            { className: "dashboard-bottom-strip" },
            React.createElement(
              "div",
              { className: "dashboard-mini-stat" },
              React.createElement("span", null, "Loads"),
              React.createElement("strong", null, loading ? "..." : String(buildLogicalLoads(loads).length)),
            ),
            React.createElement(
              "div",
              { className: "dashboard-mini-stat" },
              React.createElement("span", null, "Routing"),
              React.createElement("strong", null, routeMode === "live" ? "Live" : "Estimated"),
            ),
            React.createElement(
              "button",
              { type: "button", className: "ghost-button", onClick: () => onNavigate("home") },
              "Back to dashboard",
            ),
          ),
        ),
        React.createElement(
          "aside",
          { className: "dashboard-panel dashboard-panel-right" },
          simulation
            ? React.createElement(
                React.Fragment,
                null,
                React.createElement(
                  "div",
                  { className: "panel-block" },
                  React.createElement("p", { className: "eyebrow" }, "Primary Result"),
                  React.createElement("h2", null, "Recommended operation"),
                  React.createElement(
                    "div",
                    { className: "stats-grid compact" },
                    React.createElement(Stat, { label: "Travel", value: formatMinutes(simulation.routeMinutes) }),
                    React.createElement(Stat, { label: "Routing", value: routeMode === "live" ? "Live" : "Estimated" }),
                    React.createElement(Stat, { label: "ETA", value: formatMinutes(simulation.bestPlan.totalMinutes), tone: "accent" }),
                  ),
                ),
                React.createElement(PhasePanel, { simulation, currentMinute }),
                React.createElement(
                  "section",
                  { className: "dashboard-recent-list" },
                  scenarioPlans.map((plan, index) =>
                    React.createElement(ScenarioCard, {
                      key: plan.name,
                      plan,
                      active: plan.name === bestScenario?.name,
                      onSelect: () => onNavigate("compare"),
                    }),
                  ),
                ),
              )
            : React.createElement(
                "div",
                { className: "empty-card tall" },
                React.createElement("p", { className: "eyebrow" }, "No Run Yet"),
                React.createElement("h3", null, "Generate your first plan"),
                React.createElement(
                  "p",
                  null,
                  "After you select both rig locations and click Generate plan, the recommended transfer path and saved history will appear here.",
                ),
                React.createElement(
                  "div",
                  { className: "stats-grid compact" },
                  React.createElement(Stat, { label: "Loads", value: loading ? "..." : String(buildLogicalLoads(loads).length) }),
                  React.createElement(Stat, { label: "Routing", value: "Ready" }),
                  React.createElement(Stat, { label: "Archive", value: "Auto-save" }),
                ),
              ),
        ),
      ),
    ),
  );
}

function App() {
  const [loads, setLoads] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [routeMode, setRouteMode] = useState("estimated");
  const [routingMessage, setRoutingMessage] = useState("");
  const [startPoint, setStartPoint] = useState(null);
  const [endPoint, setEndPoint] = useState(null);
  const [workers, setWorkers] = useState("4");
  const [trucks, setTrucks] = useState("2");
  const [simulation, setSimulation] = useState(null);
  const [history, setHistory] = useState([]);
  const [currentMinute, setCurrentMinute] = useState(0);
  const [playbackSpeed, setPlaybackSpeed] = useState(1);
  const [screen, setScreen] = useState(getInitialScreen);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const animationFrameRef = useRef(null);
  const animationStartedAtRef = useRef(null);
  const logicalLoads = buildLogicalLoads(loads);

  useEffect(() => {
    setHistory(readHistoryEntries());
  }, []);

  useEffect(() => {
    async function fetchLoads() {
      try {
        const response = await fetch("/api/loads");
        if (!response.ok) {
          throw new Error(`Request failed with ${response.status}`);
        }

        const data = await response.json();
        setLoads(data);
      } catch (err) {
        setError(err.message || "Failed to load data");
      } finally {
        setLoading(false);
      }
    }

    fetchLoads();
  }, []);

  useEffect(() => {
    if (!simulation?.bestPlan?.totalMinutes) {
      return undefined;
    }

    animationStartedAtRef.current = null;

    const animate = (timestamp) => {
      if (animationStartedAtRef.current === null) {
        animationStartedAtRef.current = timestamp;
      }

      const elapsedSeconds = (timestamp - animationStartedAtRef.current) / 1000;
      const simulatedMinutes =
        elapsedSeconds * (simulation.bestPlan.totalMinutes / BASE_PLAYBACK_SECONDS) * playbackSpeed;
      const nextMinute = Math.min(simulation.bestPlan.totalMinutes, simulatedMinutes);

      setCurrentMinute(nextMinute);

      if (nextMinute < simulation.bestPlan.totalMinutes) {
        animationFrameRef.current = window.requestAnimationFrame(animate);
      }
    };

    animationFrameRef.current = window.requestAnimationFrame(animate);

    return () => {
      if (animationFrameRef.current !== null) {
        window.cancelAnimationFrame(animationFrameRef.current);
      }
      animationFrameRef.current = null;
      animationStartedAtRef.current = null;
    };
  }, [simulation, playbackSpeed]);

  async function runSimulation() {
    if (!startPoint || !endPoint) {
      setRoutingMessage("Pick both rig locations on the map first.");
      return;
    }

    if (!logicalLoads.length) {
      setRoutingMessage("The load dataset has not finished loading yet.");
      return;
    }

    const workerCount = Math.max(1, Number.parseInt(workers, 10) || 1);
    const truckCount = Math.max(1, Number.parseInt(trucks, 10) || 1);
    const capacity = Math.max(1, Math.min(workerCount, truckCount));
    let routeData = fallbackRouteData(startPoint, endPoint);

    try {
      routeData = await fetchRouteData(startPoint, endPoint);
      setRouteMode("live");
      setRoutingMessage("Using routed driving time from the map service.");
    } catch {
      setRouteMode("estimated");
      setRoutingMessage("Live routing was unavailable. Using straight-line travel estimate.");
    }

    const scenarioPlans = buildScenarioPlans(logicalLoads, routeData, workerCount, truckCount);
    const bestScenario = scenarioPlans[0] || null;
    const bestPlan = bestScenario?.bestVariant || null;

    if (!bestPlan) {
      setRoutingMessage("No plan variants could be generated from the current loads.");
      return;
    }

    const nextSimulation = {
      startPoint,
      endPoint,
      workerCount,
      truckCount,
      capacity,
      routeMinutes: routeData.minutes,
      routeSource: routeData.source,
      routeGeometry: routeData.geometry,
      scenarioPlans,
      plans: bestScenario.variantPlans,
      bestPlan,
      bestScenario,
    };

    setSimulation(nextSimulation);
    setCurrentMinute(0);

    const historyEntry = {
      id: String(Date.now()),
      createdAt: new Date().toLocaleString(),
      title: `${formatCoordinate(startPoint)} to ${formatCoordinate(endPoint)}`,
      planName: bestScenario.name,
      eta: formatMinutes(bestPlan.totalMinutes),
      routeTime: formatMinutes(routeData.minutes),
      workers: bestScenario.workerCount,
      trucks: bestScenario.truckCount,
      start: formatCoordinate(startPoint),
      end: formatCoordinate(endPoint),
    };

    setHistory(saveHistoryEntry(historyEntry));
  }

  if (screen === "login") {
    return React.createElement(LoginScreen, {
      email,
      password,
      onEmailChange: setEmail,
      onPasswordChange: setPassword,
      onSubmit: () => setScreen("planner"),
    });
  }

  if (screen === "compare" || screen === "history") {
    return React.createElement(CompareScreen, {
      simulation,
      routeMode,
      onNavigate: setScreen,
    });
  }

  if (screen === "home" || screen === "planner") {
    return React.createElement(PlannerScreen, {
      loads,
      loading,
      error,
      routeMode,
      routingMessage,
      startPoint,
      endPoint,
      workers,
      trucks,
      simulation,
      currentMinute,
      playbackSpeed,
      onNavigate: setScreen,
      onStartPoint: setStartPoint,
      onEndPoint: setEndPoint,
      onWorkers: setWorkers,
      onTrucks: setTrucks,
      onPlaybackSpeed: setPlaybackSpeed,
      onRun: runSimulation,
    });
  }

  return null;
}

createRoot(document.getElementById("root")).render(React.createElement(App));

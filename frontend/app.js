import React, { useEffect, useRef, useState } from "https://esm.sh/react@18";
import { createRoot } from "https://esm.sh/react-dom@18/client";

const MIN_LOAD_DURATION_MINUTES = 30;
const MAX_LOAD_DURATION_MINUTES = 120;
const DEFAULT_CENTER = [24.7136, 46.6753];
const BASE_PLAYBACK_SECONDS = 40;

function Stat({ label, value }) {
  return React.createElement(
    "div",
    { className: "stat" },
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

function getLoadDurationMinutes(loadId) {
  const seeded = ((loadId * 37) % (MAX_LOAD_DURATION_MINUTES - MIN_LOAD_DURATION_MINUTES + 1));
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
    `https://router.project-osrm.org/route/v1/driving/${coordinates}?overview=full&geometries=geojson`
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
        truckId: truck.id,
        loadId: load.id,
        title: `Truck ${truck.id} starts loading #${load.id}`,
        description: `Stage ${waveIndex + 1}: rig down for ${load.description} at the source rig for ${formatMinutes(load.rig_down_duration || 0)}.`,
      });

      steps.push({
        type: "load-finish",
        minute: rigDownFinish,
        truckId: truck.id,
        loadId: load.id,
        title: `Truck ${truck.id} departs with load #${load.id}`,
        description: `${load.description} is secured and moving toward the destination rig.`,
      });

      steps.push({
        type: "arrival",
        minute: arrivalAtDestination,
        truckId: truck.id,
        loadId: load.id,
        title: `Truck ${truck.id} delivers load #${load.id}`,
        description: `${load.description} arrives at the destination rig.`,
      });

      steps.push({
        type: "rig-up-finish",
        minute: rigUpFinish,
        truckId: truck.id,
        loadId: load.id,
        title: `Truck ${truck.id} completes rig up for #${load.id}`,
        description: `${load.description} is rigged up at the destination in ${formatMinutes(load.rig_up_duration || 0)}.`,
      });

      truck.availableAt = returnToSource;
      stageArrivals.push(rigUpFinish);
    });

    stageReadyAt = Math.max(...stageArrivals);

    steps.push({
      type: "stage-complete",
      minute: stageReadyAt,
      title: `Stage ${waveIndex + 1} complete`,
      description: `All loads in stage ${waveIndex + 1} have been transferred.`,
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
    return "Waiting at source";
  }

  if (currentMinute < activeTrip.rigDownFinish) {
    return `Loading #${activeTrip.loadId}`;
  }
  if (currentMinute < activeTrip.arrivalAtDestination) {
    return `Going to destination with #${activeTrip.loadId}`;
  }
  if (currentMinute < activeTrip.rigUpFinish) {
    return `Rig Up #${activeTrip.loadId}`;
  }
  if (activeTrip.returnToSource && currentMinute < activeTrip.returnToSource) {
    return "Returning empty";
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
      (currentMinute - activeTrip.rigDownFinish) /
        (activeTrip.arrivalAtDestination - activeTrip.rigDownFinish || 1)
    );
  }
  if (currentMinute < activeTrip.rigUpFinish) {
    return { lat: outbound[outbound.length - 1][0], lng: outbound[outbound.length - 1][1] };
  }
  if (activeTrip.returnToSource && currentMinute < activeTrip.returnToSource) {
    return interpolatePath(
      inbound,
      (currentMinute - activeTrip.rigUpFinish) /
        (activeTrip.returnToSource - activeTrip.rigUpFinish || 1)
    );
  }

  return { lat: outbound[outbound.length - 1][0], lng: outbound[outbound.length - 1][1] };
}

function createTruckIcon(truckId) {
  const svg = `
    <svg width="44" height="44" viewBox="0 0 44 44" fill="none" xmlns="http://www.w3.org/2000/svg">
      <g filter="url(#shadow)">
        <path d="M10 24.5C10 20.9101 12.9101 18 16.5 18H25.5C28.5376 18 31 20.4624 31 23.5V28.5H10V24.5Z" fill="#3F3A8A"/>
        <path d="M31 21H34.7C35.5546 21 36.3542 21.4091 36.85 22.1L39.15 25.3C39.6987 26.0634 40 27.0001 40 27.9403V28.5H31V21Z" fill="#5A54C5"/>
        <rect x="14" y="20.5" width="6.5" height="4.5" rx="1.2" fill="#E8F0FF"/>
        <rect x="22" y="20.5" width="6.5" height="4.5" rx="1.2" fill="#E8F0FF"/>
        <circle cx="16.5" cy="30.5" r="3.5" fill="#1E1B4B"/>
        <circle cx="16.5" cy="30.5" r="1.7" fill="#F8FAFC"/>
        <circle cx="33.5" cy="30.5" r="3.5" fill="#1E1B4B"/>
        <circle cx="33.5" cy="30.5" r="1.7" fill="#F8FAFC"/>
        <path d="M31 23.2H35.1L36.8 25.6H31V23.2Z" fill="#E8F0FF"/>
      </g>
      <circle cx="35" cy="10" r="7" fill="#FF7A1A"/>
      <text x="35" y="12.5" text-anchor="middle" font-family="Space Grotesk, sans-serif" font-size="8" font-weight="700" fill="white">${truckId}</text>
      <defs>
        <filter id="shadow" x="2" y="11" width="40" height="29" filterUnits="userSpaceOnUse" color-interpolation-filters="sRGB">
          <feFlood flood-opacity="0" result="BackgroundImageFix"/>
          <feColorMatrix in="SourceAlpha" type="matrix" values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 127 0" result="hardAlpha"/>
          <feOffset dy="2"/>
          <feGaussianBlur stdDeviation="3"/>
          <feComposite in2="hardAlpha" operator="out"/>
          <feColorMatrix type="matrix" values="0 0 0 0 0.149 0 0 0 0 0.137 0 0 0 0 0.404 0 0 0 0.28 0"/>
          <feBlend mode="normal" in2="BackgroundImageFix" result="effect1_dropShadow_1_1"/>
          <feBlend mode="normal" in="SourceGraphic" in2="effect1_dropShadow_1_1" result="shape"/>
        </filter>
      </defs>
    </svg>`;

  return window.L.divIcon({
    className: "truck-marker-icon",
    html: `<div class="truck-marker-body">${svg}</div>`,
    iconSize: [44, 44],
    iconAnchor: [22, 22],
  });
}

function buildRigTooltipHtml(simulation, currentMinute, side) {
  if (!simulation?.bestPlan?.playback?.trips?.length) {
    return `<div class="rig-tooltip"><strong>${side === "start" ? "Start rig" : "End rig"}</strong><p>No simulation running yet.</p></div>`;
  }

  const trips = simulation.bestPlan.playback.trips;
  let title = "";
  let items = [];

  if (side === "start") {
    title = "Loads still at start rig";
    items = trips.filter((trip) => currentMinute < trip.arrivalAtDestination);
  } else {
    title = "Loads at end rig";
    items = trips.filter((trip) => currentMinute >= trip.arrivalAtDestination);
  }

  const rows = items
    .slice(0, 8)
    .map((trip) => {
      let status = "";
      if (side === "start") {
        if (currentMinute < trip.loadStart) {
          status = "waiting";
        } else if (currentMinute < trip.rigDownFinish) {
          status = "rig down";
        } else if (currentMinute < trip.arrivalAtDestination) {
          status = "in transit";
        }
      } else if (currentMinute < trip.rigUpFinish) {
        status = "rig up";
      } else {
        status = "ready";
      }

      return `<li><span>#${trip.loadId} ${trip.description}</span><em>${status}</em></li>`;
    })
    .join("");

  const extra =
    items.length > 8 ? `<p class="rig-tooltip-more">+${items.length - 8} more</p>` : "";

  return `<div class="rig-tooltip"><strong>${title}</strong>${items.length ? `<ul>${rows}</ul>${extra}` : `<p>None right now.</p>`}</div>`;
}

function buildPhaseBreakdown(simulation, currentMinute) {
  if (!simulation?.bestPlan) {
    return [];
  }

  const loads = simulation.bestPlan.waves.flat();
  const trips = simulation.bestPlan.playback.trips;

  const rigDownTotal = loads.reduce(
    (total, load) => total + (load.rig_down_duration || 0),
    0
  );
  const rigDownCompleted = trips.reduce((total, trip) => {
    const completedMinutes = Math.max(
      0,
      Math.min(currentMinute, trip.rigDownFinish) - trip.loadStart
    );
    const load = loads.find((item) => item.id === trip.loadId);
    return total + Math.min(completedMinutes, load?.rig_down_duration || 0);
  }, 0);

  const rigMoveTotal = trips.length * simulation.routeMinutes;
  const rigMoveCompleted = trips.reduce((total, trip) => {
    const completedMinutes = Math.max(
      0,
      Math.min(currentMinute, trip.arrivalAtDestination) - trip.rigDownFinish
    );
    return total + Math.min(completedMinutes, simulation.routeMinutes);
  }, 0);

  const rigUpTotal = loads.reduce(
    (total, load) => total + (load.rig_up_duration || 0),
    0
  );
  const rigUpCompleted = trips.reduce((total, trip) => {
    const load = loads.find((item) => item.id === trip.loadId);
    const completedMinutes = Math.max(
      0,
      Math.min(currentMinute, trip.rigUpFinish) - trip.arrivalAtDestination
    );
    return total + Math.min(completedMinutes, load?.rig_up_duration || 0);
  }, 0);

  return [
    {
      label: "Rig Down",
      completed: rigDownCompleted,
      total: rigDownTotal,
      percent: rigDownTotal ? (rigDownCompleted / rigDownTotal) * 100 : 0,
    },
    {
      label: "Rig Move",
      completed: rigMoveCompleted,
      total: rigMoveTotal,
      percent: rigMoveTotal ? (rigMoveCompleted / rigMoveTotal) * 100 : 0,
    },
    {
      label: "Rig Up",
      completed: rigUpCompleted,
      total: rigUpTotal,
      percent: rigUpTotal ? (rigUpCompleted / rigUpTotal) * 100 : 0,
    },
  ];
}

function PhaseBars({ simulation, currentMinute }) {
  const phases = buildPhaseBreakdown(simulation, currentMinute);

  return React.createElement(
    "section",
    { className: "phase-bars-panel" },
    React.createElement("p", { className: "eyebrow" }, "Process Split"),
    React.createElement("h3", null, "Rig Down / Move / Up"),
    React.createElement(
      "div",
      { className: "phase-bars" },
      phases.map((phase) =>
        React.createElement(
          "div",
          { className: "phase-row", key: phase.label },
          React.createElement(
            "div",
            { className: "phase-row-top" },
            React.createElement("strong", null, phase.label),
            React.createElement(
              "span",
              null,
              `${Math.round(phase.percent)}%`,
            )
          ),
          React.createElement(
            "div",
            { className: "phase-track" },
            React.createElement("div", {
              className: `phase-fill ${phase.label.toLowerCase().replace(/\s+/g, "-")}`,
              style: { width: `${phase.percent}%` },
            })
          ),
          React.createElement(
            "p",
            { className: "phase-caption" },
            `${formatMinutes(phase.completed)} / ${formatMinutes(phase.total)} completed`
          )
        )
      )
    )
  );
}

function SimulationPlayback({ simulation, currentMinute }) {
  const [stepIndex, setStepIndex] = useState(0);

  useEffect(() => {
    setStepIndex(0);
  }, [simulation, currentMinute]);

  useEffect(() => {
    if (!simulation?.bestPlan?.playback?.steps?.length) {
      return undefined;
    }

    const visibleCount = simulation.bestPlan.playback.steps.filter(
      (step) => step.minute <= currentMinute
    ).length;
    setStepIndex(Math.max(0, visibleCount - 1));
    return undefined;
  }, [simulation, currentMinute]);

  if (!simulation?.bestPlan) {
    return null;
  }

  const visibleSteps = simulation.bestPlan.playback.steps.slice(0, stepIndex + 1);

  return React.createElement(
    "section",
    { className: "playback-panel" },
    React.createElement(
      "div",
      { className: "playback-header" },
      React.createElement("p", { className: "eyebrow" }, "Best Plan Playback"),
      React.createElement("h3", null, simulation.bestPlan.name),
      React.createElement(
        "p",
        { className: "meta large" },
        `Current simulation time: ${formatMinutes(currentMinute)} of ${formatMinutes(simulation.bestPlan.totalMinutes)}.`,
      ),
    ),
    React.createElement(
      "div",
      { className: "truck-strip" },
      Array.from({ length: simulation.truckCount }, (_, index) =>
        React.createElement(
          "div",
          { className: "truck-card", key: index + 1 },
          React.createElement("strong", null, `Truck ${index + 1}`),
          React.createElement(
            "span",
            { className: "truck-status" },
            getTruckStatus(simulation.bestPlan.playback, currentMinute, index + 1),
          ),
        ),
      ),
    ),
    React.createElement(
      "div",
      { className: "timeline" },
      visibleSteps.map((step, index) =>
        React.createElement(
          "div",
          {
            className: `timeline-step${index === visibleSteps.length - 1 ? " current" : ""}`,
            key: `${step.type}-${step.minute}-${index}`,
          },
          React.createElement("span", { className: "timeline-minute" }, formatMinutes(step.minute)),
          React.createElement(
            "div",
            { className: "timeline-copy" },
            React.createElement("strong", null, step.title),
            React.createElement("p", null, step.description),
          ),
        ),
      ),
    ),
  );
}

function RecentLogs({ simulation, currentMinute }) {
  if (!simulation?.bestPlan) {
    return React.createElement(
      "section",
      { className: "log-panel" },
      React.createElement("p", { className: "eyebrow" }, "Activity Log"),
      React.createElement("h3", null, "Latest events"),
      React.createElement(
        "p",
        { className: "empty-state" },
        "Run the simulation to see the latest transfer events here."
      )
    );
  }

  const logs = simulation.bestPlan.playback.steps
    .filter((step) => step.minute <= currentMinute)
    .slice(-6)
    .reverse();

  return React.createElement(
    "section",
    { className: "log-panel" },
    React.createElement("p", { className: "eyebrow" }, "Activity Log"),
    React.createElement("h3", null, "Latest events"),
    React.createElement(
      "div",
      { className: "log-list" },
      logs.map((log, index) =>
        React.createElement(
          "div",
          { className: "log-row", key: `${log.type}-${log.minute}-${index}` },
          React.createElement("span", { className: "log-time" }, formatMinutes(log.minute)),
          React.createElement(
            "div",
            { className: "log-copy" },
            React.createElement("strong", null, log.title),
            React.createElement("p", null, log.description)
          )
        )
      )
    )
  );
}

function SpeedControl({ speed, onChange }) {
  return React.createElement(
    "label",
    { className: "speed-control" },
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
          `${option}x`
        )
      )
    )
  );
}

function RealMap({ startPoint, endPoint, onSelectStart, onSelectEnd, simulation, currentMinute }) {
  const mapElementRef = useRef(null);
  const mapRef = useRef(null);
  const markersRef = useRef({ start: null, end: null });
  const routeLineRef = useRef(null);
  const truckMarkersRef = useRef([]);

  useEffect(() => {
    if (!mapElementRef.current || mapRef.current || !window.L) {
      return undefined;
    }

    const map = window.L.map(mapElementRef.current).setView(DEFAULT_CENTER, 6);
    window.L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19,
      attribution: "&copy; OpenStreetMap contributors",
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
      ? window.L.marker([startPoint.lat, startPoint.lng])
          .addTo(map)
          .bindTooltip(buildRigTooltipHtml(simulation, currentMinute, "start"), {
            direction: "top",
            offset: [0, -12],
            opacity: 0.96,
          })
      : null;
    markersRef.current.end = endPoint
      ? window.L.marker([endPoint.lat, endPoint.lng])
          .addTo(map)
          .bindTooltip(buildRigTooltipHtml(simulation, currentMinute, "end"), {
            direction: "top",
            offset: [0, -12],
            opacity: 0.96,
          })
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
      color: "#cb5c32",
      weight: 5,
      opacity: 0.85,
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
      const position = getTruckPosition(
        simulation.bestPlan.playback,
        simulation.routeGeometry,
        currentMinute,
        truckId
      );

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
    { className: "real-map-shell" },
    React.createElement("div", { ref: mapElementRef, className: "real-map" }),
    React.createElement(
      "div",
      { className: "map-picker-actions" },
      React.createElement(
        "button",
        {
          type: "button",
          className: "map-pick-button active-start",
          onClick: () => {
            const map = mapRef.current;
            if (!map) {
              return;
            }

            map.once("click", (event) => {
              onSelectStart({
                lat: event.latlng.lat,
                lng: event.latlng.lng,
              });
            });
          },
        },
        "Pick start rig on map",
      ),
      React.createElement(
        "button",
        {
          type: "button",
          className: "map-pick-button active-end",
          onClick: () => {
            const map = mapRef.current;
            if (!map) {
              return;
            }

            map.once("click", (event) => {
              onSelectEnd({
                lat: event.latlng.lat,
                lng: event.latlng.lng,
              });
            });
          },
        },
        "Pick end rig on map",
      ),
    ),
  );
}

function PlanCard({ plan, best, onPickLoad }) {
  return React.createElement(
    "article",
    { className: `plan-card${best ? " best" : ""}` },
    React.createElement(
      "div",
      { className: "plan-top" },
      React.createElement(
        "div",
        null,
        React.createElement("p", { className: "eyebrow" }, plan.name),
        React.createElement("h3", null, best ? "Recommended path" : "Alternative path")
      ),
      best ? React.createElement("span", { className: "best-badge" }, "Best ETA") : null
    ),
    React.createElement(
      "div",
      { className: "plan-stats" },
      React.createElement(Stat, { label: "Route", value: formatMinutes(plan.routeMinutes) }),
      React.createElement(Stat, { label: "Work", value: formatMinutes(plan.processingMinutes) }),
      React.createElement(Stat, { label: "ETA", value: formatMinutes(plan.totalMinutes) })
    ),
    React.createElement(
      "div",
      { className: "wave-list" },
      plan.waves.slice(0, 5).map((wave, index) =>
        React.createElement(
          "section",
          { className: "wave-box", key: `${plan.name}-${index}` },
          React.createElement("strong", null, `Stage ${index + 1}`),
          React.createElement(
            "div",
            { className: "wave-loads" },
            wave.map((load) =>
              React.createElement(
                "button",
                {
                  type: "button",
                  className: "mini-load",
                  key: load.id,
                  onClick: () => onPickLoad(load.id),
                },
                `#${load.id} ${load.description}`
              )
            )
          )
        )
      )
    ),
    React.createElement(
      "p",
      { className: "plan-note" },
      `First loads: ${plan.waves[0]?.map((load) => `#${load.id}`).join(", ") || "-"}`
    )
  );
}

function LoadCard({ load, isSelected, onSelect }) {
  return React.createElement(
    "button",
    {
      type: "button",
      className: `load-card${isSelected ? " selected" : ""}`,
      onClick: () => onSelect(load.id),
    },
    React.createElement(
      "div",
      { className: "load-card-top" },
      React.createElement("span", { className: "load-id" }, `Load #${load.id}`),
      load.is_critical
        ? React.createElement("span", { className: "critical-badge" }, "Critical")
        : null
    ),
    React.createElement("h3", null, load.description),
    React.createElement("p", { className: "meta" }, `${load.phase} / ${load.category}`),
    React.createElement(
      "div",
      { className: "tags" },
      React.createElement("span", { className: "tag" }, load.priority || "No Priority"),
      React.createElement("span", { className: "tag" }, load.truck_type || "No Truck"),
      React.createElement("span", { className: "tag" }, `${getLoadDurationMinutes(load.id)} min`)
    ),
    React.createElement(
      "p",
      { className: "dependency-summary" },
      load.dependency_ids.length
        ? `Depends on ${load.dependency_ids.length} load${load.dependency_ids.length > 1 ? "s" : ""}`
        : "No dependencies"
    )
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
  const [currentMinute, setCurrentMinute] = useState(0);
  const [playbackSpeed, setPlaybackSpeed] = useState(1);
  const animationFrameRef = useRef(null);
  const animationStartedAtRef = useRef(null);
  const logicalLoads = buildLogicalLoads(loads);

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
        elapsedSeconds *
        (simulation.bestPlan.totalMinutes / BASE_PLAYBACK_SECONDS) *
        playbackSpeed;
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

    const workerCount = Math.max(1, Number.parseInt(workers, 10) || 1);
    const truckCount = Math.max(1, Number.parseInt(trucks, 10) || 1);
    const capacity = Math.max(1, Math.min(workerCount, truckCount));
    let routeData = fallbackRouteData(startPoint, endPoint);

    try {
      routeData = await fetchRouteData(startPoint, endPoint);
      setRouteMode("live");
      setRoutingMessage("Using routed driving time from the map service.");
    } catch (routeError) {
      setRouteMode("estimated");
      setRoutingMessage("Live routing was unavailable. Using straight-line travel estimate.");
    }

    const plannerVariants = buildSchedules(logicalLoads);
    const plans = plannerVariants.map((variant) => {
      const waves = variant.wavesForCapacity(capacity);
      const playback = buildPlayback({ routeMinutes: routeData.minutes, waves }, truckCount);

      return {
        name: variant.name,
        waves,
        routeMinutes: routeData.minutes,
        processingMinutes: Math.max(0, playback.totalMinutes - routeData.minutes),
        totalMinutes: playback.totalMinutes,
        playback,
      };
    });

    plans.sort((a, b) => a.totalMinutes - b.totalMinutes);
    const bestPlan = plans[0] || null;

    setSimulation({
      startPoint,
      endPoint,
      workerCount,
      truckCount,
      capacity,
      routeMinutes: routeData.minutes,
      routeSource: routeData.source,
      routeGeometry: routeData.geometry,
      plans,
      bestPlan,
    });
    setCurrentMinute(0);
  }

  if (loading) {
    return React.createElement(
      "main",
      { className: "page-shell" },
      React.createElement("p", { className: "status" }, "Loading loads...")
    );
  }

  if (error) {
    return React.createElement(
      "main",
      { className: "page-shell" },
      React.createElement("p", { className: "status error" }, error)
    );
  }

  return React.createElement(
    "main",
    { className: "page-shell dashboard-shell" },
    React.createElement(RealMap, {
      startPoint,
      endPoint,
      onSelectStart: setStartPoint,
      onSelectEnd: setEndPoint,
      simulation,
      currentMinute,
    }),
    React.createElement(
      "section",
      { className: "dashboard-overlays" },
      React.createElement(
        "aside",
        { className: "left-panel control-panel" },
        React.createElement("p", { className: "eyebrow" }, "RigSync"),
        React.createElement("h2", null, "Transfer controls"),
        React.createElement(
          "div",
          { className: "planner-box" },
          React.createElement("p", { className: "eyebrow" }, "Planner"),
          React.createElement("h3", null, "Rig transfer inputs"),
          React.createElement(
            "div",
            { className: "form-grid" },
            React.createElement(
              "label",
              { className: "field" },
              React.createElement("span", null, "From rig"),
              React.createElement("input", { type: "text", value: formatCoordinate(startPoint), readOnly: true })
            ),
            React.createElement(
              "label",
              { className: "field" },
              React.createElement("span", null, "To rig"),
              React.createElement("input", { type: "text", value: formatCoordinate(endPoint), readOnly: true })
            ),
            React.createElement(
              "label",
              { className: "field" },
              React.createElement("span", null, "Workers"),
              React.createElement("input", {
                type: "number",
                min: "1",
                value: workers,
                onChange: (event) => setWorkers(event.target.value),
              })
            ),
            React.createElement(
              "label",
              { className: "field" },
              React.createElement("span", null, "Trucks"),
              React.createElement("input", {
                type: "number",
                min: "1",
                value: trucks,
                onChange: (event) => setTrucks(event.target.value),
              })
            )
          ),
          React.createElement("button", { type: "button", className: "run-button", onClick: runSimulation }, "Run transfer simulation"),
          React.createElement(SpeedControl, { speed: playbackSpeed, onChange: setPlaybackSpeed }),
          React.createElement("p", { className: "planner-note" }, "Use the full map to pick the source and destination rigs."),
          routingMessage ? React.createElement("p", { className: "planner-note" }, routingMessage) : null
        )
      ),
      React.createElement(
        "div",
        { className: "map-header-overlay" },
        React.createElement("p", { className: "eyebrow" }, "Live Map"),
        React.createElement("h1", null, "Rig transfer simulation"),
        React.createElement(
          "p",
          { className: "hero-copy" },
          "Pick rigs directly on the map, run the plan, and watch the best route play live."
        )
      ),
      React.createElement(
        "aside",
        { className: "detail-panel stats-panel" },
        simulation
          ? React.createElement(
              React.Fragment,
              null,
              React.createElement(
                "div",
                { className: "detail-header" },
                React.createElement("p", { className: "eyebrow" }, "Simulation Result"),
                React.createElement("h2", null, `${formatCoordinate(simulation.startPoint)} to ${formatCoordinate(simulation.endPoint)}`),
                React.createElement("p", { className: "meta large" }, `Workers: ${simulation.workerCount} / Trucks: ${simulation.truckCount} / Parallel capacity: ${simulation.capacity}`),
                React.createElement("p", { className: "meta large" }, `Route source: ${simulation.routeSource}`)
              ),
              React.createElement(
                "div",
                { className: "detail-stats" },
                React.createElement(Stat, { label: "Travel time", value: formatMinutes(simulation.routeMinutes) }),
                React.createElement(Stat, { label: "Routing", value: routeMode === "live" ? "Live map route" : "Fallback estimate" }),
                React.createElement(Stat, { label: "Best ETA", value: formatMinutes(simulation.plans[0].totalMinutes) })
              ),
              React.createElement(PhaseBars, { simulation, currentMinute }),
              React.createElement(SimulationPlayback, { simulation, currentMinute })
            )
          : React.createElement(
              "div",
              { className: "empty-panel" },
              React.createElement("p", { className: "eyebrow" }, "Simulation Result"),
              React.createElement("h2", null, "No run yet"),
              React.createElement("p", { className: "empty-state" }, "Pick start and end rig coordinates on the map, then run the transfer simulation.")
            )
      )
    )
  );
}

createRoot(document.getElementById("root")).render(React.createElement(App));

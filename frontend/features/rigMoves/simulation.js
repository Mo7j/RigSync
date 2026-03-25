import {
  DEFAULT_CENTER,
  MAX_LOAD_DURATION_MINUTES,
  MIN_LOAD_DURATION_MINUTES,
} from "../../lib/constants.js";

export { DEFAULT_CENTER };

export function parseCoordinateString(value) {
  if (!value || typeof value !== "string") {
    return null;
  }

  const [lat, lng] = value.split(",").map((item) => Number.parseFloat(item.trim()));
  if (Number.isNaN(lat) || Number.isNaN(lng)) {
    return null;
  }

  return { lat, lng };
}

export function haversineKilometers(start, end) {
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

function getLoadDurationMinutes(loadId) {
  const seeded = (loadId * 37) % (MAX_LOAD_DURATION_MINUTES - MIN_LOAD_DURATION_MINUTES + 1);
  return MIN_LOAD_DURATION_MINUTES + seeded;
}

export function buildLogicalLoads(rawLoads) {
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

  const distanceKm = haversineKilometers(start, end);
  const averageTruckSpeedKmh = 45;

  return Math.max(15, Math.round((distanceKm / averageTruckSpeedKmh) * 60));
}

export async function fetchRouteData(start, end) {
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
  const distanceMeters = route?.distance;

  if (!seconds || !distanceMeters || !route?.geometry?.coordinates?.length) {
    throw new Error("No route duration returned");
  }

  return {
    minutes: Math.max(1, Math.round(seconds / 60)),
    distanceKm: Math.max(1, Math.round((distanceMeters / 1000) * 10) / 10),
    geometry: route.geometry.coordinates.map(([lng, lat]) => [lat, lng]),
    source: "OSRM driving route",
  };
}

export function fallbackRouteData(start, end) {
  const distanceKm = haversineKilometers(start, end);

  return {
    minutes: haversineMinutes(start, end),
    distanceKm: Math.max(1, Math.round(distanceKm * 10) / 10),
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

function buildFleetPlanCounts(requestedTruckCount) {
  const baseCount = Math.max(1, requestedTruckCount || 1);
  const counts = [];

  if (baseCount <= 1) {
    counts.push(1, 2, 3);
  } else if (baseCount === 2) {
    counts.push(1, 2, 3);
  } else {
    counts.push(baseCount - 1, baseCount, baseCount + 1);
  }

  return [...new Set(counts)].sort((a, b) => a - b).slice(0, 3);
}

export function buildPlayback(plan, truckCount) {
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

export function buildScenarioPlans(logicalLoads, routeData, workerCount, truckCount) {
  const plannerVariants = buildSchedules(logicalLoads);
  const fleetPlanCounts = buildFleetPlanCounts(truckCount);

  return fleetPlanCounts
    .map((planTruckCount, index) => {
      const scenarioWorkerCount = Math.max(workerCount, planTruckCount + 2);
      const capacity = Math.max(1, Math.min(scenarioWorkerCount, planTruckCount));
      const variantPlans = plannerVariants.map((variant) => {
        const waves = variant.wavesForCapacity(capacity);
        const playback = buildPlayback({ routeMinutes: routeData.minutes, waves }, planTruckCount);

        return {
          name: variant.name,
          waves,
          routeMinutes: routeData.minutes,
          routeDistanceKm: routeData.distanceKm,
          processingMinutes: Math.max(0, playback.totalMinutes - routeData.minutes),
          totalMinutes: playback.totalMinutes,
          playback,
        };
      });
      const bestVariant = variantPlans.reduce(
        (best, variant) => (!best || variant.totalMinutes < best.totalMinutes ? variant : best),
        null,
      );

      return {
        name: `Plan ${index + 1}`,
        workerCount: scenarioWorkerCount,
        truckCount: planTruckCount,
        capacity,
        routeMinutes: routeData.minutes,
        routeDistanceKm: routeData.distanceKm,
        routeSource: routeData.source,
        routeGeometry: routeData.geometry,
        variantPlans,
        bestVariant,
        totalMinutes: bestVariant?.totalMinutes || 0,
        processingMinutes: bestVariant?.processingMinutes || 0,
        playback: bestVariant?.playback || null,
        waves: bestVariant?.waves || [],
      };
    });
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

export function getTruckStatus(playback, currentMinute, truckId) {
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

export function getTruckPosition(playback, geometry, currentMinute, truckId) {
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

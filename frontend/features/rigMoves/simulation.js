import {
  DEFAULT_CENTER,
  MAX_LOAD_DURATION_MINUTES,
  MIN_LOAD_DURATION_MINUTES,
} from "../../lib/constants.js";

export { DEFAULT_CENTER };

function yieldToBrowser() {
  return new Promise((resolve) => {
    window.setTimeout(resolve, 0);
  });
}

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

function getLoadDurationMinutes(loadId, fallbackMinutes = null) {
  if (Number.isFinite(fallbackMinutes) && fallbackMinutes > 0) {
    return Math.max(15, Math.round(fallbackMinutes));
  }

  const seedSource = String(loadId || "0");
  const seededBase = [...seedSource].reduce((sum, character) => sum + character.charCodeAt(0), 0);
  const seeded = (seededBase * 37) % (MAX_LOAD_DURATION_MINUTES - MIN_LOAD_DURATION_MINUTES + 1);
  return MIN_LOAD_DURATION_MINUTES + seeded;
}

function normalizeTruckTypeKey(type) {
  const normalized = String(type || "")
    .toLowerCase()
    .replace(/[^a-z]/g, "");

  if (normalized === "fb" || normalized.includes("flatbed")) {
    return "flatbed";
  }
  if (normalized === "lb" || normalized.includes("lowbed") || normalized.includes("support")) {
    return "lowbed";
  }
  if (normalized === "hh" || normalized.includes("heavyhaul")) {
    return "heavyhauler";
  }

  return normalized;
}

function normalizeTruckTypeLabel(type) {
  const normalized = normalizeTruckTypeKey(type);
  if (normalized === "support" || normalized === "lowbed") {
    return "Low-bed";
  }
  if (normalized === "flatbed") {
    return "Flat-bed";
  }
  if (normalized === "heavyhauler") {
    return "Heavy Hauler";
  }
  return String(type || "").trim() || "Heavy Hauler";
}

function tokenizeTruckTypes(value) {
  if (Array.isArray(value)) {
    return value.flatMap((item) => tokenizeTruckTypes(item));
  }

  return String(value || "")
    .split(/[\/,|]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function normalizeTruckOptions(value) {
  return [...new Set(tokenizeTruckTypes(value).map((item) => normalizeTruckTypeLabel(item)).filter(Boolean))];
}

function buildLegacyLogicalLoads(rawLoads) {
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

function buildWorkbookLogicalLoads(rawLoads) {
  const logicalLoads = [];
  const codeToLogicalIds = new Map();
  let nextLogicalId = 1;

  (rawLoads || []).forEach((load) => {
    const isExpandedWorkbookRow = /-(?:L|LOAD)\d+$/i.test(String(load.code || "").trim());
    const loadCount = isExpandedWorkbookRow ? 1 : Math.max(1, Number.parseInt(load.load_count, 10) || 1);

    for (let index = 0; index < loadCount; index += 1) {
      const minimumCrewRoles = {
        rig_down: load.minimum_crew_down_roles || {},
        rig_up: load.minimum_crew_up_roles || {},
      };
      const optimalCrewRoles = {
        rig_down: load.optimal_crew_down_roles || {},
        rig_up: load.optimal_crew_up_roles || {},
      };
      const logicalLoad = {
        id: nextLogicalId,
        template_id: load.id,
        code: load.code,
        key: `${load.code || load.id}::${index}`,
        description: load.description,
        category: load.category,
        priority: Number.parseInt(load.priority, 10) || 0,
        truck_type: load.truck_type || (load.truck_types || []).join(" / "),
        truck_options: normalizeTruckOptions(load.truck_types || load.truck_type),
        weight_tons: Number(load.weight_tons) || null,
        dimensions: load.dimensions || null,
        is_critical: Boolean(load.is_critical),
        rig_down_duration: getLoadDurationMinutes(`${load.code || load.id}-down-${index}`, load.avg_rig_down_minutes),
        rig_up_duration: getLoadDurationMinutes(`${load.code || load.id}-up-${index}`, load.avg_rig_up_minutes),
        optimal_rig_down_duration: getLoadDurationMinutes(`${load.code || load.id}-opt-down-${index}`, load.optimal_rig_down_minutes || load.avg_rig_down_minutes),
        optimal_rig_up_duration: getLoadDurationMinutes(`${load.code || load.id}-opt-up-${index}`, load.optimal_rig_up_minutes || load.avg_rig_up_minutes),
        minimum_crew_roles: minimumCrewRoles,
        optimal_crew_roles: optimalCrewRoles,
        min_worker_count: Math.max(
          1,
          ...Object.values(minimumCrewRoles.rig_down || {}),
          ...Object.values(minimumCrewRoles.rig_up || {}),
          Number.parseInt(load.minimum_crew_down_count, 10) || 0,
          Number.parseInt(load.minimum_crew_up_count, 10) || 0,
        ),
        optimal_worker_count: Math.max(
          ...Object.values(optimalCrewRoles.rig_down || {}),
          ...Object.values(optimalCrewRoles.rig_up || {}),
          Number.parseInt(load.optimal_crew_down_count, 10) || 0,
          Number.parseInt(load.optimal_crew_up_count, 10) || 0,
          Number.parseInt(load.minimum_crew_down_count, 10) || 0,
          Number.parseInt(load.minimum_crew_up_count, 10) || 0,
          1,
        ),
        rig_down_dependency_codes: load.rig_down_dependency_codes || [],
        rig_down_dependency_phase_codes: load.rig_down_dependency_phase_codes || [],
        rig_move_dependency_codes: load.rig_move_dependency_codes || [],
        rig_move_dependency_phase_codes: load.rig_move_dependency_phase_codes || [],
        rig_up_dependency_codes: load.rig_up_dependency_codes || [],
        rig_up_dependency_phase_codes: load.rig_up_dependency_phase_codes || [],
        rig_down_dependency_ids: [],
        rig_move_dependency_ids: [],
        rig_up_dependency_ids: [],
        dependency_ids: [],
        source_kind: load.source_kind || (String(load.category || "").toLowerCase() === "startup" ? "startup" : "rig"),
      };

      logicalLoads.push(logicalLoad);
      if (!codeToLogicalIds.has(load.code)) {
        codeToLogicalIds.set(load.code, []);
      }
      codeToLogicalIds.get(load.code).push(nextLogicalId);
      nextLogicalId += 1;
    }
  });

  logicalLoads.forEach((load) => {
    load.rig_down_dependency_ids = (load.rig_down_dependency_codes || [])
      .flatMap((code) => codeToLogicalIds.get(code) || [])
      .filter((dependencyId) => dependencyId !== load.id)
      .sort((a, b) => a - b);
    load.rig_move_dependency_ids = (load.rig_move_dependency_codes || [])
      .flatMap((code) => codeToLogicalIds.get(code) || [])
      .filter((dependencyId) => dependencyId !== load.id)
      .sort((a, b) => a - b);
    load.rig_up_dependency_ids = (load.rig_up_dependency_codes || [])
      .flatMap((code) => codeToLogicalIds.get(code) || [])
      .filter((dependencyId) => dependencyId !== load.id)
      .sort((a, b) => a - b);
    load.dependency_ids = [...new Set([...load.rig_down_dependency_ids, ...load.rig_move_dependency_ids])]
      .sort((a, b) => a - b);
  });

  const logicalLoadById = new Map(logicalLoads.map((load) => [load.id, load]));
  logicalLoads.forEach((load) => {
    load.rig_down_dependency_ids = load.rig_down_dependency_ids.filter((dependencyId) => {
      const dependencyLoad = logicalLoadById.get(dependencyId);
      if (!dependencyLoad) {
        return false;
      }

      const isDirectCycle = (dependencyLoad.rig_down_dependency_ids || []).includes(load.id);
      if (!isDirectCycle) {
        return true;
      }

      const loadPriority = Number.parseInt(load.priority, 10) || 0;
      const dependencyPriority = Number.parseInt(dependencyLoad.priority, 10) || 0;
      if (loadPriority !== dependencyPriority) {
        return loadPriority < dependencyPriority;
      }

      return load.id < dependencyId;
    });
    load.dependency_ids = [...new Set(load.rig_down_dependency_ids)].sort((a, b) => a - b);
  });

  return logicalLoads;
}

export function buildLogicalLoads(rawLoads) {
  if ((rawLoads || []).some((load) => load?.load_count != null || load?.code)) {
    return buildWorkbookLogicalLoads(rawLoads);
  }

  return buildLegacyLogicalLoads(rawLoads);
}

function haversineMinutes(start, end) {
  if (!start || !end) {
    return 0;
  }

  const distanceKm = haversineKilometers(start, end);
  const averageTruckSpeedKmh = 45;

  return Math.max(15, Math.round((distanceKm / averageTruckSpeedKmh) * 60));
}

function buildTruckSpecMap(truckSpecs = []) {
  return new Map(
    (truckSpecs || []).map((spec) => [
      normalizeTruckTypeKey(spec.type),
      {
        ...spec,
        type: normalizeTruckTypeLabel(spec.type),
        average_speed_kmh: Number(spec.average_speed_kmh) || 40,
        max_weight_tons: Number(spec.max_weight_tons) || 0,
        alpha: Number(spec.alpha) || 0.3,
        dimensions: {
          length: Number(spec?.dimensions?.length) || 0,
          width: Number(spec?.dimensions?.width) || 0,
          height: Number(spec?.dimensions?.height) || 0,
        },
      },
    ]),
  );
}

function buildFleetForPlayback(truckCount, truckSetup = [], truckSpecs = []) {
  const truckSpecMap = buildTruckSpecMap(truckSpecs);
  const normalizedSetup = (truckSetup || [])
    .map((item) => ({
      type: normalizeTruckTypeLabel(item?.type),
      count: Math.max(1, Number.parseInt(item?.count, 10) || 0),
    }))
    .filter((item) => item.type && item.count > 0);

  const expandedFleet = normalizedSetup.flatMap((item) =>
    Array.from({ length: item.count }, () => item.type),
  );
  const fallbackType = normalizedSetup[0]?.type || "Heavy Haul";

  return Array.from({ length: truckCount }, (_, index) => ({
    id: index + 1,
    type: expandedFleet[index] || fallbackType,
    availableAt: 0,
    driveSinceBreakMinutes: 0,
    spec: truckSpecMap.get(normalizeTruckTypeKey(expandedFleet[index] || fallbackType)) || null,
  }));
}

export async function fetchRouteData(start, end) {
  const coordinates = `${start.lng},${start.lat};${end.lng},${end.lat}`;
  const routingUrls = [
    `https://router.project-osrm.org/route/v1/driving/${coordinates}?overview=full&geometries=geojson`,
    `https://routing.openstreetmap.de/routed-car/route/v1/driving/${coordinates}?overview=full&geometries=geojson`,
  ];
  let lastError = null;

  for (const url of routingUrls) {
    try {
      const controller = new AbortController();
      const timeoutId = window.setTimeout(() => controller.abort(), 6000);
      const response = await fetch(url, { signal: controller.signal });
      window.clearTimeout(timeoutId);

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
        source: url.includes("routing.openstreetmap.de") ? "OSM DE driving route" : "OSRM driving route",
      };
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError || new Error("Routing unavailable");
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

function buildLoadSorters(objective, truckCostByType) {
  return (left, right) => {
    const leftPriority = Number.parseInt(left.priority, 10) || 0;
    const rightPriority = Number.parseInt(right.priority, 10) || 0;
    const leftMinDuration = (left.rig_down_duration || 0) + (left.rig_up_duration || 0);
    const rightMinDuration = (right.rig_down_duration || 0) + (right.rig_up_duration || 0);
    const leftFlexibility = Math.max(1, left.truck_options?.length || 1);
    const rightFlexibility = Math.max(1, right.truck_options?.length || 1);
    const leftTruckCost = Math.min(...(left.truck_options || ["Heavy Hauler"]).map((type) => truckCostByType.get(normalizeTruckTypeKey(type)) || 999));
    const rightTruckCost = Math.min(...(right.truck_options || ["Heavy Hauler"]).map((type) => truckCostByType.get(normalizeTruckTypeKey(type)) || 999));

    if (objective === "cheapest") {
      return leftFlexibility - rightFlexibility || leftTruckCost - rightTruckCost || leftMinDuration - rightMinDuration || leftPriority - rightPriority;
    }

    if (objective === "utilized") {
      return leftFlexibility - rightFlexibility || rightMinDuration - leftMinDuration || leftTruckCost - rightTruckCost || leftPriority - rightPriority;
    }

    return leftPriority - rightPriority || rightMinDuration - leftMinDuration || leftFlexibility - rightFlexibility || leftTruckCost - rightTruckCost;
  };
}

function buildSchedules(loads, truckCapacity, workerCapacity, objective, truckCostByType) {
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

  const localIndegree = new Map(indegree);
  const ready = loads.filter((load) => load.dependency_ids.length === 0).map((load) => load.id);
  const completed = new Set();
  const waves = [];
  const readySorter = buildLoadSorters(objective, truckCostByType);

  while (completed.size < loads.length) {
    const batch = [];
    let committedWorkers = 0;
    const orderedReadyLoads = ready
      .map((loadId) => loadMap.get(loadId))
      .filter(Boolean)
      .sort(readySorter);

    orderedReadyLoads.forEach((load) => {
      if (batch.length >= truckCapacity) {
        return;
      }

      const requiredWorkers = Math.max(1, Number(load.min_worker_count) || 1);
      if (committedWorkers + requiredWorkers > workerCapacity && batch.length > 0) {
        return;
      }

      if (committedWorkers + requiredWorkers <= workerCapacity || batch.length === 0) {
        batch.push(load);
        committedWorkers += requiredWorkers;
      }
    });

    if (!batch.length) {
      break;
    }

    batch.forEach((load) => {
      const readyIndex = ready.indexOf(load.id);
      if (readyIndex >= 0) {
        ready.splice(readyIndex, 1);
      }
      completed.add(load.id);
      (dependentsMap.get(load.id) || []).forEach((dependentId) => {
        localIndegree.set(dependentId, localIndegree.get(dependentId) - 1);
        if (localIndegree.get(dependentId) === 0) {
          ready.push(dependentId);
        }
      });
    });

    waves.push(batch);
  }

  return waves;
}

function estimateTravelMinutes(distanceKm, fallbackMinutes, load, truckSpec) {
  if (load.routeMinutesByTruck?.[truckSpec?.type]) {
    return load.routeMinutesByTruck[truckSpec.type];
  }
  if (!truckSpec || !distanceKm || !truckSpec.average_speed_kmh) {
    return Math.max(1, Number(load.routeMinutes) || fallbackMinutes || 1);
  }

  const loadWeightRatio =
    load.weight_tons && truckSpec.max_weight_tons
      ? Math.min(load.weight_tons / truckSpec.max_weight_tons, 1)
      : 0.35;
  const effectiveSpeed = Math.max(10, truckSpec.average_speed_kmh * (1 - (truckSpec.alpha || 0.3) * loadWeightRatio));
  return Math.max(1, Math.round((distanceKm / effectiveSpeed) * 60));
}

function isSpecialPermitLoad(load, truck) {
  if (!load || !truck) {
    return false;
  }

  const truckType = normalizeTruckTypeKey(truck.type);
  const eligibleTypes = new Set((load.truck_options || []).map((type) => normalizeTruckTypeKey(type)));
  const maxWeightTons = Number(truck.spec?.max_weight_tons) || 0;
  const loadWeightTons = Math.max(0, Number(load.weight_tons) || 0);

  return (
    eligibleTypes.has(truckType) &&
    truckType.includes("heavy") &&
    (maxWeightTons <= 0 || loadWeightTons <= maxWeightTons)
  );
}

function fitsTruckToLoad(load, truck) {
  if (!truck) {
    return false;
  }

  if (load.truck_options?.length) {
    const eligibleTypes = new Set(load.truck_options.map((type) => normalizeTruckTypeKey(type)));
    if (!eligibleTypes.has(normalizeTruckTypeKey(truck.type))) {
      return false;
    }
  }

  const maxWeightTons = Number(truck.spec?.max_weight_tons) || 0;
  if (maxWeightTons > 0 && Number(load.weight_tons) > maxWeightTons) {
    return false;
  }

  const truckDimensions = truck.spec?.dimensions || {};
  const loadDimensions = load.dimensions || {};
  const exceedsDimensions =
    (Number(truckDimensions.length) > 0 && Number(loadDimensions.length) > Number(truckDimensions.length)) ||
    (Number(truckDimensions.width) > 0 && Number(loadDimensions.width) > Number(truckDimensions.width)) ||
    (Number(truckDimensions.height) > 0 && Number(loadDimensions.height) > Number(truckDimensions.height));

  if (exceedsDimensions) {
    return isSpecialPermitLoad(load, truck);
  }

  return true;
}

function canTruckCarryLoadBundle(loads, truck) {
  if (!truck || !loads?.length) {
    return false;
  }

  const truckSpec = truck.spec || {};
  const truckDimensions = truckSpec.dimensions || {};
  const totalWeight = loads.reduce((sum, load) => sum + Math.max(0, Number(load.weight_tons) || 0), 0);
  const totalLength = loads.reduce((sum, load) => sum + Math.max(0, Number(load?.dimensions?.length) || 0), 0);
  const maxWidth = Math.max(...loads.map((load) => Math.max(0, Number(load?.dimensions?.width) || 0)), 0);
  const maxHeight = Math.max(...loads.map((load) => Math.max(0, Number(load?.dimensions?.height) || 0)), 0);

  if ((Number(truckSpec.max_weight_tons) || 0) > 0 && totalWeight > Number(truckSpec.max_weight_tons)) {
    return false;
  }
  if ((Number(truckDimensions.length) || 0) > 0 && totalLength > Number(truckDimensions.length)) {
    return loads.length === 1 && isSpecialPermitLoad(loads[0], truck);
  }
  if ((Number(truckDimensions.width) || 0) > 0 && maxWidth > Number(truckDimensions.width)) {
    return loads.length === 1 && isSpecialPermitLoad(loads[0], truck);
  }
  if ((Number(truckDimensions.height) || 0) > 0 && maxHeight > Number(truckDimensions.height)) {
    return loads.length === 1 && isSpecialPermitLoad(loads[0], truck);
  }

  return true;
}

function formatBundleLoadCodes(loads = []) {
  const codes = loads.map((load) => load.code || `#${load.id}`).filter(Boolean);
  if (codes.length <= 2) {
    return codes.join(" + ");
  }
  return `${codes.slice(0, 2).join(" + ")} +${codes.length - 2}`;
}

function adjustTaskDuration(averageMinutes, optimalMinutes, minWorkers, optimalWorkers, workersAllocated) {
  const avg = Math.max(10, Number(averageMinutes) || 10);
  const optimum = Math.max(10, Number(optimalMinutes) || avg);
  const minimumWorkers = Math.max(1, Number(minWorkers) || 1);
  const optimalWorkersClamped = Math.max(minimumWorkers, Number(optimalWorkers) || minimumWorkers);

  if (optimalWorkersClamped <= minimumWorkers) {
    return optimum;
  }

  const ratio = Math.max(0, Math.min(1, (workersAllocated - minimumWorkers) / (optimalWorkersClamped - minimumWorkers)));
  return Math.round(avg - ratio * (avg - optimum));
}

function buildTruckCostMap(truckSetup = []) {
  const configured = new Map(
    (truckSetup || [])
      .filter((truck) => truck?.type)
      .map((truck) => [normalizeTruckTypeKey(truck.type), Math.max(0, Number(truck.hourlyCost) || 0)]),
  );

  return new Map([
    [normalizeTruckTypeKey("Flat-bed"), configured.get(normalizeTruckTypeKey("Flat-bed")) ?? 105],
    [normalizeTruckTypeKey("Low-bed"), configured.get(normalizeTruckTypeKey("Low-bed")) ?? 155],
    [normalizeTruckTypeKey("Heavy Hauler"), configured.get(normalizeTruckTypeKey("Heavy Hauler")) ?? 260],
    ...[...configured.entries()],
  ]);
}

function getAverageWorkerHourlyCost(workerShiftConfig = null) {
  if (Number.isFinite(Number(workerShiftConfig?.averageHourlyCost))) {
    return Math.max(0, Number(workerShiftConfig.averageHourlyCost));
  }

  const roleEntries = Object.values(workerShiftConfig?.roles || {});
  const totalWorkers = roleEntries.reduce((sum, role) => sum + Math.max(0, Number.parseInt(role?.count, 10) || 0), 0);
  const totalCost = roleEntries.reduce(
    (sum, role) => sum + ((Math.max(0, Number.parseInt(role?.count, 10) || 0) * Math.max(0, Number(role?.hourlyCost) || 0))),
    0,
  );

  return totalWorkers > 0 ? totalCost / totalWorkers : 18;
}

function allocateWorkerRoles(totalWorkers, workerShiftConfig = null) {
  const configuredRoles = workerShiftConfig?.roles || {};
  const roleEntries = Object.entries(configuredRoles)
    .map(([roleId, role]) => ({
      roleId,
      count: Math.max(0, Number.parseInt(role?.count, 10) || 0),
    }))
    .filter((role) => role.count > 0);

  if (!roleEntries.length) {
    return totalWorkers > 0 ? { crew: totalWorkers } : {};
  }

  const safeTotalWorkers = Math.max(0, Number.parseInt(totalWorkers, 10) || 0);
  if (!safeTotalWorkers) {
    return Object.fromEntries(roleEntries.map((role) => [role.roleId, 0]));
  }

  const totalAvailable = roleEntries.reduce((sum, role) => sum + role.count, 0);
  const allocations = roleEntries.map((role) => {
    const exact = (safeTotalWorkers * role.count) / Math.max(totalAvailable, 1);
    return {
      roleId: role.roleId,
      allocated: Math.min(role.count, Math.floor(exact)),
      remainder: exact - Math.floor(exact),
      capacity: role.count,
    };
  });

  let assigned = allocations.reduce((sum, role) => sum + role.allocated, 0);
  const prioritized = [...allocations].sort((left, right) => right.remainder - left.remainder);
  let cursor = 0;

  while (assigned < safeTotalWorkers && prioritized.length) {
    const target = prioritized[cursor % prioritized.length];
    if (target.allocated < target.capacity) {
      target.allocated += 1;
      assigned += 1;
    }
    cursor += 1;
    if (cursor > prioritized.length * Math.max(safeTotalWorkers, 1)) {
      break;
    }
  }

  return Object.fromEntries(allocations.map((role) => [role.roleId, role.allocated]));
}

function getObjectiveScore({ objective, completionMinute, truckCost, idleGap, fitPenalty, routeDistanceKm = 0 }) {
  const distanceWeight = Math.max(0.6, Math.min(2.4, 1 + (Number(routeDistanceKm) || 0) / 180));

  if (objective === "cheapest") {
    return (truckCost * 14 * distanceWeight) + (completionMinute * 0.45) + (idleGap * 0.35) + fitPenalty;
  }

  if (objective === "utilized") {
    return (completionMinute * 0.8) + (idleGap * 9) + (truckCost * 0.5 * distanceWeight) + (fitPenalty * 1.15);
  }

  return completionMinute + (idleGap * 0.2) + (truckCost * 0.12 * distanceWeight) + fitPenalty;
}

function selectTruckForLoad(trucks, load, stageReadyAt, objective, routeDistanceKm, fallbackRouteMinutes, rigDownDuration, rigUpDuration, truckCostByType) {
  const eligibleTrucks = trucks.filter((truck) => fitsTruckToLoad(load, truck));
  if (!eligibleTrucks.length) {
    return null;
  }

  return eligibleTrucks.reduce((best, truck) => {
    const routeMinutes = estimateTravelMinutes(routeDistanceKm, fallbackRouteMinutes, load, truck.spec);
    const pickupRouteMinutes = Math.max(0, Number(load.pickupRouteMinutes) || 0);
    const dispatchStart = Math.max(truck.availableAt, stageReadyAt - pickupRouteMinutes);
    const loadStart = Math.max(stageReadyAt, dispatchStart + pickupRouteMinutes);
    const completionMinute = loadStart + rigDownDuration + routeMinutes + rigUpDuration + routeMinutes;
    const truckRate = truckCostByType.get(normalizeTruckTypeKey(truck.type)) || 120;
    const truckCost = ((pickupRouteMinutes + routeMinutes * 2 + rigDownDuration + rigUpDuration) / 60) * truckRate;
    const idleGap = Math.max(0, dispatchStart - truck.availableAt);
    const overloadRatio =
      load.weight_tons && truck.spec?.max_weight_tons
        ? Math.max(0, (load.weight_tons - truck.spec.max_weight_tons) / truck.spec.max_weight_tons)
        : 0;
    const lengthOverflow =
      load.dimensions?.length && truck.spec?.dimensions?.length
        ? Math.max(0, (load.dimensions.length - truck.spec.dimensions.length) / truck.spec.dimensions.length)
        : 0;
    const widthOverflow =
      load.dimensions?.width && truck.spec?.dimensions?.width
        ? Math.max(0, (load.dimensions.width - truck.spec.dimensions.width) / truck.spec.dimensions.width)
        : 0;
    const heightOverflow =
      load.dimensions?.height && truck.spec?.dimensions?.height
        ? Math.max(0, (load.dimensions.height - truck.spec.dimensions.height) / truck.spec.dimensions.height)
        : 0;
    const fitPenalty = (overloadRatio * 180) + ((lengthOverflow + widthOverflow + heightOverflow) * 120);
    const score = getObjectiveScore({
      objective,
      completionMinute,
      truckCost,
      idleGap,
      fitPenalty,
      routeDistanceKm,
    });

    if (!best || score < best.score || (score === best.score && completionMinute < best.completionMinute)) {
      return {
        truck,
        score,
        completionMinute,
        routeMinutes,
        pickupRouteMinutes,
        dispatchStart,
        loadStart,
      };
    }

    return best;
  }, null);
}

function summarizePlaybackMetrics(playback, truckCostByType, workerCount, workerHourlyCost) {
  const trips = playback?.trips || [];
  const journeys = playback?.journeys?.length ? playback.journeys : trips;
  const totalMinutes = Math.max(1, playback?.totalMinutes || 1);
  const usedTruckIds = [...new Set(journeys.map((trip) => trip.truckId))];
  const usedTruckSetup = [...new Map(
    journeys.map((trip) => [trip.truckId, trip.truckType])
  ).values()].reduce((summary, truckType) => {
    const existing = summary.find((item) => item.type === truckType);
    if (existing) {
      existing.count += 1;
    } else {
      summary.push({
        id: normalizeTruckTypeKey(truckType),
        type: truckType,
        count: 1,
      });
    }
    return summary;
  }, []);
  const truckActiveMinutes = journeys.reduce(
    (sum, trip) =>
      sum +
      Math.max(
        0,
        ((trip.moveStart || trip.pickupLoadStart || trip.loadStart || 0) - (trip.dispatchStart || trip.pickupLoadStart || trip.loadStart || 0)) +
          ((trip.returnStart || trip.unloadDropFinish || trip.arrivalAtDestination || 0) - (trip.moveStart || trip.pickupLoadFinish || trip.rigDownFinish || 0)) +
          ((trip.returnToSource || 0) - (trip.returnStart || trip.unloadDropFinish || trip.arrivalAtDestination || 0)),
      ),
    0,
  );
  const truckCost = journeys.reduce((sum, trip) => {
    const truckRate = truckCostByType.get(normalizeTruckTypeKey(trip.truckType)) || 120;
    const activeMinutes =
      ((trip.moveStart || trip.pickupLoadStart || trip.loadStart || 0) - (trip.dispatchStart || trip.pickupLoadStart || trip.loadStart || 0)) +
      ((trip.returnStart || trip.unloadDropFinish || trip.arrivalAtDestination || 0) - (trip.moveStart || trip.pickupLoadFinish || trip.rigDownFinish || 0)) +
      ((trip.returnToSource || 0) - (trip.returnStart || trip.unloadDropFinish || trip.arrivalAtDestination || 0));
    return sum + (Math.max(0, activeMinutes) / 60) * truckRate;
  }, 0);
  const workerActiveMinutes = trips.reduce(
    (sum, trip) =>
      sum +
      Math.max(0, (trip.rigDownFinish || 0) - (trip.rigDownStart || trip.loadStart || 0)) * Math.max(0, Number(trip.rigDownWorkerCount) || 0) +
      Math.max(0, (trip.pickupLoadFinish || 0) - (trip.pickupLoadStart || trip.rigDownFinish || 0)) * Math.max(0, Number(trip.pickupLoadWorkerCount) || 0) +
      Math.max(0, (trip.unloadDropFinish || 0) - (trip.unloadDropStart || trip.arrivalAtDestination || 0)) * Math.max(0, Number(trip.unloadDropWorkerCount) || 0) +
      Math.max(0, (trip.rigUpFinish || 0) - (trip.rigUpStart || trip.unloadDropFinish || trip.arrivalAtDestination || 0)) * Math.max(0, Number(trip.rigUpWorkerCount) || 0),
    0,
  );
  const workerCost = (workerActiveMinutes * workerHourlyCost) / 60;
  const truckCount = new Set(journeys.map((trip) => trip.truckId)).size || 1;
  const truckCapacityMinutes = truckCount * totalMinutes;
  const workerCapacityMinutes = Math.max(1, workerCount) * totalMinutes;
  const truckUtilization = Math.min(100, Math.round((truckActiveMinutes / Math.max(truckCapacityMinutes, 1)) * 100));
  const workerUtilization = Math.min(100, Math.round((workerActiveMinutes / Math.max(workerCapacityMinutes, 1)) * 100));
  const utilization = Math.min(
    100,
    Math.round(((truckActiveMinutes + workerActiveMinutes) / Math.max(truckCapacityMinutes + workerCapacityMinutes, 1)) * 100),
  );
  const idleMinutes = Math.max(0, truckCapacityMinutes - truckActiveMinutes);
  const workerIdleMinutes = Math.max(0, workerCapacityMinutes - workerActiveMinutes);

  return {
    usedTruckCount: Math.max(1, usedTruckIds.length),
    usedTruckSetup,
    truckUtilization,
    workerUtilization,
    utilization,
    idleMinutes,
    workerIdleMinutes,
    workerActiveMinutes,
    costEstimate: Math.round(truckCost + workerCost),
  };
}

function buildUsedTruckSetup(usedTruckSetup = [], configuredTruckSetup = []) {
  const configuredByType = new Map(
    (configuredTruckSetup || []).map((truck, index) => [
      normalizeTruckTypeKey(truck?.type) || `truck-${index + 1}`,
      truck,
    ]),
  );

  return (usedTruckSetup || [])
    .map((truck, index) => {
      const key = normalizeTruckTypeKey(truck?.type) || `truck-${index + 1}`;
      const configured = configuredByType.get(key) || {};
      return {
        ...configured,
        id: configured.id || truck.id || key,
        type: normalizeTruckTypeLabel(truck.type || configured.type),
        count: Math.max(0, Number.parseInt(truck?.count, 10) || 0),
        hourlyCost: Math.max(0, Number(configured.hourlyCost) || 0),
      };
    })
    .filter((truck) => truck.type?.trim() && truck.count > 0);
}

function getScenarioWorkerCount(objective, maxWorkerCount, routeDistanceKm = 0) {
  const minWorkers = 4;
  const distanceFactor = Math.max(0, Math.min(1.5, (Number(routeDistanceKm) || 0) / 180));

  if (objective === "cheapest") {
    return Math.max(minWorkers, Math.ceil(maxWorkerCount * Math.max(0.45, 0.62 - distanceFactor * 0.08)));
  }

  if (objective === "utilized") {
    return Math.max(minWorkers, Math.ceil(maxWorkerCount * Math.max(0.5, 0.62 - distanceFactor * 0.05)));
  }

  return Math.max(minWorkers, maxWorkerCount);
}

function buildCandidateWorkerCounts(logicalLoads = [], maxWorkerCount = 0, objective = "fastest") {
  const available = Math.max(4, Number.parseInt(maxWorkerCount, 10) || 0);
  const minimumRequired = Math.max(
    4,
    ...logicalLoads.map((load) =>
      Math.max(
        1,
        sumRoleRequirements(load?.minimum_crew_roles?.rig_down || {}),
        sumRoleRequirements(load?.minimum_crew_roles?.rig_up || {}),
        Number(load?.min_worker_count) || 1,
      ),
    ),
  );
  const optimalRequired = Math.max(
    minimumRequired,
    ...logicalLoads.map((load) =>
      Math.max(
        minimumRequired,
        sumRoleRequirements(load?.optimal_crew_roles?.rig_down || {}),
        sumRoleRequirements(load?.optimal_crew_roles?.rig_up || {}),
        Number(load?.optimal_worker_count) || minimumRequired,
      ),
    ),
  );

  const candidates = new Set([
    minimumRequired,
    optimalRequired,
    Math.min(available, Math.max(minimumRequired, Math.ceil((minimumRequired + optimalRequired) / 2))),
    Math.min(available, Math.max(optimalRequired, Math.ceil(available * 0.75))),
    available,
  ]);

  return [...candidates]
    .filter((count) => count >= minimumRequired && count <= available)
    .sort((left, right) => {
      if (objective === "cheapest") {
        return left - right;
      }
      if (objective === "fastest") {
        return right - left;
      }
      const midpoint = (minimumRequired + available) / 2;
      return Math.abs(left - midpoint) - Math.abs(right - midpoint) || right - left;
    });
}

function getClockMinute(totalMinutes, startClockMinutes = 360) {
  return (startClockMinutes + Math.max(0, Math.round(totalMinutes))) % 1440;
}

function isDaytimeMinute(totalMinutes, startClockMinutes = 360) {
  const clockMinute = getClockMinute(totalMinutes, startClockMinutes);
  return clockMinute >= 360 && clockMinute < 1080;
}

function alignToDaytime(totalMinutes, startClockMinutes = 360) {
  let minute = Math.max(0, totalMinutes);
  while (!isDaytimeMinute(minute, startClockMinutes)) {
    minute += 30;
  }
  return minute;
}

function alignCriticalWindow(dispatchStart, pickupRouteMinutes, rigDownDuration, routeMinutes, rigUpDuration, startClockMinutes) {
  let candidate = Math.max(0, dispatchStart);

  for (let index = 0; index < 96; index += 1) {
    const loadStart = candidate + pickupRouteMinutes;
    const rigDownFinish = loadStart + rigDownDuration;
    const arrivalAtDestination = rigDownFinish + routeMinutes;
    const rigUpFinish = arrivalAtDestination + rigUpDuration;
    const downStartClock = getClockMinute(loadStart, startClockMinutes);
    const downFinishClock = getClockMinute(rigDownFinish, startClockMinutes);
    const upStartClock = getClockMinute(arrivalAtDestination, startClockMinutes);
    const upFinishClock = getClockMinute(rigUpFinish, startClockMinutes);

    const downFitsDay = downStartClock >= 360 && downFinishClock <= 1080 && downFinishClock >= downStartClock;
    const upFitsDay = upStartClock >= 360 && upFinishClock <= 1080 && upFinishClock >= upStartClock;

    if (downFitsDay && upFitsDay) {
      return candidate;
    }

    candidate = alignToDaytime(candidate + 30, startClockMinutes);
  }

  return candidate;
}

function applyTravelWithBreaks(startMinute, rawTravelMinutes, driveSinceBreakMinutes) {
  let currentMinute = Math.max(0, startMinute);
  let remainingTravel = Math.max(0, Math.round(rawTravelMinutes));
  let drivingSinceBreak = Math.max(0, Math.round(driveSinceBreakMinutes));

  while (remainingTravel > 0) {
    const drivingCapacity = 480 - drivingSinceBreak;
    if (drivingCapacity <= 0) {
      currentMinute += 120;
      drivingSinceBreak = 0;
      continue;
    }

    const travelChunk = Math.min(remainingTravel, drivingCapacity);
    currentMinute += travelChunk;
    remainingTravel -= travelChunk;
    drivingSinceBreak += travelChunk;

    if (remainingTravel > 0) {
      currentMinute += 120;
      drivingSinceBreak = 0;
    }
  }

  return {
    endMinute: currentMinute,
    driveSinceBreakMinutes: drivingSinceBreak,
  };
}

function buildScenarioResourceProfiles(baseTruckSetup, logicalLoads = [], truckSpecs = [], enforceExactFleet = false) {
  const normalizedSetup = (baseTruckSetup || []).map((truck) => ({
    ...truck,
    type: normalizeTruckTypeLabel(truck.type),
    count: Math.max(0, Number.parseInt(truck.count, 10) || 0),
    hourlyCost: Math.max(0, Number(truck.hourlyCost) || 0),
  })).filter((truck) => truck.count > 0);
  if (!normalizedSetup.length) {
    return [];
  }

  if (enforceExactFleet) {
    return [normalizedSetup];
  }

  const truckSpecMap = buildTruckSpecMap(truckSpecs);
  const types = normalizedSetup.map((truck) => truck.type);
  const minimumCountsByType = new Map(types.map((type) => [type, 0]));

  (logicalLoads || []).forEach((load) => {
    const feasibleTypes = types.filter((type) =>
      fitsTruckToLoad(load, {
        type,
        spec: truckSpecMap.get(normalizeTruckTypeKey(type)) || null,
      }),
    );

    if (feasibleTypes.length === 1) {
      const onlyType = feasibleTypes[0];
      minimumCountsByType.set(onlyType, Math.max(1, minimumCountsByType.get(onlyType) || 0));
    }
  });

  const candidates = [];

  function materialize(index, countsByType) {
    if (index >= normalizedSetup.length) {
      const truckSetup = normalizedSetup
        .map((truck) => ({
          ...truck,
          count: countsByType.get(truck.type) || 0,
        }))
        .filter((truck) => truck.count > 0);

      if (truckSetup.length) {
        candidates.push(truckSetup);
      }
      return;
    }

    const baseTruck = normalizedSetup[index];
    const minimumCount = Math.min(baseTruck.count, Math.max(0, minimumCountsByType.get(baseTruck.type) || 0));
    for (let count = minimumCount; count <= baseTruck.count; count += 1) {
      countsByType.set(baseTruck.type, count);
      materialize(index + 1, countsByType);
    }
  }

  materialize(0, new Map());
  const uniqueCandidates = [];
  const seen = new Set();

  candidates.forEach((truckSetup) => {
    const signature = truckSetup
      .map((truck) => `${normalizeTruckTypeKey(truck.type)}:${truck.count}`)
      .sort()
      .join("|");
    if (seen.has(signature)) {
      return;
    }
    seen.add(signature);
    uniqueCandidates.push(truckSetup);
  });

  const scoredCandidates = uniqueCandidates.map((truckSetup) => {
    const totalCount = truckSetup.reduce((sum, truck) => sum + truck.count, 0);
    const minimumPenalty = normalizedSetup.reduce((sum, truck) => {
      const minimumCount = minimumCountsByType.get(truck.type) || 0;
      const actualCount = truckSetup.find((candidateTruck) => candidateTruck.type === truck.type)?.count || 0;
      return sum + Math.max(0, actualCount - minimumCount);
    }, 0);
    const totalHourlyCost = truckSetup.reduce(
      (sum, truck) => sum + ((Number(truck.hourlyCost) || 0) * truck.count),
      0,
    );

    return {
      truckSetup,
      totalCount,
      minimumPenalty,
      totalHourlyCost,
    };
  });

  const sortedCandidates = scoredCandidates.sort((left, right) =>
    (left.totalCount - right.totalCount) ||
    (left.minimumPenalty - right.minimumPenalty) ||
    (left.totalHourlyCost - right.totalHourlyCost),
  );

  const representativeByTruckCount = [];
  const seenTruckCounts = new Set();
  sortedCandidates.forEach((candidate) => {
    if (seenTruckCounts.has(candidate.totalCount)) {
      return;
    }
    seenTruckCounts.add(candidate.totalCount);
    representativeByTruckCount.push(candidate);
  });

  const diversified = [];
  const diversifiedSignatures = new Set();
  function pushCandidate(candidate) {
    if (!candidate) {
      return;
    }
    const signature = candidate.truckSetup
      .map((truck) => `${normalizeTruckTypeKey(truck.type)}:${truck.count}`)
      .sort()
      .join("|");
    if (diversifiedSignatures.has(signature)) {
      return;
    }
    diversifiedSignatures.add(signature);
    diversified.push(candidate);
  }

  pushCandidate(representativeByTruckCount[0]);
  pushCandidate(representativeByTruckCount[Math.floor((representativeByTruckCount.length - 1) / 2)]);
  pushCandidate(representativeByTruckCount[representativeByTruckCount.length - 1]);
  pushCandidate([...sortedCandidates].sort((left, right) => left.totalHourlyCost - right.totalHourlyCost)[0]);
  pushCandidate([...sortedCandidates].sort((left, right) => right.totalHourlyCost - left.totalHourlyCost)[0]);

  return diversified
    .slice(0, 5)
    .map((candidate) => candidate.truckSetup);
}

function splitShiftCapacity(totalWorkers = 0) {
  const safeTotal = Math.max(0, Number.parseInt(totalWorkers, 10) || 0);
  const dayShift = Math.ceil(safeTotal / 2);
  const nightShift = Math.max(0, safeTotal - dayShift);

  return { dayShift, nightShift };
}

function splitRoleCountsAcrossShifts(roles = {}, dayTarget = 0, reservedDayRoles = {}) {
  const normalizedRoles = Object.entries(roles || {})
    .map(([roleId, role]) => ({
      roleId,
      count: Math.max(0, Number.parseInt(role?.count, 10) || 0),
    }))
    .filter((role) => role.count > 0);

  const totalWorkers = normalizedRoles.reduce((sum, role) => sum + role.count, 0);
  if (!totalWorkers) {
    return { dayRoles: {}, nightRoles: {} };
  }

  const safeDayTarget = Math.max(0, Math.min(totalWorkers, Number.parseInt(dayTarget, 10) || 0));
  const allocations = normalizedRoles.map((role) => ({
    roleId: role.roleId,
    totalCount: role.count,
    dayCount: Math.min(
      role.count,
      Math.max(0, Number.parseInt(reservedDayRoles?.[role.roleId], 10) || 0),
    ),
  }));

  let assignedDay = allocations.reduce((sum, role) => sum + role.dayCount, 0);
  const sortedRoles = [...allocations].sort((left, right) =>
    right.totalCount - left.totalCount || left.roleId.localeCompare(right.roleId),
  );

  while (assignedDay < safeDayTarget) {
    let madeProgress = false;
    for (const role of sortedRoles) {
      if (assignedDay >= safeDayTarget) {
        break;
      }
      if (role.dayCount < role.totalCount) {
        role.dayCount += 1;
        assignedDay += 1;
        madeProgress = true;
      }
    }
    if (!madeProgress) {
      break;
    }
  }

  const dayRoles = {};
  const nightRoles = {};
  allocations.forEach((role) => {
    dayRoles[role.roleId] = role.dayCount;
    nightRoles[role.roleId] = Math.max(0, role.totalCount - role.dayCount);
  });

  return { dayRoles, nightRoles };
}

function buildCriticalDayRoleMinimums(loads = []) {
  return (loads || [])
    .filter((load) => load?.is_critical)
    .reduce((result, load) => {
      const phaseRequirements = [
        load?.minimum_crew_roles?.rig_down || {},
        load?.minimum_crew_roles?.rig_up || {},
      ];

      phaseRequirements.forEach((requirements) => {
        Object.entries(requirements).forEach(([roleId, count]) => {
          const required = Math.max(0, Number.parseInt(count, 10) || 0);
          result[roleId] = Math.max(result[roleId] || 0, required);
        });
      });

      return result;
    }, {});
}

function buildWorkerPool(workerShiftConfig = null, fallbackWorkerCount = 0) {
  const roles = workerShiftConfig?.roles || {};
  const pool = [];
  const configuredRoleCount = Object.values(roles).reduce(
    (sum, role) => sum + Math.max(0, Number.parseInt(role?.count, 10) || 0),
    0,
  );
  const fallbackShiftCapacity = splitShiftCapacity(fallbackWorkerCount);
  const requestedDayShift = Math.max(
    0,
    Math.min(
      configuredRoleCount || fallbackWorkerCount,
      Number.parseInt(workerShiftConfig?.dayShift, 10) || fallbackShiftCapacity.dayShift,
    ),
  );
  const reservedDayRoles = workerShiftConfig?.criticalDayRoleMinimums || {};
  const reservedDayCount = Object.values(reservedDayRoles).reduce(
    (sum, count) => sum + Math.max(0, Number.parseInt(count, 10) || 0),
    0,
  );
  const effectiveDayTarget = Math.max(requestedDayShift, Math.min(configuredRoleCount || fallbackWorkerCount, reservedDayCount));
  const { dayRoles, nightRoles } = splitRoleCountsAcrossShifts(roles, effectiveDayTarget, reservedDayRoles);

  Object.keys(roles).forEach((roleId) => {
    const dayCount = Math.max(0, dayRoles[roleId] || 0);
    const nightCount = Math.max(0, nightRoles[roleId] || 0);

    Array.from({ length: dayCount }, (_, index) => ({
      id: `${roleId}-day-${index + 1}`,
      label: `${roleId} day ${index + 1}`,
      roleId,
      shiftType: "day",
      availableAt: 0,
    })).forEach((worker) => pool.push(worker));

    Array.from({ length: nightCount }, (_, index) => ({
      id: `${roleId}-night-${index + 1}`,
      label: `${roleId} night ${index + 1}`,
      roleId,
      shiftType: "night",
      availableAt: 0,
    })).forEach((worker) => pool.push(worker));
  });

  if (pool.length) {
    return pool;
  }

  const genericCount = Math.max(0, Number.parseInt(fallbackWorkerCount, 10) || 0);
  const { dayShift: dayCount, nightShift: nightCount } = splitShiftCapacity(genericCount);

  Array.from({ length: dayCount }, (_, index) => ({
    id: `crew-day-${index + 1}`,
    label: `Crew Day ${index + 1}`,
    roleId: "crew",
    shiftType: "day",
    availableAt: 0,
  })).forEach((worker) => pool.push(worker));

  Array.from({ length: nightCount }, (_, index) => ({
    id: `crew-night-${index + 1}`,
    label: `Crew Night ${index + 1}`,
    roleId: "crew",
    shiftType: "night",
    availableAt: 0,
  })).forEach((worker) => pool.push(worker));

  return pool;
}

function getShiftWindow(shiftType, minute, startClockMinutes = 360) {
  const safeMinute = Math.max(0, Math.floor(minute || 0));
  const cycleIndex = Math.floor(safeMinute / 1440);

  for (let offset = -1; offset <= 2; offset += 1) {
    const cycleStart = (cycleIndex + offset) * 1440;
    const windowStart = cycleStart + startClockMinutes + (shiftType === "night" ? 720 : 0);
    const windowEnd = windowStart + 720;

    if (safeMinute >= windowStart && safeMinute < windowEnd) {
      return { start: windowStart, end: windowEnd };
    }

    if (safeMinute < windowStart) {
      return { start: windowStart, end: windowEnd };
    }
  }

  const fallbackStart = cycleIndex * 1440 + startClockMinutes + (shiftType === "night" ? 720 : 0);
  return {
    start: fallbackStart,
    end: fallbackStart + 720,
  };
}

function buildRoleCountConfig(workers) {
  return {
    roles: Object.entries(
      (workers || []).reduce((result, worker) => {
        result[worker.roleId] = {
          count: (result[worker.roleId]?.count || 0) + 1,
        };
        return result;
      }, {}),
    ).reduce((result, [roleId, value]) => {
      result[roleId] = value;
      return result;
    }, {}),
  };
}

function sumRoleRequirements(roleRequirements = {}) {
  return Object.values(roleRequirements || {}).reduce(
    (sum, count) => sum + Math.max(0, Number.parseInt(count, 10) || 0),
    0,
  );
}

function getWorkerShiftEnd(worker, minute, startClockMinutes = 360) {
  return getShiftWindow(worker.shiftType, minute, startClockMinutes).end;
}

function getNextWorkerActiveMinute(worker, minute, startClockMinutes = 360) {
  const candidateMinute = Math.max(0, Math.floor(Math.max(worker?.availableAt || 0, minute || 0)));
  const shiftWindow = getShiftWindow(worker?.shiftType, candidateMinute, startClockMinutes);

  if (candidateMinute < shiftWindow.start) {
    return shiftWindow.start;
  }

  if (candidateMinute >= shiftWindow.end) {
    return getShiftWindow(worker?.shiftType, candidateMinute + 1, startClockMinutes).start;
  }

  return candidateMinute;
}

function calculateTaskRate(averageMinutes, optimalMinutes, minWorkers, optimalWorkers, workersAllocated) {
  const duration = adjustTaskDuration(
    averageMinutes,
    optimalMinutes,
    minWorkers,
    optimalWorkers,
    workersAllocated,
  );

  return duration > 0 ? 1 / duration : 0;
}

function estimateHandlingMinutes(load, phase = "pickup") {
  const weight = Math.max(0, Number(load?.weight_tons) || 0);
  const dimensions = load?.dimensions || {};
  const maxDimension = Math.max(
    Number(dimensions.length) || 0,
    Number(dimensions.width) || 0,
    Number(dimensions.height) || 0,
  );

  let minutes = phase === "unload" ? 15 : 20;
  if (weight >= 20) {
    minutes += 10;
  }
  if (weight >= 35) {
    minutes += 10;
  }
  if (maxDimension >= 10) {
    minutes += 10;
  }
  if (maxDimension >= 20) {
    minutes += 10;
  }

  return Math.max(15, Math.min(60, minutes));
}

function buildPlanningTaskGraph(loads = [], routeData = {}) {
  const tasks = [];
  const taskMap = new Map();
  const outgoing = new Map();
  const indegree = new Map();
  const loadCodeToIds = new Map();
  const phaseOrder = new Map([
    ["start", 0],
    ["rig_down", 1],
    ["move", 2],
    ["pickup_load", 2],
    ["haul", 3],
    ["unload_drop", 4],
    ["rig_up", 5],
    ["finish", 6],
  ]);

  (loads || []).forEach((load) => {
    const code = String(load?.code || "").trim().toUpperCase();
    if (!code) {
      return;
    }
    if (!loadCodeToIds.has(code)) {
      loadCodeToIds.set(code, []);
    }
    loadCodeToIds.get(code).push(load.id);
  });

  function compareTaskOrder(left, right) {
    return (
      (left.loadId - right.loadId) ||
      ((phaseOrder.get(left.phase) || 99) - (phaseOrder.get(right.phase) || 99)) ||
      String(left.id).localeCompare(String(right.id))
    );
  }

  function addTask(task) {
    const record = {
      ...task,
      predecessorIds: [...(task.predecessorIds || [])],
      successorIds: [],
      earliestStart: 0,
      earliestFinish: 0,
      latestStart: 0,
      latestFinish: 0,
      slack: 0,
      isCritical: false,
      activityCode: task.activityCode || "",
      activityLabel: task.activityLabel || "",
      sourceKind: task.sourceKind || "rig",
    };
    tasks.push(record);
    taskMap.set(record.id, record);
    outgoing.set(record.id, []);
    indegree.set(record.id, 0);
  }

  function resolveDependencyTaskIds(rawDependencies = [], phase = "rig_down") {
    const suffix = phase === "rig_up" ? "rig_up" : "rig_down";

    return [...new Set(
      (rawDependencies || []).flatMap((dependency) => {
        if (Number.isFinite(Number(dependency))) {
          return [`${dependency}:${suffix}`];
        }

        const normalized = String(dependency || "").trim().toUpperCase();
        if (!normalized) {
          return [];
        }

        if (loadCodeToIds.has(normalized)) {
          return (loadCodeToIds.get(normalized) || []).map((loadId) => `${loadId}:${suffix}`);
        }

        return [];
      }),
    )];
  }

  (loads || []).forEach((load) => {
    const routeMinutes = Math.max(1, Number(load?.routeMinutes) || Number(routeData?.minutes) || 1);
    const pickupMinutes = estimateHandlingMinutes(load, "pickup");
    const unloadMinutes = estimateHandlingMinutes(load, "unload");
    const rigDownDeps = resolveDependencyTaskIds([
      ...(load.rig_down_dependency_ids || []),
      ...(load.dependency_ids || []),
      ...(load.rig_down_dependency_codes || []),
    ], "rig_down");
    const rigUpDeps = resolveDependencyTaskIds([
      ...(load.rig_up_dependency_ids || []),
      ...(load.rig_up_dependency_codes || []),
    ], "rig_up");
    const sourceKind = load?.source_kind || "rig";
    const moveDurationMinutes = Math.max(1, pickupMinutes + routeMinutes + unloadMinutes);
    const chain = sourceKind === "startup"
      ? [
          {
            id: `${load.id}:move`,
            loadId: load.id,
            loadCode: load.code || `#${load.id}`,
            description: load.description,
            phase: "move",
            activityCode: "RM",
            activityLabel: "Rig Moving",
            sourceKind,
            durationMinutes: moveDurationMinutes,
            predecessorIds: ["START"],
          },
          {
            id: `${load.id}:rig_up`,
            loadId: load.id,
            loadCode: load.code || `#${load.id}`,
            description: load.description,
            phase: "rig_up",
            activityCode: "RU",
            activityLabel: "Rig Up",
            sourceKind,
            durationMinutes: Math.max(1, Number(load.rig_up_duration) || 1),
            predecessorIds: [`${load.id}:move`, ...rigUpDeps],
          },
        ]
      : [
          {
            id: `${load.id}:rig_down`,
            loadId: load.id,
            loadCode: load.code || `#${load.id}`,
            description: load.description,
            phase: "rig_down",
            activityCode: "RD",
            activityLabel: "Rig Down",
            sourceKind,
            durationMinutes: Math.max(1, Number(load.rig_down_duration) || 1),
            predecessorIds: rigDownDeps,
          },
          {
            id: `${load.id}:move`,
            loadId: load.id,
            loadCode: load.code || `#${load.id}`,
            description: load.description,
            phase: "move",
            activityCode: "RM",
            activityLabel: "Rig Moving",
            sourceKind,
            durationMinutes: moveDurationMinutes,
            predecessorIds: [`${load.id}:rig_down`],
          },
          {
            id: `${load.id}:rig_up`,
            loadId: load.id,
            loadCode: load.code || `#${load.id}`,
            description: load.description,
            phase: "rig_up",
            activityCode: "RU",
            activityLabel: "Rig Up",
            sourceKind,
            durationMinutes: Math.max(1, Number(load.rig_up_duration) || 1),
            predecessorIds: [`${load.id}:move`, ...rigUpDeps],
          },
        ];
    chain.forEach(addTask);
  });

  addTask({
    id: "START",
    loadId: 0,
    loadCode: "START",
    description: "Project start",
    phase: "start",
    activityCode: "START",
    activityLabel: "Start",
    sourceKind: "system",
    durationMinutes: 0,
    predecessorIds: [],
  });
  addTask({
    id: "FINISH",
    loadId: Number.MAX_SAFE_INTEGER,
    loadCode: "FINISH",
    description: "Project finish",
    phase: "finish",
    activityCode: "FINISH",
    activityLabel: "Finish",
    sourceKind: "system",
    durationMinutes: 0,
    predecessorIds: [],
  });

  tasks
    .filter((task) => task.phase === "rig_down" && task.id !== "START" && task.id !== "FINISH")
    .forEach((task) => {
      if (!task.predecessorIds.length) {
        task.predecessorIds.push("START");
      }
    });

  const rigUpTaskIds = tasks
    .filter((task) => task.phase === "rig_up" && task.id !== "FINISH")
    .map((task) => task.id);
  const finishTask = taskMap.get("FINISH");
  finishTask.predecessorIds = rigUpTaskIds;

  tasks.forEach((task) => {
    task.predecessorIds.forEach((predecessorId) => {
      if (!taskMap.has(predecessorId)) {
        return;
      }
      outgoing.get(predecessorId).push(task.id);
      taskMap.get(predecessorId).successorIds.push(task.id);
      indegree.set(task.id, (indegree.get(task.id) || 0) + 1);
    });
  });

  const queue = tasks.filter((task) => (indegree.get(task.id) || 0) === 0);
  const topo = [];
  const localIndegree = new Map(indegree);

  while (queue.length) {
    queue.sort(compareTaskOrder);
    const current = queue.shift();
    topo.push(current);
    (outgoing.get(current.id) || []).forEach((nextId) => {
      localIndegree.set(nextId, (localIndegree.get(nextId) || 0) - 1);
      if ((localIndegree.get(nextId) || 0) <= 0) {
        queue.push(taskMap.get(nextId));
      }
    });
  }

  if (topo.length < tasks.length) {
    const seenIds = new Set(topo.map((task) => task.id));
    const remaining = tasks
      .filter((task) => !seenIds.has(task.id))
      .sort((left, right) => {
        const leftDegree = localIndegree.get(left.id) || 0;
        const rightDegree = localIndegree.get(right.id) || 0;
        return leftDegree - rightDegree || compareTaskOrder(left, right);
      });

    remaining.forEach((task) => {
      topo.push(task);
    });
  }

  topo.forEach((task) => {
    const predecessorFinish = Math.max(
      0,
      ...task.predecessorIds
        .map((predecessorId) => taskMap.get(predecessorId)?.earliestFinish || 0),
    );
    task.earliestStart = predecessorFinish;
    task.earliestFinish = predecessorFinish + task.durationMinutes;
  });

  const projectFinish = Math.max(0, ...topo.map((task) => task.earliestFinish));
  [...topo].reverse().forEach((task) => {
    const successorStarts = task.successorIds
      .map((successorId) => taskMap.get(successorId)?.latestStart)
      .filter((value) => Number.isFinite(value));
    task.latestFinish = successorStarts.length ? Math.min(...successorStarts) : projectFinish;
    task.latestStart = task.latestFinish - task.durationMinutes;
    task.slack = Math.max(0, task.latestStart - task.earliestStart);
    task.isCritical = task.slack === 0;
  });

  if (!tasks.some((task) => task.isCritical) && topo.length) {
    const finishTask = [...topo].sort((left, right) => right.earliestFinish - left.earliestFinish || compareTaskOrder(left, right))[0];
    let cursor = finishTask;
    const protectedIds = new Set();

    while (cursor && !protectedIds.has(cursor.id)) {
      protectedIds.add(cursor.id);
      cursor.isCritical = true;
      cursor.slack = 0;
      cursor.latestStart = cursor.earliestStart;
      cursor.latestFinish = cursor.earliestFinish;

      const predecessors = cursor.predecessorIds
        .map((predecessorId) => taskMap.get(predecessorId))
        .filter(Boolean)
        .sort((left, right) => right.earliestFinish - left.earliestFinish || compareTaskOrder(left, right));
      cursor = predecessors[0] || null;
    }
  }

  const loadMetrics = new Map();
  (loads || []).forEach((load) => {
    const loadTasks = tasks.filter((task) => task.loadId === load.id);
    const finishTask = loadTasks.find((task) => task.phase === "rig_up");
    const slack = finishTask?.slack ?? Math.min(...loadTasks.map((task) => task.slack));
    const criticalMinutes = loadTasks
      .filter((task) => task.isCritical)
      .reduce((sum, task) => sum + task.durationMinutes, 0);
    loadMetrics.set(load.id, {
      loadId: load.id,
      slack: Number.isFinite(slack) ? slack : 0,
      isCritical: loadTasks.some((task) => task.isCritical),
      criticalTaskCount: loadTasks.filter((task) => task.isCritical).length,
      criticalMinutes,
      chainMinutes: loadTasks.reduce((sum, task) => sum + task.durationMinutes, 0),
      earliestFinish: finishTask?.earliestFinish || 0,
    });
  });

  return {
    tasks,
    taskMap,
    projectFinish,
    criticalTaskIds: tasks.filter((task) => task.isCritical).map((task) => task.id),
    loadMetrics,
  };
}

function scheduleCrewTask({
  phase,
  load,
  earliestStart,
  averageMinutes,
  optimalMinutes,
  objective = "fastest",
  workerPool,
  workerShiftConfig,
  startClockMinutes,
  allowedShiftTypes = null,
}) {
  const hasRoleRoster = Object.keys(workerShiftConfig?.roles || {}).length > 0;
  const minimumRoleRequirements = hasRoleRoster
    ? (load?.minimum_crew_roles?.[phase.replace("-", "_")] || {})
    : {};
  const optimalRoleRequirements = hasRoleRoster
    ? (load?.optimal_crew_roles?.[phase.replace("-", "_")] || {})
    : {};
  const minWorkers = hasRoleRoster
    ? Math.max(1, sumRoleRequirements(minimumRoleRequirements) || Number(load?.min_worker_count) || 1)
    : 1;
  const maxPreferredWorkers = hasRoleRoster
    ? Math.max(
        minWorkers,
        sumRoleRequirements(optimalRoleRequirements) || Number(load?.optimal_worker_count) || minWorkers,
      )
    : 1;
  const preferredWorkers = objective === "cheapest" ? minWorkers : maxPreferredWorkers;
  let attempt = Math.max(0, Math.floor(earliestStart || 0));

  for (let iteration = 0; iteration < 20000; iteration += 1) {
    const trialPool = workerPool.map((worker) => ({ ...worker }));
    const assignments = [];
    const aggregateRoleCounts = {};
    let segmentStart = attempt;
    let remainingWork = 1;
    let maxWorkerCount = 0;
    let madeProgress = false;
    let nextAttemptHint = null;

    while (remainingWork > 1e-6) {
      const onShiftWorkers = trialPool.filter((worker) => {
        if (allowedShiftTypes?.length && !allowedShiftTypes.includes(worker.shiftType)) {
          return false;
        }
        const shiftWindow = getShiftWindow(worker.shiftType, segmentStart, startClockMinutes);
        return worker.availableAt <= segmentStart && segmentStart >= shiftWindow.start && segmentStart < shiftWindow.end;
      });

      const requiredRoleIds = Object.keys(minimumRoleRequirements);
      const hasRequiredRoles = requiredRoleIds.every((roleId) => {
        const availableCount = onShiftWorkers.filter((worker) => worker.roleId === roleId).length;
        return availableCount >= (Number.parseInt(minimumRoleRequirements[roleId], 10) || 0);
      });

      if (onShiftWorkers.length < minWorkers || !hasRequiredRoles) {
        const relevantWorkers = (requiredRoleIds.length
          ? trialPool.filter((worker) => requiredRoleIds.includes(worker.roleId))
          : trialPool
        )
          .filter((worker) => !allowedShiftTypes?.length || allowedShiftTypes.includes(worker.shiftType))
          .map((worker) => getNextWorkerActiveMinute(worker, segmentStart + 1, startClockMinutes))
          .filter((candidateMinute) => candidateMinute > segmentStart);

        if (relevantWorkers.length) {
          nextAttemptHint = Math.min(...relevantWorkers);
        }
        break;
      }

      const assignedWorkerCount = Math.min(preferredWorkers, onShiftWorkers.length);
      const targetRoleCounts = { ...minimumRoleRequirements };
      let assignedRoles = sumRoleRequirements(targetRoleCounts);

      if (assignedRoles < assignedWorkerCount) {
        const additionalRoleCounts = allocateWorkerRoles(
          assignedWorkerCount - assignedRoles,
          buildRoleCountConfig(onShiftWorkers),
        );
        Object.entries(additionalRoleCounts).forEach(([roleId, count]) => {
          const optimalCap = Number.parseInt(optimalRoleRequirements[roleId], 10) || null;
          const nextCount = (targetRoleCounts[roleId] || 0) + count;
          targetRoleCounts[roleId] = optimalCap ? Math.min(nextCount, optimalCap) : nextCount;
        });
      }

      const selectedWorkers = [];

      Object.entries(targetRoleCounts).forEach(([roleId, count]) => {
        onShiftWorkers
          .filter((worker) => worker.roleId === roleId)
          .sort((left, right) => left.availableAt - right.availableAt)
          .slice(0, count)
          .forEach((worker) => {
            if (!selectedWorkers.includes(worker)) {
              selectedWorkers.push(worker);
            }
          });
      });

      if (selectedWorkers.length < assignedWorkerCount) {
        onShiftWorkers
          .sort((left, right) => left.availableAt - right.availableAt)
          .forEach((worker) => {
            if (selectedWorkers.length < assignedWorkerCount && !selectedWorkers.includes(worker)) {
              selectedWorkers.push(worker);
            }
          });
      }

      if (selectedWorkers.length < minWorkers) {
        const nextSelectedWorkerWindow = onShiftWorkers
          .map((worker) => getNextWorkerActiveMinute(worker, segmentStart + 1, startClockMinutes))
          .filter((candidateMinute) => candidateMinute > segmentStart);

        if (nextSelectedWorkerWindow.length) {
          nextAttemptHint = Math.min(...nextSelectedWorkerWindow);
        }
        break;
      }

      const segmentWorkerCount = selectedWorkers.length;
      const rate = calculateTaskRate(
        averageMinutes,
        optimalMinutes,
        minWorkers,
        maxPreferredWorkers,
        segmentWorkerCount,
      );

      if (rate <= 0) {
        break;
      }

      const segmentEndLimit = Math.min(...selectedWorkers.map((worker) => getWorkerShiftEnd(worker, segmentStart, startClockMinutes)));
      const minutesNeeded = Math.ceil(remainingWork / rate);
      const segmentEnd = Math.min(segmentEndLimit, segmentStart + minutesNeeded);
      const workedMinutes = segmentEnd - segmentStart;

      if (workedMinutes <= 0) {
        const nextWorkerWindow = selectedWorkers
          .map((worker) => getNextWorkerActiveMinute(worker, segmentStart + 1, startClockMinutes))
          .filter((candidateMinute) => candidateMinute > segmentStart);

        if (nextWorkerWindow.length) {
          nextAttemptHint = Math.min(...nextWorkerWindow);
        }
        break;
      }

      madeProgress = true;
      remainingWork = Math.max(0, remainingWork - (workedMinutes * rate));
      maxWorkerCount = Math.max(maxWorkerCount, segmentWorkerCount);

      Object.entries(targetRoleCounts).forEach(([roleId, count]) => {
        aggregateRoleCounts[roleId] = Math.max(aggregateRoleCounts[roleId] || 0, count);
      });

      selectedWorkers.forEach((worker) => {
        worker.availableAt = segmentEnd;
        assignments.push({
          workerId: worker.id,
          workerLabel: worker.label,
          roleId: worker.roleId,
          shiftType: worker.shiftType,
          phase,
          loadId: load.id,
          loadCode: load.code || `#${load.id}`,
          description: load.description,
          startMinute: segmentStart,
          endMinute: segmentEnd,
        });
      });

      segmentStart = segmentEnd;
    }

    if (madeProgress && remainingWork <= 1e-6) {
      assignments.forEach((assignment) => {
        const worker = workerPool.find((item) => item.id === assignment.workerId);
        if (worker) {
          worker.availableAt = assignment.endMinute;
        }
      });

      return {
        startMinute: attempt,
        endMinute: Math.max(...assignments.map((assignment) => assignment.endMinute), attempt),
        workerCount: maxWorkerCount || minWorkers,
        workerRoles: Object.fromEntries(
          Object.entries(aggregateRoleCounts).filter(([, count]) => count > 0),
        ),
        assignments,
      };
    }

    attempt = Math.max(attempt + 15, nextAttemptHint || 0);
  }

  throw new Error(`No ${phase} worker crew could be scheduled for ${load?.description || "load"}.`);
}

export async function buildPlayback(
  plan,
  truckCount,
  truckSetup = [],
  truckSpecs = [],
  objective = "fastest",
  workerCount = 6,
  workerShiftConfig = null,
  progressOptions = {},
) {
  const steps = [];
  const trucks = buildFleetForPlayback(truckCount, truckSetup, truckSpecs);
  const trips = [];
  const playbackJourneys = [];
  const workerAssignments = [];
  const truckCostByType = buildTruckCostMap(truckSetup);
  const workerHourlyCost = getAverageWorkerHourlyCost(workerShiftConfig);
  const rigDownCompletionByLoadId = new Map();
  const rigUpCompletionByLoadId = new Map();
  const startClockMinutes =
    ((Number.parseInt(workerShiftConfig?.startHour, 10) || 6) * 60) +
    (Number.parseInt(workerShiftConfig?.startMinute, 10) || 0);
  const planningAnalysis = plan?.planningAnalysis || buildPlanningTaskGraph(plan?.loads || (plan?.waves || []).flat(), {
    minutes: plan?.routeMinutes,
  });
  const criticalDayRoleMinimums = buildCriticalDayRoleMinimums(plan?.loads || (plan?.waves || []).flat());
  const workerPool = buildWorkerPool(
    {
      ...(workerShiftConfig || {}),
      criticalDayRoleMinimums,
    },
    workerCount,
  );
  const knownLoadIds = new Set((plan?.loads || []).map((load) => load.id));
  const loadTaskMetrics = planningAnalysis.loadMetrics || new Map();
  const actualTasks = [];
  const loads = (plan?.loads?.length ? plan.loads : (plan?.waves || []).flat()).slice();
  const pendingLoads = loads
    .map((load, index) => ({ ...load, __order: index }))
    .sort((left, right) =>
      (Number.parseInt(left.priority, 10) || 0) - (Number.parseInt(right.priority, 10) || 0) ||
      left.__order - right.__order,
    );
  const totalLoadsToSchedule = Math.max(1, pendingLoads.length);
  const progressBase = Number(progressOptions.basePercent) || 0;
  const progressSpan = Number(progressOptions.spanPercent) || 0;
  const evaluationIndex = Math.max(1, Number(progressOptions.evaluationIndex) || 1);
  const totalEvaluations = Math.max(1, Number(progressOptions.totalEvaluations) || 1);
  const totalWorkUnits = Math.max(1, totalEvaluations * (totalLoadsToSchedule + 1));
  const baseWorkUnits = (evaluationIndex - 1) * (totalLoadsToSchedule + 1);
  const reportProgress = typeof progressOptions.onProgress === "function" ? progressOptions.onProgress : null;
  const readyLoadCandidateLimit = 6;
  const truckCandidateLimit = 2;

  function scoreReadyLoad(load) {
    const dependencyReadyAt = Math.max(
      0,
      ...((load.rig_down_dependency_ids || load.dependency_ids || [])
        .filter((dependencyId) => knownLoadIds.has(dependencyId))
        .map((dependencyId) => rigDownCompletionByLoadId.get(dependencyId) || 0)),
    );
    const metrics = loadTaskMetrics.get(load.id) || {};
    const priority = Number.parseInt(load.priority, 10) || 0;
    const flexibility = Math.max(1, load.truck_options?.length || 1);
    const minWorkers = Math.max(
      1,
      sumRoleRequirements(load?.minimum_crew_roles?.rig_down || {}),
      sumRoleRequirements(load?.minimum_crew_roles?.rig_up || {}),
      Number(load?.min_worker_count) || 1,
    );

    if (objective === "cheapest") {
      return (
        (priority * 100) +
        ((metrics.slack || 0) * 2) +
        (flexibility * 20) +
        dependencyReadyAt +
        (minWorkers * 3)
      );
    }

    if (objective === "utilized") {
      return (
        dependencyReadyAt +
        ((metrics.slack || 0) * 4) +
        (flexibility * 15) -
        ((metrics.criticalMinutes || 0) * 0.2)
      );
    }

    return (
      (priority * 100) +
      ((metrics.slack || 0) * 6) +
      (flexibility * 25) +
      dependencyReadyAt -
      ((metrics.criticalMinutes || 0) * 0.35)
    );
  }

  function evaluateLoadCandidate(load, candidatePoolLoads = []) {
    const criticalCrewShiftTypes = load.is_critical ? ["day"] : null;
    const activeDependencyIds = (load.rig_down_dependency_ids || load.dependency_ids || [])
      .filter((dependencyId) => knownLoadIds.has(dependencyId));
    const dependencyReadyAt = Math.max(
      0,
      ...activeDependencyIds.map((dependencyId) => rigDownCompletionByLoadId.get(dependencyId) || 0),
    );
    const pickupLoadMinutes = estimateHandlingMinutes(load, "pickup");
    const eligibleTruckPool = trucks
      .filter((truck) => fitsTruckToLoad(load, truck))
      .sort((left, right) => {
        const leftCost = truckCostByType.get(normalizeTruckTypeKey(left.type)) || 120;
        const rightCost = truckCostByType.get(normalizeTruckTypeKey(right.type)) || 120;

        if (objective === "cheapest") {
          return (
            (leftCost - rightCost) ||
            (left.availableAt - right.availableAt)
          );
        }

        if (objective === "utilized") {
          return (
            (left.availableAt - right.availableAt) ||
            (leftCost - rightCost)
          );
        }

        return (
          (left.availableAt - right.availableAt) ||
          (leftCost - rightCost)
        );
      });
    const eligibleTrucks = eligibleTruckPool
      .slice(0, Math.max(truckCandidateLimit, Math.min(eligibleTruckPool.length, 4)));

    if (!eligibleTrucks.length) {
      throw new Error(`No eligible truck is available for ${load.description}.`);
    }

    let lastTruckFailure = null;
    const bestCandidate = eligibleTrucks.reduce((best, truck) => {
      try {
        const candidateWorkerPool = workerPool.map((worker) => ({ ...worker }));
        const rigDownTask = scheduleCrewTask({
          phase: "rig-down",
          load,
          earliestStart: dependencyReadyAt,
          averageMinutes: load.rig_down_duration,
          optimalMinutes: load.optimal_rig_down_duration,
          objective,
          workerPool: candidateWorkerPool,
          workerShiftConfig,
          startClockMinutes,
          allowedShiftTypes: criticalCrewShiftTypes,
        });
        const baseRouteMinutes = estimateTravelMinutes(plan.routeDistanceKm, plan.routeMinutes, load, truck.spec);
        const pickupRouteMinutes = Math.max(0, Number(load.pickupRouteMinutes) || 0);
        const dispatchStart = Math.max(truck.availableAt, rigDownTask.endMinute);
        const pickupTravel = applyTravelWithBreaks(dispatchStart, pickupRouteMinutes, truck.driveSinceBreakMinutes);
        const pickupLoadTask = scheduleCrewTask({
          phase: "rig-down",
          load: {
            ...load,
            minimum_crew_roles: {
              ...(load.minimum_crew_roles || {}),
              rig_down: {},
            },
            optimal_crew_roles: {
              ...(load.optimal_crew_roles || {}),
              rig_down: {},
            },
            min_worker_count: 1,
            optimal_worker_count: 1,
          },
          earliestStart: Math.max(rigDownTask.endMinute, pickupTravel.endMinute),
          averageMinutes: pickupLoadMinutes,
          optimalMinutes: pickupLoadMinutes,
          objective,
          workerPool: candidateWorkerPool,
          workerShiftConfig,
          startClockMinutes,
          allowedShiftTypes: null,
        });
        const moveStart = pickupLoadTask.endMinute;
        const routeMinutes = baseRouteMinutes;
        const outboundTravel = applyTravelWithBreaks(moveStart, routeMinutes, pickupTravel.driveSinceBreakMinutes);
        const arrivalAtDestination = outboundTravel.endMinute;
        const rigUpDependencyReadyAt = Math.max(
          0,
          ...((load.rig_up_dependency_ids || [])
            .filter((dependencyId) => knownLoadIds.has(dependencyId))
            .map((dependencyId) => rigUpCompletionByLoadId.get(dependencyId) || 0)),
        );
        const unloadMinutes = estimateHandlingMinutes(load, "unload");
        const unloadDropTask = scheduleCrewTask({
          phase: "rig-up",
          load: {
            ...load,
            minimum_crew_roles: {
              ...(load.minimum_crew_roles || {}),
              rig_up: {},
            },
            optimal_crew_roles: {
              ...(load.optimal_crew_roles || {}),
              rig_up: {},
            },
            min_worker_count: 1,
            optimal_worker_count: 1,
          },
          earliestStart: arrivalAtDestination,
          averageMinutes: unloadMinutes,
          optimalMinutes: unloadMinutes,
          objective,
          workerPool: candidateWorkerPool,
          workerShiftConfig,
          startClockMinutes,
          allowedShiftTypes: null,
        });
        const rigUpTask = scheduleCrewTask({
          phase: "rig-up",
          load,
          earliestStart: Math.max(unloadDropTask.endMinute, rigUpDependencyReadyAt),
          averageMinutes: load.rig_up_duration,
          optimalMinutes: load.optimal_rig_up_duration,
          objective,
          workerPool: candidateWorkerPool,
          workerShiftConfig,
          startClockMinutes,
          allowedShiftTypes: load.is_critical ? ["day"] : null,
        });

        const returnStart = unloadDropTask.endMinute;
        const returnTravel = applyTravelWithBreaks(returnStart, routeMinutes, outboundTravel.driveSinceBreakMinutes);
        const returnToSource = returnTravel.endMinute;
        const truckRate = truckCostByType.get(normalizeTruckTypeKey(truck.type)) || 120;
        const truckActiveMinutes =
          Math.max(0, moveStart - dispatchStart) +
          Math.max(0, unloadDropTask.endMinute - moveStart) +
          Math.max(0, returnToSource - returnStart);
        const workerActiveMinutes =
          Math.max(0, rigDownTask.endMinute - rigDownTask.startMinute) * Math.max(0, Number(rigDownTask.workerCount) || 0) +
          Math.max(0, pickupLoadTask.endMinute - pickupLoadTask.startMinute) * Math.max(0, Number(pickupLoadTask.workerCount) || 0) +
          Math.max(0, unloadDropTask.endMinute - unloadDropTask.startMinute) * Math.max(0, Number(unloadDropTask.workerCount) || 0) +
          Math.max(0, rigUpTask.endMinute - rigUpTask.startMinute) * Math.max(0, Number(rigUpTask.workerCount) || 0);
        const completionMinute = rigUpTask.endMinute;
        const totalSlack = loadTaskMetrics.get(load.id)?.slack || 0;
        const totalCriticalMinutes = loadTaskMetrics.get(load.id)?.criticalMinutes || 0;
        const score = objective === "cheapest"
          ? (((truckActiveMinutes / 60) * truckRate) + ((workerActiveMinutes / 60) * workerHourlyCost)) * 100 + completionMinute + (totalSlack * 0.5)
          : objective === "utilized"
            ? Math.max(0, dispatchStart - truck.availableAt) + Math.max(0, rigDownTask.startMinute - dependencyReadyAt) + completionMinute * 0.25 + (totalSlack * 0.8)
            : completionMinute + (totalSlack * 4) - (totalCriticalMinutes * 0.1);

        const candidate = {
          load,
          loads: [
            {
              load,
              routeMinutes,
              rigDownTask,
              pickupLoadTask,
              unloadDropTask,
              rigUpTask,
            },
          ],
          truckId: truck.id,
          truckType: truck.type,
          routeMinutes,
          pickupRouteMinutes,
          dispatchStart,
          rigDownTask,
          pickupLoadTask,
          moveStart,
          arrivalAtDestination,
          unloadDropTask,
          rigUpTask,
          returnStart,
          returnToSource,
          bundleLabel: formatBundleLoadCodes([load]),
          updatedWorkerPool: candidateWorkerPool,
          updatedTruckState: {
            availableAt: returnToSource,
            driveSinceBreakMinutes: returnTravel.driveSinceBreakMinutes,
          },
          score,
        };

        if (!best || candidate.score < best.score || (candidate.score === best.score && completionMinute < Math.max(...(best.loads || []).map((entry) => entry.rigUpTask.endMinute), 0))) {
          return candidate;
        }
      } catch (error) {
        lastTruckFailure = error;
        return best;
      }

      return best;
    }, null);

    if (!bestCandidate && lastTruckFailure) {
      throw lastTruckFailure;
    }

    return bestCandidate;
  }

  function sortEvaluatedCandidates(candidates) {
    return candidates.slice().sort((left, right) =>
      (left.rigDownTask.startMinute - right.rigDownTask.startMinute) ||
      (left.dispatchStart - right.dispatchStart) ||
      (left.score - right.score) ||
      (left.rigUpTask.endMinute - right.rigUpTask.endMinute) ||
      ((Number.parseInt(left.load.priority, 10) || 0) - (Number.parseInt(right.load.priority, 10) || 0)) ||
      (left.load.__order - right.load.__order),
    );
  }

  function commitChosenCandidate(chosen) {
    workerPool.splice(0, workerPool.length, ...chosen.updatedWorkerPool);
    (chosen.loads || []).forEach((entry) => {
      workerAssignments.push(
        ...entry.rigDownTask.assignments,
        ...entry.pickupLoadTask.assignments,
        ...entry.unloadDropTask.assignments,
        ...entry.rigUpTask.assignments,
      );
    });

    const truck = trucks.find((item) => item.id === chosen.truckId);
    if (truck) {
      truck.availableAt = chosen.updatedTruckState.availableAt;
      truck.driveSinceBreakMinutes = chosen.updatedTruckState.driveSinceBreakMinutes;
    }

    const journeyId = `journey-${chosen.truckId}-${steps.length + 1}`;
    const journeyLoads = (chosen.loads || []).map((entry) => entry.load);
    const journeys = playbackJourneys;
    journeys.push({
      id: journeyId,
      truckId: chosen.truckId,
      truckType: chosen.truckType,
      loadIds: journeyLoads.map((load) => load.id),
      loadCodes: journeyLoads.map((load) => load.code || `#${load.id}`),
      description: chosen.bundleLabel || formatBundleLoadCodes(journeyLoads),
      dispatchStart: chosen.dispatchStart,
      moveStart: chosen.moveStart,
      arrivalAtDestination: chosen.arrivalAtDestination,
      returnStart: chosen.returnStart,
      returnToSource: chosen.returnToSource,
      routeMinutes: chosen.routeMinutes,
    });

    (chosen.loads || []).forEach((entry) => {
      trips.push({
        journeyId,
        truckId: chosen.truckId,
        truckType: chosen.truckType,
        loadId: entry.load.id,
        loadCode: entry.load.code || `#${entry.load.id}`,
        description: entry.load.description,
        sourceKind: entry.load.source_kind || "rig",
        sourceLabel: entry.load.sourceLabel || null,
        destinationLabel: entry.load.destinationLabel || null,
        dispatchStart: chosen.dispatchStart,
        pickupRouteMinutes: entry.load.pickupRouteMinutes || null,
        pickupRouteGeometry: entry.load.pickupRouteGeometry || null,
        routeMinutes: chosen.routeMinutes,
        routeGeometry: entry.load.routeGeometry || null,
        loadStart: entry.rigDownTask.startMinute,
        rigDownStart: entry.rigDownTask.startMinute,
        rigDownFinish: entry.rigDownTask.endMinute,
        pickupLoadStart: entry.pickupLoadTask.startMinute,
        pickupLoadFinish: entry.pickupLoadTask.endMinute,
        moveStart: chosen.moveStart,
        rigDownWorkerCount: entry.rigDownTask.workerCount,
        rigDownWorkerRoles: entry.rigDownTask.workerRoles,
        pickupLoadWorkerCount: entry.pickupLoadTask.workerCount,
        pickupLoadWorkerRoles: entry.pickupLoadTask.workerRoles,
        arrivalAtDestination: chosen.arrivalAtDestination,
        unloadDropStart: entry.unloadDropTask.startMinute,
        unloadDropFinish: entry.unloadDropTask.endMinute,
        unloadDropWorkerCount: entry.unloadDropTask.workerCount,
        unloadDropWorkerRoles: entry.unloadDropTask.workerRoles,
        rigUpStart: entry.rigUpTask.startMinute,
        rigUpFinish: entry.rigUpTask.endMinute,
        rigUpWorkerCount: entry.rigUpTask.workerCount,
        rigUpWorkerRoles: entry.rigUpTask.workerRoles,
        returnStart: chosen.returnStart,
        returnToSource: chosen.returnToSource,
      });

      const nominalTasks = planningAnalysis.tasks.filter((task) => task.loadId === entry.load.id);
      const nominalTaskMap = new Map(nominalTasks.map((task) => [task.phase, task]));
      const moveNominalTask = nominalTaskMap.get("move") || nominalTaskMap.get("haul") || nominalTaskMap.get("pickup_load");
      const actualLoadTasks = [];
      if ((entry.load?.source_kind || "rig") !== "startup") {
        actualLoadTasks.push({
          id: `${entry.load.id}:rig_down`,
          loadId: entry.load.id,
          loadCode: entry.load.code || `#${entry.load.id}`,
          description: entry.load.description,
          phase: "rig_down",
          predecessorIds: [...(nominalTaskMap.get("rig_down")?.predecessorIds || [])],
          startMinute: entry.rigDownTask.startMinute,
          endMinute: entry.rigDownTask.endMinute,
          earliestStart: nominalTaskMap.get("rig_down")?.earliestStart ?? entry.rigDownTask.startMinute,
          earliestFinish: nominalTaskMap.get("rig_down")?.earliestFinish ?? entry.rigDownTask.endMinute,
          latestStart: nominalTaskMap.get("rig_down")?.latestStart ?? entry.rigDownTask.startMinute,
          latestFinish: nominalTaskMap.get("rig_down")?.latestFinish ?? entry.rigDownTask.endMinute,
          slack: nominalTaskMap.get("rig_down")?.slack || 0,
          isCritical: Boolean(nominalTaskMap.get("rig_down")?.isCritical),
          activityCode: nominalTaskMap.get("rig_down")?.activityCode || "RD",
          activityLabel: nominalTaskMap.get("rig_down")?.activityLabel || "Rig Down",
          sourceKind: nominalTaskMap.get("rig_down")?.sourceKind || entry.load?.source_kind || "rig",
        });
      }
      actualLoadTasks.push({
          id: `${entry.load.id}:move`,
          loadId: entry.load.id,
          loadCode: entry.load.code || `#${entry.load.id}`,
          description: entry.load.description,
          phase: "move",
          predecessorIds: [...(moveNominalTask?.predecessorIds || [])],
          startMinute: entry.pickupLoadTask.startMinute,
          endMinute: entry.unloadDropTask.endMinute,
          earliestStart: moveNominalTask?.earliestStart ?? entry.pickupLoadTask.startMinute,
          earliestFinish: moveNominalTask?.earliestFinish ?? entry.unloadDropTask.endMinute,
          latestStart: moveNominalTask?.latestStart ?? entry.pickupLoadTask.startMinute,
          latestFinish: moveNominalTask?.latestFinish ?? entry.unloadDropTask.endMinute,
          slack: moveNominalTask?.slack || 0,
          isCritical: Boolean(moveNominalTask?.isCritical),
          activityCode: moveNominalTask?.activityCode || "RM",
          activityLabel: moveNominalTask?.activityLabel || "Rig Moving",
          sourceKind: moveNominalTask?.sourceKind || entry.load?.source_kind || "rig",
        },
        {
          id: `${entry.load.id}:rig_up`,
          loadId: entry.load.id,
          loadCode: entry.load.code || `#${entry.load.id}`,
          description: entry.load.description,
          phase: "rig_up",
          predecessorIds: [...(nominalTaskMap.get("rig_up")?.predecessorIds || [])],
          startMinute: entry.rigUpTask.startMinute,
          endMinute: entry.rigUpTask.endMinute,
          earliestStart: nominalTaskMap.get("rig_up")?.earliestStart ?? entry.rigUpTask.startMinute,
          earliestFinish: nominalTaskMap.get("rig_up")?.earliestFinish ?? entry.rigUpTask.endMinute,
          latestStart: nominalTaskMap.get("rig_up")?.latestStart ?? entry.rigUpTask.startMinute,
          latestFinish: nominalTaskMap.get("rig_up")?.latestFinish ?? entry.rigUpTask.endMinute,
          slack: nominalTaskMap.get("rig_up")?.slack || 0,
          isCritical: Boolean(nominalTaskMap.get("rig_up")?.isCritical),
          activityCode: nominalTaskMap.get("rig_up")?.activityCode || "RU",
          activityLabel: nominalTaskMap.get("rig_up")?.activityLabel || "Rig Up",
          sourceKind: nominalTaskMap.get("rig_up")?.sourceKind || entry.load?.source_kind || "rig",
        },
      );
      actualTasks.push(...actualLoadTasks);

      steps.push({
        type: "rig-down-start",
        minute: entry.rigDownTask.startMinute,
        title: `Rig down starts for ${entry.load.code || `#${entry.load.id}`}`,
        description: `${entry.load.description} starts rig down.`,
      });
      steps.push({
        type: "pickup-load-finish",
        minute: entry.pickupLoadTask.endMinute,
        title: `Truck ${chosen.truckId} is loaded with ${entry.load.code || `#${entry.load.id}`}`,
        description: `${entry.load.description} is secured and ready to move.`,
      });
      steps.push({
        type: "arrival",
        minute: chosen.arrivalAtDestination,
        title: `Truck ${chosen.truckId} reaches destination with ${entry.load.code || `#${entry.load.id}`}`,
        description: entry.load.destinationLabel
          ? `${entry.load.description} reaches ${entry.load.destinationLabel}.`
          : `${entry.load.description} reaches the destination rig.`,
      });
      steps.push({
        type: "unload-drop-finish",
        minute: entry.unloadDropTask.endMinute,
        title: `Truck ${chosen.truckId} unloads ${entry.load.code || `#${entry.load.id}`}`,
        description: `${entry.load.description} is dropped and the truck is released.`,
      });
      steps.push({
        type: "rig-up-finish",
        minute: entry.rigUpTask.endMinute,
        title: `Rig up complete for ${entry.load.code || `#${entry.load.id}`}`,
        description: `${entry.load.description} is positioned at the destination.`,
      });

      rigDownCompletionByLoadId.set(entry.load.id, entry.rigDownTask.endMinute);
      rigUpCompletionByLoadId.set(entry.load.id, entry.rigUpTask.endMinute);
      const pendingIndex = pendingLoads.findIndex((item) => item.id === entry.load.id && item.__order === entry.load.__order);
      if (pendingIndex >= 0) {
        pendingLoads.splice(pendingIndex, 1);
      }
    });

    steps.push({
      type: "move-start",
      minute: chosen.moveStart,
      title: `Truck ${chosen.truckId} departs with ${chosen.bundleLabel || formatBundleLoadCodes(journeyLoads)}`,
      description: `${chosen.bundleLabel || formatBundleLoadCodes(journeyLoads)} leave the source after pickup is complete.`,
    });
  }

  steps.push({
    type: "dispatch",
    minute: 0,
    title: "Transfer operation starts",
    description: `${truckCount} truck${truckCount > 1 ? "s are" : " is"} ready at the source rig.`,
  });

  while (pendingLoads.length) {
    if (reportProgress) {
      const completedLoads = totalLoadsToSchedule - pendingLoads.length;
      const nextPendingLoad = pendingLoads[0];
      const completedWorkUnits = baseWorkUnits + 1 + completedLoads;
      reportProgress({
        stage: "scheduling",
        percent: Math.min(99, (completedWorkUnits / totalWorkUnits) * 92),
        message: `Scheduling loads ${completedLoads + 1}/${totalLoadsToSchedule}`,
        detail: `Stage 7 of 8. Assigning ${nextPendingLoad?.code || nextPendingLoad?.description || `load ${completedLoads + 1}`} to workers and trucks.`,
        completedStages: 7,
        totalStages: 8,
      });
    }
    await yieldToBrowser();
    const readyLoads = pendingLoads.filter((load) =>
      (load.rig_down_dependency_ids || load.dependency_ids || [])
        .filter((dependencyId) => knownLoadIds.has(dependencyId))
        .every((dependencyId) => rigDownCompletionByLoadId.has(dependencyId)),
    );
    if (!readyLoads.length) {
      throw new Error("Some loads are still waiting on unresolved dependencies.");
    }

    const shortlistedReadyLoads = readyLoads
      .slice()
      .sort((left, right) =>
        (scoreReadyLoad(left) - scoreReadyLoad(right)) ||
        ((left.__order || 0) - (right.__order || 0)),
      )
      .slice(0, Math.min(readyLoadCandidateLimit, readyLoads.length));

    let evaluatedCandidates = shortlistedReadyLoads
      .map((load) => evaluateLoadCandidate(load, shortlistedReadyLoads))
      .filter(Boolean);

    if (!evaluatedCandidates.length && shortlistedReadyLoads.length < readyLoads.length) {
      evaluatedCandidates = readyLoads
        .map((load) => evaluateLoadCandidate(load, readyLoads))
        .filter(Boolean);
    }

    if (!evaluatedCandidates.length) {
      const firstReady = readyLoads[0];
      throw new Error(`No feasible execution path could be scheduled for ${firstReady?.description || "load"}.`);
    }

    const chosen = sortEvaluatedCandidates(evaluatedCandidates)[0];
    commitChosenCandidate(chosen);
  }

  return {
    steps: steps.sort((a, b) => a.minute - b.minute),
    journeys: playbackJourneys.sort((left, right) => left.dispatchStart - right.dispatchStart),
    trips,
    tasks: actualTasks.sort((left, right) => left.startMinute - right.startMinute),
    planningAnalysis,
    workerAssignments: workerAssignments.sort((left, right) => left.startMinute - right.startMinute),
    totalMinutes: Math.max(...steps.map((step) => step.minute), 0),
  };
}

export async function buildScenarioPlans(
  logicalLoads,
  routeData,
  workerCount,
  truckCount,
  truckSetup = [],
  truckSpecs = [],
  workerShiftConfig = null,
  progressOptions = {},
) {
  const workerHourlyCost = getAverageWorkerHourlyCost(workerShiftConfig);
  const planningAnalysis = buildPlanningTaskGraph(logicalLoads, routeData);
  const hasConfiguredWorkerRoster = Object.keys(workerShiftConfig?.roles || {}).length > 0;
  const maxShiftWorkers = Math.max(
    hasConfiguredWorkerRoster ? 4 : 8,
    hasConfiguredWorkerRoster ? (Number.parseInt(workerShiftConfig?.dayShift, 10) || 0) : 0,
    hasConfiguredWorkerRoster ? (Number.parseInt(workerShiftConfig?.nightShift, 10) || 0) : 0,
    Number(workerCount) || 0,
    hasConfiguredWorkerRoster ? 0 : logicalLoads.length,
    hasConfiguredWorkerRoster ? 0 : truckCount,
  );
  const candidateTruckSetups = buildScenarioResourceProfiles(
    truckSetup,
    logicalLoads,
    truckSpecs,
    Boolean(workerShiftConfig?.enforceExactFleet),
  );
  const candidateTruckSetupMeta = candidateTruckSetups.map((candidateTruckSetup) => ({
    truckSetup: candidateTruckSetup,
    totalCount: candidateTruckSetup.reduce((sum, truck) => sum + truck.count, 0),
    totalHourlyCost: candidateTruckSetup.reduce((sum, truck) => sum + ((Number(truck.hourlyCost) || 0) * truck.count), 0),
  }));
  const scenarioDefinitions = [
    {
      name: "Fastest",
      objective: "fastest",
      compare(left, right) {
        return (
          (left.totalMinutes - right.totalMinutes) ||
          (left.costEstimate - right.costEstimate) ||
          (left.requestedTruckCount - right.requestedTruckCount)
        );
      },
    },
    {
      name: "Cheapest",
      objective: "cheapest",
      compare(left, right) {
        return (
          (left.costEstimate - right.costEstimate) ||
          (left.totalMinutes - right.totalMinutes) ||
          (left.requestedTruckCount - right.requestedTruckCount)
        );
      },
    },
    {
      name: "Utilized",
      objective: "utilized",
      compare(left, right) {
        return (
          (right.utilization - left.utilization) ||
          (left.idleMinutes - right.idleMinutes) ||
          (left.totalMinutes - right.totalMinutes) ||
          (left.costEstimate - right.costEstimate)
        );
      },
    },
  ];

  const scenarioFailures = [];
  const workerCountCandidatesByObjective = new Map(
    scenarioDefinitions.map((definition) => [
      definition.objective,
      hasConfiguredWorkerRoster
        ? buildCandidateWorkerCounts(logicalLoads, maxShiftWorkers, definition.objective)
        : [maxShiftWorkers],
    ]),
  );
  const totalScenarioEvaluations = Math.max(
    1,
    scenarioDefinitions.reduce(
      (sum, definition) =>
        sum + (Math.max(candidateTruckSetups.length, 1) * Math.max(workerCountCandidatesByObjective.get(definition.objective)?.length || 0, 1)),
      0,
    ),
  );
  const loadsPerEvaluation = Math.max(1, logicalLoads.length + 1);
  const totalWorkUnits = Math.max(1, totalScenarioEvaluations * loadsPerEvaluation);
  let completedEvaluations = 0;
  const reportProgress = typeof progressOptions.onProgress === "function" ? progressOptions.onProgress : null;
  const scenarios = scenarioDefinitions.reduce((result, definition) => {
    return result;
  }, []);

  for (const definition of scenarioDefinitions) {
    const profileWorkerCounts = workerCountCandidatesByObjective.get(definition.objective) || [getScenarioWorkerCount(definition.objective, maxShiftWorkers, routeData.distanceKm)];
    const definitionFailures = [];
    let bestScenario = null;
    const averageTruckCount = candidateTruckSetupMeta.length
      ? candidateTruckSetupMeta.reduce((sum, candidate) => sum + candidate.totalCount, 0) / candidateTruckSetupMeta.length
      : 0;
    const orderedCandidateTruckSetups = [...candidateTruckSetupMeta]
      .sort((left, right) => {
        if (definition.objective === "fastest") {
          return (
            (right.totalCount - left.totalCount) ||
            (left.totalHourlyCost - right.totalHourlyCost)
          );
        }

        if (definition.objective === "cheapest") {
          return (
            (left.totalHourlyCost - right.totalHourlyCost) ||
            (left.totalCount - right.totalCount)
          );
        }

        return (
          (Math.abs(left.totalCount - averageTruckCount) - Math.abs(right.totalCount - averageTruckCount)) ||
          (left.totalHourlyCost - right.totalHourlyCost)
        );
      })
      .map((candidate) => candidate.truckSetup);

    for (const profileWorkerCount of profileWorkerCounts) {
      for (const candidateTruckSetup of orderedCandidateTruckSetups) {
        completedEvaluations += 1;
        const scenarioTruckCount = Math.max(1, candidateTruckSetup.reduce((sum, truck) => sum + truck.count, 0) || truckCount || 1);
        const scenarioWorkerCapacity = hasConfiguredWorkerRoster
          ? profileWorkerCount
          : Math.max(maxShiftWorkers, scenarioTruckCount, logicalLoads.length);
        if (reportProgress) {
          const completedWorkUnits = ((completedEvaluations - 1) * loadsPerEvaluation) + 1;
          reportProgress({
            stage: "scenario",
            percent: Math.min(92, (completedWorkUnits / totalWorkUnits) * 92),
            message: `Evaluating ${definition.name} scenario ${completedEvaluations}/${totalScenarioEvaluations}`,
            detail: `Stage 6 of 8. Comparing candidate truck and worker combinations for the ${definition.name} plan.`,
            completedStages: 6,
            totalStages: 8,
          });
        }
        await yieldToBrowser();

        try {
          const truckCostByType = buildTruckCostMap(candidateTruckSetup);
          const waves = buildSchedules(logicalLoads, scenarioTruckCount, scenarioWorkerCapacity, definition.objective, truckCostByType);
          const playback = await buildPlayback(
            {
              routeMinutes: routeData.minutes,
              routeDistanceKm: routeData.distanceKm,
              loads: logicalLoads,
              planningAnalysis,
              waves,
            },
            scenarioTruckCount,
            candidateTruckSetup,
            truckSpecs,
            definition.objective,
            scenarioWorkerCapacity,
            workerShiftConfig,
            {
              onProgress: reportProgress,
              basePercent: Math.min(92, ((completedEvaluations - 1) / totalScenarioEvaluations) * 92),
              spanPercent: Math.max(1, 92 / totalScenarioEvaluations),
              evaluationIndex: completedEvaluations,
              totalEvaluations: totalScenarioEvaluations,
            },
          );
        const metrics = summarizePlaybackMetrics(playback, truckCostByType, profileWorkerCount, workerHourlyCost);
        const usedTruckSetup = buildUsedTruckSetup(metrics.usedTruckSetup, candidateTruckSetup);
        const usedTruckCount = usedTruckSetup.reduce((sum, truck) => sum + truck.count, 0) || metrics.usedTruckCount;
        const bestVariant = {
          name: definition.name,
          routeMinutes: routeData.minutes,
          processingMinutes: Math.max(0, playback.totalMinutes - routeData.minutes),
          totalMinutes: playback.totalMinutes,
          playback,
          metrics,
          criticalPath: playback?.planningAnalysis?.criticalTaskIds || [],
        };
        const candidateScenario = {
          name: definition.name,
          objective: definition.objective,
          workerCount: scenarioWorkerCapacity,
          workerShifts: splitShiftCapacity(scenarioWorkerCapacity),
          truckCount: usedTruckCount,
          allocatedTruckCount: usedTruckCount,
          capacity: usedTruckCount,
          routeMinutes: routeData.minutes,
          routeDistanceKm: routeData.distanceKm,
          routeSource: routeData.source,
          routeGeometry: routeData.geometry,
          truckSetup: usedTruckSetup,
          allocatedTruckSetup: usedTruckSetup,
          usedTruckSetup,
          requestedTruckCount: scenarioTruckCount,
          requestedTruckSetup: candidateTruckSetup,
          variantPlans: [bestVariant],
          bestVariant,
          totalMinutes: playback.totalMinutes,
          processingMinutes: Math.max(0, playback.totalMinutes - routeData.minutes),
          playback,
          planningAnalysis: playback?.planningAnalysis || planningAnalysis,
          waves,
          utilization: metrics.utilization,
          truckUtilization: metrics.truckUtilization,
          workerUtilization: metrics.workerUtilization,
          idleMinutes: metrics.idleMinutes,
          workerIdleMinutes: metrics.workerIdleMinutes,
          costEstimate: metrics.costEstimate,
        };

        if (!bestScenario || definition.compare(candidateScenario, bestScenario) < 0) {
          bestScenario = candidateScenario;
        }
        } catch (error) {
          definitionFailures.push({
            message: error instanceof Error ? error.message : String(error),
            workerCount: hasConfiguredWorkerRoster ? profileWorkerCount : scenarioWorkerCapacity,
            truckCount: scenarioTruckCount,
            truckSetup: candidateTruckSetup.map((truck) => ({
              type: truck.type,
              count: truck.count,
            })),
          });
        }
      }
    }

    if (bestScenario) {
      scenarios.push(bestScenario);
    } else {
      scenarioFailures.push({
        name: definition.name,
        objective: definition.objective,
        workerCount: profileWorkerCounts[profileWorkerCounts.length - 1] || getScenarioWorkerCount(definition.objective, maxShiftWorkers, routeData.distanceKm),
        failures: definitionFailures,
      });
    }
  }

  scenarios.debug = {
    scenarioFailures,
  };

  return scenarios;
}

function reverseGeometry(geometry) {
  return [...geometry].reverse();
}

function resolvePlaybackTruckId(playback, truckId) {
  const requestedId = String(truckId ?? "").trim();
  if (!requestedId) {
    return null;
  }

  const playbackTruckIds = [...new Set((playback?.trips || []).map((trip) => String(trip?.truckId ?? "").trim()).filter(Boolean))];
  if (!playbackTruckIds.length) {
    return null;
  }

  if (playbackTruckIds.includes(requestedId)) {
    return requestedId;
  }

  const ordinalIndex = Number.parseInt(requestedId, 10);
  if (Number.isFinite(ordinalIndex) && ordinalIndex >= 1 && ordinalIndex <= playbackTruckIds.length) {
    return playbackTruckIds[ordinalIndex - 1];
  }

  return requestedId;
}

function findActiveTruckTrip(playback, currentMinute, truckId) {
  const resolvedTruckId = resolvePlaybackTruckId(playback, truckId);
  const truckTrips = playback.trips.filter((trip) => String(trip.truckId ?? "").trim() === resolvedTruckId);
  const activeTrip = truckTrips.find((trip) => {
    const tripEnd = trip.returnToSource ?? trip.unloadDropFinish ?? trip.arrivalAtDestination;
    const tripStart = trip.dispatchStart ?? trip.pickupLoadStart ?? trip.loadStart;
    return currentMinute >= tripStart && currentMinute <= tripEnd;
  }) || null;

  return { truckTrips, activeTrip };
}

function resolveTripExecutionAssignments(executionAssignments = [], trip = null) {
  if (!trip) {
    return { sourceAssignment: null, returnAssignment: null };
  }

  const sourceAssignment = (executionAssignments || []).find(
    (assignment) => assignment?.taskType !== "return" && String(assignment?.loadId) === String(trip?.loadId),
  ) || null;
  const returnAssignment = sourceAssignment
    ? (executionAssignments || []).find(
        (assignment) =>
          assignment?.taskType === "return" && (
            String(assignment?.linkedAssignmentId) === String(sourceAssignment?.id) ||
            String(assignment?.returnForAssignmentId) === String(sourceAssignment?.id)
          ),
      ) || null
    : null;

  return { sourceAssignment, returnAssignment };
}

function getAssignmentDelayThresholdMinutes(assignment) {
  if (Number.isFinite(Number(assignment?.delayThresholdMinutes))) {
    return Math.max(0, Number(assignment.delayThresholdMinutes));
  }
  return 20;
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
  const { truckTrips, activeTrip } = findActiveTruckTrip(playback, currentMinute, truckId);

  if (!activeTrip) {
    const deliveredTrip = [...truckTrips].reverse().find((trip) => currentMinute > trip.arrivalAtDestination);
    if (deliveredTrip) {
      return `Delivered #${deliveredTrip.loadId}`;
    }
    return "Waiting";
  }

  if (activeTrip.dispatchStart != null && currentMinute < (activeTrip.pickupLoadStart ?? activeTrip.loadStart)) {
    return `Heading to pickup #${activeTrip.loadId}`;
  }
  if (currentMinute < (activeTrip.pickupLoadFinish ?? activeTrip.moveStart ?? activeTrip.rigDownFinish)) {
    return `Loading #${activeTrip.loadId}`;
  }
  if (currentMinute < activeTrip.arrivalAtDestination) {
    return `In transit #${activeTrip.loadId}`;
  }
  if (currentMinute < (activeTrip.unloadDropFinish ?? activeTrip.arrivalAtDestination)) {
    return `Unloading #${activeTrip.loadId}`;
  }
  if (activeTrip.returnStart != null && activeTrip.returnToSource && currentMinute < activeTrip.returnToSource) {
    return "Returning";
  }
  return `Delivered #${activeTrip.loadId}`;
}

export function getTruckRoadHoldState(playback, currentMinute, truckId, executionAssignments = []) {
  const { truckTrips, activeTrip } = findActiveTruckTrip(playback, currentMinute, truckId);
  const deliveredTrip = [...truckTrips].reverse().find((trip) => currentMinute > (trip.returnToSource ?? trip.arrivalAtDestination)) || null;
  const referenceTrip = activeTrip || deliveredTrip;
  const { sourceAssignment, returnAssignment } = resolveTripExecutionAssignments(executionAssignments, referenceTrip);
  const outboundArrivalConfirmed = Boolean(sourceAssignment?.outboundArrivedAt);
  const returnStartedConfirmed = Boolean(returnAssignment?.moveStartedAt || returnAssignment?.returnMoveStartedAt || sourceAssignment?.returnMoveStartedAt);
  const returnArrivalConfirmed = Boolean(returnAssignment?.returnedToSourceAt);
  const returnStartMinute = referenceTrip?.returnStart ?? referenceTrip?.unloadDropFinish ?? referenceTrip?.arrivalAtDestination ?? null;
  const returnFinishMinute = referenceTrip?.returnToSource ?? null;

  const holdOutbound = Boolean(
    referenceTrip &&
    !outboundArrivalConfirmed &&
    currentMinute >= (referenceTrip.arrivalAtDestination ?? Infinity) &&
    currentMinute < (returnStartMinute ?? Infinity),
  );
  const holdReturn = Boolean(
    referenceTrip &&
    returnFinishMinute != null &&
    !returnArrivalConfirmed &&
    currentMinute >= returnFinishMinute,
  );

  return {
    activeTrip,
    referenceTrip,
    holdOutbound,
    holdReturn,
    outboundArrivalConfirmed,
    returnStartedConfirmed,
    returnArrivalConfirmed,
  };
}

export function getTruckDelayState(playback, currentMinute, truckId, executionAssignments = []) {
  const { truckTrips, activeTrip } = findActiveTruckTrip(playback, currentMinute, truckId);
  const deliveredTrip = [...truckTrips].reverse().find((trip) => currentMinute > (trip.returnToSource ?? trip.arrivalAtDestination)) || null;
  const referenceTrip = activeTrip || deliveredTrip;
  const { sourceAssignment, returnAssignment } = resolveTripExecutionAssignments(executionAssignments, referenceTrip);
  const roadHoldState = getTruckRoadHoldState(playback, currentMinute, truckId, executionAssignments);
  const returnStartMinute = referenceTrip?.returnStart ?? referenceTrip?.unloadDropFinish ?? referenceTrip?.arrivalAtDestination ?? null;

  let relevantAssignment = null;
  if (roadHoldState.holdReturn) {
    relevantAssignment = returnAssignment || sourceAssignment;
  } else if (roadHoldState.holdOutbound) {
    relevantAssignment = sourceAssignment;
  } else if (activeTrip && returnStartMinute != null && currentMinute >= returnStartMinute) {
    relevantAssignment = returnAssignment || sourceAssignment;
  } else if (activeTrip) {
    relevantAssignment = sourceAssignment;
  }

  const plannedFinishMinute = Number(relevantAssignment?.stagePlan?.rigMove?.finishMinute);
  const lateMinutes = Number.isFinite(plannedFinishMinute)
    ? Math.max(0, currentMinute - plannedFinishMinute)
    : 0;
  const delayThresholdMinutes = getAssignmentDelayThresholdMinutes(relevantAssignment);
  const isDelayed = Boolean(relevantAssignment) && lateMinutes > delayThresholdMinutes;

  return {
    isDelayed,
    lateMinutes,
    delayThresholdMinutes,
    assignment: relevantAssignment,
    referenceTrip,
  };
}

export function getTruckPosition(playback, geometry, currentMinute, truckId, executionAssignments = []) {
  const { truckTrips, activeTrip } = findActiveTruckTrip(playback, currentMinute, truckId);
  const nextTrip = truckTrips.find((trip) => currentMinute < (trip.dispatchStart ?? trip.pickupLoadStart ?? trip.loadStart)) || null;
  const deliveredTrip = [...truckTrips].reverse().find((trip) => currentMinute > trip.arrivalAtDestination) || null;
  const activeGeometry = activeTrip?.routeGeometry?.length ? activeTrip.routeGeometry : geometry;
  const pickupGeometry = activeTrip?.pickupRouteGeometry?.length ? activeTrip.pickupRouteGeometry : null;
  const outbound = activeGeometry;
  const inbound = reverseGeometry(activeGeometry);
  const roadHoldState = getTruckRoadHoldState(playback, currentMinute, truckId, executionAssignments);
  const returnStartedConfirmed = roadHoldState.returnStartedConfirmed;

  if (!outbound?.length) {
    return null;
  }

  if (!activeTrip) {
    const nextGeometry =
      nextTrip?.pickupRouteGeometry?.length
        ? nextTrip.pickupRouteGeometry
        : nextTrip?.routeGeometry?.length
          ? nextTrip.routeGeometry
          : geometry;
    const deliveredGeometry = deliveredTrip?.routeGeometry?.length ? deliveredTrip.routeGeometry : geometry;
    const { sourceAssignment, returnAssignment } = resolveTripExecutionAssignments(executionAssignments, deliveredTrip);
    const shouldHoldDeliveredAtDestination = Boolean(
      deliveredTrip &&
      sourceAssignment?.outboundArrivedAt &&
      !returnAssignment?.moveStartedAt &&
      !returnAssignment?.returnedToSourceAt,
    );
    const target = deliveredTrip && !deliveredTrip.returnToSource
      ? deliveredGeometry?.[deliveredGeometry.length - 1]
      : shouldHoldDeliveredAtDestination
        ? deliveredGeometry?.[deliveredGeometry.length - 1]
      : nextTrip
        ? nextGeometry?.[0]
        : deliveredGeometry?.[0] || geometry?.[0];
    if (!target) {
      return null;
    }
    return { lat: target[0], lng: target[1] };
  }

  if (currentMinute < (activeTrip.pickupLoadStart ?? activeTrip.loadStart)) {
    if (pickupGeometry?.length && currentMinute < (activeTrip.pickupLoadStart ?? activeTrip.loadStart)) {
      return interpolatePath(
        pickupGeometry,
        (currentMinute - (activeTrip.dispatchStart ?? activeTrip.pickupLoadStart ?? activeTrip.loadStart)) /
          (((activeTrip.pickupLoadStart ?? activeTrip.loadStart) - (activeTrip.dispatchStart ?? activeTrip.pickupLoadStart ?? activeTrip.loadStart)) || 1),
      );
    }
    return { lat: outbound[0][0], lng: outbound[0][1] };
  }
  if (currentMinute < (activeTrip.moveStart ?? activeTrip.pickupLoadFinish ?? activeTrip.rigDownFinish)) {
    return { lat: outbound[0][0], lng: outbound[0][1] };
  }
  if (currentMinute < activeTrip.arrivalAtDestination) {
    return interpolatePath(
      outbound,
      (currentMinute - (activeTrip.moveStart ?? activeTrip.pickupLoadFinish ?? activeTrip.rigDownFinish)) / (activeTrip.arrivalAtDestination - (activeTrip.moveStart ?? activeTrip.pickupLoadFinish ?? activeTrip.rigDownFinish) || 1),
    );
  }
  if (roadHoldState.holdOutbound) {
    return { lat: outbound[outbound.length - 1][0], lng: outbound[outbound.length - 1][1] };
  }
  if (!returnStartedConfirmed || (activeTrip.returnStart ?? activeTrip.unloadDropFinish ?? activeTrip.arrivalAtDestination) > currentMinute) {
    return { lat: outbound[outbound.length - 1][0], lng: outbound[outbound.length - 1][1] };
  }
  if (returnStartedConfirmed && activeTrip.returnToSource && currentMinute < activeTrip.returnToSource) {
    return interpolatePath(
      inbound,
      (currentMinute - (activeTrip.returnStart ?? activeTrip.unloadDropFinish ?? activeTrip.arrivalAtDestination)) / (activeTrip.returnToSource - (activeTrip.returnStart ?? activeTrip.unloadDropFinish ?? activeTrip.arrivalAtDestination) || 1),
    );
  }
  if (activeTrip.returnToSource) {
    return { lat: outbound[0][0], lng: outbound[0][1] };
  }
  return { lat: outbound[outbound.length - 1][0], lng: outbound[outbound.length - 1][1] };
}

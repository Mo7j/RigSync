import { DEFAULT_TRUCK_SETUP } from "../../lib/constants.js";

const DEFAULT_MANAGER_FLEETS = {
  "manager-nasser": [
    { id: "heavy-haul", type: "Heavy Hauler", count: 6, hourlyCost: 260 },
    { id: "flatbed", type: "Flat-bed", count: 4, hourlyCost: 105 },
    { id: "low-bed", type: "Low-bed", count: 3, hourlyCost: 155 },
  ],
};

const DEFAULT_MANAGER_WORKERS = {
  "manager-nasser": {
    assistant_driller: { count: 1, hourlyCost: 28 },
    bop_tech: { count: 1, hourlyCost: 34 },
    camp_foreman: { count: 1, hourlyCost: 24 },
    crane_operator: { count: 2, hourlyCost: 30 },
    derrickman: { count: 1, hourlyCost: 26 },
    driller: { count: 1, hourlyCost: 32 },
    electrician: { count: 3, hourlyCost: 34 },
    floorman: { count: 8, hourlyCost: 20 },
    forklift_crane_operator: { count: 2, hourlyCost: 28 },
    mechanic: { count: 3, hourlyCost: 36 },
    operator: { count: 1, hourlyCost: 24 },
    pumpman_mechanic: { count: 1, hourlyCost: 36 },
    rigger: { count: 4, hourlyCost: 22 },
    roustabout: { count: 8, hourlyCost: 18 },
    welder: { count: 2, hourlyCost: 32 },
    yard_foreman: { count: 2, hourlyCost: 26 },
  },
};

const LEGACY_WORKER_ROLE_ALIASES = {
  floor_men: "floorman",
  floormen: "floorman",
  roustabouts: "roustabout",
  electricians: "electrician",
  mechanics: "mechanic",
  welders: "welder",
};

const managerResourceCache = new Map();

function getDefaultTruckHourlyCost(type) {
  const normalizedType = String(type || "").trim().toLowerCase();
  const defaults = Object.values(DEFAULT_MANAGER_FLEETS)
    .flat()
    .find((truck) => String(truck.type || "").trim().toLowerCase() === normalizedType);

  return Math.max(0, Number.parseFloat(defaults?.hourlyCost) || 0);
}

function normalizeFleetEntry(entry, index) {
  const defaultHourlyCost = getDefaultTruckHourlyCost(entry.type);
  const parsedHourlyCost = Math.max(0, Number.parseFloat(entry.hourlyCost) || 0);

  return {
    id: entry.id || `fleet-${index + 1}`,
    type: String(entry.type || "").trim() || `Truck Type ${index + 1}`,
    count: Math.max(0, Number.parseInt(entry.count, 10) || 0),
    hourlyCost: parsedHourlyCost > 0 ? parsedHourlyCost : defaultHourlyCost,
  };
}

function normalizeFleet(fleet) {
  return (fleet || []).map(normalizeFleetEntry).filter((entry) => entry.type);
}

function normalizeWorkerCount(count) {
  return Math.max(0, Number.parseInt(count, 10) || 0);
}

function normalizeHourlyCost(cost) {
  return Math.max(0, Number.parseFloat(cost) || 0);
}

function normalizeWorkerRoleEntry(value, defaults = {}) {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const parsedHourlyCost = normalizeHourlyCost(value.hourlyCost ?? defaults.hourlyCost);
    return {
      count: normalizeWorkerCount(value.count ?? value.available ?? defaults.count),
      hourlyCost: parsedHourlyCost > 0 ? parsedHourlyCost : normalizeHourlyCost(defaults.hourlyCost),
    };
  }

  return {
    count: normalizeWorkerCount(value ?? defaults.count),
    hourlyCost: normalizeHourlyCost(defaults.hourlyCost),
  };
}

function normalizeWorkerRoles(value, managerId) {
  const defaults = DEFAULT_MANAGER_WORKERS[managerId] || {
    assistant_driller: { count: 1, hourlyCost: 28 },
    bop_tech: { count: 1, hourlyCost: 34 },
    camp_foreman: { count: 1, hourlyCost: 24 },
    crane_operator: { count: 2, hourlyCost: 30 },
    derrickman: { count: 1, hourlyCost: 26 },
    driller: { count: 1, hourlyCost: 32 },
    electrician: { count: 2, hourlyCost: 34 },
    floorman: { count: 4, hourlyCost: 20 },
    forklift_crane_operator: { count: 2, hourlyCost: 28 },
    mechanic: { count: 2, hourlyCost: 36 },
    operator: { count: 1, hourlyCost: 24 },
    pumpman_mechanic: { count: 1, hourlyCost: 36 },
    rigger: { count: 2, hourlyCost: 22 },
    roustabout: { count: 4, hourlyCost: 18 },
    welder: { count: 2, hourlyCost: 32 },
    yard_foreman: { count: 1, hourlyCost: 26 },
  };

  if (value && typeof value === "object" && !Array.isArray(value)) {
    const canonicalValue = Object.entries(value).reduce((roles, [roleId, roleValue]) => {
      const normalizedRoleId = LEGACY_WORKER_ROLE_ALIASES[roleId] || roleId;
      const existing = roles[normalizedRoleId] || {};
      const current = normalizeWorkerRoleEntry(roleValue, defaults[normalizedRoleId] || {});
      roles[normalizedRoleId] = {
        count: (existing.count || 0) + current.count,
        hourlyCost: current.hourlyCost || existing.hourlyCost || normalizeHourlyCost(defaults[normalizedRoleId]?.hourlyCost),
      };
      return roles;
    }, {});

    const normalized = Object.keys(defaults).reduce((roles, roleId) => {
      roles[roleId] = normalizeWorkerRoleEntry(canonicalValue[roleId], defaults[roleId]);
      return roles;
    }, {});

    if (Object.keys(normalized).some((roleId) => normalized[roleId].count > 0 || normalized[roleId].hourlyCost > 0)) {
      return normalized;
    }
  }

  const legacy = normalizeWorkerCount(value);
  if (legacy > 0) {
    return Object.keys(defaults).reduce((roles, roleId, index) => {
      const baseline = defaults[roleId] || {};
      roles[roleId] = {
        count: index === 0 ? Math.max(legacy, normalizeWorkerCount(baseline.count)) : normalizeWorkerCount(baseline.count),
        hourlyCost: normalizeHourlyCost(baseline.hourlyCost),
      };
      return roles;
    }, {});
  }

  return Object.keys(defaults).reduce((roles, roleId) => {
    roles[roleId] = normalizeWorkerRoleEntry(defaults[roleId], defaults[roleId]);
    return roles;
  }, {});
}

function normalizeManagerResources(managerId, resources = {}) {
  return {
    fleet: normalizeFleet(resources.fleet || DEFAULT_MANAGER_FLEETS[managerId] || DEFAULT_TRUCK_SETUP),
    workers: normalizeWorkerRoles(resources.workers, managerId),
  };
}

function normalizeTypeKey(type) {
  return String(type || "").trim().toLowerCase().replace(/[^a-z]/g, "");
}

export function getDefaultManagerFleet(managerId) {
  return normalizeFleet(DEFAULT_MANAGER_FLETS[managerId] || DEFAULT_TRUCK_SETUP);
}

export async function hydrateManagerResources(managerId) {
  if (!managerId) {
    return { fleet: [], workers: {} };
  }

  const response = await fetch(`/api/manager-resources/${encodeURIComponent(managerId)}`);
  if (!response.ok) {
    throw new Error(`Manager resources request failed with ${response.status}`);
  }

  const payload = await response.json();
  const normalized = normalizeManagerResources(managerId, payload);
  managerResourceCache.set(managerId, normalized);
  return normalized;
}

export function readManagerFleet(managerId) {
  return managerResourceCache.get(managerId)?.fleet || getDefaultManagerFleet(managerId);
}

export async function writeManagerFleet(managerId, fleet) {
  const current = managerResourceCache.get(managerId) || normalizeManagerResources(managerId, {});
  const normalized = {
    fleet: normalizeFleet(fleet),
    workers: normalizeWorkerRoles(current.workers, managerId),
  };

  const response = await fetch(`/api/manager-resources/${encodeURIComponent(managerId)}`, {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(normalized),
  });

  if (!response.ok) {
    throw new Error(`Manager fleet save failed with ${response.status}`);
  }

  managerResourceCache.set(managerId, normalized);
  return normalized.fleet;
}

export function sumTruckCounts(truckSetup) {
  return (truckSetup || []).reduce((sum, item) => sum + Math.max(0, Number.parseInt(item.count, 10) || 0), 0);
}

export function buildFleetAvailability({ managerFleet, moves, currentMoveId = null }) {
  const remainingByType = new Map();

  normalizeFleet(managerFleet).forEach((truck) => {
    remainingByType.set(normalizeTypeKey(truck.type), {
      ...truck,
      available: truck.count,
      allocated: 0,
    });
  });

  (moves || []).forEach((move) => {
    if (!move || move.id === currentMoveId) {
      return;
    }

    if (move.executionState !== "active") {
      return;
    }

    const truckSetup = move.truckSetup?.length ? move.truckSetup : move.simulation?.truckSetup || [];
    truckSetup.forEach((truck) => {
      const key = normalizeTypeKey(truck.type);
      const current = remainingByType.get(key);
      if (!current) {
        return;
      }

      const allocatedCount = Math.max(0, Number.parseInt(truck.count, 10) || 0);
      current.allocated += allocatedCount;
      current.available = Math.max(0, current.count - current.allocated);
    });
  });

  return [...remainingByType.values()];
}

export function readManagerWorkers(managerId) {
  return managerResourceCache.get(managerId)?.workers || normalizeWorkerRoles(null, managerId);
}

export async function writeManagerWorkers(managerId, workers) {
  const current = managerResourceCache.get(managerId) || normalizeManagerResources(managerId, {});
  const normalized = {
    fleet: normalizeFleet(current.fleet),
    workers: normalizeWorkerRoles(workers, managerId),
  };

  const response = await fetch(`/api/manager-resources/${encodeURIComponent(managerId)}`, {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(normalized),
  });

  if (!response.ok) {
    throw new Error(`Manager workers save failed with ${response.status}`);
  }

  managerResourceCache.set(managerId, normalized);
  return normalized.workers;
}

export function buildWorkerAvailability({ totalWorkers, moves, currentMoveId = null, managerId = "manager-nasser" }) {
  const normalizedWorkers = normalizeWorkerRoles(totalWorkers, managerId);
  const total = Object.values(normalizedWorkers).reduce((sum, role) => sum + normalizeWorkerCount(role.count), 0);
  const dayShift = Math.ceil(total / 2);
  const nightShift = Math.max(0, total - dayShift);
  const totalHourlyCost = Object.values(normalizedWorkers).reduce(
    (sum, role) => sum + (normalizeWorkerCount(role.count) * normalizeHourlyCost(role.hourlyCost)),
    0,
  );
  const allocated = (moves || []).reduce((sum, move) => {
    if (!move || move.id === currentMoveId || move.executionState !== "active") {
      return sum;
    }
    return sum + Math.max(0, Number.parseInt(move.simulation?.workerCount, 10) || 0);
  }, 0);

  return {
    total,
    roles: normalizedWorkers,
    dayShift,
    nightShift,
    averageHourlyCost: total > 0 ? totalHourlyCost / total : 0,
    allocated,
    available: Math.max(0, total - allocated),
  };
}

export function getAvailabilityValidationError(truckSetup, availability) {
  const requestedByType = new Map();

  (truckSetup || []).forEach((truck) => {
    const key = normalizeTypeKey(truck.type);
    requestedByType.set(key, (requestedByType.get(key) || 0) + Math.max(0, Number.parseInt(truck.count, 10) || 0));
  });

  for (const resource of availability || []) {
    const requested = requestedByType.get(normalizeTypeKey(resource.type)) || 0;
    if (requested > resource.available) {
      return `${resource.type} exceeds availability. Requested ${requested}, available ${resource.available}.`;
    }
  }

  for (const [typeKey, requested] of requestedByType.entries()) {
    const matched = (availability || []).find((resource) => normalizeTypeKey(resource.type) === typeKey);
    if (!matched && requested > 0) {
      return `Requested truck type is not available in the manager fleet.`;
    }
  }

  return "";
}

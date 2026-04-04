import { DEFAULT_TRUCK_SETUP } from "../../lib/constants.js";
import { MANAGER_RESOURCES_STORAGE_KEY } from "../../lib/constants.js";

const DEFAULT_MANAGER_FLEETS = {
  "manager-nasser": [
    { id: "heavy-haul", type: "Heavy Hauler", count: 6, hourlyCost: 260 },
    { id: "flatbed", type: "Flat-bed", count: 4, hourlyCost: 105 },
    { id: "low-bed", type: "Low-bed", count: 3, hourlyCost: 155 },
  ],
};

const managerResourceCache = new Map();

function readStoredManagerResources() {
  try {
    const stored = window.localStorage.getItem(MANAGER_RESOURCES_STORAGE_KEY);
    return stored ? JSON.parse(stored) : {};
  } catch {
    return {};
  }
}

function persistManagerResources() {
  try {
    const serialized = Object.fromEntries(managerResourceCache.entries());
    window.localStorage.setItem(MANAGER_RESOURCES_STORAGE_KEY, JSON.stringify(serialized));
  } catch {
    // Ignore storage failures and keep runtime cache.
  }
}

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

function normalizeManagerResources(managerId, resources = {}) {
  return {
    fleet: normalizeFleet(resources.fleet || DEFAULT_MANAGER_FLEETS[managerId] || DEFAULT_TRUCK_SETUP),
  };
}

function ensureManagerResourceCache(managerId) {
  if (!managerId || managerResourceCache.has(managerId)) {
    return managerResourceCache.get(managerId) || null;
  }

  const storedResources = readStoredManagerResources();
  if (storedResources?.[managerId]) {
    const normalized = normalizeManagerResources(managerId, storedResources[managerId]);
    managerResourceCache.set(managerId, normalized);
    return normalized;
  }

  return null;
}

function normalizeTypeKey(type) {
  return String(type || "").trim().toLowerCase().replace(/[^a-z]/g, "");
}

export function getDefaultManagerFleet(managerId) {
  return normalizeFleet(DEFAULT_MANAGER_FLEETS[managerId] || DEFAULT_TRUCK_SETUP);
}

export async function hydrateManagerResources(managerId) {
  if (!managerId) {
    return { fleet: [] };
  }

  const response = await fetch(`/api/manager-resources/${encodeURIComponent(managerId)}`);
  if (!response.ok) {
    throw new Error(`Manager resources request failed with ${response.status}`);
  }

  const payload = await response.json();
  const normalized = normalizeManagerResources(managerId, payload);
  managerResourceCache.set(managerId, normalized);
  persistManagerResources();
  return normalized;
}

export function readManagerFleet(managerId) {
  return ensureManagerResourceCache(managerId)?.fleet || getDefaultManagerFleet(managerId);
}

export async function writeManagerFleet(managerId, fleet) {
  const normalized = {
    fleet: normalizeFleet(fleet),
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
  persistManagerResources();
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
      return "Requested truck type is not available in the manager fleet.";
    }
  }

  return "";
}

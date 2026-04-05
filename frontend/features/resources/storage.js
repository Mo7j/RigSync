import { DEFAULT_TRUCK_SETUP } from "../../lib/constants.js";
import { fetchManagerResourcesDoc, saveManagerResourcesDoc } from "../../lib/firebaseOperations.js";

const DEFAULT_MANAGER_FLEETS = {
  "manager-nasser": [
    { id: "heavy-haul", type: "Heavy Hauler", count: 6, hourlyCost: 260 },
    { id: "flatbed", type: "Flat-bed", count: 4, hourlyCost: 105 },
    { id: "low-bed", type: "Low-bed", count: 3, hourlyCost: 155 },
  ],
};

const DEFAULT_MANAGER_DRIVERS = {};

const managerResourceCache = new Map();

function normalizeTypeKey(type) {
  return String(type || "").trim().toLowerCase().replace(/[^a-z]/g, "");
}

function getDefaultTruckHourlyCost(type) {
  const normalizedType = normalizeTypeKey(type);
  const defaults = Object.values(DEFAULT_MANAGER_FLEETS)
    .flat()
    .find((truck) => normalizeTypeKey(truck.type) === normalizedType);

  return Math.max(0, Number.parseFloat(defaults?.hourlyCost) || 0);
}

function getTypePrefix(type) {
  const normalizedType = normalizeTypeKey(type);
  if (normalizedType.includes("heavy")) {
    return "HH";
  }
  if (normalizedType.includes("flat")) {
    return "FB";
  }
  if (normalizedType.includes("low")) {
    return "LB";
  }
  return "TR";
}

function buildDefaultTruckRecords(managerId) {
  const fleet = DEFAULT_MANAGER_FLEETS[managerId] || DEFAULT_TRUCK_SETUP;
  const trucks = [];

  fleet.forEach((entry) => {
    const total = Math.max(0, Number.parseInt(entry.count, 10) || 0);
    const prefix = getTypePrefix(entry.type);

    for (let index = 0; index < total; index += 1) {
      trucks.push({
        id: `truck-${normalizeTypeKey(entry.type)}-${index + 1}`,
        name: `${prefix}-${String(index + 1).padStart(2, "0")}`,
        type: entry.type,
      });
    }
  });

  return trucks;
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

function normalizeTruckEntry(entry, index) {
  return {
    id: entry.id || `truck-${index + 1}`,
    name: String(entry.name || "").trim() || `Truck ${index + 1}`,
    type: String(entry.type || "").trim() || "Truck",
  };
}

function normalizeDriverEntry(entry, index, managerId) {
  return {
    id: entry.id || `driver-${index + 1}`,
    name: String(entry.name || "").trim() || `Driver ${index + 1}`,
    email: String(entry.email || "").trim().toLowerCase(),
    truckType: String(entry.truckType || entry.type || "").trim() || "Truck",
    truckId: String(entry.truckId || "").trim(),
    managerId,
    role: "Driver",
  };
}

function normalizeTaskAssignmentEntry(entry, index) {
  const stageStatus = entry.stageStatus || {};
  const currentStage =
    String(entry.currentStage || "").trim() ||
    (!stageStatus.rigDownCompleted ? "rigDown" : !stageStatus.rigMoveCompleted ? "rigMove" : !stageStatus.rigUpCompleted ? "rigUp" : "completed");

  return {
    id: entry.id || `assignment-${index + 1}`,
    moveId: String(entry.moveId || "").trim(),
    moveName: String(entry.moveName || "").trim(),
    driverId: String(entry.driverId || "").trim(),
    driverName: String(entry.driverName || "").trim(),
    truckId: String(entry.truckId || "").trim(),
    truckType: String(entry.truckType || "").trim(),
    plannedTruckType: String(entry.plannedTruckType || "").trim(),
    startLabel: String(entry.startLabel || "").trim(),
    endLabel: String(entry.endLabel || "").trim(),
    loadId: entry.loadId ?? null,
    loadCode: String(entry.loadCode || "").trim(),
    tripLabel: String(entry.tripLabel || "").trim(),
    tripNumber: Math.max(1, Number.parseInt(entry.tripNumber, 10) || index + 1),
    plannedTripCount: Math.max(1, Number.parseInt(entry.plannedTripCount, 10) || 1),
    plannedStartMinute: Number.isFinite(Number(entry.plannedStartMinute)) ? Number(entry.plannedStartMinute) : null,
    plannedFinishMinute: Number.isFinite(Number(entry.plannedFinishMinute)) ? Number(entry.plannedFinishMinute) : null,
    journeyId: String(entry.journeyId || "").trim(),
    currentStage,
    stageStatus: {
      rigDownCompleted: Boolean(stageStatus.rigDownCompleted),
      rigMoveCompleted: Boolean(stageStatus.rigMoveCompleted),
      rigUpCompleted: Boolean(stageStatus.rigUpCompleted),
    },
    stageCompletedAt: {
      rigDown: entry.stageCompletedAt?.rigDown || null,
      rigMove: entry.stageCompletedAt?.rigMove || null,
      rigUp: entry.stageCompletedAt?.rigUp || null,
    },
    status: String(entry.status || "").trim() || (currentStage === "completed" ? "completed" : "queued"),
    sequence: Math.max(1, Number.parseInt(entry.sequence, 10) || index + 1),
    assignedAt: entry.assignedAt || null,
    updatedAt: entry.updatedAt || null,
  };
}

function normalizeFleet(fleet) {
  return (fleet || []).map(normalizeFleetEntry).filter((entry) => entry.type);
}

function normalizeTrucks(trucks) {
  return (trucks || []).map(normalizeTruckEntry).filter((entry) => entry.name && entry.type);
}

function normalizeDrivers(drivers, managerId) {
  return (drivers || [])
    .map((entry, index) => normalizeDriverEntry(entry, index, managerId))
    .filter((entry) => entry.name && entry.email);
}

function normalizeTaskAssignments(taskAssignments) {
  return (taskAssignments || [])
    .map(normalizeTaskAssignmentEntry)
    .filter((entry) => entry.driverId || entry.truckId || entry.moveId);
}

function deriveTrucksFromDrivers(drivers) {
  return normalizeDrivers(drivers, null).map((driver, index) => {
    const truckType = driver.truckType || "Truck";
    const prefix = getTypePrefix(truckType);
    return {
      id: driver.truckId || `truck-${normalizeTypeKey(truckType)}-${index + 1}`,
      name: `${driver.name || "Driver"} • ${prefix}`,
      type: truckType,
    };
  });
}

function deriveFleetFromTrucks(trucks) {
  const grouped = new Map();

  normalizeTrucks(trucks).forEach((truck) => {
    const key = normalizeTypeKey(truck.type);
    const current = grouped.get(key) || {
      id: key || `fleet-${grouped.size + 1}`,
      type: truck.type,
      count: 0,
      hourlyCost: getDefaultTruckHourlyCost(truck.type),
    };
    current.count += 1;
    grouped.set(key, current);
  });

  return [...grouped.values()];
}

function normalizeManagerResources(managerId, resources = {}) {
  const normalizedDrivers = normalizeDrivers(resources.drivers?.length ? resources.drivers : DEFAULT_MANAGER_DRIVERS[managerId] || [], managerId);
  const trucks = normalizeTrucks(
    normalizedDrivers.length
      ? deriveTrucksFromDrivers(normalizedDrivers)
      : resources.trucks?.length
        ? resources.trucks
        : [],
  );
  const fleet = normalizeFleet(deriveFleetFromTrucks(trucks));

  return {
    fleet,
    trucks,
    drivers: normalizedDrivers.map((driver, index) => ({
      ...driver,
      truckId: driver.truckId || trucks[index]?.id || "",
    })),
    taskAssignments: normalizeTaskAssignments(resources.taskAssignments || resources.task_assignments || []),
  };
}

export function setManagerResourcesCache(managerId, resources) {
  const normalized = normalizeManagerResources(managerId, resources);
  managerResourceCache.set(managerId, normalized);
  return normalized;
}

export function getDefaultManagerFleet(managerId) {
  return normalizeFleet(DEFAULT_MANAGER_FLEETS[managerId] || DEFAULT_TRUCK_SETUP);
}

export function readManagerResources(managerId) {
  return managerResourceCache.get(managerId) || normalizeManagerResources(managerId);
}

export async function hydrateManagerResources(managerId) {
  if (!managerId) {
    return { fleet: [], trucks: [], drivers: [], taskAssignments: [] };
  }

  const payload = await fetchManagerResourcesDoc(managerId);
  const normalized = payload ? normalizeManagerResources(managerId, payload) : normalizeManagerResources(managerId);
  managerResourceCache.set(managerId, normalized);
  return normalized;
}

export function readManagerFleet(managerId) {
  return readManagerResources(managerId).fleet || getDefaultManagerFleet(managerId);
}

export async function writeManagerResources(managerId, resources) {
  const normalized = normalizeManagerResources(managerId, resources);
  const derivedTrucks = deriveTrucksFromDrivers(normalized.drivers);
  const derivedFleet = deriveFleetFromTrucks(derivedTrucks);
  const payload = {
    fleet: derivedFleet,
    trucks: derivedTrucks,
    drivers: normalized.drivers,
    taskAssignments: normalized.taskAssignments,
  };

  await saveManagerResourcesDoc(managerId, payload);
  const savedNormalized = normalizeManagerResources(managerId, payload);
  managerResourceCache.set(managerId, savedNormalized);
  return savedNormalized;
}

export async function writeManagerFleet(managerId, fleet) {
  const current = readManagerResources(managerId);
  const groupedFleet = normalizeFleet(fleet);
  const nextTrucks = [];

  groupedFleet.forEach((entry) => {
    const prefix = getTypePrefix(entry.type);
    for (let index = 0; index < entry.count; index += 1) {
      nextTrucks.push({
        id: `truck-${normalizeTypeKey(entry.type)}-${index + 1}`,
        name: `${prefix}-${String(index + 1).padStart(2, "0")}`,
        type: entry.type,
      });
    }
  });

  const saved = await writeManagerResources(managerId, {
    ...current,
    fleet: groupedFleet,
    trucks: nextTrucks,
  });

  return saved.fleet;
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

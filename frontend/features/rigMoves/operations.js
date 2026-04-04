import { TEST_USERS } from "../auth/auth.js";
import { readRigInventoryAdjustments } from "../rigInventory/storage.js";

function normalizeTruckTypes(value) {
  if (Array.isArray(value)) {
    return value.map((item) => String(item || "").trim()).filter(Boolean);
  }

  return String(value || "")
    .split("/")
    .map((item) => item.trim())
    .filter(Boolean);
}

function getRigLabel(move) {
  return move?.endLabel || move?.name || "Unnamed rig";
}

function getUserAssignedRigId(userId) {
  return TEST_USERS.find((user) => user.id === userId)?.assignedRig?.id || `rig-${userId || "home"}`;
}

function getUserAssignedRig(userId) {
  return TEST_USERS.find((user) => user.id === userId)?.assignedRig || null;
}

function buildReusableLoadInventory(logicalLoads = []) {
  const grouped = new Map();

  (logicalLoads || []).forEach((load) => {
    const key = [load.category, load.description, load.truck_type].join("||");
    if (!grouped.has(key)) {
      grouped.set(key, {
        id: key,
        category: load.category || "Rig equipment",
        description: load.description || "Unnamed load",
        truckTypes: normalizeTruckTypes(load.truck_options || load.truck_types || load.truck_type),
        count: 0,
        isCritical: Boolean(load.is_critical) || Number.parseInt(load.priority, 10) <= 2,
      });
    }

    grouped.get(key).count += 1;
  });

  return [...grouped.values()].sort((a, b) => {
    if (a.category !== b.category) {
      return String(a.category).localeCompare(String(b.category));
    }

    return String(a.description).localeCompare(String(b.description));
  });
}

export const DEFAULT_STARTUP_REQUIREMENTS = [
  { id: "SU-01", description: "Drill pipe", count: 4, priority: 7, truckTypes: ["Flat-bed", "Low-bed"], dependencyLabel: "After RL-31 and RL-36", isReusable: true },
  { id: "SU-02", description: "Drill collars / BHA tools", count: 2, priority: 7, truckTypes: ["Low-bed", "Heavy Hauler"], dependencyLabel: "After RL-31", isReusable: true },
  { id: "SU-03", description: "Drill bit", count: 1, priority: 7, truckTypes: ["Flat-bed"], dependencyLabel: "After SU-02", isReusable: true },
  { id: "SU-04", description: "Subs / crossovers / float subs", count: 1, priority: 7, truckTypes: ["Flat-bed"], dependencyLabel: "After SU-02", isReusable: true },
  { id: "SU-05", description: "Tubular handling tools", count: 2, priority: 6, truckTypes: ["Flat-bed"], dependencyLabel: "Standalone startup load", isReusable: true },
  { id: "SU-06", description: "Tubular baskets / pipe accessories", count: 2, priority: 6, truckTypes: ["Flat-bed"], dependencyLabel: "After RL-31", isReusable: true },
  { id: "SU-07", description: "Drilling fluid / spud mud", count: 4, priority: 7, truckTypes: ["Flat-bed", "Low-bed"], dependencyLabel: "After RL-14 and RL-11", isReusable: false },
  { id: "SU-08", description: "Mud chemicals", count: 4, priority: 7, truckTypes: ["Flat-bed"], dependencyLabel: "After RL-14", isReusable: false },
  { id: "SU-09", description: "Water / brine supply", count: 3, priority: 7, truckTypes: ["Low-bed"], dependencyLabel: "After RL-12", isReusable: false },
  { id: "SU-10", description: "Diesel fuel", count: 2, priority: 7, truckTypes: ["Low-bed"], dependencyLabel: "After RL-10", isReusable: false },
  { id: "SU-11", description: "Lubricants & hydraulic oil", count: 1, priority: 6, truckTypes: ["Flat-bed"], dependencyLabel: "Standalone startup load", isReusable: false },
  { id: "SU-12", description: "Grease, filters & maintenance consumables", count: 1, priority: 6, truckTypes: ["Flat-bed"], dependencyLabel: "Standalone startup load", isReusable: false },
  { id: "SU-13", description: "Standpipe manifold parts & seals", count: 1, priority: 6, truckTypes: ["Flat-bed"], dependencyLabel: "Startup support item", isReusable: true },
  { id: "SU-14", description: "BOP test equipment", count: 1, priority: 7, truckTypes: ["Low-bed"], dependencyLabel: "After RL-26", isReusable: true },
];

export function buildStartupTransferLoads(startupLoads = [], supportRouteMap = {}) {
  let syntheticId = 90000;

  return (startupLoads || []).flatMap((load) =>
    (load.sourcingPlan || []).flatMap((source, sourceIndex) =>
      Array.from({ length: source.assigned }, (_, itemIndex) => {
        syntheticId += 1;
        const supportRouteKey = `${load.id}-${source.moveId}-${sourceIndex}`;
        const supportRoute = supportRouteMap[supportRouteKey] || null;

        return {
          id: syntheticId,
          key: `startup-transfer-${load.id}-${source.moveId}-${sourceIndex}-${itemIndex}`,
          supportRouteKey,
          description: `${load.description} transfer from ${source.rigLabel}`,
          category: "Startup Support",
          priority: load.priority,
          truck_type: load.truckTypes?.[0] || "Flat-bed",
          truck_options: load.truckTypes || [],
          rig_down_id: null,
          rig_up_id: null,
          rig_down_duration: 30,
          rig_up_duration: load.avg_rig_up_minutes || 45,
          optimal_rig_down_duration: 20,
          optimal_rig_up_duration: Math.max(15, Math.round((load.avg_rig_up_minutes || 45) * 0.85)),
          min_worker_count: 2,
          optimal_worker_count: 4,
          sourceLabel: source.rigLabel,
          sourcePoint: source.rigPoint || null,
          destinationLabel: supportRoute?.destinationLabel || "Destination",
          pickupRouteMinutes: supportRoute?.pickupRouteMinutes || null,
          pickupRouteGeometry: supportRoute?.pickupGeometry || null,
          routeMinutes: supportRoute?.routeMinutes || null,
          routeDistanceKm: supportRoute?.routeDistanceKm || null,
          routeGeometry: supportRoute?.geometry || null,
          dependency_ids: [],
        };
      }),
    ),
  );
}

export function buildStartupTransferSchedule(startupLoads = [], destinationLabel = "Destination") {
  return (startupLoads || [])
    .flatMap((load) =>
      (load.sourcingPlan || []).map((source, index) => ({
        key: `${load.id}-${source.moveId}-${index}`,
        loadLabel: load.description,
        quantity: source.assigned,
        sourceLabel: source.rigLabel,
        sourcePoint: source.rigPoint || null,
        destinationLabel,
        truckLabel: (load.truckTypes || []).join(" / ") || "Assigned truck",
      })),
    )
    .filter((item) => item.quantity > 0);
}

function normalizeStartupRequirements(startupRequirements = []) {
  const source = startupRequirements?.length ? startupRequirements : DEFAULT_STARTUP_REQUIREMENTS;
  return source.map((load) => ({
    ...load,
    id: load.id,
    description: load.description || "Startup load",
    count: Math.max(1, Number.parseInt(load.count ?? load.load_count, 10) || 1),
    priority: Number.parseInt(load.priority, 10) || 0,
    truckTypes: normalizeTruckTypes(load.truckTypes || load.truck_types || load.truck_type),
    dependencyLabel: load.dependencyLabel || "Standalone startup load",
    isReusable: Boolean(load.isReusable),
    avg_rig_up_minutes: Number.parseInt(load.avg_rig_up_minutes, 10) || null,
  }));
}

export function buildOperatingSnapshot({ move, teamMoves = [], logicalLoads = [], startupRequirements = [] }) {
  const reusableInventory = buildReusableLoadInventory(logicalLoads);
  const managerId = move?.createdBy?.managerId || null;
  const currentForemanId = move?.createdBy?.id || null;
  const donorRigs = TEST_USERS.filter(
    (user) =>
      user.role === "Foreman" &&
      user.managerId === managerId &&
      user.id !== currentForemanId,
  ).map((user) => {
    const latestRigMove =
      (teamMoves || [])
        .filter((candidate) => candidate?.createdBy?.id === user.id)
        .sort((a, b) => new Date(b.updatedAt || b.createdAt || 0) - new Date(a.updatedAt || a.createdAt || 0))[0] || null;
    const assignedRig = getUserAssignedRig(user.id);

    return {
      foremanId: user.id,
      rigId: getUserAssignedRigId(user.id),
      rigLabel: latestRigMove?.endLabel || assignedRig?.startLabel || assignedRig?.name || user.name,
      rigPoint: latestRigMove?.endPoint || assignedRig?.startPoint || null,
      moveName: latestRigMove?.name || `${assignedRig?.name || user.name} rig`,
    };
  });

  const startupLoads = normalizeStartupRequirements(startupRequirements).map((load) => {
    const donorOptions = donorRigs
      .map((donor) => {
        if (!load.isReusable) {
          return null;
        }

        const donorInventory = readRigInventoryAdjustments(donor.rigId);
        const donorTransferableCount =
          donorInventory?.[load.id] && typeof donorInventory[load.id] === "object"
            ? Math.max(0, Number.parseInt(donorInventory[load.id].transferable, 10) || 0)
            : 0;
        const available = Math.min(load.count, donorTransferableCount);

        if (available < 1) {
          return null;
        }

        return {
          moveId: donor.rigId,
          moveName: donor.moveName,
          rigLabel: donor.rigLabel,
          rigPoint: donor.rigPoint,
          available,
        };
      })
      .filter(Boolean)
      .sort((a, b) => b.available - a.available || a.rigLabel.localeCompare(b.rigLabel));

    let remaining = load.count;
    const sourcingPlan = donorOptions
      .map((option) => {
        if (remaining <= 0) {
          return null;
        }

        const assigned = Math.min(option.available, remaining);
        remaining -= assigned;

        return {
          ...option,
          assigned,
        };
      })
      .filter(Boolean);

    const coveredCount = load.count - remaining;

    return {
      ...load,
      coveredCount,
      missingCount: remaining,
      readiness: remaining === 0 ? "covered" : coveredCount > 0 ? "partial" : "missing",
      sourcingPlan,
    };
  });

  const reusableTotal = reusableInventory.reduce((sum, item) => sum + item.count, 0);
  const criticalReusableTotal = reusableInventory.filter((item) => item.isCritical).reduce((sum, item) => sum + item.count, 0);
  const startupNeeded = startupLoads.reduce((sum, item) => sum + item.count, 0);
  const startupCovered = startupLoads.reduce((sum, item) => sum + item.coveredCount, 0);
  const startupMissing = startupLoads.reduce((sum, item) => sum + item.missingCount, 0);

  return {
    reusableInventory,
    startupLoads,
    reusableSummary: {
      totalUnits: reusableTotal,
      categoryCount: new Set(reusableInventory.map((item) => item.category)).size,
      criticalUnits: criticalReusableTotal,
    },
    startupSummary: {
      totalUnits: startupNeeded,
      coveredUnits: startupCovered,
      missingUnits: startupMissing,
      donorRigCount: donorRigs.length,
    },
  };
}

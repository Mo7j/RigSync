import { readRigInventoryAdjustments } from "../rigInventory/storage.js";
import { createId } from "../../lib/id.js";
import { buildLogicalLoads, haversineKilometers } from "./simulation.js";

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

  if (normalized === "flatbed") {
    return "Flat-bed";
  }
  if (normalized === "lowbed" || normalized === "support") {
    return "Low-bed";
  }
  if (normalized === "heavyhauler") {
    return "Heavy Hauler";
  }

  return String(type || "").trim();
}

function normalizeTruckTypes(value) {
  const tokens = Array.isArray(value)
    ? value.flatMap((item) => normalizeTruckTypes(item))
    : String(value || "")
      .split(/[\/,|]/)
      .map((item) => item.trim())
      .filter(Boolean);

  return [...new Set(tokens.map((item) => normalizeTruckTypeLabel(item)).filter(Boolean))];
}

function parseDependencyCodes(value) {
  if (Array.isArray(value)) {
    return value.map((item) => String(item || "").trim()).filter(Boolean);
  }

  return [...String(value || "").matchAll(/\b(?:RL|SU)-\d+(?:-L\d+)?\b/gi)]
    .map((match) => String(match[0] || "").trim().toUpperCase())
    .filter(Boolean);
}

function getRigLabel(move) {
  return move?.endLabel || move?.name || "Unnamed rig";
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
          code: `${load.id}-X${sourceIndex + 1}-${itemIndex + 1}`,
          family_id: load.id,
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
          min_worker_count: Math.max(1, Number.parseInt(load.minimum_crew_up_count, 10) || 2),
          optimal_worker_count: Math.max(
            Math.max(1, Number.parseInt(load.minimum_crew_up_count, 10) || 2),
            Number.parseInt(load.optimal_crew_up_count, 10) || 4,
          ),
          minimum_crew_roles: {
            rig_down: {},
            rig_up: load.minimum_crew_up_roles || {},
          },
          optimal_crew_roles: {
            rig_down: {},
            rig_up: load.optimal_crew_up_roles || {},
          },
          sourceLabel: source.rigLabel,
          sourcePoint: source.rigPoint || null,
          destinationLabel: supportRoute?.destinationLabel || "Destination",
          pickupRouteMinutes: supportRoute?.pickupRouteMinutes || null,
          pickupRouteGeometry: supportRoute?.pickupGeometry || null,
          routeMinutes: supportRoute?.routeMinutes || null,
          routeDistanceKm: supportRoute?.routeDistanceKm || null,
          routeGeometry: supportRoute?.geometry || null,
          rig_down_dependency_codes: load.rig_down_dependency_codes || [],
          rig_move_dependency_codes: load.rig_move_dependency_codes || [],
          rig_up_dependency_codes: load.rig_up_dependency_codes || [],
          source_kind: "startup",
          dependency_ids: [],
        };
      }),
    ),
  );
}

export function buildStartupPlanningLoads(startupRequirements = [], startupLoads = [], supportRouteMap = {}) {
  const transferLoads = buildStartupTransferLoads(startupLoads, supportRouteMap);
  void startupRequirements;
  return transferLoads;
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

function normalizeStartupRequirements(startupRequirements = undefined) {
  const source = Array.isArray(startupRequirements)
    ? startupRequirements
    : [];
  const grouped = new Map();

  source.forEach((load) => {
    const id = String(load.id || load.code || "").trim() || createId();
    const baseId = id.replace(/-L\d+$/i, "");
    if (!grouped.has(baseId)) {
      grouped.set(baseId, {
        ...load,
        id: baseId,
        description: load.description || "Startup load",
        count: 0,
        priority: Number.parseInt(load.priority, 10) || 0,
        truckTypes: normalizeTruckTypes(load.truckTypes || load.truck_types || load.truck_type),
        dependencyLabel: load.dependencyLabel || "Standalone startup load",
        isReusable: Boolean(load.isReusable),
        avg_rig_up_minutes: Number.parseInt(load.avg_rig_up_minutes, 10) || null,
        rig_down_dependency_codes: [],
        rig_move_dependency_codes: [],
        rig_up_dependency_codes: [],
      });
    }

    const entry = grouped.get(baseId);
    entry.count += Math.max(1, Number.parseInt(load.count ?? load.load_count, 10) || 1);
    entry.priority = Math.min(entry.priority, Number.parseInt(load.priority, 10) || entry.priority || 0);
    entry.avg_rig_up_minutes = entry.avg_rig_up_minutes || Number.parseInt(load.avg_rig_up_minutes, 10) || null;
    entry.truckTypes = [...new Set([...entry.truckTypes, ...normalizeTruckTypes(load.truckTypes || load.truck_types || load.truck_type)])];
    entry.rig_move_dependency_codes.push(...parseDependencyCodes(load.rig_move_dependency_codes || load.dependencyLabel));
    entry.rig_up_dependency_codes.push(...parseDependencyCodes(load.rig_up_dependency_codes || load.dependencyLabel));
    entry.isReusable = entry.isReusable || Boolean(load.isReusable);
  });

  return [...grouped.values()].map((load) => ({
    ...load,
    rig_down_dependency_codes: [...new Set(load.rig_down_dependency_codes)],
    rig_move_dependency_codes: [...new Set(load.rig_move_dependency_codes)],
    rig_up_dependency_codes: [...new Set(load.rig_up_dependency_codes)],
  }));
}

export function buildOperatingSnapshot({
  move,
  teamMoves = [],
  logicalLoads = [],
  startupRequirements = undefined,
  liveSourceInventorySnapshot = null,
}) {
  const reusableInventory = buildReusableLoadInventory(logicalLoads);
  const managerId = move?.createdBy?.managerId || null;
  const currentForemanId = move?.createdBy?.id || null;
  const donorRigByForemanId = new Map();
  (teamMoves || [])
    .filter((candidate) => candidate?.createdBy?.managerId === managerId)
    .filter((candidate) => candidate?.createdBy?.id && candidate.createdBy.id !== currentForemanId)
    .filter((candidate) => candidate?.endPoint)
    .sort((a, b) => new Date(b.updatedAt || b.createdAt || 0) - new Date(a.updatedAt || a.createdAt || 0))
    .forEach((candidate) => {
      const foremanId = String(candidate.createdBy.id);
      if (donorRigByForemanId.has(foremanId)) {
        return;
      }
      donorRigByForemanId.set(foremanId, {
        foremanId,
        rigId: String(candidate?.endLabel || candidate?.name || foremanId),
        rigLabel: candidate?.endLabel || candidate?.name || foremanId,
        rigPoint: candidate?.endPoint || null,
        moveName: candidate?.name || candidate?.endLabel || foremanId,
      });
    });
  const donorRigs = [...donorRigByForemanId.values()];

  const liveSourceNodesById = new Map(
    (liveSourceInventorySnapshot?.sourceNodes || []).map((node) => [String(node.source_id || "").trim(), node]),
  );
  const liveSourceInventoryByFamily = new Map();
  (liveSourceInventorySnapshot?.sourceInventory || []).forEach((row) => {
    const familyId = String(row.family_id || "").trim();
    if (!familyId) {
      return;
    }
    if (!liveSourceInventoryByFamily.has(familyId)) {
      liveSourceInventoryByFamily.set(familyId, []);
    }
    liveSourceInventoryByFamily.get(familyId).push(row);
  });

  const startupLoads = normalizeStartupRequirements(startupRequirements).map((load) => {
    const liveDonorOptions = load.isReusable
      ? (liveSourceInventoryByFamily.get(String(load.id || "").trim()) || [])
        .map((row) => {
          const sourceId = String(row.source_id || "").trim();
          const sourceNode = liveSourceNodesById.get(sourceId) || null;
          const remainingUnits = Math.max(
            0,
            (Number.parseInt(row.available_units, 10) || 0) - (Number.parseInt(row.reserved_units, 10) || 0),
          );
          if (!sourceId || remainingUnits < 1) {
            return null;
          }

          return {
            moveId: sourceId,
            moveName: sourceNode?.source_name || sourceId,
            rigLabel: sourceNode?.source_name || sourceId,
            rigPoint: sourceNode?.point || null,
            distanceKm: Number.isFinite(Number(sourceNode?.distance_to_destination_km))
              ? Number(sourceNode.distance_to_destination_km)
              : (move?.endPoint && sourceNode?.point ? haversineKilometers(sourceNode.point, move.endPoint) : Number.POSITIVE_INFINITY),
            available: Math.min(load.count, remainingUnits),
          };
        })
        .filter(Boolean)
      : [];

    const donorOptions = (liveDonorOptions.length ? liveDonorOptions : donorRigs
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
          distanceKm: move?.endPoint && donor.rigPoint ? haversineKilometers(donor.rigPoint, move.endPoint) : Number.POSITIVE_INFINITY,
          available,
        };
      })
      .filter(Boolean))
      .sort((a, b) => b.available - a.available || a.distanceKm - b.distanceKm || a.rigLabel.localeCompare(b.rigLabel));

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
    donorRigs,
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
      donorRigCount: liveSourceInventorySnapshot?.sourceNodes?.length || donorRigs.length,
    },
  };
}

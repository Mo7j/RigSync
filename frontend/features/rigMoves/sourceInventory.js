import { fetchRigInventoryDoc } from "../../lib/firebaseOperations.js";
import { fallbackRouteData } from "./simulation.js";

function normalizeText(value) {
  const text = String(value || "").trim();
  return text || null;
}

function getSelectedScenario(move) {
  const scenarios = move?.simulation?.scenarioPlans || [];
  return (
    scenarios.find((scenario) => scenario?.name === move?.simulation?.preferredScenarioName) ||
    scenarios[0] ||
    null
  );
}

function getLatestRigMove(teamMoves = [], foremanId) {
  return (teamMoves || [])
    .filter((move) => move?.createdBy?.id === foremanId)
    .sort((left, right) => new Date(right.updatedAt || right.createdAt || 0) - new Date(left.updatedAt || left.createdAt || 0))[0] || null;
}

function resolveRigDescriptor(foreman, teamMoves = []) {
  const assignedRig = foreman?.assignedRig || null;
  const latestRigMove = getLatestRigMove(teamMoves, foreman?.id);
  const rigId = assignedRig?.id || `rig-${foreman?.id || "unknown"}`;
  const rigPoint = latestRigMove?.endPoint || assignedRig?.startPoint || null;
  return {
    foremanId: foreman?.id,
    rigId,
    rigLabel: latestRigMove?.endLabel || assignedRig?.startLabel || assignedRig?.name || foreman?.name || rigId,
    rigPoint,
  };
}

function buildReservedUnitsMap(managerScopedMoves = [], currentMoveId = null) {
  const reserved = new Map();

  (managerScopedMoves || [])
    .filter((move) => move?.id && String(move.id) !== String(currentMoveId || ""))
    .filter((move) => move?.executionState !== "completed" && move?.operatingState !== "drilling")
    .forEach((move) => {
      const scenario = getSelectedScenario(move);
      (scenario?.sourceReservations || []).forEach((reservation) => {
        const key = `${reservation.sourceId}::${reservation.familyId}`;
        reserved.set(key, (reserved.get(key) || 0) + Math.max(0, Number.parseInt(reservation.unitsReserved, 10) || 0));
      });
    });

  return reserved;
}

export async function buildLiveSourceInventorySnapshot({
  currentMove = null,
  currentUser = null,
  managedForemen = [],
  managerScopedMoves = [],
  startupRequirements = [],
  destinationPoint = null,
}) {
  const currentForemanId = currentMove?.createdBy?.id || currentUser?.id || null;
  const donorRigs = (managedForemen || [])
    .filter((foreman) => foreman?.id && foreman.id !== currentForemanId)
    .map((foreman) => resolveRigDescriptor(foreman, managerScopedMoves))
    .filter((rig) => rig?.rigId);

  if (!donorRigs.length) {
    return {
      sourceNodes: [],
      sourceInventory: [],
      reservationTotals: [],
    };
  }

  const inventoryDocs = await Promise.all(
    donorRigs.map(async (rig) => {
      try {
        const payload = await fetchRigInventoryDoc(rig.rigId);
        return {
          rig,
          adjustments: payload?.adjustments && typeof payload.adjustments === "object" ? payload.adjustments : {},
        };
      } catch {
        return {
          rig,
          adjustments: {},
        };
      }
    }),
  );

  const reservedByKey = buildReservedUnitsMap(managerScopedMoves, currentMove?.id);
  const startupRequirementById = new Map(
    (startupRequirements || []).map((load) => [String(load.id || load.code || "").trim(), load]),
  );

  const sourceNodes = inventoryDocs.map(({ rig }) => ({
    source_id: rig.rigId,
    source_type: "EXTERNAL_RIG",
    source_name: rig.rigLabel,
    active: true,
    point: rig.rigPoint || null,
    distance_to_destination_km: destinationPoint && rig.rigPoint
      ? fallbackRouteData(rig.rigPoint, destinationPoint).distanceKm
      : null,
    notes: "Live rigInventory source",
  }));

  const sourceInventory = inventoryDocs.flatMap(({ rig, adjustments }) =>
    Object.entries(adjustments || {})
      .map(([familyId, value]) => {
        const transferable = Math.max(0, Number.parseInt(value?.transferable, 10) || 0);
        const onSite = Math.max(0, Number.parseInt(value?.onSite, 10) || 0);
        const startupRequirement = startupRequirementById.get(familyId) || null;
        if (!startupRequirement?.isReusable && transferable <= 0) {
          return null;
        }
        const key = `${rig.rigId}::${familyId}`;
        const reservedUnits = reservedByKey.get(key) || 0;
        return {
          source_id: rig.rigId,
          family_id: familyId,
          available_units: transferable,
          reserved_units: reservedUnits,
          on_site_units: onSite,
          active: true,
          notes: "Live Firestore rig inventory",
        };
      })
      .filter(Boolean),
  );

  const reservationTotals = sourceInventory.map((row) => ({
    sourceId: row.source_id,
    familyId: row.family_id,
    availableUnits: row.available_units,
    reservedUnits: row.reserved_units,
    remainingUnits: Math.max(0, row.available_units - row.reserved_units),
  }));

  return {
    sourceNodes,
    sourceInventory,
    reservationTotals,
  };
}

export function applyScenarioReservationsToStartupLoads(startupLoads = [], sourceReservations = [], liveSourceInventorySnapshot = null) {
  const availabilityByKey = new Map(
    (liveSourceInventorySnapshot?.sourceInventory || []).map((row) => [
      `${row.source_id}::${row.family_id}`,
      row,
    ]),
  );
  const reservationsByFamily = new Map();
  (sourceReservations || []).forEach((reservation) => {
    const familyId = String(reservation.familyId || "").trim();
    if (!familyId) {
      return;
    }
    if (!reservationsByFamily.has(familyId)) {
      reservationsByFamily.set(familyId, []);
    }
    const key = `${reservation.sourceId}::${familyId}`;
    const liveRow = availabilityByKey.get(key);
    reservationsByFamily.get(familyId).push({
      moveId: reservation.sourceId,
      rigLabel: reservation.sourceLabel,
      assigned: Math.max(0, Number.parseInt(reservation.unitsReserved, 10) || 0),
      available: Math.max(
        0,
        Number.parseInt(liveRow?.available_units ?? reservation.availableUnits, 10) || 0,
      ),
      reserved: Math.max(
        0,
        Number.parseInt(liveRow?.reserved_units ?? reservation.reservedUnitsBefore, 10) || 0,
      ),
    });
  });

  return (startupLoads || []).map((load) => {
    const sourcingPlan = reservationsByFamily.get(String(load.id || "").trim()) || [];
    if (!sourcingPlan.length) {
      return load;
    }
    const coveredCount = sourcingPlan.reduce((sum, item) => sum + item.assigned, 0);
    const missingCount = Math.max(0, (load.count || 0) - coveredCount);
    return {
      ...load,
      sourcingPlan,
      coveredCount,
      missingCount,
      readiness: missingCount === 0 ? "covered" : coveredCount > 0 ? "partial" : "missing",
    };
  });
}

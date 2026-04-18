import { clampPercentage, formatCoordinate, formatMinutes, formatShortDate } from "../../lib/format.js";
import { createId } from "../../lib/id.js";
import { haversineKilometers } from "./simulation.js";
import { deleteMoveDoc, fetchMoveDoc, saveMoveDoc } from "../../lib/firebaseOperations.js";
import { deleteMoveRecord, fetchMoveRecord, fetchMoveRecords, saveMoveRecord } from "./api.js";

let movesCache = [];
const MOVE_BACKUP_STORAGE_KEY = "rigsync.moveBackups";

export function setMovesCache(nextMoves = []) {
  movesCache = sortMoves((nextMoves || []).map(normalizeStoredMove).filter(Boolean));
  return movesCache;
}

function readMoveBackups() {
  try {
    const stored = window.localStorage.getItem(MOVE_BACKUP_STORAGE_KEY);
    const parsed = stored ? JSON.parse(stored) : {};
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function writeMoveBackups(backups) {
  try {
    window.localStorage.setItem(MOVE_BACKUP_STORAGE_KEY, JSON.stringify(backups));
  } catch {
    // Ignore local persistence failures.
  }
}

function persistMoveBackup(move) {
  if (!move?.id) {
    return;
  }

  const backups = readMoveBackups();
  backups[move.id] = compactMoveForStorage(normalizeStoredMove(move));
  writeMoveBackups(backups);
}

function removeMoveBackup(moveId) {
  const backups = readMoveBackups();
  if (!backups[moveId]) {
    return;
  }

  delete backups[moveId];
  writeMoveBackups(backups);
}

function readMoveBackup(moveId) {
  const backups = readMoveBackups();
  return backups[moveId] ? normalizeStoredMove(backups[moveId]) : null;
}

function isMoveMoreComplete(candidate, current) {
  if (!current) {
    return true;
  }

  const candidateHasDetail = Boolean(candidate?.simulation?.bestPlan?.playback?.trips?.length || candidate?.simulation?.scenarioPlans?.length);
  const currentHasDetail = Boolean(current?.simulation?.bestPlan?.playback?.trips?.length || current?.simulation?.scenarioPlans?.length);
  if (candidateHasDetail !== currentHasDetail) {
    return candidateHasDetail;
  }

  return new Date(candidate?.updatedAt || 0).getTime() >= new Date(current?.updatedAt || 0).getTime();
}

function mergeMoveCollections(...collections) {
  const merged = new Map();

  collections
    .flat()
    .map((move) => normalizeStoredMove(move))
    .filter(Boolean)
    .forEach((move) => {
      const current = merged.get(move.id);
      if (isMoveMoreComplete(move, current)) {
        merged.set(move.id, move);
      }
    });

  return sortMoves([...merged.values()]);
}

export function mergeMovesCache(nextMoves = []) {
  return setMovesCache(mergeMoveCollections(readMoves(), nextMoves));
}

function roundCoordinate(value) {
  return Math.round(value * 100000) / 100000;
}

function compactGeometry(geometry, maxPoints = 120) {
  if (!Array.isArray(geometry) || geometry.length <= maxPoints) {
    return geometry;
  }

  const lastIndex = geometry.length - 1;
  const sampled = [];

  for (let index = 0; index < maxPoints; index += 1) {
    const sourceIndex = Math.round((index / Math.max(maxPoints - 1, 1)) * lastIndex);
    const point = geometry[sourceIndex];
    if (!point) {
      continue;
    }

    const compactPoint = [roundCoordinate(point[0]), roundCoordinate(point[1])];
    const previousPoint = sampled[sampled.length - 1];
    if (!previousPoint || previousPoint[0] !== compactPoint[0] || previousPoint[1] !== compactPoint[1]) {
      sampled.push(compactPoint);
    }
  }

  return sampled;
}

function compactPlayback(playback, options = {}) {
  if (!playback) {
    return null;
  }

  const includeGeometry = options.includeGeometry !== false;
  const includeJourneys = options.includeJourneys === true;

  return {
    totalMinutes: playback.totalMinutes,
    journeys: includeJourneys
      ? (playback.journeys || []).map((journey) => ({
          id: journey.id,
          truckId: journey.truckId,
          truckType: journey.truckType,
          loadIds: [...(journey.loadIds || [])],
          loadCodes: [...(journey.loadCodes || [])],
          description: journey.description || null,
          dispatchStart: journey.dispatchStart ?? 0,
          moveStart: journey.moveStart ?? 0,
          arrivalAtDestination: journey.arrivalAtDestination ?? 0,
          returnStart: journey.returnStart ?? 0,
          returnToSource: journey.returnToSource ?? 0,
          routeMinutes: journey.routeMinutes || null,
          routeDistanceKm: journey.routeDistanceKm || null,
          routeGeometry: includeGeometry ? compactGeometry(journey.routeGeometry || [], 24) : [],
        }))
      : [],
    trips: (playback.trips || []).map((trip) => ({
      truckId: trip.truckId,
      truckType: trip.truckType,
      journeyId: trip.journeyId || null,
      loadId: trip.loadId,
      loadCode: trip.loadCode || null,
      description: trip.description,
      sourceLabel: trip.sourceLabel || null,
      destinationLabel: trip.destinationLabel || null,
      dispatchStart: trip.dispatchStart ?? trip.loadStart,
      pickupRouteMinutes: trip.pickupRouteMinutes || null,
      pickupRouteGeometry: includeGeometry ? compactGeometry(trip.pickupRouteGeometry || [], 16) : [],
      routeMinutes: trip.routeMinutes || null,
      routeGeometry: includeGeometry ? compactGeometry(trip.routeGeometry || [], 24) : [],
      moveStart: trip.moveStart ?? null,
      loadStart: trip.loadStart,
      rigDownStart: trip.rigDownStart ?? trip.loadStart,
      rigDownFinish: trip.rigDownFinish,
      pickupLoadStart: trip.pickupLoadStart ?? trip.rigDownFinish,
      pickupLoadFinish: trip.pickupLoadFinish ?? trip.moveStart ?? trip.rigDownFinish,
      arrivalAtDestination: trip.arrivalAtDestination,
      unloadDropStart: trip.unloadDropStart ?? trip.arrivalAtDestination,
      unloadDropFinish: trip.unloadDropFinish ?? trip.arrivalAtDestination,
      rigUpStart: trip.rigUpStart ?? trip.arrivalAtDestination,
      rigUpFinish: trip.rigUpFinish,
      returnStart: trip.returnStart ?? trip.arrivalAtDestination,
      returnToSource: trip.returnToSource,
    })),
    steps: (playback.steps || []).map((step) => ({
      type: step.type,
      minute: step.minute,
      title: step.title,
      description: step.description,
    })),
    tasks: (playback.tasks || []).map((task) => ({
      id: task.id,
      loadId: task.loadId,
      loadCode: task.loadCode || null,
      description: task.description,
      phase: task.phase,
      activityCode: task.activityCode || "",
      activityLabel: task.activityLabel || "",
      sourceKind: task.sourceKind || "rig",
      predecessorIds: [...(task.predecessorIds || [])],
      startMinute: task.startMinute,
      endMinute: task.endMinute,
      earliestStart: task.earliestStart ?? task.startMinute ?? 0,
      earliestFinish: task.earliestFinish ?? task.endMinute ?? 0,
      latestStart: task.latestStart ?? ((task.startMinute ?? 0) + (task.slack ?? 0)),
      latestFinish: task.latestFinish ?? ((task.endMinute ?? 0) + (task.slack ?? 0)),
      slack: task.slack ?? 0,
      isCritical: Boolean(task.isCritical),
    })),
    planningAnalysis: playback.planningAnalysis
      ? {
          projectFinish: playback.planningAnalysis.projectFinish ?? playback.totalMinutes ?? 0,
          criticalTaskIds: [...(playback.planningAnalysis.criticalTaskIds || [])],
        }
      : null,
  };
}

function compactScenarioPlan(plan) {
  if (!plan) {
    return null;
  }

  const compactedPlayback = compactPlayback(plan.bestVariant?.playback || plan.playback, { includeGeometry: false });
  return {
    name: plan.name,
    truckCount: plan.truckCount,
    capacity: plan.capacity,
    routeDistanceKm: plan.routeDistanceKm,
    routeMinutes: plan.routeMinutes,
    routeSource: plan.routeSource,
    routeGeometry: compactGeometry(plan.routeGeometry || []),
    totalMinutes: plan.totalMinutes,
    truckSetup: plan.truckSetup || [],
    allocatedTruckSetup: plan.allocatedTruckSetup || [],
    usedTruckSetup: plan.usedTruckSetup || [],
    allocatedTruckCount: plan.allocatedTruckCount,
    utilization: plan.utilization,
    truckUtilization: plan.truckUtilization,
    idleMinutes: plan.idleMinutes,
    costEstimate: plan.costEstimate,
    bestVariant: plan.bestVariant
      ? {
          name: plan.bestVariant.name,
          routeMinutes: plan.bestVariant.routeMinutes,
          processingMinutes: plan.bestVariant.processingMinutes,
          totalMinutes: plan.bestVariant.totalMinutes,
          playback: compactedPlayback,
        }
      : null,
  };
}

function compactBestPlan(plan) {
  if (!plan) {
    return null;
  }

  return {
    name: plan.name,
    routeMinutes: plan.routeMinutes,
    processingMinutes: plan.processingMinutes,
    totalMinutes: plan.totalMinutes,
    playback: compactPlayback(plan.playback, { includeGeometry: false, includeJourneys: false }),
  };
}

function compactSimulation(simulation) {
  if (!simulation) {
    return null;
  }

  const scenarioPlans = (simulation.scenarioPlans || []).map(compactScenarioPlan).filter(Boolean);
  const preferredScenarioName =
    simulation.preferredScenarioName ||
    simulation.bestScenario?.name ||
    scenarioPlans[0]?.name ||
    "";

  return {
    startPoint: simulation.startPoint,
    endPoint: simulation.endPoint,
    truckCount: simulation.truckCount,
    truckSetup: simulation.truckSetup || [],
    routeDistanceKm: simulation.routeDistanceKm,
    routeMinutes: simulation.routeMinutes,
    routeSource: simulation.routeSource,
    routeGeometry: compactGeometry(simulation.routeGeometry || []),
    supportRoutes: (simulation.supportRoutes || []).map((route) => ({
      key: route.key,
      loadLabel: route.loadLabel,
      quantity: route.quantity,
      sourceLabel: route.sourceLabel,
      sourcePoint: route.sourcePoint || null,
      destinationLabel: route.destinationLabel,
      truckLabel: route.truckLabel,
      routeSource: route.routeSource || "",
      geometry: compactGeometry(route.geometry || [], 32),
      routeMinutes: route.routeMinutes || null,
      routeDistanceKm: route.routeDistanceKm || null,
      pickupGeometry: compactGeometry(route.pickupGeometry || [], 24),
      pickupRouteSource: route.pickupRouteSource || "",
      pickupRouteMinutes: route.pickupRouteMinutes || null,
      pickupRouteDistanceKm: route.pickupRouteDistanceKm || null,
    })),
    preferredScenarioName,
    scenarioPlans,
    bestScenario: compactScenarioPlan(simulation.bestScenario),
    bestPlan: compactBestPlan(simulation.bestPlan),
  };
}

function compactMoveForStorage(move) {
  if (!move) {
    return move;
  }

  return {
    ...move,
    simulation: compactSimulation(move.simulation),
  };
}

function normalizeStoredSimulation(simulation) {
  if (!simulation) {
    return null;
  }

  const compacted = compactSimulation(simulation);
  if (!compacted?.scenarioPlans?.length) {
    const fallbackScenarioName =
      compacted?.preferredScenarioName ||
      compacted?.bestScenario?.name ||
      compacted?.bestPlan?.name ||
      "Saved plan";
    const fallbackScenario =
      compacted?.bestPlan
        ? {
            name: fallbackScenarioName,
            truckCount: compacted?.bestScenario?.truckCount || compacted?.truckCount || 0,
            capacity: compacted?.bestScenario?.capacity || 0,
            routeDistanceKm: compacted?.bestScenario?.routeDistanceKm || compacted?.routeDistanceKm || 0,
            routeMinutes: compacted?.bestScenario?.routeMinutes || compacted?.bestPlan?.routeMinutes || compacted?.routeMinutes || 0,
            routeSource: compacted?.bestScenario?.routeSource || compacted?.routeSource || "",
            routeGeometry: compacted?.bestScenario?.routeGeometry || compacted?.routeGeometry || [],
            totalMinutes: compacted?.bestScenario?.totalMinutes || compacted?.bestPlan?.totalMinutes || 0,
            truckSetup: compacted?.bestScenario?.truckSetup || compacted?.truckSetup || [],
            allocatedTruckSetup:
              compacted?.bestScenario?.allocatedTruckSetup ||
              compacted?.bestScenario?.truckSetup ||
              compacted?.truckSetup ||
              [],
            usedTruckSetup: compacted?.bestScenario?.usedTruckSetup || [],
            allocatedTruckCount:
              compacted?.bestScenario?.allocatedTruckCount ||
              compacted?.bestScenario?.truckCount ||
              compacted?.truckCount ||
              0,
            utilization: compacted?.bestScenario?.utilization || 0,
            truckUtilization: compacted?.bestScenario?.truckUtilization || 0,
            idleMinutes: compacted?.bestScenario?.idleMinutes || 0,
            costEstimate: compacted?.bestScenario?.costEstimate || 0,
            bestVariant: {
              ...compacted.bestPlan,
              name: compacted.bestPlan.name || fallbackScenarioName,
            },
          }
        : null;

    if (fallbackScenario) {
      return {
        ...compacted,
        scenarioPlans: [fallbackScenario],
        bestScenario: fallbackScenario,
        preferredScenarioName: fallbackScenario.name,
      };
    }

    return compacted;
  }

  const preferredScenario =
    compacted.scenarioPlans.find((plan) => plan.name === compacted.preferredScenarioName) ||
    compacted.scenarioPlans[0];

  const hydratedScenarioPlans = compacted.scenarioPlans.map((plan) => {
    if (plan.name === preferredScenario?.name) {
      return {
        ...plan,
        bestVariant: compacted.bestPlan
          ? {
              ...plan.bestVariant,
              ...compacted.bestPlan,
              playback: compacted.bestPlan.playback || plan.bestVariant?.playback || null,
            }
          : plan.bestVariant,
      };
    }

    return plan;
  });

  return {
    ...compacted,
    scenarioPlans: hydratedScenarioPlans,
    bestScenario:
      hydratedScenarioPlans.find((plan) => plan.name === preferredScenario?.name) ||
      compacted.bestScenario,
    preferredScenarioName: preferredScenario?.name || "",
  };
}

function normalizeStoredMove(move) {
  if (!move) {
    return move;
  }

  const resolvedManagerId =
    move.managerId ||
    (move.createdBy?.role === "Manager" ? move.createdBy?.id : move.createdBy?.managerId) ||
    null;

  return {
    ...move,
    managerId: resolvedManagerId,
    createdBy: move.createdBy || {
      id: "foreman-fahad",
      name: "Fahad Al-Qahtani",
      role: "Foreman",
      managerId: resolvedManagerId || "manager-nasser",
    },
    executionState: move.executionState || "planning",
    operatingState: move.operatingState || (move.executionState === "completed" ? "drilling" : "standby"),
    executionProgress: {
      managerNotified: Boolean(move.executionProgress?.managerNotified),
      trucksReserved: Boolean(move.executionProgress?.trucksReserved),
      liveDataRequested: Boolean(move.executionProgress?.liveDataRequested),
      rigDownCompleted: Boolean(move.executionProgress?.rigDownCompleted),
      rigMoveCompleted: Boolean(move.executionProgress?.rigMoveCompleted),
      rigUpCompleted: Boolean(move.executionProgress?.rigUpCompleted),
      trackingMode: move.executionProgress?.trackingMode === "demoUltrasonic" ? "demoUltrasonic" : "driverApp",
      ultrasonicStartCm: Math.max(0, Number(move.executionProgress?.ultrasonicStartCm) || 45),
      ultrasonicArrivalCm: Math.max(0, Number(move.executionProgress?.ultrasonicArrivalCm) || 8),
      ultrasonicLatestCm:
        move.executionProgress?.ultrasonicLatestCm == null
          ? null
          : Math.max(0, Number(move.executionProgress.ultrasonicLatestCm) || 0),
      ultrasonicLastUpdatedAt: move.executionProgress?.ultrasonicLastUpdatedAt || null,
    },
    simulation: normalizeStoredSimulation(move.simulation),
  };
}

function sortMoves(moves) {
  return [...moves].sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
}

export async function hydrateMoves(managerId, { summary = false } = {}) {
  if (!managerId) {
    return setMovesCache([]);
  }

  const remoteMoves = await fetchMoveRecords(managerId, { summary });
  const backupMoves = Object.values(readMoveBackups()).filter((move) => {
    const moveManagerId = move?.createdBy?.role === "Manager" ? move.createdBy?.id : move?.createdBy?.managerId;
    return moveManagerId === managerId;
  });

  return setMovesCache(mergeMoveCollections(remoteMoves, backupMoves));
}

export async function fetchMove(moveId) {
  let payload = null;

  try {
    payload = normalizeStoredMove(await fetchMoveRecord(moveId));
  } catch {
    payload = null;
  }

  if (!payload) {
    try {
      payload = normalizeStoredMove(await fetchMoveDoc(moveId));
    } catch {
      payload = null;
    }
  }

  if (!payload) {
    payload = readMoveBackup(moveId);
  }

  if (!payload) {
    return null;
  }

  persistMoveBackup(payload);
  const current = readMoves().filter((item) => item.id !== payload.id);
  setMovesCache([payload, ...current]);
  return payload;
}

export function readMoves() {
  return sortMoves(movesCache);
}

export async function upsertMove(move) {
  const compactedMove = compactMoveForStorage(normalizeStoredMove(move));
  const savedMove = normalizeStoredMove(await saveMoveRecord(compactedMove));
  persistMoveBackup(savedMove);
  void saveMoveDoc(compactedMove).catch(() => {});
  const current = readMoves().filter((item) => item.id !== savedMove.id);
  return setMovesCache([savedMove, ...current]);
}

export async function removeMove(moveId) {
  await deleteMoveRecord(moveId);
  removeMoveBackup(moveId);
  try {
    await deleteMoveDoc(moveId);
  } catch {
    // Keep the local removal even if Firestore cleanup fails.
  }
  return setMovesCache(readMoves().filter((move) => move.id !== moveId));
}

export function updateMoveProgress(moveId, progressMinute) {
  const nextMoves = readMoves().map((move) => {
    if (move.id !== moveId) {
      return move;
    }

    const activeScenario =
      move.simulation?.scenarioPlans?.find(
        (scenario) => scenario.name === move.simulation?.preferredScenarioName,
      ) || move.simulation?.scenarioPlans?.[0];
    const totalMinutes = activeScenario?.bestVariant?.totalMinutes || 1;
    return {
      ...move,
      updatedAt: new Date().toISOString(),
      progressMinute,
      completionPercentage: clampPercentage((progressMinute / totalMinutes) * 100),
    };
  });

  return setMovesCache(nextMoves);
}

export async function persistMoveSession(moveId, sessionState) {
  const targetMove = readMoves().find((move) => move.id === moveId);
  if (!targetMove) {
    return null;
  }

  const updatedMove = normalizeStoredMove({
    ...targetMove,
    ...sessionState,
    executionProgress: {
      ...(targetMove.executionProgress || {}),
      ...(sessionState.executionProgress || {}),
    },
  });

  const persistedMove = compactMoveForStorage({
    ...updatedMove,
    updatedAt: new Date().toISOString(),
  });
  const syncedMove = normalizeStoredMove(persistedMove);

  await saveMoveRecord(persistedMove);
  persistMoveBackup(persistedMove);
  void saveMoveDoc({
    id: moveId,
    managerId: updatedMove.managerId,
    createdBy: updatedMove.createdBy,
    ...sessionState,
    executionProgress: updatedMove.executionProgress,
    updatedAt: persistedMove.updatedAt,
  }).catch(() => {});
  const current = readMoves().filter((item) => item.id !== syncedMove.id);
  setMovesCache([syncedMove, ...current]);
  return syncedMove;
}

export function createMoveRecord({ name, startPoint, endPoint, startLabel, endLabel, simulation, routeMode, loadCount, createdBy = null }) {
  const totalMinutes = simulation.bestPlan.totalMinutes;
  const routeKm =
    simulation?.routeDistanceKm ||
    simulation?.bestScenario?.routeDistanceKm ||
    Math.max(1, Math.round(haversineKilometers(startPoint, endPoint) * 10) / 10);
  const now = new Date();
  const isDemoMove = Boolean(createdBy?.isDemo);

  return {
    id: createId(),
    name,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    routeMode,
    loadCount,
    managerId: createdBy?.role === "Manager" ? createdBy.id : createdBy?.managerId || null,
    createdBy,
    startPoint,
    endPoint,
    startLabel: startLabel || formatCoordinate(startPoint),
    endLabel: endLabel || formatCoordinate(endPoint),
    routeKm,
    eta: formatMinutes(totalMinutes),
    routeTime: formatMinutes(simulation.routeMinutes),
    planningStartDate: now.toISOString().slice(0, 10),
    planningStartTime: "06:00",
    progressMinute: 0,
    completionPercentage: 0,
    executionState: "planning",
    operatingState: "standby",
    executionProgress: {
      managerNotified: false,
      trucksReserved: false,
      liveDataRequested: false,
      rigDownCompleted: false,
      rigMoveCompleted: false,
      rigUpCompleted: false,
      trackingMode: isDemoMove ? "demoUltrasonic" : "driverApp",
      ultrasonicStartCm: 45,
      ultrasonicArrivalCm: 8,
      ultrasonicLatestCm: isDemoMove ? 45 : null,
      ultrasonicLastUpdatedAt: isDemoMove ? now.toISOString() : null,
    },
    truckSetup: simulation.truckSetup || [],
    simulation,
    createdLabel: formatShortDate(now),
  };
}

export function migrateLegacyHistory() {
  return [];
}

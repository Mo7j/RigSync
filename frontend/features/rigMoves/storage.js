import { clampPercentage, formatCoordinate, formatMinutes, formatShortDate } from "../../lib/format.js";
import { haversineKilometers } from "./simulation.js";
import { MOVES_STORAGE_KEY } from "../../lib/constants.js";

let movesCache = [];

function loadMovesCache() {
  if (movesCache.length) {
    return movesCache;
  }

  try {
    const stored = window.localStorage.getItem(MOVES_STORAGE_KEY);
    if (!stored) {
      return movesCache;
    }

    movesCache = sortMoves((JSON.parse(stored) || []).map(normalizeStoredMove).filter(Boolean));
  } catch {
    movesCache = [];
  }

  return movesCache;
}

function persistMovesCache(nextMoves) {
  movesCache = sortMoves((nextMoves || []).map(normalizeStoredMove).filter(Boolean));

  try {
    window.localStorage.setItem(MOVES_STORAGE_KEY, JSON.stringify(movesCache));
  } catch {
    // Ignore storage failures and keep runtime cache.
  }

  return movesCache;
}

function roundCoordinate(value) {
  return Math.round(value * 100000) / 100000;
}

function compactGeometry(geometry, maxPoints = 1200) {
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

function compactPlayback(playback) {
  if (!playback) {
    return null;
  }

  return {
    totalMinutes: playback.totalMinutes,
    journeys: (playback.journeys || []).map((journey) => ({
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
    })),
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
      pickupRouteGeometry: compactGeometry(trip.pickupRouteGeometry || []),
      routeMinutes: trip.routeMinutes || null,
      routeGeometry: compactGeometry(trip.routeGeometry || []),
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
          playback: compactPlayback(plan.bestVariant.playback),
        }
      : null,
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
      geometry: compactGeometry(route.geometry || []),
      routeMinutes: route.routeMinutes || null,
      routeDistanceKm: route.routeDistanceKm || null,
      pickupGeometry: compactGeometry(route.pickupGeometry || []),
      pickupRouteSource: route.pickupRouteSource || "",
      pickupRouteMinutes: route.pickupRouteMinutes || null,
      pickupRouteDistanceKm: route.pickupRouteDistanceKm || null,
    })),
    preferredScenarioName,
    scenarioPlans,
    bestScenario: simulation.bestScenario || null,
    bestPlan: simulation.bestPlan ? { ...simulation.bestPlan, playback: compactPlayback(simulation.bestPlan.playback) } : null,
  };
}

function normalizeStoredSimulation(simulation) {
  if (!simulation) {
    return null;
  }

  const compacted = compactSimulation(simulation);
  if (!compacted?.scenarioPlans?.length) {
    return compacted;
  }

  const preferredScenario =
    compacted.scenarioPlans.find((plan) => plan.name === compacted.preferredScenarioName) ||
    compacted.scenarioPlans[0];

  return {
    ...compacted,
    preferredScenarioName: preferredScenario?.name || "",
  };
}

function normalizeStoredMove(move) {
  if (!move) {
    return move;
  }

  return {
    ...move,
    createdBy: move.createdBy || {
      id: "foreman-fahad",
      name: "Fahad Al-Qahtani",
      role: "Foreman",
      managerId: "manager-nasser",
    },
    executionState: move.executionState || "planning",
    operatingState: move.operatingState || (move.executionState === "completed" ? "drilling" : "standby"),
    executionProgress: {
      managerNotified: Boolean(move.executionProgress?.managerNotified),
      trucksReserved: Boolean(move.executionProgress?.trucksReserved),
      liveDataRequested: Boolean(move.executionProgress?.liveDataRequested),
      rigDownCompleted: Boolean(move.executionProgress?.rigDownCompleted),
      rigUpCompleted: Boolean(move.executionProgress?.rigUpCompleted),
    },
    simulation: normalizeStoredSimulation(move.simulation),
  };
}

function sortMoves(moves) {
  return [...moves].sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
}

async function saveMoveRemote(move) {
  const response = await fetch(`/api/moves/${encodeURIComponent(move.id)}`, {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ move: normalizeStoredMove(move) }),
  });

  if (!response.ok) {
    throw new Error(`Move save failed with ${response.status}`);
  }

  return normalizeStoredMove(await response.json());
}

export async function hydrateMoves(managerId, { summary = false } = {}) {
  if (!managerId) {
    persistMovesCache([]);
    return [];
  }

  const params = new URLSearchParams({ managerId, summary: summary ? "1" : "0" });
  const response = await fetch(`/api/moves?${params.toString()}`);
  if (!response.ok) {
    throw new Error(`Moves request failed with ${response.status}`);
  }

  const payload = await response.json();
  return persistMovesCache(payload || []);
}

export async function fetchMove(moveId) {
  const response = await fetch(`/api/moves/${encodeURIComponent(moveId)}`);
  if (!response.ok) {
    throw new Error(`Move request failed with ${response.status}`);
  }

  const payload = normalizeStoredMove(await response.json());
  const current = readMoves().filter((item) => item.id !== payload.id);
  persistMovesCache([payload, ...current]);
  return payload;
}

export function readMoves() {
  return sortMoves(loadMovesCache());
}

export async function upsertMove(move) {
  const savedMove = await saveMoveRemote(move);
  const current = readMoves().filter((item) => item.id !== savedMove.id);
  return persistMovesCache([savedMove, ...current]);
}

export async function removeMove(moveId) {
  const response = await fetch(`/api/moves/${encodeURIComponent(moveId)}`, {
    method: "DELETE",
  });

  if (!response.ok) {
    throw new Error(`Move delete failed with ${response.status}`);
  }

  return persistMovesCache(readMoves().filter((move) => move.id !== moveId));
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

  return persistMovesCache(nextMoves);
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

  await upsertMove(updatedMove);
  return updatedMove;
}

export function createMoveRecord({ name, startPoint, endPoint, startLabel, endLabel, simulation, routeMode, loadCount, createdBy = null }) {
  const totalMinutes = simulation.bestPlan.totalMinutes;
  const routeKm =
    simulation?.routeDistanceKm ||
    simulation?.bestScenario?.routeDistanceKm ||
    Math.max(1, Math.round(haversineKilometers(startPoint, endPoint) * 10) / 10);
  const now = new Date();

  return {
    id: crypto.randomUUID(),
    name,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    routeMode,
    loadCount,
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
      rigUpCompleted: false,
    },
    truckSetup: simulation.truckSetup || [],
    simulation,
    createdLabel: formatShortDate(now),
  };
}

export function migrateLegacyHistory() {
  return [];
}

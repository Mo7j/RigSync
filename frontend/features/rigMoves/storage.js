import { MOVES_STORAGE_KEY } from "../../lib/constants.js";
import { clampPercentage, formatCoordinate, formatMinutes, formatShortDate } from "../../lib/format.js";
import { haversineKilometers, parseCoordinateString } from "./simulation.js";

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

function compactPlayback(playback) {
  if (!playback) {
    return null;
  }

  return {
    totalMinutes: playback.totalMinutes,
    trips: (playback.trips || []).map((trip) => ({
      truckId: trip.truckId,
      loadId: trip.loadId,
      description: trip.description,
      loadStart: trip.loadStart,
      rigDownFinish: trip.rigDownFinish,
      arrivalAtDestination: trip.arrivalAtDestination,
      rigUpFinish: trip.rigUpFinish,
      returnToSource: trip.returnToSource,
    })),
    steps: (playback.steps || []).map((step) => ({
      type: step.type,
      minute: step.minute,
      title: step.title,
      description: step.description,
    })),
  };
}

function compactScenarioPlan(plan) {
  if (!plan) {
    return null;
  }

  return {
    name: plan.name,
    workerCount: plan.workerCount,
    truckCount: plan.truckCount,
    capacity: plan.capacity,
    routeMinutes: plan.routeMinutes,
    routeSource: plan.routeSource,
    routeGeometry: compactGeometry(plan.routeGeometry || []),
    totalMinutes: plan.totalMinutes,
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
    workerCount: simulation.workerCount,
    truckCount: simulation.truckCount,
    truckSetup: simulation.truckSetup || [],
    routeMinutes: simulation.routeMinutes,
    routeSource: simulation.routeSource,
    preferredScenarioName,
    scenarioPlans,
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
    simulation: normalizeStoredSimulation(move.simulation),
  };
}

function safeReadStorage() {
  try {
    const raw = window.localStorage.getItem(MOVES_STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(parsed)) {
      return [];
    }

    const normalized = parsed.map(normalizeStoredMove).filter(Boolean);
    const compactRaw = JSON.stringify(normalized);
    if (raw !== compactRaw) {
      window.localStorage.setItem(MOVES_STORAGE_KEY, compactRaw);
    }

    return normalized;
  } catch {
    return [];
  }
}

function saveMoves(nextMoves) {
  const compactMoves = nextMoves.map(normalizeStoredMove);
  window.localStorage.setItem(MOVES_STORAGE_KEY, JSON.stringify(compactMoves));
  return compactMoves;
}

export function readMoves() {
  return safeReadStorage().sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
}

export function upsertMove(move) {
  const current = readMoves().filter((item) => item.id !== move.id);
  return saveMoves([move, ...current]);
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

  return saveMoves(nextMoves);
}

export function createMoveRecord({ name, startPoint, endPoint, startLabel, endLabel, simulation, routeMode, loadCount }) {
  const totalMinutes = simulation.bestPlan.totalMinutes;
  const routeKm = Math.max(1, Math.round(haversineKilometers(startPoint, endPoint) * 10) / 10);
  const now = new Date();

  return {
    id: crypto.randomUUID(),
    name,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    routeMode,
    loadCount,
    startPoint,
    endPoint,
    startLabel: startLabel || formatCoordinate(startPoint),
    endLabel: endLabel || formatCoordinate(endPoint),
    routeKm,
    eta: formatMinutes(totalMinutes),
    routeTime: formatMinutes(simulation.routeMinutes),
    progressMinute: 0,
    completionPercentage: 0,
    truckSetup: simulation.truckSetup || [],
    simulation,
    createdLabel: formatShortDate(now),
  };
}

export function migrateLegacyHistory(historyStorageKey) {
  const existingMoves = readMoves();
  if (existingMoves.length) {
    return;
  }

  try {
    const raw = window.localStorage.getItem(historyStorageKey);
    const parsed = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(parsed) || !parsed.length) {
      return;
    }

    const migrated = parsed
      .map((entry) => {
        const startPoint = parseCoordinateString(entry.start);
        const endPoint = parseCoordinateString(entry.end);
        if (!startPoint || !endPoint) {
          return null;
        }

        return {
          id: entry.id || crypto.randomUUID(),
          name: entry.title || "Imported rig move",
          createdAt: new Date(entry.createdAt || Date.now()).toISOString(),
          updatedAt: new Date(entry.createdAt || Date.now()).toISOString(),
          routeMode: "estimated",
          loadCount: 0,
          startPoint,
          endPoint,
          startLabel: entry.start,
          endLabel: entry.end,
          routeKm: Math.max(1, Math.round(haversineKilometers(startPoint, endPoint) * 10) / 10),
          eta: entry.eta || "--",
          routeTime: entry.routeTime || "--",
          progressMinute: 0,
          completionPercentage: 0,
          simulation: null,
          createdLabel: entry.createdAt || "--",
        };
      })
      .filter(Boolean);

    if (migrated.length) {
      saveMoves(migrated);
    }
  } catch {
    // Ignore invalid legacy data.
  }
}

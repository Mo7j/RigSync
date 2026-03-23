import { MOVES_STORAGE_KEY } from "../../lib/constants.js";
import { clampPercentage, formatCoordinate, formatMinutes, formatShortDate } from "../../lib/format.js";
import { haversineKilometers, parseCoordinateString } from "./simulation.js";

function safeReadStorage() {
  try {
    const raw = window.localStorage.getItem(MOVES_STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function saveMoves(nextMoves) {
  window.localStorage.setItem(MOVES_STORAGE_KEY, JSON.stringify(nextMoves));
  return nextMoves;
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

    const totalMinutes = move.simulation?.bestPlan?.totalMinutes || 1;
    return {
      ...move,
      updatedAt: new Date().toISOString(),
      progressMinute,
      completionPercentage: clampPercentage((progressMinute / totalMinutes) * 100),
    };
  });

  return saveMoves(nextMoves);
}

export function createMoveRecord({ name, startPoint, endPoint, simulation, routeMode, loadCount }) {
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
    startLabel: formatCoordinate(startPoint),
    endLabel: formatCoordinate(endPoint),
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

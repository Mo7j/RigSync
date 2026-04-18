import { React, createRoot, h } from "./lib/react.js";
import { useHashRoute, navigateTo } from "./lib/router.js";
import { DEFAULT_TRUCK_SETUP } from "./lib/constants.js";
import { fetchLoads, fetchLocationLabel } from "./features/rigMoves/api.js";
import { buildLogicalLoads, fetchRouteData, fallbackRouteData } from "./features/rigMoves/simulation.js";
import { buildScenarioPlans } from "./features/rigMoves/isePlanner.js";
import { buildOperatingSnapshot, buildStartupTransferSchedule } from "./features/rigMoves/operations.js";
import { applyRigInventoryAdjustments, hydrateRigInventoryAdjustments, readRigInventoryAdjustments, setRigInventoryCache, writeRigInventoryAdjustments } from "./features/rigInventory/storage.js";
import {
  authenticateUser,
  createDriverAccount,
  createForemanAccount,
  createSession,
  getSession,
  refreshSession,
  clearSession,
} from "./features/auth/auth.js";
import {
  hydrateMoves,
  mergeMovesCache,
  readMoves,
  fetchMove,
  createMoveRecord,
  upsertMove,
  persistMoveSession,
  removeMove,
} from "./features/rigMoves/storage.js";
import {
  setManagerResourcesCache,
  readManagerResources,
  readManagerFleet,
  hydrateManagerResources,
  writeManagerResources,
  writeManagerFleet,
  buildFleetAvailability,
  getAvailabilityValidationError,
  sumTruckCounts,
} from "./features/resources/storage.js";
import { subscribeManagedForemen, subscribeManagerMoves, subscribeManagerResources, subscribeRigInventoryDoc } from "./lib/firebaseOperations.js";
import { HomePage } from "./pages/HomePage.js";
import { LoginPage } from "./pages/LoginPage.js";
import { DashboardPage } from "./pages/DashboardPage.js";
import { ManagerDashboardPage } from "./pages/ManagerDashboardPage.js";
import { DriverDashboardPage } from "./pages/DriverDashboardPage.js";
import { RigMovePage } from "./pages/RigMovePage.js";
import { Card } from "./components/ui/Card.js";
import { AppLayout } from "./layouts/AppLayout.js";
import { formatCoordinate, formatDate, formatMinutes } from "./lib/format.js";
import { DEFAULT_LANGUAGE, LANGUAGE_STORAGE_KEY, getLanguageDirection } from "./lib/language.js";

const { useEffect, useRef, useState } = React;
const DEMO_ACCOUNT_EMAIL = "demo@rigsync.com";
const NORMAL_PLAYBACK_SPEED = 1500;
const DEFAULT_PLAYBACK_SPEED = 15000;
const DEMO_SENSOR_SYNC_INTERVAL_MS = 2500;
const DEMO_RIG_LOADS = [
  {
    id: "demo-load-1",
    code: "DM-01",
    description: "Demo power skid",
    category: "Demo",
    priority: 1,
    truck_type: "Low-bed",
    truck_types: ["Low-bed"],
    load_count: 1,
    weight_tons: 12,
    avg_rig_down_minutes: 20,
    avg_rig_up_minutes: 20,
    optimal_rig_down_minutes: 15,
    optimal_rig_up_minutes: 15,
    minimum_crew_down_count: 1,
    minimum_crew_up_count: 1,
    optimal_crew_down_count: 1,
    optimal_crew_up_count: 1,
    minimum_crew_down_roles: { operator: 1 },
    minimum_crew_up_roles: { operator: 1 },
    optimal_crew_down_roles: { operator: 1 },
    optimal_crew_up_roles: { operator: 1 },
  },
  {
    id: "demo-load-2",
    code: "DM-02",
    description: "Demo pipe basket",
    category: "Demo",
    priority: 2,
    truck_type: "Low-bed",
    truck_types: ["Low-bed"],
    load_count: 1,
    weight_tons: 8,
    avg_rig_down_minutes: 15,
    avg_rig_up_minutes: 15,
    optimal_rig_down_minutes: 10,
    optimal_rig_up_minutes: 10,
    minimum_crew_down_count: 1,
    minimum_crew_up_count: 1,
    optimal_crew_down_count: 1,
    optimal_crew_up_count: 1,
    minimum_crew_down_roles: { operator: 1 },
    minimum_crew_up_roles: { operator: 1 },
    optimal_crew_down_roles: { operator: 1 },
    optimal_crew_up_roles: { operator: 1 },
    rig_down_dependency_codes: ["DM-01"],
    rig_move_dependency_codes: ["DM-01"],
  },
];
const DEMO_TRUCK_SPECS = [
  {
    type: "Low-bed",
    max_weight_tons: 20,
    average_speed_kmh: 25,
    alpha: 0.2,
    hourlyCost: 95,
  },
];

function isDemoSession(session) {
  return Boolean(session?.isDemo || String(session?.email || "").trim().toLowerCase() === DEMO_ACCOUNT_EMAIL);
}

function getAssignmentDelayThresholdMinutes(assignment) {
  if (Number.isFinite(Number(assignment?.delayThresholdMinutes))) {
    return Math.max(0, Number(assignment.delayThresholdMinutes));
  }
  return 20;
}

function buildSimpleDemoPlayback({
  loads,
  routeGeometry,
  startLabel,
  endLabel,
  truckType = "Low-bed",
  truckId = "demo-low-bed-1",
}) {
  const selectedLoads = (loads || []).slice(0, 2);
  const pickupBufferMinutes = 0;
  const destinationBufferMinutes = 0;
  const stagingGapMinutes = 1;
  const trips = [];
  const steps = [];
  const tasks = [];
  let nextDispatchMinute = 1;

  selectedLoads.forEach((load, index) => {
    const loadId = index + 1;
    const loadCode = `${load?.code || `DM-0${loadId}`}-L1`;
    const description = load?.description || `Demo load ${loadId}`;
    const routeMinutes = 1;
    const rigDownDuration = 1 + (index % 2);
    const rigUpDuration = 1 + ((index + 1) % 2);
    const rigDownStart = Math.max(0, nextDispatchMinute - pickupBufferMinutes - rigDownDuration);
    const rigDownFinish = rigDownStart + rigDownDuration;
    const pickupLoadStart = rigDownFinish;
    const pickupLoadFinish = pickupLoadStart + pickupBufferMinutes;
    const moveStart = pickupLoadFinish;
    const arrivalAtDestination = moveStart + routeMinutes;
    const unloadDropStart = arrivalAtDestination;
    const unloadDropFinish = unloadDropStart + destinationBufferMinutes;
    const rigUpStart = unloadDropFinish;
    const rigUpFinish = rigUpStart + rigUpDuration;
    const returnStart = rigUpFinish;
    const returnToSource = returnStart + routeMinutes;

    trips.push({
      truckId,
      truckType,
      journeyId: `${loadCode}-journey`,
      loadId,
      loadCode,
      description,
      sourceLabel: startLabel,
      destinationLabel: endLabel,
      dispatchStart: rigDownStart,
      pickupRouteMinutes: 0,
      pickupRouteGeometry: [],
      routeMinutes,
      routeGeometry,
      moveStart,
      loadStart: rigDownStart,
      rigDownStart,
      rigDownFinish,
      pickupLoadStart,
      pickupLoadFinish,
      arrivalAtDestination,
      unloadDropStart,
      unloadDropFinish,
      rigUpStart,
      rigUpFinish,
      returnStart,
      returnToSource,
      sourceKind: "rig",
    });

    steps.push(
      {
        type: "rig-down-start",
        minute: rigDownStart,
        title: `${loadCode} rig down starts`,
        description: `${description} begins rig down at ${startLabel}.`,
      },
      {
        type: "move-start",
        minute: moveStart,
        title: `${truckType} departs with ${loadCode}`,
        description: `${description} begins rig moving to ${endLabel}.`,
      },
      {
        type: "rig-up-start",
        minute: rigUpStart,
        title: `${loadCode} rig up starts`,
        description: `${description} begins rig up at ${endLabel}.`,
      },
    );

    tasks.push(
      {
        id: `${loadCode} (RD)`,
        loadId,
        loadCode,
        description,
        phase: "rig_down",
        activityCode: "RD",
        activityLabel: "Rig Down",
        sourceKind: "rig",
        predecessorIds: [],
        startMinute: rigDownStart,
        endMinute: rigDownFinish,
        earliestStart: rigDownStart,
        earliestFinish: rigDownFinish,
        latestStart: rigDownStart,
        latestFinish: rigDownFinish,
        slack: 0,
        isCritical: true,
      },
      {
        id: `${loadCode} (RM)`,
        loadId,
        loadCode,
        description,
        phase: "move",
        activityCode: "RM",
        activityLabel: "Rig Moving",
        sourceKind: "rig",
        predecessorIds: [`${loadCode} (RD)`],
        startMinute: moveStart,
        endMinute: arrivalAtDestination,
        earliestStart: moveStart,
        earliestFinish: arrivalAtDestination,
        latestStart: moveStart,
        latestFinish: arrivalAtDestination,
        slack: 0,
        isCritical: true,
      },
      {
        id: `${loadCode} (RU)`,
        loadId,
        loadCode,
        description,
        phase: "rig_up",
        activityCode: "RU",
        activityLabel: "Rig Up",
        sourceKind: "rig",
        predecessorIds: [`${loadCode} (RM)`],
        startMinute: rigUpStart,
        endMinute: rigUpFinish,
        earliestStart: rigUpStart,
        earliestFinish: rigUpFinish,
        latestStart: rigUpStart,
        latestFinish: rigUpFinish,
        slack: 0,
        isCritical: true,
      },
    );

    nextDispatchMinute = returnToSource + stagingGapMinutes;
  });

  const totalMinutes = Math.max(...trips.map((trip) => trip.rigUpFinish), 1);

  return {
    totalMinutes,
    journeys: trips,
    trips,
    steps,
    tasks,
    planningAnalysis: {
      projectFinish: totalMinutes,
      criticalTaskIds: tasks.map((task) => task.id),
    },
    resourceUsage: [],
  };
}

function readStoredLanguage() {
  try {
    return window.localStorage.getItem(LANGUAGE_STORAGE_KEY) || DEFAULT_LANGUAGE;
  } catch {
    return DEFAULT_LANGUAGE;
  }
}

function yieldForUiPaint() {
  return new Promise((resolve) => {
    window.requestAnimationFrame(() => {
      window.setTimeout(resolve, 0);
    });
  });
}

function normalizePlannerTruckType(type) {
  const normalized = String(type || "").trim().toLowerCase().replace(/[^a-z]/g, "");
  if (normalized === "hh" || normalized.includes("heavy")) {
    return "Heavy Hauler";
  }
  if (normalized === "fb" || normalized.includes("flat")) {
    return "Flat-bed";
  }
  if (normalized === "lb" || normalized.includes("low") || normalized.includes("support")) {
    return "Low-bed";
  }
  return "";
}

function createSimulationProgressState({
  percent = 0,
  message = "",
  detail = "",
  startedAt = 0,
  completedStages = 0,
  totalStages = 0,
}) {
  const safePercent = Math.max(0, Math.min(100, Math.round(percent)));
  const safeStartedAt = Number(startedAt) || 0;
  const now = Date.now();
  const elapsedMs = safeStartedAt ? Math.max(0, now - safeStartedAt) : 0;
  const remainingMs =
    safeStartedAt && safePercent > 0 && safePercent < 100
      ? Math.max(0, Math.round((elapsedMs * (100 - safePercent)) / safePercent))
      : 0;

  return {
    percent: safePercent,
    message,
    detail,
    startedAt: safeStartedAt,
    elapsedMs,
    remainingMs,
    completedStages,
    totalStages,
  };
}

function isCoordinateLabel(label) {
  return typeof label === "string" && /^-?\d+(\.\d+)?\s*,\s*-?\d+(\.\d+)?$/.test(label.trim());
}

function normalizeTruckTypeKey(type) {
  const normalized = String(type || "")
    .toLowerCase()
    .replace(/[^a-z]/g, "");

  if (normalized === "hh" || normalized.includes("heavy")) {
    return "heavyhauler";
  }
  if (normalized === "fb" || normalized.includes("flat")) {
    return "flatbed";
  }
  if (normalized === "lb" || normalized.includes("low") || normalized.includes("support")) {
    return "lowbed";
  }

  return normalized;
}

function summarizeScenarioFailures(scenarioPlans) {
  const scenarioFailures = scenarioPlans?.debug?.scenarioFailures || [];
  if (!scenarioFailures.length) {
    return "";
  }

  return scenarioFailures
    .map((scenarioFailure) => {
      const firstFailure = scenarioFailure.failures?.[0] || null;
      if (!firstFailure?.message) {
        return `${scenarioFailure.name}: no feasible fleet mix found.`;
      }

      const truckSetupLabel = (firstFailure.truckSetup || [])
        .map((truck) => `${truck.type} x${truck.count}`)
        .join(", ");
      const fleetText = truckSetupLabel ? ` Fleet: ${truckSetupLabel}.` : "";

      return `${scenarioFailure.name}: ${firstFailure.message} Trucks: ${firstFailure.truckCount}.${fleetText}`;
    })
    .slice(0, 3)
    .join(" ");
}

function getLoadRequiredTruckTypes(load) {
  const directType = String(load?.truck_type || "").trim();
  const directNormalized = normalizePlannerTruckType(directType);
  const optionTypes = (load?.truck_options || load?.truckTypes || load?.truck_types || [])
    .map((type) => normalizePlannerTruckType(type))
    .filter(Boolean);

  if (directNormalized && !/[\/,|]/.test(directType)) {
    return [directNormalized];
  }

  if (optionTypes.length) {
    return [...new Set(optionTypes)];
  }

  return directNormalized ? [directNormalized] : [];
}

function getMissingTruckCoverage(loads, truckSetup) {
  const availableTypeKeys = new Set(
    (truckSetup || [])
      .filter((truck) => Math.max(0, Number.parseInt(truck?.count, 10) || 0) > 0)
      .map((truck) => normalizeTruckTypeKey(truck.type))
      .filter(Boolean),
  );

  for (const load of loads || []) {
    const requiredTypes = getLoadRequiredTruckTypes(load);
    if (!requiredTypes.length) {
      continue;
    }

    const isCovered = requiredTypes.some((type) => availableTypeKeys.has(normalizeTruckTypeKey(type)));
    if (!isCovered) {
      return {
        loadCode: load.code || load.id || "Load",
        requiredTypes,
      };
    }
  }

  return null;
}

function getActiveScenario(move) {
  const scenarioPlans = move?.simulation?.scenarioPlans || [];
  if (!scenarioPlans.length) {
    return null;
  }

  return (
    scenarioPlans.find((scenario) => scenario.name === move?.simulation?.preferredScenarioName) ||
    scenarioPlans[0]
  );
}

function hasMultiTruckPlans(move) {
  const scenarioPlans = move?.simulation?.scenarioPlans || [];
  const distinctPlanNames = new Set(
    scenarioPlans
      .map((scenario) => scenario?.name)
      .filter(Boolean),
  );

  return scenarioPlans.length >= 3 && distinctPlanNames.size >= 3;
}

function isMoveDetailLoaded(move) {
  return Boolean(
    move?.simulation?.scenarioPlans?.length ||
    move?.simulation?.bestPlan?.playback?.trips?.length,
  );
}

function getSessionManagerId(session) {
  if (!session) {
    return null;
  }

  return session.role === "Manager" ? session.id : session.managerId || null;
}

function getAssignmentStageLabel(stageState = {}) {
  if (!stageState.rigDownCompleted) {
    return "rigDown";
  }
  if (!stageState.rigMoveCompleted) {
    return "rigMove";
  }
  if (!stageState.rigUpCompleted) {
    return "rigUp";
  }
  return "completed";
}

function getDriverMoveState(assignment = {}) {
  if (assignment?.taskType === "return") {
    if (!assignment?.moveStartedAt) {
      return "readyOutbound";
    }
    if (!assignment?.returnedToSourceAt) {
      return "movingReturn";
    }
    return "returned";
  }

  if (!assignment?.moveStartedAt) {
    return "readyOutbound";
  }
  if (!assignment?.outboundArrivedAt) {
    return "movingOutbound";
  }
  if (!assignment?.returnMoveStartedAt) {
    return "readyReturn";
  }
  if (!assignment?.returnedToSourceAt) {
    return "movingReturn";
  }
  return "returned";
}

function getAssignmentSensorProgress(move, assignment) {
  const executionProgress = move?.executionProgress || {};
  if (executionProgress?.trackingMode !== "demoUltrasonic") {
    return { enabled: false, progressPercent: null, readyToArrive: true };
  }

  const latestCm = executionProgress?.ultrasonicLatestCm == null
    ? null
    : Math.max(0, Number(executionProgress.ultrasonicLatestCm) || 0);
  if (latestCm == null) {
    return { enabled: true, progressPercent: null, readyToArrive: false };
  }

  const startCm = Math.max(0, Number(executionProgress?.ultrasonicStartCm) || 45);
  const arrivalCm = Math.max(0, Number(executionProgress?.ultrasonicArrivalCm) || 8);
  const endCm = Math.min(arrivalCm, startCm);
  const totalWindow = Math.max(startCm - endCm, 0.001);
  const outboundProgressPercent = Math.max(0, Math.min(100, Math.round(((startCm - latestCm) / totalWindow) * 100)));
  const isReturnTrip = assignment?.taskType === "return" || getDriverMoveState(assignment) === "movingReturn";
  const progressPercent = isReturnTrip
    ? Math.max(0, Math.min(100, 100 - outboundProgressPercent))
    : outboundProgressPercent;

  return {
    enabled: true,
    progressPercent,
    readyToArrive: progressPercent >= 100,
  };
}

function createReturnAssignmentFromLoad(assignment, timestamp) {
  return {
    ...assignment,
    id: `${assignment.id}-return`,
    taskType: "return",
    returnForAssignmentId: assignment.id,
    linkedAssignmentId: assignment.id,
    tripLabel: `Return to ${assignment.startLabel || "Source"}`,
    simpleLoadLabel: "Return Trip",
    startLabel: assignment.endLabel || assignment.startLabel || "",
    endLabel: assignment.startLabel || assignment.endLabel || "",
    loadId: null,
    loadCode: "",
    currentStage: "rigMove",
    status: "active",
    moveStartedAt: null,
    outboundArrivedAt: null,
    returnMoveStartedAt: null,
    returnedToSourceAt: null,
    stageStatus: {
      rigDownCompleted: true,
      rigMoveCompleted: false,
      rigUpCompleted: true,
    },
    stageCompletedAt: {
      rigDown: assignment.stageCompletedAt?.rigDown || timestamp,
      rigMove: null,
      rigUp: assignment.stageCompletedAt?.rigMove || timestamp,
    },
    stageDelayNotes: {
      rigDown: null,
      rigMove: null,
      rigUp: null,
    },
    updatedAt: timestamp,
  };
}

function getStageDelayMinutes({ assignment, stage, completedAt = new Date().toISOString() }) {
  const plannedFinishMinute = assignment?.stagePlan?.[stage]?.finishMinute;
  const executionStartedAt = assignment?.executionStartedAt || assignment?.assignedAt;
  if (!Number.isFinite(Number(plannedFinishMinute)) || !executionStartedAt) {
    return 0;
  }

  const actualElapsedMinutes =
    Math.max(0, new Date(completedAt).getTime() - new Date(executionStartedAt).getTime()) / 60000;
  return Math.max(0, actualElapsedMinutes - Number(plannedFinishMinute));
}

function getMovePlayback(move) {
  const preferredScenarioName = move?.simulation?.preferredScenarioName || "";
  const preferredScenario =
    (move?.simulation?.scenarioPlans || []).find((scenario) => scenario.name === preferredScenarioName) ||
    move?.simulation?.bestScenario ||
    move?.simulation?.scenarioPlans?.[0] ||
    null;

  return move?.simulation?.bestPlan?.playback || preferredScenario?.bestVariant?.playback || null;
}

function pruneTaskAssignments(taskAssignments = [], moves = []) {
  const moveById = new Map((moves || []).filter(Boolean).map((move) => [move.id, move]));

  return (taskAssignments || []).filter((assignment) => {
    if (!assignment?.moveId) {
      return false;
    }

    const move = moveById.get(assignment.moveId);
    if (!move) {
      return false;
    }

    if (move.executionState !== "active") {
      return false;
    }

    if (!assignment.driverId) {
      return false;
    }

    if (assignment.taskType === "return") {
      return Boolean(assignment.linkedAssignmentId || assignment.returnForAssignmentId);
    }

    if (!assignment.loadId) {
      return false;
    }

    return true;
  });
}

function buildDriverAssignmentsForMove({ move, managerResources }) {
  const activeAssignments = (managerResources?.taskAssignments || []).filter((assignment) => assignment.status !== "completed");
  const busyDriverIds = new Set(activeAssignments.map((assignment) => assignment.driverId));
  const drivers = managerResources?.drivers || [];
  const freeDrivers = drivers.filter((driver) => !busyDriverIds.has(driver.id));
  const assignedAt = new Date().toISOString();
  const playback = getMovePlayback(move);
  const trips = [...(playback?.trips || [])]
    .filter((trip) => trip?.loadId != null)
    .sort((left, right) => (left.loadStart ?? 0) - (right.loadStart ?? 0) || (left.loadId ?? 0) - (right.loadId ?? 0));
  const primaryPool = (freeDrivers.length ? freeDrivers : drivers).filter(Boolean);
  if (!trips.length) {
    return [];
  }
  const tripsByPlannedTruck = new Map();
  trips.forEach((trip) => {
    const plannedTruckKey = `${trip.truckType || "Truck"}::${trip.truckId ?? "0"}`;
    if (!tripsByPlannedTruck.has(plannedTruckKey)) {
      tripsByPlannedTruck.set(plannedTruckKey, []);
    }
    tripsByPlannedTruck.get(plannedTruckKey).push(trip);
  });

  const plannedTruckLanes = [...tripsByPlannedTruck.entries()]
    .map(([plannedTruckKey, plannedTrips]) => ({
      plannedTruckKey,
      truckType: plannedTrips[0]?.truckType || "Truck",
      plannedTruckId: plannedTrips[0]?.truckId ?? null,
      trips: [...plannedTrips].sort(
        (left, right) => (left.loadStart ?? 0) - (right.loadStart ?? 0) || (left.loadId ?? 0) - (right.loadId ?? 0),
      ),
    }))
    .sort(
      (left, right) => (left.trips[0]?.loadStart ?? 0) - (right.trips[0]?.loadStart ?? 0) || ((left.plannedTruckId ?? 0) - (right.plannedTruckId ?? 0)),
    );

  const usedDriverIds = new Set();
  function pickDriverForLane(type, lane) {
    const typeKey = String(type || "").trim().toLowerCase();
    const exactPrimary = primaryPool.find(
      (driver) => !usedDriverIds.has(driver.id) && String(driver.truckType || "").trim().toLowerCase() === typeKey,
    );
    if (exactPrimary) {
      usedDriverIds.add(exactPrimary.id);
      return exactPrimary;
    }

    const exactAny = drivers.find(
      (driver) => !usedDriverIds.has(driver.id) && String(driver.truckType || "").trim().toLowerCase() === typeKey,
    );
    if (exactAny) {
      usedDriverIds.add(exactAny.id);
      return exactAny;
    }

    const fallbackPrimary = primaryPool.find((driver) => !usedDriverIds.has(driver.id));
    if (fallbackPrimary) {
      usedDriverIds.add(fallbackPrimary.id);
      return fallbackPrimary;
    }

    const fallbackAny = drivers.find((driver) => !usedDriverIds.has(driver.id));
    if (fallbackAny) {
      usedDriverIds.add(fallbackAny.id);
      return fallbackAny;
    }

    return {
      id: `synthetic-${move.id}-${(lane?.plannedTruckId ?? lane?.plannedTruckKey ?? typeKey) || "truck"}`,
      name: `${String(type || lane?.truckType || "Truck").trim() || "Truck"} crew`,
      truckId: lane?.plannedTruckId == null ? "" : String(lane.plannedTruckId),
      truckType: lane?.truckType || type || "Truck",
    };
  }

  const laneDriverByKey = new Map();
  plannedTruckLanes.forEach((lane) => {
    const driver = pickDriverForLane(lane.truckType, lane);
    if (!driver) {
      return;
    }
    laneDriverByKey.set(lane.plannedTruckKey, {
      driver,
      lane,
    });
  });

  const orderedTrips = plannedTruckLanes
    .flatMap((lane) =>
      lane.trips.map((trip) => ({
        trip,
        lane,
        laneDriver: laneDriverByKey.get(lane.plannedTruckKey) || null,
      })),
    )
    .filter((entry) => entry.laneDriver?.driver)
    .sort(
      (left, right) => (left.trip.loadStart ?? 0) - (right.trip.loadStart ?? 0) ||
        (left.trip.loadId ?? 0) - (right.trip.loadId ?? 0) ||
        String(left.lane.plannedTruckKey).localeCompare(String(right.lane.plannedTruckKey)),
    );

  let sequenceCursor = 0;

  return orderedTrips.map(({ trip, lane, laneDriver }, index) => {
    const driver = laneDriver.driver;
    const simpleLoadLabel = `Load ${index + 1}`;
    const rigDownDuration = Math.max(
      1,
      Math.round((trip.rigDownFinish ?? trip.loadStart ?? 0) - (trip.rigDownStart ?? trip.loadStart ?? 0)) || 1,
    );
    const rigMoveDuration = Math.max(
      1,
      Math.round((trip.arrivalAtDestination ?? trip.moveFinish ?? 0) - (trip.moveStart ?? trip.pickupLoadFinish ?? trip.rigDownFinish ?? 0)) || 1,
    );
    const rigUpDuration = Math.max(
      1,
      Math.round((trip.rigUpFinish ?? trip.returnToSource ?? trip.arrivalAtDestination ?? 0) - (trip.rigUpStart ?? trip.unloadDropFinish ?? trip.arrivalAtDestination ?? 0)) || 1,
    );
    const rigDownStartMinute = sequenceCursor;
    const rigDownFinishMinute = rigDownStartMinute + rigDownDuration;
    const rigMoveStartMinute = rigDownFinishMinute;
    const rigMoveFinishMinute = rigMoveStartMinute + rigMoveDuration;
    const rigUpStartMinute = rigMoveFinishMinute;
    const rigUpFinishMinute = rigUpStartMinute + rigUpDuration;
    sequenceCursor = rigUpFinishMinute;

    return {
      id: `assignment-${move.id}-${driver.id}-${trip.loadId}-${index + 1}`,
      moveId: move.id,
      moveName: move.name,
      driverId: driver.id,
      driverName: driver.name,
      truckId: driver.truckId || "",
      truckType: driver.truckType || lane.truckType || "Truck",
      plannedTruckType: lane.truckType || driver.truckType || "",
      plannedTruckId: lane.plannedTruckId,
      startLabel: move.startLabel || "",
      endLabel: move.endLabel || "",
      loadId: trip.loadId,
      loadCode: trip.loadCode || "",
      simpleLoadLabel,
      tripLabel: simpleLoadLabel,
      tripNumber: index + 1,
      plannedTripCount: orderedTrips.length,
      sequence: index + 1,
      plannedStartMinute: rigDownStartMinute,
      plannedFinishMinute: rigUpFinishMinute,
      stagePlan: {
        rigDown: {
          startMinute: rigDownStartMinute,
          finishMinute: rigDownFinishMinute,
        },
        rigMove: {
          startMinute: rigMoveStartMinute,
          finishMinute: rigMoveFinishMinute,
        },
        rigUp: {
          startMinute: rigUpStartMinute,
          finishMinute: rigUpFinishMinute,
        },
      },
      stageDelayNotes: {
        rigDown: null,
        rigMove: null,
        rigUp: null,
      },
      journeyId: trip.journeyId || null,
      moveStartedAt: null,
      outboundArrivedAt: null,
      returnMoveStartedAt: null,
      returnedToSourceAt: null,
      stageStatus: {
        rigDownCompleted: false,
        rigMoveCompleted: false,
        rigUpCompleted: false,
      },
      stageCompletedAt: {
        rigDown: null,
        rigMove: null,
        rigUp: null,
      },
      currentStage: "rigDown",
      status: index === 0 ? "foreman" : "queued",
      taskType: "load",
      linkedAssignmentId: null,
      returnForAssignmentId: null,
      assignedAt,
      executionStartedAt: assignedAt,
      updatedAt: assignedAt,
      delayThresholdMinutes: move?.createdBy?.isDemo ? (20 / 60) : 20,
      isDemoMove: Boolean(move?.createdBy?.isDemo),
    };
  });
}

function getLatestMoveByState(moves, predicate) {
  return moves
    .filter(predicate)
    .sort((a, b) => new Date(b.updatedAt || b.createdAt || 0) - new Date(a.updatedAt || a.createdAt || 0))[0] || null;
}

function isUsableRigMove(move) {
  if (!move?.id) {
    return false;
  }

  const hasStart = Boolean(move.startPoint || String(move.startLabel || "").trim());
  const hasEnd = Boolean(move.endPoint || String(move.endLabel || "").trim());
  return hasStart && hasEnd;
}

function buildForemanRigContext({ session, visibleMoves, managerScopedMoves, logicalLoads, startupRequirements = [], rigInventoryRevision = 0 }) {
  const assignedRig = session?.assignedRig || null;
  const stableRigId = assignedRig?.id || `rig-${session?.id || "home"}`;
  const latestDrillingMove = getLatestMoveByState(
    visibleMoves,
    (move) => isUsableRigMove(move) && (move?.operatingState === "drilling" || move?.executionState === "completed"),
  );
  const activeMove = getLatestMoveByState(
    visibleMoves,
    (move) => isUsableRigMove(move) && move?.operatingState !== "drilling" && move?.executionState !== "completed",
  );
  const currentPoint = latestDrillingMove?.endPoint || assignedRig?.startPoint || null;
  const currentLabel = latestDrillingMove?.endLabel || assignedRig?.startLabel || formatCoordinate(currentPoint);
  const baseRigInventory = buildOperatingSnapshot({
    move: latestDrillingMove || activeMove || { id: stableRigId, name: assignedRig?.name || "Rig" },
    teamMoves: managerScopedMoves,
    logicalLoads,
    startupRequirements,
  });
  const rigInventory = applyRigInventoryAdjustments(
    baseRigInventory,
    readRigInventoryAdjustments(stableRigId),
  );

  void rigInventoryRevision;

  return {
    activeMove,
    rig: {
      ...(assignedRig || {}),
      id: stableRigId,
      currentPoint,
      currentLabel,
    },
    rigInventory,
  };
}

function buildPlanningLoadsForMove({ baseLogicalLoads, move, teamMoves, startupRequirements = [] }) {
  const operatingSnapshot = buildOperatingSnapshot({
    move,
    teamMoves,
    logicalLoads: baseLogicalLoads,
    startupRequirements,
  });
  void operatingSnapshot;

  return [
    ...(baseLogicalLoads || []),
    ...buildLogicalLoads(startupRequirements || []).map((load) => ({
      ...load,
      source_kind: "startup",
    })),
  ];
}

function App() {
  const route = useHashRoute();
  const [session, setSession] = useState(getSession);
  const [language, setLanguage] = useState(readStoredLanguage);
  const [loads, setLoads] = useState([]);
  const [startupRequirements, setStartupRequirements] = useState([]);
  const [truckSpecs, setTruckSpecs] = useState([]);
  const [isLoadingLoads, setIsLoadingLoads] = useState(true);
  const [loadsError, setLoadsError] = useState("");
  const [moves, setMoves] = useState([]);
  const [rigInventoryRevision, setRigInventoryRevision] = useState(0);
  const [areMovesHydrated, setAreMovesHydrated] = useState(false);
  const [areManagerResourcesHydrated, setAreManagerResourcesHydrated] = useState(false);
  const [isActiveMoveHydrated, setIsActiveMoveHydrated] = useState(false);
  const [createError, setCreateError] = useState("");
  const [isCreatingMove, setIsCreatingMove] = useState(false);
  const [managerResources, setManagerResources] = useState({
    fleet: [],
    trucks: [],
    drivers: [],
    taskAssignments: [],
  });
  const [managedForemen, setManagedForemen] = useState([]);
  const [managerFleet, setManagerFleet] = useState([]);
  const [isSimulatingMove, setIsSimulatingMove] = useState(false);
  const [simulationProgress, setSimulationProgress] = useState(
    createSimulationProgressState({ percent: 0, message: "" }),
  );
  const [moveSimulationError, setMoveSimulationError] = useState("");
  const [currentMinute, setCurrentMinute] = useState(0);
  const [playbackSpeed, setPlaybackSpeed] = useState(DEFAULT_PLAYBACK_SPEED);
  const [isPlaybackRunning, setIsPlaybackRunning] = useState(false);
  const [isPlaybackPaused, setIsPlaybackPaused] = useState(false);
  const [sceneFocusResetKey, setSceneFocusResetKey] = useState(0);
  const [areSceneAssetsReady, setAreSceneAssetsReady] = useState(true);
  const [isScenePlaybackReady, setIsScenePlaybackReady] = useState(false);
  const animationFrameRef = useRef(null);
  const animationStartedAtRef = useRef(null);
  const lastPersistedMinuteRef = useRef(null);
  const lastPlaybackUiUpdateRef = useRef(0);
  const lastSavedMoveSessionRef = useRef("");
  const [routeMoveFallback, setRouteMoveFallback] = useState(null);

  useEffect(() => {
    const normalizedLanguage = language === "ar" ? "ar" : "en";
    document.documentElement.lang = normalizedLanguage;
    document.documentElement.dir = getLanguageDirection(normalizedLanguage);
    try {
      window.localStorage.setItem(LANGUAGE_STORAGE_KEY, normalizedLanguage);
    } catch {
      // Ignore storage errors.
    }
  }, [language]);

  function handleToggleLanguage() {
    setLanguage((current) => (current === "ar" ? "en" : "ar"));
  }

  useEffect(() => {
    void refreshSession().then((nextSession) => {
      if (nextSession) {
        setSession(nextSession);
      }
    }).catch(() => {});
  }, []);

  useEffect(() => {
    if ("scrollRestoration" in window.history) {
      const previous = window.history.scrollRestoration;
      window.history.scrollRestoration = "manual";
      return () => {
        window.history.scrollRestoration = previous;
      };
    }
    return undefined;
  }, []);

  useEffect(() => {
    let cancelled = false;

    async function loadDataset() {
      setIsLoadingLoads(true);
      setLoadsError("");

      try {
        if (isDemoSession(session)) {
          if (!cancelled) {
            setLoads(DEMO_RIG_LOADS);
            setStartupRequirements([]);
            setTruckSpecs(DEMO_TRUCK_SPECS);
          }
          return;
        }

        const dataset = await fetchLoads();
        if (!cancelled) {
          setLoads(dataset.rigLoads || []);
          setStartupRequirements(dataset.startupLoads || []);
          setTruckSpecs(dataset.truckSpecs || []);
        }
      } catch (error) {
        if (!cancelled) {
          setLoadsError(error.message || "Failed to load rig move dataset.");
        }
      } finally {
        if (!cancelled) {
          setIsLoadingLoads(false);
        }
      }
    }

    loadDataset();

    return () => {
      cancelled = true;
    };
  }, [session?.email, session?.isDemo]);

  useEffect(() => {
    const animatedNodes = [];
    const selectors = [".card", ".move-row"];
    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          entry.target.classList.toggle("is-visible", entry.isIntersecting);
        });
      },
      {
        threshold: 0.1,
        rootMargin: "-4% 0px -4% 0px",
      },
    );

    const frameId = window.requestAnimationFrame(() => {
      document.querySelectorAll(selectors.join(", ")).forEach((node, index) => {
        node.classList.add("scroll-reveal");
        node.style.setProperty("--reveal-delay", `${Math.min(index * 45, 220)}ms`);
        observer.observe(node);
        animatedNodes.push(node);
      });
    });

    return () => {
      window.cancelAnimationFrame(frameId);
      observer.disconnect();
      animatedNodes.forEach((node) => {
        node.classList.remove("scroll-reveal", "is-visible");
        node.style.removeProperty("--reveal-delay");
      });
    };
  }, [route.page, moves.length]);

  useEffect(() => {
    if (route.page !== "home") {
      document.body.classList.remove("home-interactive");
      document.documentElement.style.removeProperty("--mouse-x");
      document.documentElement.style.removeProperty("--mouse-y");
      document.documentElement.style.removeProperty("--grid-shift-x");
      document.documentElement.style.removeProperty("--grid-shift-y");
      document.documentElement.style.removeProperty("--orbit-left-x");
      document.documentElement.style.removeProperty("--orbit-left-y");
      document.documentElement.style.removeProperty("--orbit-right-x");
      document.documentElement.style.removeProperty("--orbit-right-y");
      document.documentElement.style.removeProperty("--home-scroll-progress");
      document.documentElement.style.removeProperty("--home-scroll-shift");
      document.documentElement.style.removeProperty("--home-scene-index");
      return undefined;
    }

    document.body.classList.add("home-interactive");

    const handleMouseMove = (event) => {
      const x = event.clientX;
      const y = event.clientY;
      const centerX = window.innerWidth / 2;
      const centerY = window.innerHeight / 2;
      const shiftX = (x - centerX) * -0.018;
      const shiftY = (y - centerY) * -0.018;
      const orbitLeftX = shiftX * -0.35;
      const orbitLeftY = shiftY * -0.35;
      const orbitRightX = shiftX * 0.45;
      const orbitRightY = shiftY * 0.45;

      document.documentElement.style.setProperty("--mouse-x", `${x}px`);
      document.documentElement.style.setProperty("--mouse-y", `${y}px`);
      document.documentElement.style.setProperty("--grid-shift-x", `${shiftX}px`);
      document.documentElement.style.setProperty("--grid-shift-y", `${shiftY}px`);
      document.documentElement.style.setProperty("--orbit-left-x", `${orbitLeftX}px`);
      document.documentElement.style.setProperty("--orbit-left-y", `${orbitLeftY}px`);
      document.documentElement.style.setProperty("--orbit-right-x", `${orbitRightX}px`);
      document.documentElement.style.setProperty("--orbit-right-y", `${orbitRightY}px`);
    };

    const handleScroll = () => {
      const maxScroll = Math.max(document.documentElement.scrollHeight - window.innerHeight, 1);
      const progress = Math.min(Math.max(window.scrollY / maxScroll, 0), 1);
      document.documentElement.style.setProperty("--home-scroll-progress", progress.toFixed(4));
      document.documentElement.style.setProperty("--home-scroll-shift", `${Math.round(progress * 260)}px`);
    };

    handleMouseMove({
      clientX: window.innerWidth / 2,
      clientY: window.innerHeight / 2,
    });
    handleScroll();

    window.addEventListener("mousemove", handleMouseMove);
    window.addEventListener("scroll", handleScroll, { passive: true });

    return () => {
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("scroll", handleScroll);
      document.body.classList.remove("home-interactive");
      document.documentElement.style.removeProperty("--mouse-x");
      document.documentElement.style.removeProperty("--mouse-y");
      document.documentElement.style.removeProperty("--grid-shift-x");
      document.documentElement.style.removeProperty("--grid-shift-y");
      document.documentElement.style.removeProperty("--orbit-left-x");
      document.documentElement.style.removeProperty("--orbit-left-y");
      document.documentElement.style.removeProperty("--orbit-right-x");
      document.documentElement.style.removeProperty("--orbit-right-y");
      document.documentElement.style.removeProperty("--home-scroll-progress");
      document.documentElement.style.removeProperty("--home-scroll-shift");
      document.documentElement.style.removeProperty("--home-scene-index");
    };
  }, [route.page]);

  useEffect(() => {
    if (route.page === "home") {
      window.scrollTo(0, 0);
    }
  }, [route.page]);

  const logicalLoads = buildLogicalLoads(loads);
  const managerId = getSessionManagerId(session);
  const managerScopedMoves = managerId
    ? moves.filter((move) => {
        if (!move) {
          return false;
        }
        const moveManagerId = move.createdBy?.role === "Manager" ? move.createdBy?.id : move.createdBy?.managerId;
        return moveManagerId === managerId;
      })
    : [];
  const visibleMoves = session?.role === "Foreman"
    ? moves.filter((move) => move?.createdBy?.id === session.id)
    : session?.role === "Manager"
      ? managerScopedMoves
      : moves.filter(Boolean);
  const activeMove =
    route.page === "move"
      ? (
          visibleMoves.find((move) => move && String(move.id) === String(route.moveId)) ||
          managerScopedMoves.find((move) => move && String(move.id) === String(route.moveId)) ||
          (routeMoveFallback && String(routeMoveFallback.id) === String(route.moveId) ? routeMoveFallback : null) ||
          moves.find((move) => move && String(move.id) === String(route.moveId)) ||
          null
        )
      : null;
  const activeMoveRef = useRef(activeMove);
  useEffect(() => {
    activeMoveRef.current = activeMove;
  }, [activeMove]);
  const activeScenario = getActiveScenario(activeMove);
  const activeTotalMinutes = activeScenario?.bestVariant?.totalMinutes || 0;
  const activeExecutionState = activeMove?.executionState || "planning";
  const availableFleet = buildFleetAvailability({
    managerFleet,
    moves: managerScopedMoves,
    currentMoveId: activeMove?.id || null,
  });
  const managerFleetSignature = JSON.stringify(
    (managerFleet || []).map((truck) => ({
      id: truck.id,
      type: truck.type,
      count: truck.count,
      hourlyCost: truck.hourlyCost,
    })),
  );
  const foremanRigContext =
    session?.role === "Foreman"
      ? buildForemanRigContext({
          session,
          visibleMoves,
          managerScopedMoves,
          logicalLoads,
          startupRequirements,
          rigInventoryRevision,
        })
      : null;
  const matchedDriverIds = session?.role === "Driver"
    ? new Set(
        [
          session.id,
          ...(managerResources?.drivers || [])
            .filter((driver) => String(driver.email || "").trim().toLowerCase() === String(session.email || "").trim().toLowerCase())
            .map((driver) => driver.id),
        ].filter(Boolean),
      )
    : new Set();
  const driverAssignments = session?.role === "Driver"
    ? (managerResources?.taskAssignments || []).filter((assignment) => matchedDriverIds.has(assignment.driverId))
    : [];
  const moveExecutionAssignments = activeMove
    ? (managerResources?.taskAssignments || []).filter((assignment) => assignment.moveId === activeMove.id)
    : [];

  useEffect(() => {
    if (!managerId) {
      setMoves([]);
      setManagerResources({ fleet: [], trucks: [], drivers: [], taskAssignments: [] });
      setManagedForemen([]);
      setManagerFleet([]);
      setAreManagerResourcesHydrated(true);
      setAreMovesHydrated(true);
      return undefined;
    }

    setAreMovesHydrated(false);
    setAreManagerResourcesHydrated(false);

    void hydrateMoves(managerId, { summary: true })
      .then((hydratedMoves) => {
        setMoves(hydratedMoves);
        setAreMovesHydrated(true);
      })
      .catch(() => {});

    void hydrateManagerResources(managerId)
      .then((hydratedResources) => {
        setManagerResources(hydratedResources);
        setManagerFleet(hydratedResources.fleet || readManagerFleet(managerId));
        setAreManagerResourcesHydrated(true);
      })
      .catch(() => {
        setAreManagerResourcesHydrated(true);
      });

    const unsubscribeMoves = subscribeManagerMoves(managerId, (remoteMoves) => {
      const normalizedMoves = mergeMovesCache(remoteMoves);
      setMoves(normalizedMoves);
      setAreMovesHydrated(true);
    });

    const unsubscribeResources = subscribeManagerResources(managerId, (remoteResources) => {
      const normalizedResources = setManagerResourcesCache(managerId, remoteResources || readManagerResources(managerId));
      setManagerResources(normalizedResources);
      setManagerFleet(normalizedResources.fleet || readManagerFleet(managerId));
      setAreManagerResourcesHydrated(true);
    });

    return () => {
      unsubscribeMoves?.();
      unsubscribeResources?.();
    };
  }, [managerId, session?.role]);

  useEffect(() => {
    if (!managerId) {
      setManagedForemen([]);
      return undefined;
    }

    return subscribeManagedForemen(managerId, (nextForemen) => {
      setManagedForemen(nextForemen || []);
    });
  }, [managerId]);

  useEffect(() => {
    if (!managerId || !areManagerResourcesHydrated || !activeMove || activeMove.executionState !== "active") {
      return;
    }

    if (moveExecutionAssignments.length) {
      return;
    }

    const recoveredAssignments = buildDriverAssignmentsForMove({
      move: activeMove,
      managerResources,
    });

    if (!recoveredAssignments.length) {
      return;
    }

    void handleSaveManagerResources({
      ...managerResources,
      taskAssignments: [
        ...(managerResources?.taskAssignments || []).filter((assignment) => assignment.moveId !== activeMove.id),
        ...recoveredAssignments,
      ],
    });
  }, [managerId, areManagerResourcesHydrated, activeMove?.id, activeMove?.executionState, moveExecutionAssignments.length, managerResources]);

  useEffect(() => {
    if (!managerId || !areMovesHydrated) {
      return;
    }

    const currentAssignments = managerResources?.taskAssignments || [];
    const prunedAssignments = pruneTaskAssignments(currentAssignments, moves);
    if (prunedAssignments.length === currentAssignments.length) {
      return;
    }

    void handleSaveManagerResources({
      ...managerResources,
      taskAssignments: prunedAssignments,
    });
  }, [managerId, areMovesHydrated, managerResources, moves]);

  useEffect(() => {
    let cancelled = false;

    async function hydrateActiveMove() {
      if (route.page !== "move" || !route.moveId) {
        setRouteMoveFallback(null);
        setIsActiveMoveHydrated(false);
        return;
      }

      if (activeMove && isMoveDetailLoaded(activeMove)) {
        setRouteMoveFallback(activeMove);
        setIsActiveMoveHydrated(true);
        return;
      }

      setIsActiveMoveHydrated(false);

      try {
        const hydratedMove = await fetchMove(route.moveId);
        if (!cancelled && hydratedMove) {
          setRouteMoveFallback(hydratedMove);
          setMoves((current) => {
            const remaining = current.filter((move) => move.id !== hydratedMove.id);
            return [hydratedMove, ...remaining];
          });
          setIsActiveMoveHydrated(true);
        } else if (!cancelled) {
          setRouteMoveFallback(null);
          setIsActiveMoveHydrated(true);
        }
      } catch {
        if (!cancelled) {
          setIsActiveMoveHydrated(Boolean(activeMove && isMoveDetailLoaded(activeMove)));
        }
      }
    }

    hydrateActiveMove();

    return () => {
      cancelled = true;
    };
  }, [route.page, route.moveId, activeMove?.id, activeMove?.updatedAt]);

  useEffect(() => {
    if (
      route.page !== "move" ||
      !route.moveId ||
      !activeMoveRef.current ||
      activeMoveRef.current.executionProgress?.trackingMode !== "demoUltrasonic"
    ) {
      return undefined;
    }

    let cancelled = false;

    const syncDemoMove = async () => {
      try {
        const latestMove = await fetchMove(route.moveId);
        if (!latestMove || cancelled) {
          return;
        }

        const currentMove = activeMoveRef.current;
        const currentLatestCm = currentMove?.executionProgress?.ultrasonicLatestCm;
        const nextLatestCm = latestMove?.executionProgress?.ultrasonicLatestCm;
        const currentUpdatedAt = currentMove?.updatedAt || "";
        const nextUpdatedAt = latestMove?.updatedAt || "";

        if (
          currentUpdatedAt === nextUpdatedAt &&
          Number(currentLatestCm) === Number(nextLatestCm)
        ) {
          return;
        }

        const onlyUltrasonicChanged =
          currentUpdatedAt !== nextUpdatedAt &&
          currentMove?.simulation &&
          JSON.stringify(currentMove.simulation) === JSON.stringify(latestMove.simulation) &&
          JSON.stringify(currentMove.executionAssignments || []) === JSON.stringify(latestMove.executionAssignments || []) &&
          JSON.stringify(currentMove.stageStatus || {}) === JSON.stringify(latestMove.stageStatus || {}) &&
          JSON.stringify(currentMove.createdBy || {}) === JSON.stringify(latestMove.createdBy || {}) &&
          JSON.stringify(currentMove.startPoint || {}) === JSON.stringify(latestMove.startPoint || {}) &&
          JSON.stringify(currentMove.endPoint || {}) === JSON.stringify(latestMove.endPoint || {}) &&
          JSON.stringify({
            trackingMode: currentMove?.executionProgress?.trackingMode,
            ultrasonicStartCm: currentMove?.executionProgress?.ultrasonicStartCm,
            ultrasonicArrivalCm: currentMove?.executionProgress?.ultrasonicArrivalCm,
            executionState: currentMove?.executionState,
          }) === JSON.stringify({
            trackingMode: latestMove?.executionProgress?.trackingMode,
            ultrasonicStartCm: latestMove?.executionProgress?.ultrasonicStartCm,
            ultrasonicArrivalCm: latestMove?.executionProgress?.ultrasonicArrivalCm,
            executionState: latestMove?.executionState,
          });

        if (onlyUltrasonicChanged) {
          setRouteMoveFallback((current) => (
            current && String(current.id) === String(latestMove.id)
              ? {
                  ...current,
                  updatedAt: latestMove.updatedAt,
                  completionPercentage: latestMove.completionPercentage,
                  executionProgress: latestMove.executionProgress,
                }
              : latestMove
          ));
          return;
        }

        setRouteMoveFallback(latestMove);
        setMoves((current) => {
          const remaining = current.filter((move) => move.id !== latestMove.id);
          return [latestMove, ...remaining];
        });
      } catch {
        // Keep the current move state if the fast demo sync misses.
      }
    };

    const intervalId = window.setInterval(syncDemoMove, DEMO_SENSOR_SYNC_INTERVAL_MS);
    void syncDemoMove();

    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
    };
  }, [
    route.page,
    route.moveId,
    activeMove?.id,
    activeMove?.executionProgress?.trackingMode,
  ]);

  useEffect(() => {
    if (route.page !== "move" || !route.moveId || !activeMove) {
      return;
    }

    if (String(activeMove.id) === String(route.moveId)) {
      setRouteMoveFallback(activeMove);
    }
  }, [route.page, route.moveId, activeMove]);

  useEffect(() => {
    if (!foremanRigContext?.rig?.id) {
      return undefined;
    }

    const unsubscribe = subscribeRigInventoryDoc(foremanRigContext.rig.id, (payload) => {
      setRigInventoryCache(foremanRigContext.rig.id, payload?.adjustments || {});
      setRigInventoryRevision((value) => value + 1);
    });

    void hydrateRigInventoryAdjustments(foremanRigContext.rig.id)
      .then(() => setRigInventoryRevision((value) => value + 1))
      .catch(() => {});

    return () => {
      unsubscribe?.();
    };
  }, [foremanRigContext?.rig?.id]);

  useEffect(() => {
    if (route.page !== "move") {
      setIsScenePlaybackReady(false);
      setIsPlaybackRunning(false);
      setIsPlaybackPaused(false);
    }
  }, [route.page, activeMove?.id]);

  useEffect(() => {
    if (route.page !== "move" || !activeMove) {
      lastSavedMoveSessionRef.current = "";
      return;
    }

    const restoredMinute = Math.min(activeMove.progressMinute || 0, activeTotalMinutes || activeMove.progressMinute || 0);
    const restoredSpeed =
      Number(activeMove.playbackSpeed) ||
      (activeMove?.createdBy?.isDemo ? NORMAL_PLAYBACK_SPEED : DEFAULT_PLAYBACK_SPEED);

    setCurrentMinute(restoredMinute);
    lastPersistedMinuteRef.current = restoredMinute;
    setPlaybackSpeed(restoredSpeed);
    setIsPlaybackRunning(false);
    setIsPlaybackPaused(activeExecutionState === "active" && restoredMinute > 0 && restoredMinute < activeTotalMinutes);
    lastSavedMoveSessionRef.current = `${activeMove.id}:${Math.round(restoredMinute)}:${restoredSpeed}`;
  }, [route.page, activeMove?.id, activeExecutionState]);

  useEffect(() => {
    if (route.page !== "move" || !activeMove) {
      return undefined;
    }

    const flushMoveSession = (minuteOverride = lastPersistedMinuteRef.current) => {
      const resolvedMinute = Number.isFinite(Number(minuteOverride)) ? Number(minuteOverride) : 0;
      const nextMinute = Math.max(0, Math.min(Math.round(resolvedMinute), activeTotalMinutes || Math.round(resolvedMinute)));
      const nextSpeed = Number(playbackSpeed) || (activeMove?.createdBy?.isDemo ? NORMAL_PLAYBACK_SPEED : DEFAULT_PLAYBACK_SPEED);
      const nextCompletion = activeTotalMinutes > 0 ? Math.min(100, Math.max(0, (nextMinute / activeTotalMinutes) * 100)) : 0;
      const nextSnapshot = `${activeMove.id}:${nextMinute}:${nextSpeed}`;

      if (lastSavedMoveSessionRef.current === nextSnapshot) {
        return;
      }

      lastSavedMoveSessionRef.current = nextSnapshot;
      void persistMoveSession(activeMove.id, {
        progressMinute: nextMinute,
        completionPercentage: nextCompletion,
        playbackSpeed: nextSpeed,
      }).catch(() => {});
      setMoves((current) =>
        current.map((move) =>
          move.id === activeMove.id
            ? {
                ...move,
                progressMinute: nextMinute,
                completionPercentage: nextCompletion,
                playbackSpeed: nextSpeed,
              }
            : move,
        ),
      );
    };

    const intervalId = window.setInterval(() => {
      flushMoveSession(lastPersistedMinuteRef.current);
    }, 8000);

    const handleBeforeUnload = () => {
      flushMoveSession(lastPersistedMinuteRef.current);
    };

    window.addEventListener("beforeunload", handleBeforeUnload);

    return () => {
      window.clearInterval(intervalId);
      window.removeEventListener("beforeunload", handleBeforeUnload);
      flushMoveSession(lastPersistedMinuteRef.current);
    };
  }, [route.page, activeMove?.id, playbackSpeed, activeTotalMinutes]);

  useEffect(() => {
    let cancelled = false;

    async function ensureMovePlans() {
      const isDemoMove =
        Boolean(activeMove?.createdBy?.isDemo) ||
        activeMove?.executionProgress?.trackingMode === "demoUltrasonic";
      const needsRouteRefresh =
        activeMove?.routeMode !== "live" ||
        (activeMove?.simulation?.routeGeometry?.length || 0) < 3;
      const needsPlanRefresh = activeMove ? !hasMultiTruckPlans(activeMove) : false;

      if (
        route.page !== "move" ||
        !activeMove ||
        !logicalLoads.length ||
        isDemoMove ||
        (!needsPlanRefresh && !needsRouteRefresh)
      ) {
        return;
      }

      try {
      const refreshedAvailability = buildFleetAvailability({
          managerFleet,
          moves: managerScopedMoves,
          currentMoveId: activeMove.id,
        });
      const refreshedMove = await buildMoveWithSimulation({
        name: activeMove.name,
        startPoint: activeMove.startPoint,
        endPoint: activeMove.endPoint,
        loadCount: logicalLoads.length,
        logicalLoads,
        truckSetup: activeMove.truckSetup || activeMove.simulation?.truckSetup || DEFAULT_TRUCK_SETUP,
        previousMove: activeMove,
        availability: refreshedAvailability,
        scenarioTruckSetup: refreshedAvailability,
      });

        if (!cancelled) {
          setMoves(await upsertMove(refreshedMove));
        }
      } catch {
        // Keep the existing move if background plan generation fails.
      }
    }

    ensureMovePlans();

    return () => {
      cancelled = true;
    };
  }, [route.page, activeMove?.id, activeMove?.updatedAt, logicalLoads.length, managerFleetSignature, managerScopedMoves.length, truckSpecs.length, startupRequirements.length]);

  useEffect(() => {
    if (!session && (route.page === "dashboard" || route.page === "move")) {
      navigateTo("/login");
    }
  }, [route.page, session]);

  useEffect(() => {
    if (route.page !== "move" || !activeTotalMinutes || !areSceneAssetsReady || isSimulatingMove || !isPlaybackRunning) {
      if (animationFrameRef.current !== null) {
        window.cancelAnimationFrame(animationFrameRef.current);
      }
      animationFrameRef.current = null;
      animationStartedAtRef.current = null;
      return undefined;
    }

    const persistedMinute = Number.isFinite(Number(lastPersistedMinuteRef.current))
      ? Number(lastPersistedMinuteRef.current)
      : Number(activeMove.progressMinute) || 0;
    const startingMinute = Math.min(Math.max(0, persistedMinute), activeTotalMinutes);

    setCurrentMinute(startingMinute);
    lastPersistedMinuteRef.current = startingMinute;
    lastPlaybackUiUpdateRef.current = 0;
    animationStartedAtRef.current = null;

    const animate = (timestamp) => {
      if (animationStartedAtRef.current === null) {
        animationStartedAtRef.current = timestamp;
      }

      const elapsedSeconds = (timestamp - animationStartedAtRef.current) / 1000;
      const effectivePlaybackSpeed = Number(playbackSpeed) || 1;
      const simulatedMinutes =
        startingMinute +
        (elapsedSeconds / 60) * effectivePlaybackSpeed;
      const nextMinute = Math.min(activeTotalMinutes, simulatedMinutes);

      lastPersistedMinuteRef.current = nextMinute;
      if (
        lastPlaybackUiUpdateRef.current === 0 ||
        (timestamp - lastPlaybackUiUpdateRef.current) >= 33 ||
        nextMinute >= activeTotalMinutes
      ) {
        lastPlaybackUiUpdateRef.current = timestamp;
        setCurrentMinute(nextMinute);
      }

      if (nextMinute < activeTotalMinutes) {
        animationFrameRef.current = window.requestAnimationFrame(animate);
      } else {
        animationFrameRef.current = null;
        animationStartedAtRef.current = null;
        lastPersistedMinuteRef.current = 0;
        lastPlaybackUiUpdateRef.current = 0;
        setCurrentMinute(activeTotalMinutes);
        setIsPlaybackRunning(false);
        setIsPlaybackPaused(false);
      }
    };

    animationFrameRef.current = window.requestAnimationFrame(animate);

    return () => {
      if (animationFrameRef.current !== null) {
        window.cancelAnimationFrame(animationFrameRef.current);
      }
      animationFrameRef.current = null;
      animationStartedAtRef.current = null;
      lastPlaybackUiUpdateRef.current = 0;
    };
  }, [activeMove?.id, route.page, playbackSpeed, activeTotalMinutes, areSceneAssetsReady, isSimulatingMove, isPlaybackRunning]);

  async function handleLogin({ email, password }) {
    const matchedUser = await authenticateUser(email, password);
    const nextSession = getSession()?.id === matchedUser.id ? getSession() : matchedUser;
    createSession(nextSession);
    setSession(nextSession);
    navigateTo("/dashboard");
  }

  function handleLogout() {
    clearSession();
    setSession(null);
    navigateTo("/home");
  }

  async function handleCreateMove(formValues) {
    setCreateError("");

    if (!logicalLoads.length) {
      setCreateError("The load dataset is still loading. Try again when the platform is ready.");
      return;
    }

    const availableTruckSetup = (availableFleet || [])
      .map((truck) => ({
        id: truck.id,
        type: truck.type,
        count: Math.max(0, Number.parseInt(truck.available, 10) || 0),
      }))
      .filter((truck) => truck.type && truck.count > 0);

    if (!sumTruckCounts(availableTruckSetup)) {
      setCreateError("No trucks are currently available in the manager fleet for a new rig move.");
      return;
    }

    setIsCreatingMove(true);
    const simulationStartedAt = Date.now();
    setSimulationProgress(
      createSimulationProgressState({
        percent: 1,
        message: "Preparing simulation",
        detail: "Stage 0 of 8. The browser has reserved the planner and is about to start route preparation.",
        startedAt: simulationStartedAt,
        completedStages: 0,
        totalStages: 8,
      }),
    );

    try {
      await yieldForUiPaint();
      const move = await buildMoveWithSimulation({
        name: formValues.name,
        startPoint: formValues.startPoint,
        endPoint: formValues.endPoint,
        startLabel: formValues.startLabel,
        endLabel: formValues.endLabel,
        loadCount: logicalLoads.length,
        logicalLoads,
        truckSetup: availableTruckSetup,
        availability: availableFleet,
        scenarioTruckSetup: availableFleet,
        onProgress: ({
          percent = 0,
          message = "Simulating plan",
          detail = "",
          completedStages = 0,
          totalStages = 8,
        }) => {
          setSimulationProgress(
            createSimulationProgressState({
              percent: Math.max(1, Math.min(99, Math.round(percent))),
              message,
              detail,
              startedAt: simulationStartedAt,
              completedStages,
              totalStages,
            }),
          );
        },
      });

      setAreSceneAssetsReady(true);
      setIsScenePlaybackReady(false);
      const nextMoves = await upsertMove(move);
      setMoves(nextMoves);
      setPlaybackSpeed(move?.createdBy?.isDemo ? NORMAL_PLAYBACK_SPEED : DEFAULT_PLAYBACK_SPEED);
      setIsPlaybackRunning(false);
      setIsPlaybackPaused(false);
      setSimulationProgress(
        createSimulationProgressState({
          percent: 100,
          message: "Simulation complete",
          detail: "Stage 8 of 8. Scenario selection and playback generation finished.",
          startedAt: simulationStartedAt,
          completedStages: 8,
          totalStages: 8,
        }),
      );
      navigateTo(`/move/${move.id}`);
    } catch (error) {
      setCreateError(error.message || "Failed to create the rig move.");
    } finally {
      setIsCreatingMove(false);
      window.setTimeout(
        () => setSimulationProgress(createSimulationProgressState({ percent: 0, message: "" })),
        300,
      );
    }
  }

  async function buildDemoMoveWithSimpleSchedule({
    name,
    startPoint,
    endPoint,
    startLabel: providedStartLabel,
    endLabel: providedEndLabel,
    logicalLoads,
    truckSetup,
    previousMove,
  }) {
    const routeData = (() => fallbackRouteData(startPoint, endPoint))();
    let resolvedRouteData = routeData;
    let routeMode = "estimated";
    let startLabel = providedStartLabel || previousMove?.startLabel || formatCoordinate(startPoint);
    let endLabel = providedEndLabel || previousMove?.endLabel || formatCoordinate(endPoint);

    try {
      resolvedRouteData = await fetchRouteData(startPoint, endPoint);
      routeMode = "live";
    } catch {
      resolvedRouteData = routeData;
    }

    const shouldResolveStartLabel = !startLabel || isCoordinateLabel(startLabel);
    const shouldResolveEndLabel = !endLabel || isCoordinateLabel(endLabel);
    if (shouldResolveStartLabel || shouldResolveEndLabel) {
      try {
        const [nextStartLabel, nextEndLabel] = await Promise.all([
          shouldResolveStartLabel ? fetchLocationLabel(startPoint) : Promise.resolve(null),
          shouldResolveEndLabel ? fetchLocationLabel(endPoint) : Promise.resolve(null),
        ]);
        startLabel = nextStartLabel || startLabel;
        endLabel = nextEndLabel || endLabel;
      } catch {
        // Keep coordinate fallback labels when reverse geocoding is unavailable.
      }
    }

    const normalizedTruckSetup = (truckSetup || [])
      .map((item) => ({
        ...item,
        type: normalizePlannerTruckType(item.type),
        count: Math.max(0, Number.parseInt(item.count, 10) || 0),
        hourlyCost: Math.max(0, Number(item.hourlyCost) || 0),
      }))
      .filter((item) => item.type && item.count > 0);
    const lowBedTruck =
      normalizedTruckSetup.find((truck) => normalizePlannerTruckType(truck.type) === "Low-bed") ||
      normalizedTruckSetup[0] ||
      { id: "demo-low-bed", type: "Low-bed", count: 1, hourlyCost: 95 };
    const demoLoads = (logicalLoads || DEMO_RIG_LOADS).slice(0, 2);
    const playback = buildSimpleDemoPlayback({
      loads: demoLoads,
      routeGeometry: resolvedRouteData.geometry || [],
      startLabel,
      endLabel,
      truckType: lowBedTruck.type || "Low-bed",
      truckId: `${lowBedTruck.id || "demo-low-bed"}-1`,
    });
    const bestPlan = {
      name: "Demo schedule",
      routeMinutes: 4,
      processingMinutes: Math.max(0, playback.totalMinutes - 4),
      totalMinutes: playback.totalMinutes,
      playback,
    };
    const bestScenario = {
      name: "Demo schedule",
      truckCount: 1,
      capacity: 1,
      routeDistanceKm: resolvedRouteData.distanceKm,
      routeMinutes: 4,
      routeSource: resolvedRouteData.source,
      routeGeometry: resolvedRouteData.geometry || [],
      totalMinutes: playback.totalMinutes,
      truckSetup: [lowBedTruck],
      allocatedTruckSetup: [lowBedTruck],
      usedTruckSetup: [{ id: lowBedTruck.id, type: lowBedTruck.type, count: 1, hourlyCost: lowBedTruck.hourlyCost || 95 }],
      allocatedTruckCount: 1,
      utilization: 100,
      truckUtilization: 100,
      idleMinutes: 0,
      costEstimate: Math.round(((lowBedTruck.hourlyCost || 95) * playback.totalMinutes) / 60),
      bestVariant: bestPlan,
    };
    const simulation = {
      startPoint,
      endPoint,
      truckCount: 1,
      truckSetup: [lowBedTruck],
      routeDistanceKm: resolvedRouteData.distanceKm,
      routeMinutes: 4,
      routeSource: resolvedRouteData.source,
      routeGeometry: resolvedRouteData.geometry || [],
      supportRoutes: [],
      preferredScenarioName: bestScenario.name,
      scenarioPlans: [bestScenario],
      bestScenario,
      bestPlan,
    };

    if (!previousMove) {
      return createMoveRecord({
        name,
        startPoint,
        endPoint,
        startLabel,
        endLabel,
        routeMode,
        loadCount: demoLoads.length,
        simulation,
        createdBy: session
          ? {
              id: session.id,
              name: session.name,
              role: session.role,
              managerId: session.managerId || null,
              isDemo: Boolean(session.isDemo),
            }
          : null,
      });
    }

    return {
      ...previousMove,
      name,
      updatedAt: new Date().toISOString(),
      routeMode,
      loadCount: demoLoads.length,
      startLabel,
      endLabel,
      truckSetup: [lowBedTruck],
      routeKm: resolvedRouteData.distanceKm,
      eta: formatMinutes(bestPlan.totalMinutes),
      routeTime: formatMinutes(4),
      progressMinute: previousMove.progressMinute || 0,
      completionPercentage: previousMove.completionPercentage || 0,
      playbackSpeed: previousMove.playbackSpeed || NORMAL_PLAYBACK_SPEED,
      planningStartDate: previousMove.planningStartDate || new Date().toISOString().slice(0, 10),
      planningStartTime: previousMove.planningStartTime || "06:00",
      simulation,
    };
  }

  async function buildMoveWithSimulation({ name, startPoint, endPoint, startLabel: providedStartLabel, endLabel: providedEndLabel, loadCount, logicalLoads, truckSetup, previousMove, availability = [], scenarioTruckSetup = null, enforceExactFleet = false, onProgress = null }) {
    if (isDemoSession(session)) {
      onProgress?.({
        percent: 20,
        message: "Preparing demo schedule",
        detail: "Stage 1 of 2. Building the fixed two-load demo plan.",
        completedStages: 1,
        totalStages: 2,
      });
      const demoMove = await buildDemoMoveWithSimpleSchedule({
        name,
        startPoint,
        endPoint,
        startLabel: providedStartLabel,
        endLabel: providedEndLabel,
        logicalLoads,
        truckSetup,
        previousMove,
      });
      onProgress?.({
        percent: 100,
        message: "Demo schedule ready",
        detail: "Stage 2 of 2. The demo move was created without the production planner.",
        completedStages: 2,
        totalStages: 2,
      });
      return demoMove;
    }

    const availabilityByType = new Map(
      (availability || []).map((item) => [String(item.type || "").trim().toLowerCase(), item]),
    );
    const sanitizedTruckSetup = truckSetup
      .map((item) => ({
        ...item,
        type: normalizePlannerTruckType(item.type),
        count: Math.max(0, Number.parseInt(item.count, 10) || 0),
        hourlyCost: Math.max(
          0,
          Number(
            item.hourlyCost ??
              availabilityByType.get(String(item.type || "").trim().toLowerCase())?.hourlyCost,
          ) || 0,
        ),
      }))
      .filter((item) => item.type && item.count > 0);
    const availabilityError = getAvailabilityValidationError(sanitizedTruckSetup, availability);
    if (availabilityError) {
      throw new Error(availabilityError);
    }
    const requestedTruckCount = sanitizedTruckSetup.reduce((sum, item) => sum + item.count, 0);
    if (requestedTruckCount < 1) {
      throw new Error("Add at least one truck before running the simulation.");
    }
    const truckCount = requestedTruckCount;
    const planningCrewBaseline = 4;

    let routeData = fallbackRouteData(startPoint, endPoint);
    let routeMode = "estimated";
    let startLabel = providedStartLabel || previousMove?.startLabel || formatCoordinate(startPoint);
    let endLabel = providedEndLabel || previousMove?.endLabel || formatCoordinate(endPoint);

    onProgress?.({
      percent: 2,
      message: "Resolving route",
      detail: "Stage 1 of 8. Calculating the primary route between the current rig and the destination.",
      completedStages: 1,
      totalStages: 8,
    });
    try {
      routeData = await fetchRouteData(startPoint, endPoint);
      routeMode = "live";
    } catch {
      routeMode = "estimated";
    }

    onProgress?.({
      percent: 8,
      message: "Preparing locations",
      detail: "Stage 2 of 8. Resolving human-readable labels for the source and destination.",
      completedStages: 2,
      totalStages: 8,
    });
    const shouldResolveStartLabel = !startLabel || isCoordinateLabel(startLabel);
    const shouldResolveEndLabel = !endLabel || isCoordinateLabel(endLabel);
    if (shouldResolveStartLabel || shouldResolveEndLabel) {
      try {
        const [nextStartLabel, nextEndLabel] = await Promise.all([
          shouldResolveStartLabel ? fetchLocationLabel(startPoint) : Promise.resolve(null),
          shouldResolveEndLabel ? fetchLocationLabel(endPoint) : Promise.resolve(null),
        ]);
        startLabel = nextStartLabel || startLabel;
        endLabel = nextEndLabel || endLabel;
      } catch {
        // Keep coordinate fallback labels when reverse geocoding is unavailable.
      }
    }

    onProgress?.({
      percent: 14,
      message: "Building startup loads",
      detail: "Stage 3 of 8. Expanding startup and reusable support loads for this move.",
      completedStages: 3,
      totalStages: 8,
    });
    const moveContext =
      previousMove ||
      {
        name,
        startPoint,
        endPoint,
        createdBy: session
          ? {
              id: session.id,
              name: session.name,
              role: session.role,
              managerId: session.managerId || null,
              isDemo: Boolean(session.isDemo),
            }
          : null,
      };
    const operatingSnapshot = buildOperatingSnapshot({
      move: moveContext,
      teamMoves: managerScopedMoves,
      logicalLoads,
      startupRequirements,
    });
    onProgress?.({
      percent: 22,
      message: "Preparing support routes",
      detail: "Stage 4 of 8. Calculating routes from support yards and transfer origins to destination.",
      completedStages: 4,
      totalStages: 8,
    });
    const supportRoutes = await Promise.all(
      buildStartupTransferSchedule(operatingSnapshot.startupLoads, endLabel).map(async (route) => {
        let supportRouteData = fallbackRouteData(route.sourcePoint, endPoint);

        try {
          supportRouteData = await fetchRouteData(route.sourcePoint, endPoint);
        } catch {
          supportRouteData = fallbackRouteData(route.sourcePoint, endPoint);
        }

        return {
          ...route,
          geometry: supportRouteData.geometry,
          routeSource: supportRouteData.source,
          routeMinutes: supportRouteData.minutes,
          routeDistanceKm: supportRouteData.distanceKm,
        };
      }),
    );
    onProgress?.({
      percent: 30,
      message: "Preparing pickup routes",
      detail: "Stage 5 of 8. Calculating pickup travel from the rig to each support source.",
      completedStages: 5,
      totalStages: 8,
    });
    const supportRoutesWithPickup = await Promise.all(
      supportRoutes.map(async (route) => {
        let pickupRouteData = fallbackRouteData(startPoint, route.sourcePoint);

        try {
          pickupRouteData = await fetchRouteData(startPoint, route.sourcePoint);
        } catch {
          pickupRouteData = fallbackRouteData(startPoint, route.sourcePoint);
        }

        return {
          ...route,
          pickupGeometry: pickupRouteData.geometry,
          pickupRouteSource: pickupRouteData.source,
          pickupRouteMinutes: pickupRouteData.minutes,
          pickupRouteDistanceKm: pickupRouteData.distanceKm,
        };
      }),
    );
    onProgress?.({
      percent: 38,
      message: "Preparing scenarios",
      detail: "Stage 6 of 8. Building feasible truck scenarios.",
      completedStages: 6,
      totalStages: 8,
    });
    const planningLoads = [
      ...(logicalLoads || []),
      ...buildLogicalLoads(startupRequirements || []).map((load) => ({
        ...load,
        source_kind: "startup",
      })),
    ];
    const normalizedScenarioTruckSetup = (scenarioTruckSetup || sanitizedTruckSetup)
      .map((item) => ({
        ...item,
        type: normalizePlannerTruckType(item.type),
        count: Math.max(0, Number.parseInt(item.count ?? item.available, 10) || 0),
        hourlyCost: Math.max(0, Number(item.hourlyCost) || 0),
      }))
      .filter((item) => item.type && item.count > 0);
    const missingTruckCoverage = getMissingTruckCoverage(planningLoads, normalizedScenarioTruckSetup);
    if (missingTruckCoverage) {
      throw new Error(
        `Selected truck setup cannot serve ${missingTruckCoverage.loadCode}. Required: ${missingTruckCoverage.requiredTypes.join(" / ")}. Current setup: ${
          normalizedScenarioTruckSetup.map((truck) => `${truck.type} x${truck.count}`).join(", ") || "None"
        }.`,
      );
    }
    const scenarioPlans = await buildScenarioPlans(planningLoads, routeData, planningCrewBaseline, truckCount, normalizedScenarioTruckSetup, truckSpecs, {
      dayShift: planningCrewBaseline,
      nightShift: planningCrewBaseline,
      roles: {},
      averageHourlyCost: 0,
      startHour: Number.parseInt((previousMove?.planningStartTime || "06:00").split(":")[0], 10) || 6,
      startMinute: Number.parseInt((previousMove?.planningStartTime || "06:00").split(":")[1], 10) || 0,
      enforceExactFleet,
    }, {
      onProgress,
    });
    const bestScenario = scenarioPlans.reduce(
      (best, plan) => (!best || plan.totalMinutes < best.totalMinutes ? plan : best),
      null,
    );
    const bestPlan = bestScenario?.bestVariant || null;

    if (!bestPlan) {
      const failureSummary = summarizeScenarioFailures(scenarioPlans);
      throw new Error(
        failureSummary
          ? `No valid simulation plan could be generated for this rig move. ${failureSummary}`
          : "No valid simulation plan could be generated for this rig move.",
      );
    }

    const simulation = {
      startPoint,
      endPoint,
      truckCount: bestScenario.truckCount,
      truckSetup: sanitizedTruckSetup,
      routeDistanceKm: routeData.distanceKm,
      routeMinutes: routeData.minutes,
      routeSource: routeData.source,
      routeGeometry: routeData.geometry,
      supportRoutes: supportRoutesWithPickup,
      preferredScenarioName: bestScenario.name,
      scenarioPlans,
      bestScenario,
      bestPlan,
    };

    if (!previousMove) {
      return createMoveRecord({
        name,
        startPoint,
        endPoint,
        startLabel,
        endLabel,
        routeMode,
        loadCount: planningLoads.length,
        simulation,
        createdBy: session
          ? {
              id: session.id,
              name: session.name,
              role: session.role,
              managerId: session.managerId || null,
              isDemo: Boolean(session.isDemo),
            }
          : null,
      });
    }

    return {
      ...previousMove,
      name,
      updatedAt: new Date().toISOString(),
      routeMode,
      loadCount: planningLoads.length,
      startLabel,
      endLabel,
      truckSetup: sanitizedTruckSetup,
      routeKm: routeData.distanceKm,
      eta: formatMinutes(bestPlan.totalMinutes),
      routeTime: formatMinutes(routeData.minutes),
      progressMinute: previousMove.progressMinute || 0,
      completionPercentage: previousMove.completionPercentage || 0,
      playbackSpeed: previousMove.playbackSpeed || DEFAULT_PLAYBACK_SPEED,
      planningStartDate: previousMove.planningStartDate || new Date().toISOString().slice(0, 10),
      planningStartTime: previousMove.planningStartTime || "06:00",
      simulation,
    };
  }

  async function handleRunMoveSimulation({ moveId, truckSetup, enforceExactFleet = false }) {
    setMoveSimulationError("");

    if (!logicalLoads.length) {
      setMoveSimulationError("The load dataset is still loading. Try again in a moment.");
      return;
    }

    const targetMove = visibleMoves.find((move) => move.id === moveId);
    if (!targetMove) {
      setMoveSimulationError("The selected move could not be found.");
      return;
    }

    const moveAvailability = buildFleetAvailability({
      managerFleet,
      moves: managerScopedMoves,
      currentMoveId: moveId,
    });

    const simulationStartedAt = Date.now();
    setIsSimulatingMove(true);
    setSimulationProgress(
      createSimulationProgressState({
        percent: 1,
        message: "Preparing simulation",
        detail: "Stage 0 of 8. The browser has reserved the planner and is about to start route preparation.",
        startedAt: simulationStartedAt,
        completedStages: 0,
        totalStages: 8,
      }),
    );

    try {
      await yieldForUiPaint();
      setAreSceneAssetsReady(true);
      setIsScenePlaybackReady(false);
      if (animationFrameRef.current !== null) {
        window.cancelAnimationFrame(animationFrameRef.current);
      }
      animationFrameRef.current = null;
      animationStartedAtRef.current = null;
      lastPlaybackUiUpdateRef.current = 0;
      lastPersistedMinuteRef.current = 0;
      setCurrentMinute(0);
      setIsPlaybackRunning(false);
      setIsPlaybackPaused(false);

      const updatedMove = await buildMoveWithSimulation({
        name: targetMove.name,
        startPoint: targetMove.startPoint,
        endPoint: targetMove.endPoint,
        loadCount: logicalLoads.length,
        logicalLoads,
        truckSetup,
        previousMove: targetMove,
        availability: moveAvailability,
        scenarioTruckSetup: moveAvailability,
        enforceExactFleet,
        onProgress: ({
          percent = 0,
          message = "Simulating plan",
          detail = "",
          completedStages = 0,
          totalStages = 8,
        }) => {
          setSimulationProgress(
            createSimulationProgressState({
              percent: Math.max(1, Math.min(99, Math.round(percent))),
              message,
              detail,
              startedAt: simulationStartedAt,
              completedStages,
              totalStages,
            }),
          );
        },
      });
      const nextMoves = await upsertMove({
        ...updatedMove,
        progressMinute: 0,
        completionPercentage: 0,
      });
      setMoves(nextMoves);
      setCurrentMinute(0);
      lastPersistedMinuteRef.current = 0;
      lastPlaybackUiUpdateRef.current = 0;
      setPlaybackSpeed(updatedMove?.createdBy?.isDemo ? NORMAL_PLAYBACK_SPEED : DEFAULT_PLAYBACK_SPEED);
      setIsPlaybackRunning(false);
      setIsPlaybackPaused(false);
      setSimulationProgress(
        createSimulationProgressState({
          percent: 100,
          message: "Simulation complete",
          detail: "Stage 8 of 8. Scenario selection and playback generation finished.",
          startedAt: simulationStartedAt,
          completedStages: 8,
          totalStages: 8,
        }),
      );
      return true;
    } catch (error) {
      setMoveSimulationError(error.message || "Failed to start the execution plan.");
      return false;
    } finally {
      setIsSimulatingMove(false);
      window.setTimeout(
        () => setSimulationProgress(createSimulationProgressState({ percent: 0, message: "" })),
        300,
      );
    }
  }

  async function handleOpenMove(moveId) {
    setAreSceneAssetsReady(true);
    setIsScenePlaybackReady(false);
    setIsPlaybackRunning(false);
    lastPersistedMinuteRef.current = 0;
    lastPlaybackUiUpdateRef.current = 0;
    setCurrentMinute(0);
    setIsPlaybackPaused(false);
    navigateTo(`/move/${moveId}`);
  }

  async function handleSelectMovePlan({ moveId, scenarioName }) {
    const targetMove = visibleMoves.find((move) => move.id === moveId);
    if (!targetMove?.simulation?.scenarioPlans?.length) {
      return;
    }

    const selectedScenario = targetMove.simulation.scenarioPlans.find((scenario) => scenario.name === scenarioName);
    if (!selectedScenario || targetMove.simulation.preferredScenarioName === scenarioName) {
      return;
    }

    const updatedMove = {
      ...targetMove,
      updatedAt: new Date().toISOString(),
      progressMinute: 0,
      completionPercentage: 0,
      truckSetup: selectedScenario.allocatedTruckSetup || selectedScenario.truckSetup || targetMove.truckSetup,
      simulation: {
        ...targetMove.simulation,
        preferredScenarioName: scenarioName,
        bestScenario: selectedScenario,
        bestPlan: selectedScenario.bestVariant || targetMove.simulation.bestPlan,
      },
    };

    const nextMoves = await upsertMove(updatedMove);
    setMoves(nextMoves);
    lastPersistedMinuteRef.current = 0;
    lastPlaybackUiUpdateRef.current = 0;
    setCurrentMinute(0);
    setIsPlaybackRunning(false);
    setIsPlaybackPaused(false);
  }

  async function handleDeleteMove(moveId) {
    const targetMove = visibleMoves.find((move) => move.id === moveId);
    if (!targetMove) {
      return;
    }

    if (managerId) {
      await handleSaveManagerResources({
        ...(managerResources || {}),
        taskAssignments: (managerResources?.taskAssignments || []).filter((assignment) => assignment.moveId !== moveId),
      });
    }

    navigateTo("/dashboard");
    const nextMoves = await removeMove(moveId);
    setMoves(nextMoves);
  }

  function updateMoveExecutionState(moveId, executionState, extra = {}) {
    const targetMove = readMoves().find((move) => move.id === moveId);
    if (!targetMove) {
      return null;
    }

    const nowIso = new Date().toISOString();
    const updatedMove = {
      ...targetMove,
      ...extra,
      updatedAt: nowIso,
      executionState,
      executionStartedAt:
        executionState === "active"
          ? extra.executionStartedAt || targetMove.executionStartedAt || nowIso
          : targetMove.executionStartedAt || extra.executionStartedAt || null,
      executionCompletedAt:
        executionState === "completed"
          ? extra.executionCompletedAt || nowIso
          : extra.executionCompletedAt || targetMove.executionCompletedAt || null,
      operatingState:
        extra.operatingState ||
        (executionState === "completed"
          ? "drilling"
          : targetMove.operatingState || "standby"),
    };

    setMoves((current) =>
      current.map((move) => (move.id === moveId ? updatedMove : move)),
    );
    void upsertMove(updatedMove)
      .then((nextMoves) => {
        setMoves(nextMoves);
      })
      .catch(() => {});
    return updatedMove;
  }

  function updateMoveExecutionProgress(moveId, patch) {
    const targetMove = readMoves().find((move) => move.id === moveId);
    if (!targetMove) {
      return null;
    }

    const executionProgress = {
      ...(targetMove.executionProgress || {}),
      ...patch,
    };

    const nextState = executionProgress.rigUpCompleted
      ? "completed"
      : targetMove.executionState || "planning";

    const updatedMove = {
      ...targetMove,
      updatedAt: new Date().toISOString(),
      executionState: nextState,
      operatingState: executionProgress.rigUpCompleted ? "drilling" : targetMove.operatingState || "standby",
      executionProgress,
      completionPercentage:
        executionProgress.rigUpCompleted
          ? 100
          : Number.isFinite(Number(patch?.completionPercentage))
            ? Math.max(0, Math.min(100, Number(patch.completionPercentage)))
            : targetMove.completionPercentage,
      progressMinute: executionProgress.rigUpCompleted
        ? targetMove?.simulation?.bestPlan?.totalMinutes || targetMove.progressMinute
        : Number.isFinite(Number(patch?.progressMinute))
          ? Math.max(0, Number(patch.progressMinute))
          : targetMove.progressMinute,
    };

    setMoves((current) =>
      current.map((move) => (move.id === moveId ? updatedMove : move)),
    );
    void upsertMove(updatedMove)
      .then((nextMoves) => {
        setMoves(nextMoves);
      })
      .catch(() => {});
    return updatedMove;
  }

  async function handleDriverMoveAction({ assignmentId, action }) {
    if (!managerId || !session?.id || session.role !== "Driver") {
      return;
    }

    const targetAssignment = (managerResources?.taskAssignments || []).find((assignment) => {
      if (assignment.id !== assignmentId) {
        return false;
      }

      const allowedDriverIds = new Set(
        [
          session.id,
          ...(managerResources?.drivers || [])
            .filter((driver) => String(driver.email || "").trim().toLowerCase() === String(session.email || "").trim().toLowerCase())
            .map((driver) => driver.id),
        ].filter(Boolean),
      );
      return allowedDriverIds.has(assignment.driverId);
    });
    if (!targetAssignment) {
      return;
    }

    const driverMoveState = getDriverMoveState(targetAssignment);
    const isReturnTask = targetAssignment.taskType === "return";
    const targetMove = moves.find((move) => String(move?.id) === String(targetAssignment.moveId)) || null;
    const sensorProgress = getAssignmentSensorProgress(targetMove, targetAssignment);
    const startDistanceCm = Math.max(0, Number(targetMove?.executionProgress?.ultrasonicStartCm) || 45);
    const arrivalDistanceCm = Math.min(startDistanceCm, Math.max(0, Number(targetMove?.executionProgress?.ultrasonicArrivalCm) || 8));
    if (
      targetAssignment.status !== "active" ||
      driverMoveState === "returned" ||
      (!isReturnTask && !targetAssignment.stageStatus?.rigDownCompleted)
    ) {
      return;
    }

    if (
      action === "arrived" &&
      sensorProgress.enabled &&
      ((sensorProgress.progressPercent ?? -1) < 100)
    ) {
      return;
    }

    const timestamp = new Date().toISOString();
    let shouldCreateReturnAssignment = false;
    const nextTaskAssignments = (managerResources?.taskAssignments || []).map((assignment) => {
      if (assignment.id !== assignmentId) {
        return assignment;
      }

      const nextDriverMoveState = getDriverMoveState(assignment);

      if (action === "startMove") {
        if (nextDriverMoveState !== "readyOutbound") {
          return assignment;
        }
        return {
          ...assignment,
          moveStartedAt: assignment.moveStartedAt || timestamp,
          updatedAt: timestamp,
        };
      }

      if (action === "startReturn") {
        const canStartReturn =
          (assignment.taskType === "return" && nextDriverMoveState === "readyOutbound") ||
          (assignment.taskType !== "return" && nextDriverMoveState === "readyReturn");
        if (!canStartReturn) {
          return assignment;
        }
        return {
          ...assignment,
          ...(assignment.taskType === "return"
            ? { moveStartedAt: assignment.moveStartedAt || timestamp }
            : { returnMoveStartedAt: assignment.returnMoveStartedAt || timestamp }),
          updatedAt: timestamp,
        };
      }

      if (action === "arrived") {
        if (nextDriverMoveState === "movingOutbound") {
          if (assignment.taskType === "return") {
            return {
              ...assignment,
              stageStatus: {
                ...(assignment.stageStatus || {}),
                rigMoveCompleted: true,
              },
              stageCompletedAt: {
                rigDown: assignment.stageCompletedAt?.rigDown || null,
                rigMove: assignment.stageCompletedAt?.rigMove || timestamp,
                rigUp: assignment.stageCompletedAt?.rigUp || timestamp,
              },
              outboundArrivedAt: assignment.outboundArrivedAt || timestamp,
              returnedToSourceAt: assignment.returnedToSourceAt || timestamp,
              currentStage: "completed",
              status: "completed",
              updatedAt: timestamp,
            };
          }

          if (assignment.taskType !== "return") {
            shouldCreateReturnAssignment = true;
          }
          return {
            ...assignment,
            stageStatus: {
              ...(assignment.stageStatus || {}),
              rigMoveCompleted: true,
            },
            stageCompletedAt: {
              rigDown: assignment.stageCompletedAt?.rigDown || null,
              rigMove: assignment.stageCompletedAt?.rigMove || timestamp,
              rigUp: assignment.stageCompletedAt?.rigUp || null,
            },
            outboundArrivedAt: assignment.outboundArrivedAt || timestamp,
            currentStage: "rigUp",
            status: "foreman",
            updatedAt: timestamp,
          };
        }

        if (nextDriverMoveState !== "movingReturn") {
          return assignment;
        }

        return {
          ...assignment,
          stageStatus: {
            ...(assignment.stageStatus || {}),
            rigMoveCompleted: true,
          },
          stageCompletedAt: {
            rigDown: assignment.stageCompletedAt?.rigDown || null,
            rigMove: assignment.stageCompletedAt?.rigMove || timestamp,
            rigUp: assignment.stageCompletedAt?.rigUp || null,
          },
          moveStartedAt: assignment.moveStartedAt || timestamp,
          outboundArrivedAt: assignment.outboundArrivedAt || assignment.moveStartedAt || timestamp,
          returnMoveStartedAt: assignment.returnMoveStartedAt || timestamp,
          returnedToSourceAt: assignment.returnMoveStartedAt ? (assignment.returnedToSourceAt || timestamp) : timestamp,
          currentStage: "completed",
          status: "completed",
          updatedAt: timestamp,
        };
      }

      return assignment;
    });

    if (shouldCreateReturnAssignment) {
      const hasExistingReturnTask = nextTaskAssignments.some((assignment) => assignment.returnForAssignmentId === assignmentId);
      const originalAssignment = nextTaskAssignments.find((assignment) => assignment.id === assignmentId);
      if (!hasExistingReturnTask && originalAssignment) {
        nextTaskAssignments.push(createReturnAssignmentFromLoad(originalAssignment, timestamp));
      }
    }

    if (action === "arrived") {
      const completedAssignment = nextTaskAssignments.find((assignment) => assignment.id === assignmentId);
      if (completedAssignment?.status === "completed" && completedAssignment?.taskType === "return") {
        const nextQueuedAssignment = nextTaskAssignments
          .filter(
            (assignment) =>
              assignment.taskType !== "return" &&
              assignment.moveId === completedAssignment.moveId &&
              assignment.status === "queued",
          )
          .sort((left, right) => left.sequence - right.sequence)[0];

        if (nextQueuedAssignment) {
          for (let index = 0; index < nextTaskAssignments.length; index += 1) {
            if (nextTaskAssignments[index].id === nextQueuedAssignment.id) {
              nextTaskAssignments[index] = {
                ...nextQueuedAssignment,
                status: "foreman",
                updatedAt: new Date().toISOString(),
              };
              break;
            }
          }
        }
      }
    }

    await handleSaveManagerResources({
      ...managerResources,
      taskAssignments: nextTaskAssignments,
    });

    if (action === "startMove" || action === "startReturn") {
      updateMoveExecutionProgress(targetAssignment.moveId, {
        ultrasonicLatestCm: startDistanceCm,
        ultrasonicLastUpdatedAt: timestamp,
      });
    }

    if (action === "arrived") {
      updateMoveExecutionProgress(targetAssignment.moveId, {
        ultrasonicLatestCm: arrivalDistanceCm,
        ultrasonicLastUpdatedAt: timestamp,
      });
    }

    if (action === "arrived") {
      const moveAssignments = nextTaskAssignments.filter((assignment) => assignment.moveId === targetAssignment.moveId && assignment.taskType !== "return");
      const patch = {};
      if (moveAssignments.length && moveAssignments.every((assignment) => assignment.stageStatus?.rigMoveCompleted)) {
        patch.rigMoveCompleted = true;
      }
      if (Object.keys(patch).length) {
        updateMoveExecutionProgress(targetAssignment.moveId, patch);
      }
    }
  }

  async function handleDriverStageComplete({ assignmentId, stage, delayReason = "" }) {
    if (!managerId || !session?.id) {
      return;
    }

    const targetAssignment = (managerResources?.taskAssignments || []).find((assignment) => {
      if (assignment.id !== assignmentId) {
        return false;
      }

      if (session.role !== "Driver") {
        return true;
      }

      const allowedDriverIds = new Set(
        [
          session.id,
          ...(managerResources?.drivers || [])
            .filter((driver) => String(driver.email || "").trim().toLowerCase() === String(session.email || "").trim().toLowerCase())
            .map((driver) => driver.id),
        ].filter(Boolean),
      );
      return allowedDriverIds.has(assignment.driverId);
    });
    if (!targetAssignment) {
      return;
    }

    if (session.role === "Driver" && stage !== "rigMove") {
      return;
    }
    if (session.role !== "Driver" && stage === "rigMove") {
      return;
    }

    const currentStage = getAssignmentStageLabel(targetAssignment.stageStatus || {});
    if (currentStage === "completed" || currentStage !== stage) {
      return;
    }

    const projectedLateMinutes = getStageDelayMinutes({
      assignment: targetAssignment,
      stage,
    });
    const delayThresholdMinutes = getAssignmentDelayThresholdMinutes(targetAssignment);
    if (projectedLateMinutes > delayThresholdMinutes && !String(delayReason || "").trim()) {
      return;
    }

    const completionStamp = new Date().toISOString();
    const nextTaskAssignments = (managerResources?.taskAssignments || []).map((assignment) => {
      if (assignment.id !== assignmentId) {
        return assignment;
      }

      const completedAt = completionStamp;
      const lateMinutes = getStageDelayMinutes({
        assignment,
        stage,
        completedAt,
      });
      const nextStageStatus = {
        ...(assignment.stageStatus || {}),
        ...(stage === "rigDown" ? { rigDownCompleted: true } : null),
        ...(stage === "rigMove" ? { rigMoveCompleted: true } : null),
        ...(stage === "rigUp" ? { rigUpCompleted: true } : null),
      };
      const nextStage = getAssignmentStageLabel(nextStageStatus);

      return {
        ...assignment,
        stageStatus: nextStageStatus,
        stageCompletedAt: {
          rigDown: assignment.stageCompletedAt?.rigDown || (stage === "rigDown" ? completedAt : null),
          rigMove: assignment.stageCompletedAt?.rigMove || (stage === "rigMove" ? completedAt : null),
          rigUp: assignment.stageCompletedAt?.rigUp || (stage === "rigUp" ? completedAt : null),
        },
        stageDelayNotes: {
          ...(assignment.stageDelayNotes || {}),
          ...(lateMinutes > delayThresholdMinutes
            ? {
                [stage]: {
                  reason: String(delayReason || "").trim(),
                  lateMinutes,
                  notedAt: completedAt,
                },
              }
            : {}),
        },
        currentStage: nextStage,
        status: nextStage === "completed" ? "completed" : "active",
        updatedAt: completedAt,
      };
    });

      const completedAssignment = nextTaskAssignments.find((assignment) => assignment.id === assignmentId);
      if (completedAssignment?.status === "completed") {
        const nextQueuedAssignment = nextTaskAssignments
          .filter(
            (assignment) =>
              assignment.taskType !== "return" &&
              assignment.moveId === completedAssignment.moveId &&
              assignment.status === "queued",
          )
        .sort((left, right) => left.sequence - right.sequence)[0];

      if (nextQueuedAssignment) {
        for (let index = 0; index < nextTaskAssignments.length; index += 1) {
          if (nextTaskAssignments[index].id === nextQueuedAssignment.id) {
            nextTaskAssignments[index] = {
              ...nextQueuedAssignment,
              status: "foreman",
              updatedAt: new Date().toISOString(),
            };
            break;
          }
        }
      }
    }

    await handleSaveManagerResources({
      ...managerResources,
      taskAssignments: nextTaskAssignments,
    });

    const moveAssignments = nextTaskAssignments.filter((assignment) => assignment.moveId === targetAssignment.moveId);
    const patch = {};
    if (moveAssignments.length && moveAssignments.every((assignment) => assignment.stageStatus?.rigDownCompleted)) {
      patch.rigDownCompleted = true;
    }
    if (moveAssignments.length && moveAssignments.every((assignment) => assignment.stageStatus?.rigMoveCompleted)) {
      patch.rigMoveCompleted = true;
    }
    if (moveAssignments.length && moveAssignments.every((assignment) => assignment.stageStatus?.rigUpCompleted)) {
      patch.rigDownCompleted = true;
      patch.rigMoveCompleted = true;
      patch.rigUpCompleted = true;
      patch.executionCompletedAt = new Date().toISOString();
    }

    if (Object.keys(patch).length) {
      updateMoveExecutionProgress(targetAssignment.moveId, patch);
    }
  }

  async function handleSaveManagerFleet(nextFleet) {
    if (!managerId) {
      return;
    }

    const savedFleet = await writeManagerFleet(managerId, nextFleet);
    setManagerFleet(savedFleet);
    setManagerResources((current) => ({
      ...current,
      fleet: savedFleet,
    }));
  }

  async function handleSaveManagerResources(nextResources) {
    if (!managerId) {
      return;
    }

    const savedResources = await writeManagerResources(managerId, nextResources);
    setManagerResources(savedResources);
    setManagerFleet(savedResources.fleet || []);
  }

  async function handleCreateManagerDriverAccount(driverPayload) {
    if (!managerId) {
      return null;
    }

    const createdDriver = await createDriverAccount({
      ...driverPayload,
      managerId,
    });

    const savedResources = await writeManagerResources(managerId, {
      ...(managerResources || {}),
      drivers: [...(managerResources?.drivers || []), createdDriver],
    });
    setManagerResources(savedResources);
    setManagerFleet(savedResources.fleet || []);
    return createdDriver;
  }

  async function handleCreateManagerForemanAccount(foremanPayload) {
    if (!managerId) {
      return null;
    }

    const createdForeman = await createForemanAccount({
      ...foremanPayload,
      managerId,
    });

    setManagedForemen((current) => {
      if (current.some((foreman) => foreman.id === createdForeman.id)) {
        return current;
      }
      return [...current, createdForeman];
    });

    return createdForeman;
  }

  async function handleSaveRigInventory(rigId, adjustments) {
    if (!rigId) {
      return;
    }

    await writeRigInventoryAdjustments(rigId, adjustments);
    setRigInventoryRevision((value) => value + 1);
  }

  function handleRunSelectedPlan() {
    if (animationFrameRef.current !== null) {
      window.cancelAnimationFrame(animationFrameRef.current);
    }
    animationFrameRef.current = null;
    lastPersistedMinuteRef.current = 0;
    lastPlaybackUiUpdateRef.current = 0;
    setCurrentMinute(0);
    setIsPlaybackRunning(false);
    setIsPlaybackPaused(false);
    animationStartedAtRef.current = null;
    setSceneFocusResetKey((value) => value + 1);
    window.requestAnimationFrame(() => {
      setIsPlaybackRunning(true);
    });
  }

  async function handleRunCustomPlan({ moveId, truckSetup }) {
    const didUpdateMove = await handleRunMoveSimulation({
      moveId,
      truckSetup,
      enforceExactFleet: true,
    });
    if (!didUpdateMove) {
      return;
    }

    if (animationFrameRef.current !== null) {
      window.cancelAnimationFrame(animationFrameRef.current);
    }
    animationFrameRef.current = null;
    lastPersistedMinuteRef.current = 0;
    lastPlaybackUiUpdateRef.current = 0;
    setCurrentMinute(0);
    animationStartedAtRef.current = null;
    setIsPlaybackPaused(false);
    setSceneFocusResetKey((value) => value + 1);
    window.requestAnimationFrame(() => {
      setIsPlaybackRunning(true);
    });
  }

  function handlePauseTogglePlayback() {
    if (isPlaybackRunning) {
      setIsPlaybackRunning(false);
      setIsPlaybackPaused(true);
      return;
    }

    animationStartedAtRef.current = null;
    setIsPlaybackRunning(true);
    setIsPlaybackPaused(false);
  }

  function handleEndPlayback() {
    if (animationFrameRef.current !== null) {
      window.cancelAnimationFrame(animationFrameRef.current);
    }
    animationFrameRef.current = null;
    animationStartedAtRef.current = null;
    lastPersistedMinuteRef.current = 0;
    lastPlaybackUiUpdateRef.current = 0;
    setCurrentMinute(0);
    setIsPlaybackRunning(false);
    setIsPlaybackPaused(false);
    setSceneFocusResetKey((value) => value + 1);
  }

  async function handleStartExecution(moveId, options = {}) {
    const moveToAssign = readMoves().find((move) => move.id === moveId);
    if (!moveToAssign) {
      return;
    }

    const trackingMode = options?.trackingMode === "demoUltrasonic" ? "demoUltrasonic" : "driverApp";
    const ultrasonicStartCm = Math.max(0, Number(options?.ultrasonicStartCm) || 45);
    const ultrasonicArrivalCm = Math.max(0, Number(options?.ultrasonicArrivalCm) || 8);
    const ultrasonicLatestCm = trackingMode === "demoUltrasonic" ? ultrasonicStartCm : null;

    const nextAssignments = buildDriverAssignmentsForMove({
      move: moveToAssign,
      managerResources,
    });

    await handleSaveManagerResources({
      ...managerResources,
      taskAssignments: [
        ...(managerResources?.taskAssignments || []).filter((assignment) => assignment.moveId !== moveId),
        ...nextAssignments,
      ],
    });

    const updatedMove = updateMoveExecutionState(moveId, "active", {
      operatingState: "standby",
      executionStartedAt: new Date().toISOString(),
      executionCompletedAt: null,
      executionProgress: {
        managerNotified: true,
        trucksReserved: true,
        liveDataRequested: trackingMode === "driverApp",
        rigDownCompleted: false,
        rigMoveCompleted: false,
        rigUpCompleted: false,
        trackingMode,
        ultrasonicStartCm,
        ultrasonicArrivalCm,
        ultrasonicLatestCm,
        ultrasonicLastUpdatedAt: trackingMode === "demoUltrasonic" ? new Date().toISOString() : null,
      },
    });

    if (!updatedMove) {
      return;
    }

    setIsPlaybackRunning(false);
    setIsPlaybackPaused(false);
    setCurrentMinute(0);
    lastPersistedMinuteRef.current = 0;
    lastPlaybackUiUpdateRef.current = 0;
  }

  if (route.page === "login") {
    return h(LoginPage, {
      isAuthenticated: Boolean(session),
      onLogin: handleLogin,
      onBackHome: () => navigateTo("/home"),
      language,
      onToggleLanguage: handleToggleLanguage,
    });
  }

  if (route.page === "dashboard" && session) {
    if (!areMovesHydrated) {
      return h(
        AppLayout,
        {
          title: "Loading dashboard",
          subtitle: formatDate(new Date()),
          currentUser: session,
          onLogout: handleLogout,
          language,
          onToggleLanguage: handleToggleLanguage,
          fullBleed: true,
        },
        h(
          "div",
          { className: "workspace-grid dashboard-grid" },
          h(
            "section",
            { className: "dashboard-column dashboard-column-wide" },
            h(
              Card,
              { className: "empty-state" },
              h("h2", null, "Loading live data"),
              h("p", { className: "muted-copy" }, "Waiting for the latest moves and resources from the backend."),
            ),
          ),
        ),
      );
    }

    if (session.role === "Manager") {
      return h(ManagerDashboardPage, {
        moves: visibleMoves,
        foremen: managedForemen,
        managerResources,
        managerFleet,
        currentUser: session,
        currentDate: new Date(),
        onOpenMove: handleOpenMove,
        onCreateDriver: handleCreateManagerDriverAccount,
        onCreateForeman: handleCreateManagerForemanAccount,
        onSaveResources: handleSaveManagerResources,
        onSaveFleet: handleSaveManagerFleet,
        onLogout: handleLogout,
        language,
        onToggleLanguage: handleToggleLanguage,
      });
    }

    if (session.role === "Driver") {
      return h(DriverDashboardPage, {
        assignments: driverAssignments,
        moves: visibleMoves,
        currentUser: session,
        currentDate: new Date(),
        onCompleteStage: handleDriverStageComplete,
        onMoveAction: handleDriverMoveAction,
        onLogout: handleLogout,
        language,
        onToggleLanguage: handleToggleLanguage,
      });
    }

    return h(DashboardPage, {
      moves: visibleMoves,
      activeMove: foremanRigContext?.activeMove || null,
      rig: foremanRigContext?.rig || null,
      rigInventory: foremanRigContext?.rigInventory || null,
      availableFleet,
      currentUser: session,
      currentDate: new Date(),
      loadsReady: !isLoadingLoads && !loadsError,
      loadsError,
      createError,
      isCreatingMove,
      simulationProgress,
      onCreateMove: handleCreateMove,
      onSaveRigInventory: handleSaveRigInventory,
      onOpenMove: handleOpenMove,
      onLogout: handleLogout,
      language,
      onToggleLanguage: handleToggleLanguage,
    });
  }

  if (route.page === "move" && session && areMovesHydrated && isActiveMoveHydrated && !activeMove) {
    if (session.role === "Manager") {
      return h(ManagerDashboardPage, {
        moves: visibleMoves,
        foremen: managedForemen,
        managerResources,
        managerFleet,
        currentUser: session,
        currentDate: new Date(),
        onOpenMove: handleOpenMove,
        onCreateDriver: handleCreateManagerDriverAccount,
        onCreateForeman: handleCreateManagerForemanAccount,
        onSaveResources: handleSaveManagerResources,
        onSaveFleet: handleSaveManagerFleet,
        onLogout: handleLogout,
        language,
        onToggleLanguage: handleToggleLanguage,
      });
    }

    if (session.role === "Driver") {
      return h(DriverDashboardPage, {
        assignments: driverAssignments,
        moves: visibleMoves,
        currentUser: session,
        currentDate: new Date(),
        onCompleteStage: handleDriverStageComplete,
        onMoveAction: handleDriverMoveAction,
        onLogout: handleLogout,
        language,
        onToggleLanguage: handleToggleLanguage,
      });
    }

    return h(DashboardPage, {
      moves: visibleMoves,
      activeMove: foremanRigContext?.activeMove || null,
      rig: foremanRigContext?.rig || null,
      rigInventory: foremanRigContext?.rigInventory || null,
      availableFleet,
      currentUser: session,
      currentDate: new Date(),
      loadsReady: !isLoadingLoads && !loadsError,
      loadsError,
      createError,
      isCreatingMove,
      simulationProgress,
      onCreateMove: handleCreateMove,
      onSaveRigInventory: handleSaveRigInventory,
      onOpenMove: handleOpenMove,
      onLogout: handleLogout,
      language,
      onToggleLanguage: handleToggleLanguage,
    });
  }

  const activePlanningLoads =
    activeMove && session?.role === "Foreman"
      ? buildPlanningLoadsForMove({
          baseLogicalLoads: logicalLoads,
          move: activeMove,
          teamMoves: managerScopedMoves,
          startupRequirements,
        })
      : logicalLoads;

  if (route.page === "move" && session) {
    return h(RigMovePage, {
      move: activeMove,
      isLoadingMove: !areMovesHydrated || !isActiveMoveHydrated,
      currentMinute,
      sceneAssetsReady: areSceneAssetsReady,
      onScenePlaybackReadyChange: setIsScenePlaybackReady,
      playbackSpeed,
      isSimulating: isSimulatingMove,
      isPlaybackRunning,
      isPlaybackPaused,
      sceneFocusResetKey,
      logicalLoads: activePlanningLoads,
      simulationError: moveSimulationError,
      simulationProgress,
      onPlaybackSpeedChange: setPlaybackSpeed,
      onSelectPlan: handleSelectMovePlan,
      onRunPlayback: handleRunSelectedPlan,
      onRunCustomPlan: handleRunCustomPlan,
      onPausePlayback: handlePauseTogglePlayback,
      onEndPlayback: handleEndPlayback,
      onStartExecution: handleStartExecution,
      onUpdateExecutionProgress: updateMoveExecutionProgress,
      onCompleteAssignmentStage: handleDriverStageComplete,
      onDeleteMove: handleDeleteMove,
      onBack: () => navigateTo("/dashboard"),
      onLogout: handleLogout,
      currentUser: session,
      readOnly: session.role === "Manager",
      availableFleet,
      truckSpecs,
      executionState: activeExecutionState,
      operatingState: activeMove?.operatingState || "standby",
      executionProgress: activeMove?.executionProgress || {},
      executionAssignments: moveExecutionAssignments,
      teamMoves: managerScopedMoves,
      startupRequirements,
      language,
      onToggleLanguage: handleToggleLanguage,
    });
  }

  return h(HomePage, {
    language,
    moveCount: moves.length,
    loadCount: logicalLoads.length,
    isLoadingLoads,
    hasSession: Boolean(session),
    onOpenLogin: () => navigateTo("/login"),
    onOpenDashboard: () => navigateTo(session ? "/dashboard" : "/login"),
    onToggleLanguage: handleToggleLanguage,
  });
}

createRoot(document.getElementById("root")).render(h(App));

import { React, createRoot, h } from "./lib/react.js";
import { useHashRoute, navigateTo } from "./lib/router.js";
import {
  DEFAULT_TRUCK_SETUP,
} from "./lib/constants.js";
import { fetchLoads, fetchLocationLabel } from "./features/rigMoves/api.js";
import { buildLogicalLoads, buildScenarioPlans, fetchRouteData, fallbackRouteData } from "./features/rigMoves/simulation.js";
import { buildOperatingSnapshot, buildStartupTransferLoads, buildStartupTransferSchedule } from "./features/rigMoves/operations.js";
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
  readMoves,
  setMovesCache,
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
  if (normalized.includes("heavy")) {
    return "Heavy Hauler";
  }
  if (normalized.includes("flat")) {
    return "Flat-bed";
  }
  if (normalized.includes("low") || normalized.includes("support")) {
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
  return String(type || "")
    .toLowerCase()
    .replace(/[^a-z]/g, "");
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
    move?.simulation?.bestPlan?.playback?.trips?.length ||
    move?.simulation?.routeGeometry?.length,
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

function getStageDelayMinutes({ assignment, stage, completedAt = new Date().toISOString() }) {
  const plannedFinishMinute = assignment?.stagePlan?.[stage]?.finishMinute;
  const executionStartedAt = assignment?.executionStartedAt || assignment?.assignedAt;
  if (!Number.isFinite(Number(plannedFinishMinute)) || !executionStartedAt) {
    return 0;
  }

  const actualElapsedMinutes =
    Math.max(0, new Date(completedAt).getTime() - new Date(executionStartedAt).getTime()) / 60000;
  return Math.max(0, Math.round(actualElapsedMinutes - Number(plannedFinishMinute)));
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

    if (!assignment.driverId || !assignment.loadId) {
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
  if (!primaryPool.length || !trips.length) {
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
  function pickDriverForLane(type) {
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

    return null;
  }

  const assignmentQueues = new Map();
  plannedTruckLanes.forEach((lane) => {
    const driver = pickDriverForLane(lane.truckType);
    if (!driver) {
      return;
    }

    const driverAssignments = lane.trips.map((trip, index) => ({
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
      tripLabel: trip.description || `Load ${trip.loadCode || trip.loadId}`,
      tripNumber: index + 1,
      plannedTripCount: lane.trips.length,
      sequence: index + 1,
      plannedStartMinute: trip.loadStart ?? trip.dispatchStart ?? 0,
      plannedFinishMinute: trip.rigUpFinish ?? trip.returnToSource ?? trip.arrivalAtDestination ?? 0,
      stagePlan: {
        rigDown: {
          startMinute: trip.rigDownStart ?? trip.loadStart ?? 0,
          finishMinute: trip.rigDownFinish ?? trip.loadStart ?? 0,
        },
        rigMove: {
          startMinute: trip.moveStart ?? trip.pickupLoadFinish ?? trip.rigDownFinish ?? 0,
          finishMinute: trip.arrivalAtDestination ?? trip.moveFinish ?? trip.returnToSource ?? 0,
        },
        rigUp: {
          startMinute: trip.rigUpStart ?? trip.unloadDropFinish ?? trip.arrivalAtDestination ?? 0,
          finishMinute: trip.rigUpFinish ?? trip.returnToSource ?? trip.arrivalAtDestination ?? 0,
        },
      },
      stageDelayNotes: {
        rigDown: null,
        rigMove: null,
        rigUp: null,
      },
      journeyId: trip.journeyId || null,
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
      status: index === 0 ? "active" : "queued",
      assignedAt,
      executionStartedAt: assignedAt,
      updatedAt: assignedAt,
    }));

    assignmentQueues.set(driver.id, driverAssignments);
  });

  return [...assignmentQueues.values()].flat();
}

function getLatestMoveByState(moves, predicate) {
  return moves
    .filter(predicate)
    .sort((a, b) => new Date(b.updatedAt || b.createdAt || 0) - new Date(a.updatedAt || a.createdAt || 0))[0] || null;
}

function buildForemanRigContext({ session, visibleMoves, managerScopedMoves, logicalLoads, startupRequirements = [], rigInventoryRevision = 0 }) {
  const assignedRig = session?.assignedRig || null;
  const stableRigId = assignedRig?.id || `rig-${session?.id || "home"}`;
  const latestDrillingMove = getLatestMoveByState(
    visibleMoves,
    (move) => move?.operatingState === "drilling" || move?.executionState === "completed",
  );
  const activeMove = getLatestMoveByState(
    visibleMoves,
    (move) => move?.operatingState !== "drilling" && move?.executionState !== "completed",
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
  const supportRouteMap = Object.fromEntries(
    ((move?.simulation?.supportRoutes || []).map((route) => [route.key, route])),
  );

  return [
    ...(baseLogicalLoads || []),
    ...buildStartupTransferLoads(operatingSnapshot.startupLoads, supportRouteMap),
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
  const [playbackSpeed, setPlaybackSpeed] = useState(15000);
  const [isPlaybackRunning, setIsPlaybackRunning] = useState(false);
  const [isPlaybackPaused, setIsPlaybackPaused] = useState(false);
  const [sceneFocusResetKey, setSceneFocusResetKey] = useState(0);
  const [areSceneAssetsReady, setAreSceneAssetsReady] = useState(true);
  const [isScenePlaybackReady, setIsScenePlaybackReady] = useState(false);
  const animationFrameRef = useRef(null);
  const animationStartedAtRef = useRef(null);
  const lastPersistedMinuteRef = useRef(0);
  const lastPlaybackUiUpdateRef = useRef(0);
  const lastSavedMoveSessionRef = useRef("");

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
  }, []);

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
      ? visibleMoves.find((move) => move && String(move.id) === String(route.moveId)) || null
      : null;
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
      setAreMovesHydrated(true);
      return undefined;
    }

    setAreMovesHydrated(false);

    const unsubscribeMoves = subscribeManagerMoves(managerId, (remoteMoves) => {
      const normalizedMoves = setMovesCache(remoteMoves);
      setMoves(normalizedMoves);
      setAreMovesHydrated(true);
    });

    const unsubscribeResources = subscribeManagerResources(managerId, (remoteResources) => {
      const normalizedResources = setManagerResourcesCache(managerId, remoteResources || readManagerResources(managerId));
      setManagerResources(normalizedResources);
      setManagerFleet(normalizedResources.fleet || readManagerFleet(managerId));
      setAreMovesHydrated(true);
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
    if (!managerId || !activeMove || activeMove.executionState !== "active") {
      return;
    }

    if (moveExecutionAssignments.length || !(managerResources?.drivers || []).length) {
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
  }, [managerId, activeMove?.id, activeMove?.executionState, moveExecutionAssignments.length, managerResources]);

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
        setIsActiveMoveHydrated(false);
        return;
      }

      if (activeMove && isMoveDetailLoaded(activeMove)) {
        setIsActiveMoveHydrated(true);
        return;
      }

      setIsActiveMoveHydrated(false);

      try {
        const hydratedMove = await fetchMove(route.moveId);
        if (!cancelled) {
          setMoves((current) => {
            const remaining = current.filter((move) => move.id !== hydratedMove.id);
            return [hydratedMove, ...remaining];
          });
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
    const restoredSpeed = Number(activeMove.playbackSpeed) || 15000;

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
      const nextMinute = Math.max(0, Math.min(Math.round(minuteOverride || 0), activeTotalMinutes || Math.round(minuteOverride || 0)));
      const nextSpeed = Number(playbackSpeed) || 15000;
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
      const needsRouteRefresh =
        activeMove?.routeMode !== "live" ||
        (activeMove?.simulation?.routeGeometry?.length || 0) < 3;
      const needsPlanRefresh = activeMove ? !hasMultiTruckPlans(activeMove) : false;

      if (route.page !== "move" || !activeMove || !logicalLoads.length || (!needsPlanRefresh && !needsRouteRefresh)) {
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

    const startingMinute = Math.min(
      lastPersistedMinuteRef.current || activeMove.progressMinute || 0,
      activeTotalMinutes,
    );

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
        (timestamp - lastPlaybackUiUpdateRef.current) >= 80 ||
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
        lastPlaybackUiUpdateRef.current = 0;
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

    const availableTruckSetup = DEFAULT_TRUCK_SETUP.map((defaultTruck) => {
      const matched = availableFleet.find(
        (truck) => normalizeTruckTypeKey(truck.type) === normalizeTruckTypeKey(defaultTruck.type),
      );
      if (!matched?.available) {
        return null;
      }

      return {
        id: matched.id,
        type: matched.type,
        count: Math.min(matched.available, Math.max(1, Number.parseInt(defaultTruck.count, 10) || 1)),
      };
    }).filter(Boolean);

    if (!sumTruckCounts(availableTruckSetup) && availableFleet.some((truck) => truck.available > 0)) {
      const firstAvailableTruck = availableFleet.find((truck) => truck.available > 0);
      if (firstAvailableTruck) {
        availableTruckSetup.push({
          id: firstAvailableTruck.id,
          type: firstAvailableTruck.type,
          count: 1,
        });
      }
    }

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
      setPlaybackSpeed(15000);
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

  async function buildMoveWithSimulation({ name, startPoint, endPoint, startLabel: providedStartLabel, endLabel: providedEndLabel, loadCount, logicalLoads, truckSetup, previousMove, availability = [], scenarioTruckSetup = null, enforceExactFleet = false, onProgress = null }) {
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
    const supportRouteMap = Object.fromEntries(supportRoutesWithPickup.map((route) => [route.key, route]));
    const planningLoads = [
      ...(logicalLoads || []),
      ...buildStartupTransferLoads(operatingSnapshot.startupLoads, supportRouteMap),
    ];
    const normalizedScenarioTruckSetup = (scenarioTruckSetup || sanitizedTruckSetup)
      .map((item) => ({
        ...item,
        type: normalizePlannerTruckType(item.type),
        count: Math.max(0, Number.parseInt(item.count ?? item.available, 10) || 0),
        hourlyCost: Math.max(0, Number(item.hourlyCost) || 0),
      }))
      .filter((item) => item.type && item.count > 0);
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
      playbackSpeed: previousMove.playbackSpeed || 15000,
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
      setPlaybackSpeed(15000);
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

  async function handleDriverStageComplete({ assignmentId, stage, delayReason = "" }) {
    if (!managerId || !session?.id) {
      return;
    }

    const allowedDriverIds = new Set(
      [
        session.id,
        ...(managerResources?.drivers || [])
          .filter((driver) => String(driver.email || "").trim().toLowerCase() === String(session.email || "").trim().toLowerCase())
          .map((driver) => driver.id),
      ].filter(Boolean),
    );
    const targetAssignment = (managerResources?.taskAssignments || []).find(
      (assignment) => assignment.id === assignmentId && allowedDriverIds.has(assignment.driverId),
    );
    if (!targetAssignment) {
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
    if (projectedLateMinutes > 20 && !String(delayReason || "").trim()) {
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
          ...(lateMinutes > 20
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
            assignment.moveId === completedAssignment.moveId &&
            assignment.driverId === completedAssignment.driverId &&
            assignment.status === "queued",
        )
        .sort((left, right) => left.sequence - right.sequence)[0];

      if (nextQueuedAssignment) {
        for (let index = 0; index < nextTaskAssignments.length; index += 1) {
          if (nextTaskAssignments[index].id === nextQueuedAssignment.id) {
            nextTaskAssignments[index] = {
              ...nextQueuedAssignment,
              status: "active",
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
    setIsPlaybackRunning(false);
    setIsPlaybackPaused(false);
    animationStartedAtRef.current = null;
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

    animationStartedAtRef.current = null;
    setIsPlaybackPaused(false);
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
        currentUser: session,
        currentDate: new Date(),
        onCompleteStage: handleDriverStageComplete,
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
        currentUser: session,
        currentDate: new Date(),
        onCompleteStage: handleDriverStageComplete,
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

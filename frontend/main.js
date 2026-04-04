import { React, createRoot, h } from "./lib/react.js";
import { useHashRoute, navigateTo } from "./lib/router.js";
import {
  DEFAULT_MOVE_SETTINGS,
  DEFAULT_TRUCK_SETUP,
} from "./lib/constants.js";
import { fetchLoads, fetchLocationLabel } from "./features/rigMoves/api.js";
import { buildLogicalLoads, buildScenarioPlans, fetchRouteData, fallbackRouteData } from "./features/rigMoves/simulation.js";
import { buildOperatingSnapshot, buildStartupTransferLoads, buildStartupTransferSchedule } from "./features/rigMoves/operations.js";
import { applyRigInventoryAdjustments, hydrateRigInventoryAdjustments, readRigInventoryAdjustments, writeRigInventoryAdjustments } from "./features/rigInventory/storage.js";
import {
  createSession,
  getSession,
  clearSession,
  findUserByCredentials,
  getManagedForemen,
} from "./features/auth/auth.js";
import {
  readMoves,
  hydrateMoves,
  createMoveRecord,
  upsertMove,
  persistMoveSession,
  removeMove,
} from "./features/rigMoves/storage.js";
import {
  hydrateManagerResources,
  readManagerFleet,
  readManagerWorkers,
  writeManagerFleet,
  writeManagerWorkers,
  buildFleetAvailability,
  buildWorkerAvailability,
  getAvailabilityValidationError,
  sumTruckCounts,
} from "./features/resources/storage.js";
import { HomePage } from "./pages/HomePage.js";
import { LoginPage } from "./pages/LoginPage.js";
import { DashboardPage } from "./pages/DashboardPage.js";
import { ManagerDashboardPage } from "./pages/ManagerDashboardPage.js";
import { RigMovePage } from "./pages/RigMovePage.js";
import { formatCoordinate, formatMinutes } from "./lib/format.js";

const { useEffect, useRef, useState } = React;

function yieldForUiPaint() {
  return new Promise((resolve) => {
    window.requestAnimationFrame(() => {
      window.setTimeout(resolve, 0);
    });
  });
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

      return `${scenarioFailure.name}: ${firstFailure.message} Workers: ${firstFailure.workerCount}. Trucks: ${firstFailure.truckCount}.${fleetText}`;
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

function getSessionManagerId(session) {
  if (!session) {
    return null;
  }

  return session.role === "Manager" ? session.id : session.managerId || null;
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
  const [loads, setLoads] = useState([]);
  const [startupRequirements, setStartupRequirements] = useState([]);
  const [truckSpecs, setTruckSpecs] = useState([]);
  const [workerRoles, setWorkerRoles] = useState([]);
  const [isLoadingLoads, setIsLoadingLoads] = useState(true);
  const [loadsError, setLoadsError] = useState("");
  const [moves, setMoves] = useState([]);
  const [rigInventoryRevision, setRigInventoryRevision] = useState(0);
  const [areMovesHydrated, setAreMovesHydrated] = useState(false);
  const [createError, setCreateError] = useState("");
  const [isCreatingMove, setIsCreatingMove] = useState(false);
  const [managerFleet, setManagerFleet] = useState([]);
  const [managerWorkers, setManagerWorkers] = useState(0);
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
  const lastSavedMoveSessionRef = useRef("");

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
          setWorkerRoles(dataset.workerRoles || []);
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
        const moveManagerId = move.createdBy?.role === "Manager" ? move.createdBy?.id : move.createdBy?.managerId;
        return moveManagerId === managerId;
      })
    : [];
  const visibleMoves = session?.role === "Foreman"
    ? moves.filter((move) => move.createdBy?.id === session.id)
    : session?.role === "Manager"
      ? moves.filter((move) => session.teamForemanIds?.includes(move.createdBy?.id))
      : moves;
  const activeMove =
    route.page === "move"
      ? visibleMoves.find((move) => String(move.id) === String(route.moveId)) || null
      : null;
  const activeScenario = getActiveScenario(activeMove);
  const activeTotalMinutes = activeScenario?.bestVariant?.totalMinutes || 0;
  const activeExecutionState = activeMove?.executionState || "planning";
  const availableFleet = buildFleetAvailability({
    managerFleet,
    moves: managerScopedMoves,
    currentMoveId: activeMove?.id || null,
  });
  const availableWorkers = buildWorkerAvailability({
    totalWorkers: managerWorkers,
    moves: managerScopedMoves,
    currentMoveId: activeMove?.id || null,
    managerId,
  });
  const managerFleetSignature = JSON.stringify(
    (managerFleet || []).map((truck) => ({
      id: truck.id,
      type: truck.type,
      count: truck.count,
      hourlyCost: truck.hourlyCost,
    })),
  );
  const managerWorkersSignature = JSON.stringify(managerWorkers || {});
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

  useEffect(() => {
    let cancelled = false;

    async function hydrateAppState() {
      if (!managerId) {
        setMoves([]);
        setManagerFleet([]);
        setManagerWorkers(0);
        setAreMovesHydrated(true);
        return;
      }

      setAreMovesHydrated(false);
      try {
        const [hydratedMoves, resources] = await Promise.all([
          hydrateMoves(managerId),
          hydrateManagerResources(managerId),
        ]);
        if (!cancelled) {
          setMoves(hydratedMoves);
          setManagerFleet(resources.fleet || readManagerFleet(managerId));
          setManagerWorkers(resources.workers || readManagerWorkers(managerId));
          setAreMovesHydrated(true);
        }
      } catch {
        if (!cancelled) {
          setMoves(readMoves());
          setManagerFleet(readManagerFleet(managerId));
          setManagerWorkers(readManagerWorkers(managerId));
          setAreMovesHydrated(true);
        }
      }
    }

    hydrateAppState();

    return () => {
      cancelled = true;
    };
  }, [managerId]);

  useEffect(() => {
    let cancelled = false;

    async function hydrateRigInventory() {
      if (!foremanRigContext?.rig?.id) {
        return;
      }

      try {
        await hydrateRigInventoryAdjustments(foremanRigContext.rig.id);
        if (!cancelled) {
          setRigInventoryRevision((value) => value + 1);
        }
      } catch {
        // Keep empty adjustments if remote inventory is unavailable.
      }
    }

    hydrateRigInventory();

    return () => {
      cancelled = true;
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
          availableWorkers: buildWorkerAvailability({
            totalWorkers: managerWorkers,
            moves: managerScopedMoves,
            currentMoveId: activeMove.id,
            managerId,
          }),
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
  }, [route.page, activeMove?.id, activeMove?.updatedAt, logicalLoads.length, managerFleetSignature, managerWorkersSignature, managerScopedMoves.length, truckSpecs.length, startupRequirements.length]);

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

      setCurrentMinute(nextMinute);
      lastPersistedMinuteRef.current = nextMinute;

      if (nextMinute < activeTotalMinutes) {
        animationFrameRef.current = window.requestAnimationFrame(animate);
      } else {
        animationFrameRef.current = null;
        animationStartedAtRef.current = null;
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
    };
  }, [activeMove?.id, activeMove?.updatedAt, route.page, playbackSpeed, activeTotalMinutes, areSceneAssetsReady, isSimulatingMove, isPlaybackRunning]);

  async function handleLogin({ email, password }) {
    const matchedUser = findUserByCredentials(email, password);
    if (!matchedUser) {
      throw new Error("Invalid credentials. Please check your email and password.");
    }

    const nextSession = createSession(matchedUser);
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
        availableWorkers,
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

  async function buildMoveWithSimulation({ name, startPoint, endPoint, startLabel: providedStartLabel, endLabel: providedEndLabel, loadCount, logicalLoads, truckSetup, previousMove, availability = [], availableWorkers = DEFAULT_MOVE_SETTINGS.workerCount, scenarioTruckSetup = null, enforceExactFleet = false, onProgress = null }) {
    const availabilityByType = new Map(
      (availability || []).map((item) => [String(item.type || "").trim().toLowerCase(), item]),
    );
    const sanitizedTruckSetup = truckSetup
      .map((item) => ({
        ...item,
        count: Math.max(0, Number.parseInt(item.count, 10) || 0),
        hourlyCost: Math.max(
          0,
          Number(
            item.hourlyCost ??
              availabilityByType.get(String(item.type || "").trim().toLowerCase())?.hourlyCost,
          ) || 0,
        ),
      }))
      .filter((item) => item.type.trim() && item.count > 0);
    const availabilityError = getAvailabilityValidationError(sanitizedTruckSetup, availability);
    if (availabilityError) {
      throw new Error(availabilityError);
    }
    const requestedTruckCount = sanitizedTruckSetup.reduce((sum, item) => sum + item.count, 0);
    if (requestedTruckCount < 1) {
      throw new Error("Add at least one truck before running the simulation.");
    }
    const truckCount = requestedTruckCount;
    const workerCount = Math.max(
      4,
      Number.parseInt(availableWorkers?.available ?? availableWorkers?.total ?? availableWorkers, 10) || DEFAULT_MOVE_SETTINGS.workerCount,
    );

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
      detail: "Stage 6 of 8. Building feasible truck and worker scenario candidates.",
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
        count: Math.max(0, Number.parseInt(item.count ?? item.available, 10) || 0),
        hourlyCost: Math.max(0, Number(item.hourlyCost) || 0),
      }))
      .filter((item) => item.type?.trim() && item.count > 0);
    const scenarioPlans = await buildScenarioPlans(planningLoads, routeData, workerCount, truckCount, normalizedScenarioTruckSetup, truckSpecs, {
      dayShift: availableWorkers?.dayShift ?? workerCount,
      nightShift: availableWorkers?.nightShift ?? workerCount,
      roles: availableWorkers?.roles || {},
      averageHourlyCost: availableWorkers?.averageHourlyCost ?? 0,
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
      workerCount: bestScenario.workerCount,
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

  async function handleRunMoveSimulation({ moveId, truckSetup, availableWorkers: overrideAvailableWorkers = null, enforceExactFleet = false }) {
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
        availableWorkers: overrideAvailableWorkers || availableWorkers,
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

    const updatedMove = {
      ...targetMove,
      ...extra,
      updatedAt: new Date().toISOString(),
      executionState,
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
      completionPercentage: executionProgress.rigUpCompleted ? 100 : targetMove.completionPercentage,
      progressMinute: executionProgress.rigUpCompleted ? activeTotalMinutes : targetMove.progressMinute,
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

  async function handleSaveManagerFleet(nextFleet) {
    if (!managerId) {
      return;
    }

    const savedFleet = await writeManagerFleet(managerId, nextFleet);
    setManagerFleet(savedFleet);
  }

  async function handleSaveManagerWorkers(nextWorkers) {
    if (!managerId) {
      return;
    }

    const savedWorkers = await writeManagerWorkers(managerId, nextWorkers);
    setManagerWorkers(savedWorkers);
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

  async function handleRunCustomPlan({ moveId, truckSetup, availableWorkers: overrideAvailableWorkers = null }) {
    const didUpdateMove = await handleRunMoveSimulation({
      moveId,
      truckSetup,
      availableWorkers: overrideAvailableWorkers,
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
    setCurrentMinute(0);
    setIsPlaybackRunning(false);
    setIsPlaybackPaused(false);
    setSceneFocusResetKey((value) => value + 1);
  }

  function handleStartExecution(moveId) {
    const updatedMove = updateMoveExecutionState(moveId, "active", {
      operatingState: "standby",
      executionProgress: {
        managerNotified: true,
        trucksReserved: true,
        liveDataRequested: true,
        rigDownCompleted: false,
        rigUpCompleted: false,
      },
    });

    if (!updatedMove) {
      return;
    }

    setIsPlaybackRunning(false);
    setIsPlaybackPaused(false);
    setCurrentMinute(0);
    lastPersistedMinuteRef.current = 0;
  }

  function handleCompleteExecutionStage({ moveId, stage }) {
    if (stage === "rigDown") {
      updateMoveExecutionProgress(moveId, {
        rigDownCompleted: true,
      });
      return;
    }

    if (stage === "rigUp") {
      updateMoveExecutionProgress(moveId, {
        rigDownCompleted: true,
        rigUpCompleted: true,
      });
      navigateTo("/dashboard");
    }
  }

  if (route.page === "login") {
    return h(LoginPage, {
      isAuthenticated: Boolean(session),
      onLogin: handleLogin,
      onBackHome: () => navigateTo("/home"),
    });
  }

  if (route.page === "dashboard" && session) {
    if (session.role === "Manager") {
      return h(ManagerDashboardPage, {
        moves: visibleMoves,
        foremen: getManagedForemen(session.id),
        managerFleet,
        managerWorkers,
        currentUser: session,
        currentDate: new Date(),
        workerRoles,
        onOpenMove: handleOpenMove,
        onSaveFleet: handleSaveManagerFleet,
        onSaveWorkers: handleSaveManagerWorkers,
        onLogout: handleLogout,
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
    });
  }

  if (route.page === "move" && session && areMovesHydrated && !activeMove) {
    if (session.role === "Manager") {
      return h(ManagerDashboardPage, {
        moves: visibleMoves,
        foremen: getManagedForemen(session.id),
        managerFleet,
        managerWorkers,
        currentUser: session,
        currentDate: new Date(),
        workerRoles,
        onOpenMove: handleOpenMove,
        onSaveFleet: handleSaveManagerFleet,
        onSaveWorkers: handleSaveManagerWorkers,
        onLogout: handleLogout,
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
      isLoadingMove: !areMovesHydrated,
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
      onCompleteExecutionStage: handleCompleteExecutionStage,
      onDeleteMove: handleDeleteMove,
      onBack: () => navigateTo("/dashboard"),
      onLogout: handleLogout,
      currentUser: session,
      readOnly: session.role === "Manager",
      availableFleet,
      availableWorkers,
      workerRoles,
      truckSpecs,
      executionState: activeExecutionState,
      operatingState: activeMove?.operatingState || "standby",
      executionProgress: activeMove?.executionProgress || {},
      teamMoves: managerScopedMoves,
      startupRequirements,
    });
  }

  return h(HomePage, {
    moveCount: moves.length,
    loadCount: logicalLoads.length,
    isLoadingLoads,
    hasSession: Boolean(session),
    onOpenLogin: () => navigateTo("/login"),
    onOpenDashboard: () => navigateTo(session ? "/dashboard" : "/login"),
  });
}

createRoot(document.getElementById("root")).render(h(App));

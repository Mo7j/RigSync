import { React, createRoot, h } from "./lib/react.js";
import { useHashRoute, navigateTo } from "./lib/router.js";
import {
  BASE_PLAYBACK_SECONDS,
  DEFAULT_MOVE_SETTINGS,
  DEFAULT_TRUCK_SETUP,
  HISTORY_STORAGE_KEY,
} from "./lib/constants.js";
import { fetchLoads } from "./features/rigMoves/api.js";
import { buildLogicalLoads, buildScenarioPlans, fetchRouteData, fallbackRouteData } from "./features/rigMoves/simulation.js";
import { createSession, getSession, clearSession, TEST_USER } from "./features/auth/auth.js";
import {
  readMoves,
  createMoveRecord,
  upsertMove,
  migrateLegacyHistory,
} from "./features/rigMoves/storage.js";
import { HomePage } from "./pages/HomePage.js";
import { LoginPage } from "./pages/LoginPage.js";
import { DashboardPage } from "./pages/DashboardPage.js";
import { RigMovePage } from "./pages/RigMovePage.js";
import { formatMinutes } from "./lib/format.js";

const { useEffect, useRef, useState } = React;

function App() {
  const route = useHashRoute();
  const [session, setSession] = useState(getSession);
  const [loads, setLoads] = useState([]);
  const [isLoadingLoads, setIsLoadingLoads] = useState(true);
  const [loadsError, setLoadsError] = useState("");
  const [moves, setMoves] = useState([]);
  const [createError, setCreateError] = useState("");
  const [isCreatingMove, setIsCreatingMove] = useState(false);
  const [isSimulatingMove, setIsSimulatingMove] = useState(false);
  const [moveSimulationError, setMoveSimulationError] = useState("");
  const [currentMinute, setCurrentMinute] = useState(0);
  const [playbackSpeed, setPlaybackSpeed] = useState(1);
  const animationFrameRef = useRef(null);
  const animationStartedAtRef = useRef(null);
  const lastPersistedMinuteRef = useRef(0);

  useEffect(() => {
    migrateLegacyHistory(HISTORY_STORAGE_KEY);
    setMoves(readMoves());
  }, []);

  useEffect(() => {
    let cancelled = false;

    async function loadDataset() {
      setIsLoadingLoads(true);
      setLoadsError("");

      try {
        const nextLoads = await fetchLoads();
        if (!cancelled) {
          setLoads(nextLoads);
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

  const logicalLoads = buildLogicalLoads(loads);
  const activeMove = route.page === "move" ? moves.find((move) => move.id === route.moveId) || null : null;

  useEffect(() => {
    if (!session && (route.page === "dashboard" || route.page === "move")) {
      navigateTo("/login");
    }
  }, [route.page, session]);

  useEffect(() => {
    if (route.page !== "move" || !activeMove?.simulation?.bestPlan?.totalMinutes) {
      if (animationFrameRef.current !== null) {
        window.cancelAnimationFrame(animationFrameRef.current);
      }
      animationFrameRef.current = null;
      animationStartedAtRef.current = null;
      setCurrentMinute(0);
      return undefined;
    }

    const startingMinute = Math.min(
      activeMove.progressMinute || 0,
      activeMove.simulation.bestPlan.totalMinutes,
    );

    setCurrentMinute(startingMinute);
    lastPersistedMinuteRef.current = startingMinute;
    animationStartedAtRef.current = null;

    const animate = (timestamp) => {
      if (animationStartedAtRef.current === null) {
        animationStartedAtRef.current = timestamp;
      }

      const elapsedSeconds = (timestamp - animationStartedAtRef.current) / 1000;
      const simulatedMinutes =
        startingMinute +
        elapsedSeconds *
          (activeMove.simulation.bestPlan.totalMinutes / BASE_PLAYBACK_SECONDS) *
          playbackSpeed;
      const nextMinute = Math.min(activeMove.simulation.bestPlan.totalMinutes, simulatedMinutes);

      setCurrentMinute(nextMinute);
      lastPersistedMinuteRef.current = nextMinute;

      if (nextMinute < activeMove.simulation.bestPlan.totalMinutes) {
        animationFrameRef.current = window.requestAnimationFrame(animate);
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
  }, [activeMove?.id, activeMove?.updatedAt, route.page, playbackSpeed]);

  async function handleLogin({ email, password }) {
    if (email !== TEST_USER.email || password !== TEST_USER.password) {
      throw new Error("Invalid credentials. Use the provided test account.");
    }

    const nextSession = createSession();
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

    setIsCreatingMove(true);

    try {
      const move = await buildMoveWithSimulation({
        name: formValues.name,
        startPoint: formValues.startPoint,
        endPoint: formValues.endPoint,
        loadCount: logicalLoads.length,
        logicalLoads,
        truckSetup: DEFAULT_TRUCK_SETUP,
      });

      const nextMoves = upsertMove(move);
      setMoves(nextMoves);
      setPlaybackSpeed(1);
      navigateTo(`/move/${move.id}`);
    } catch (error) {
      setCreateError(error.message || "Failed to create the rig move.");
    } finally {
      setIsCreatingMove(false);
    }
  }

  async function buildMoveWithSimulation({ name, startPoint, endPoint, loadCount, logicalLoads, truckSetup, previousMove }) {
    const sanitizedTruckSetup = truckSetup
      .map((item) => ({
        ...item,
        count: Math.max(0, Number.parseInt(item.count, 10) || 0),
      }))
      .filter((item) => item.type.trim());
    const requestedTruckCount = sanitizedTruckSetup.reduce((sum, item) => sum + item.count, 0);
    if (requestedTruckCount < 1) {
      throw new Error("Add at least one truck before running the simulation.");
    }
    const truckCount = requestedTruckCount;
    const workerCount = Math.max(DEFAULT_MOVE_SETTINGS.workerCount, truckCount + 2);

    let routeData = fallbackRouteData(startPoint, endPoint);
    let routeMode = "estimated";

    try {
      routeData = await fetchRouteData(startPoint, endPoint);
      routeMode = "live";
    } catch {
      routeMode = "estimated";
    }

    const scenarioPlans = buildScenarioPlans(logicalLoads, routeData, workerCount, truckCount);
    const bestScenario = scenarioPlans.reduce(
      (best, plan) => (!best || plan.totalMinutes < best.totalMinutes ? plan : best),
      null,
    );
    const bestPlan = bestScenario?.bestVariant || null;

    if (!bestPlan) {
      throw new Error("No valid simulation plan could be generated for this rig move.");
    }

    const simulation = {
      startPoint,
      endPoint,
      workerCount: bestScenario.workerCount,
      truckCount: bestScenario.truckCount,
      truckSetup: sanitizedTruckSetup,
      routeMinutes: routeData.minutes,
      routeSource: routeData.source,
      routeGeometry: routeData.geometry,
      scenarioPlans,
      bestScenario,
      bestPlan,
    };

    if (!previousMove) {
      return createMoveRecord({
        name,
        startPoint,
        endPoint,
        routeMode,
        loadCount,
        simulation,
      });
    }

    return {
      ...previousMove,
      name,
      updatedAt: new Date().toISOString(),
      routeMode,
      loadCount,
      truckSetup: sanitizedTruckSetup,
      eta: formatMinutes(bestPlan.totalMinutes),
      routeTime: formatMinutes(routeData.minutes),
      progressMinute: 0,
      completionPercentage: 0,
      simulation,
    };
  }

  async function handleRunMoveSimulation({ moveId, truckSetup }) {
    setMoveSimulationError("");

    if (!logicalLoads.length) {
      setMoveSimulationError("The load dataset is still loading. Try again in a moment.");
      return;
    }

    const targetMove = moves.find((move) => move.id === moveId);
    if (!targetMove) {
      setMoveSimulationError("The selected move could not be found.");
      return;
    }

    setIsSimulatingMove(true);

    try {
      if (animationFrameRef.current !== null) {
        window.cancelAnimationFrame(animationFrameRef.current);
      }
      animationFrameRef.current = null;
      animationStartedAtRef.current = null;
      lastPersistedMinuteRef.current = 0;
      setCurrentMinute(0);

      const updatedMove = await buildMoveWithSimulation({
        name: targetMove.name,
        startPoint: targetMove.startPoint,
        endPoint: targetMove.endPoint,
        loadCount: logicalLoads.length,
        logicalLoads,
        truckSetup,
        previousMove: targetMove,
      });
      const nextMoves = upsertMove({
        ...updatedMove,
        progressMinute: 0,
        completionPercentage: 0,
      });
      setMoves(nextMoves);
      setCurrentMinute(0);
      setPlaybackSpeed(1);
    } catch (error) {
      setMoveSimulationError(error.message || "Failed to simulate the move.");
    } finally {
      setIsSimulatingMove(false);
    }
  }

  function handleOpenMove(moveId) {
    navigateTo(`/move/${moveId}`);
  }

  if (route.page === "login") {
    return h(LoginPage, {
      isAuthenticated: Boolean(session),
      onLogin: handleLogin,
      onBackHome: () => navigateTo("/home"),
    });
  }

  if (route.page === "dashboard" && session) {
    return h(DashboardPage, {
      moves,
      currentUser: session,
      currentDate: new Date(),
      loadsReady: !isLoadingLoads && !loadsError,
      loadsError,
      createError,
      isCreatingMove,
      onCreateMove: handleCreateMove,
      onOpenMove: handleOpenMove,
      onLogout: handleLogout,
    });
  }

  if (route.page === "move" && session) {
    return h(RigMovePage, {
      move: activeMove,
      currentMinute,
      playbackSpeed,
      isSimulating: isSimulatingMove,
      simulationError: moveSimulationError,
      onPlaybackSpeedChange: setPlaybackSpeed,
      onSimulate: handleRunMoveSimulation,
      onBack: () => navigateTo("/dashboard"),
      onLogout: handleLogout,
      currentUser: session,
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

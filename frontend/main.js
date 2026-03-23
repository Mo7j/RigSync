import { React, createRoot, h } from "./lib/react.js";
import { useHashRoute, navigateTo } from "./lib/router.js";
import {
  BASE_PLAYBACK_SECONDS,
  DEFAULT_MOVE_SETTINGS,
  DEFAULT_TRUCK_SETUP,
  HISTORY_STORAGE_KEY,
} from "./lib/constants.js";
import { fetchLoads, fetchLocationLabel } from "./features/rigMoves/api.js";
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
import { formatCoordinate, formatMinutes } from "./lib/format.js";

const { useEffect, useRef, useState } = React;

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

    handleMouseMove({
      clientX: window.innerWidth / 2,
      clientY: window.innerHeight / 2,
    });

    window.addEventListener("mousemove", handleMouseMove);

    return () => {
      window.removeEventListener("mousemove", handleMouseMove);
      document.body.classList.remove("home-interactive");
      document.documentElement.style.removeProperty("--mouse-x");
      document.documentElement.style.removeProperty("--mouse-y");
      document.documentElement.style.removeProperty("--grid-shift-x");
      document.documentElement.style.removeProperty("--grid-shift-y");
      document.documentElement.style.removeProperty("--orbit-left-x");
      document.documentElement.style.removeProperty("--orbit-left-y");
      document.documentElement.style.removeProperty("--orbit-right-x");
      document.documentElement.style.removeProperty("--orbit-right-y");
    };
  }, [route.page]);

  const logicalLoads = buildLogicalLoads(loads);
  const activeMove = route.page === "move" ? moves.find((move) => move.id === route.moveId) || null : null;
  const activeScenario = getActiveScenario(activeMove);
  const activeTotalMinutes = activeScenario?.bestVariant?.totalMinutes || 0;

  useEffect(() => {
    if (!session && (route.page === "dashboard" || route.page === "move")) {
      navigateTo("/login");
    }
  }, [route.page, session]);

  useEffect(() => {
    if (route.page !== "move" || !activeTotalMinutes) {
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
      const simulatedMinutes =
        startingMinute +
        elapsedSeconds *
          (activeTotalMinutes / BASE_PLAYBACK_SECONDS) *
          playbackSpeed;
      const nextMinute = Math.min(activeTotalMinutes, simulatedMinutes);

      setCurrentMinute(nextMinute);
      lastPersistedMinuteRef.current = nextMinute;

      if (nextMinute < activeTotalMinutes) {
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
  }, [activeMove?.id, activeMove?.updatedAt, route.page, playbackSpeed, activeTotalMinutes]);

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
        startLabel: formValues.startLabel,
        endLabel: formValues.endLabel,
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

  async function buildMoveWithSimulation({ name, startPoint, endPoint, startLabel: providedStartLabel, endLabel: providedEndLabel, loadCount, logicalLoads, truckSetup, previousMove }) {
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
    let startLabel = providedStartLabel || previousMove?.startLabel || formatCoordinate(startPoint);
    let endLabel = providedEndLabel || previousMove?.endLabel || formatCoordinate(endPoint);

    try {
      routeData = await fetchRouteData(startPoint, endPoint);
      routeMode = "live";
    } catch {
      routeMode = "estimated";
    }

    try {
      const [nextStartLabel, nextEndLabel] = await Promise.all([
        fetchLocationLabel(startPoint),
        fetchLocationLabel(endPoint),
      ]);
      startLabel = nextStartLabel || startLabel;
      endLabel = nextEndLabel || endLabel;
    } catch {
      // Keep coordinate fallback labels when reverse geocoding is unavailable.
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
      startLabel,
      endLabel,
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

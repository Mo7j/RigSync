import { React, createRoot, h } from "./lib/react.js";
import { useHashRoute, navigateTo } from "./lib/router.js";
import {
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
import { preloadSimulationSceneAssets } from "./components/map/SimulationScene3D.js";

const { useEffect, useRef, useState } = React;

function isCoordinateLabel(label) {
  return typeof label === "string" && /^-?\d+(\.\d+)?\s*,\s*-?\d+(\.\d+)?$/.test(label.trim());
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
  const distinctTruckCounts = new Set(
    scenarioPlans
      .map((scenario) => scenario?.truckCount)
      .filter((truckCount) => Number.isFinite(truckCount)),
  );

  return scenarioPlans.length >= 3 && distinctTruckCounts.size >= 3;
}

function loadStoredMoves() {
  migrateLegacyHistory(HISTORY_STORAGE_KEY);
  return readMoves();
}

function App() {
  const route = useHashRoute();
  const [session, setSession] = useState(getSession);
  const [loads, setLoads] = useState([]);
  const [isLoadingLoads, setIsLoadingLoads] = useState(true);
  const [loadsError, setLoadsError] = useState("");
  const [moves, setMoves] = useState(loadStoredMoves);
  const [areMovesHydrated, setAreMovesHydrated] = useState(true);
  const [createError, setCreateError] = useState("");
  const [isCreatingMove, setIsCreatingMove] = useState(false);
  const [isSimulatingMove, setIsSimulatingMove] = useState(false);
  const [moveSimulationError, setMoveSimulationError] = useState("");
  const [currentMinute, setCurrentMinute] = useState(0);
  const [playbackSpeed, setPlaybackSpeed] = useState(15000);
  const [isPlaybackRunning, setIsPlaybackRunning] = useState(false);
  const [isPlaybackPaused, setIsPlaybackPaused] = useState(false);
  const [sceneFocusResetKey, setSceneFocusResetKey] = useState(0);
  const [areSceneAssetsReady, setAreSceneAssetsReady] = useState(false);
  const [isScenePlaybackReady, setIsScenePlaybackReady] = useState(false);
  const animationFrameRef = useRef(null);
  const animationStartedAtRef = useRef(null);
  const lastPersistedMinuteRef = useRef(0);

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
  const activeMove =
    route.page === "move"
      ? moves.find((move) => String(move.id) === String(route.moveId)) || null
      : null;
  const activeScenario = getActiveScenario(activeMove);
  const activeTotalMinutes = activeScenario?.bestVariant?.totalMinutes || 0;

  useEffect(() => {
    if (route.page !== "move") {
      setIsScenePlaybackReady(false);
      setIsPlaybackRunning(false);
      setIsPlaybackPaused(false);
    }
  }, [route.page, activeMove?.id]);

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
        const refreshedMove = await buildMoveWithSimulation({
          name: activeMove.name,
          startPoint: activeMove.startPoint,
          endPoint: activeMove.endPoint,
          loadCount: logicalLoads.length,
          logicalLoads,
          truckSetup: activeMove.truckSetup || activeMove.simulation?.truckSetup || DEFAULT_TRUCK_SETUP,
          previousMove: activeMove,
        });

        if (!cancelled) {
          setMoves(upsertMove(refreshedMove));
        }
      } catch {
        // Keep the existing move if background plan generation fails.
      }
    }

    ensureMovePlans();

    return () => {
      cancelled = true;
    };
  }, [route.page, activeMove?.id, activeMove?.updatedAt, logicalLoads.length]);

  useEffect(() => {
    if (!session && (route.page === "dashboard" || route.page === "move")) {
      navigateTo("/login");
    }
  }, [route.page, session]);

  useEffect(() => {
    let cancelled = false;

    async function ensureMoveAssetsReady() {
      if (route.page !== "move" || !activeMove) {
        return;
      }

      if (areSceneAssetsReady) {
        return;
      }

      try {
        await preloadSimulationSceneAssets();
      } finally {
        if (!cancelled) {
          setAreSceneAssetsReady(true);
        }
      }
    }

    ensureMoveAssetsReady();

    return () => {
      cancelled = true;
    };
  }, [route.page, activeMove?.id, activeMove?.updatedAt, areSceneAssetsReady]);

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
        setIsPlaybackPaused(true);
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
    if (email !== TEST_USER.email || password !== TEST_USER.password) {
      throw new Error("Invalid credentials. Please check your email and password.");
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

      setAreSceneAssetsReady(false);
      setIsScenePlaybackReady(false);
      await preloadSimulationSceneAssets();
      const nextMoves = upsertMove(move);
      setMoves(nextMoves);
      setAreSceneAssetsReady(true);
      setPlaybackSpeed(15000);
      setIsPlaybackRunning(false);
      setIsPlaybackPaused(false);
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
        count: Math.max(1, Number.parseInt(item.count, 10) || 1),
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
      routeDistanceKm: routeData.distanceKm,
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
      routeKm: routeData.distanceKm,
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
      setAreSceneAssetsReady(false);
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
      });
      await preloadSimulationSceneAssets();
      const nextMoves = upsertMove({
        ...updatedMove,
        progressMinute: 0,
        completionPercentage: 0,
      });
      setMoves(nextMoves);
      setAreSceneAssetsReady(true);
      setCurrentMinute(0);
      lastPersistedMinuteRef.current = 0;
      setPlaybackSpeed(15000);
      setIsPlaybackRunning(false);
      setIsPlaybackPaused(false);
      return true;
    } catch (error) {
      setAreSceneAssetsReady(true);
      setMoveSimulationError(error.message || "Failed to simulate the move.");
      return false;
    } finally {
      setIsSimulatingMove(false);
    }
  }

  async function handleOpenMove(moveId) {
    setAreSceneAssetsReady(false);
    setIsScenePlaybackReady(false);
    setIsPlaybackRunning(false);
    setCurrentMinute(0);
    setIsPlaybackPaused(false);
    navigateTo(`/move/${moveId}`);
    try {
      await preloadSimulationSceneAssets();
      setAreSceneAssetsReady(true);
    } catch {
      setAreSceneAssetsReady(true);
    }
  }

  function handleSelectMovePlan({ moveId, scenarioName }) {
    const targetMove = moves.find((move) => move.id === moveId);
    if (!targetMove?.simulation?.scenarioPlans?.length) {
      return;
    }

    const hasScenario = targetMove.simulation.scenarioPlans.some((scenario) => scenario.name === scenarioName);
    if (!hasScenario || targetMove.simulation.preferredScenarioName === scenarioName) {
      return;
    }

    const updatedMove = {
      ...targetMove,
      updatedAt: new Date().toISOString(),
      progressMinute: 0,
      completionPercentage: 0,
      simulation: {
        ...targetMove.simulation,
        preferredScenarioName: scenarioName,
      },
    };

    setMoves(upsertMove(updatedMove));
    setCurrentMinute(0);
    setIsPlaybackRunning(false);
    setIsPlaybackPaused(false);
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
    const didUpdateMove = await handleRunMoveSimulation({ moveId, truckSetup });
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
      isLoadingMove: !areMovesHydrated,
      currentMinute,
      sceneAssetsReady: areSceneAssetsReady,
      onScenePlaybackReadyChange: setIsScenePlaybackReady,
      playbackSpeed,
      isSimulating: isSimulatingMove,
      isPlaybackRunning,
      isPlaybackPaused,
      sceneFocusResetKey,
      logicalLoads,
      simulationError: moveSimulationError,
      onPlaybackSpeedChange: setPlaybackSpeed,
      onSelectPlan: handleSelectMovePlan,
      onRunPlayback: handleRunSelectedPlan,
      onRunCustomPlan: handleRunCustomPlan,
      onPausePlayback: handlePauseTogglePlayback,
      onEndPlayback: handleEndPlayback,
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

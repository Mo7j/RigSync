import { React, createRoot, h } from "./lib/react.js";
import { useHashRoute, navigateTo } from "./lib/router.js";
import { BASE_PLAYBACK_SECONDS, DEFAULT_MOVE_SETTINGS, HISTORY_STORAGE_KEY } from "./lib/constants.js";
import { fetchLoads } from "./features/rigMoves/api.js";
import { buildLogicalLoads, buildScenarioPlans, fetchRouteData, fallbackRouteData } from "./features/rigMoves/simulation.js";
import { createSession, getSession, clearSession, TEST_USER } from "./features/auth/auth.js";
import {
  readMoves,
  createMoveRecord,
  upsertMove,
  updateMoveProgress,
  migrateLegacyHistory,
} from "./features/rigMoves/storage.js";
import { HomePage } from "./pages/HomePage.js";
import { LoginPage } from "./pages/LoginPage.js";
import { DashboardPage } from "./pages/DashboardPage.js";
import { RigMovePage } from "./pages/RigMovePage.js";

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

      if (Math.abs(nextMinute - lastPersistedMinuteRef.current) >= 10 || nextMinute === activeMove.simulation.bestPlan.totalMinutes) {
        lastPersistedMinuteRef.current = nextMinute;
        const nextMoves = updateMoveProgress(activeMove.id, nextMinute);
        setMoves(nextMoves);
      }

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
      const nextMoves = updateMoveProgress(activeMove.id, lastPersistedMinuteRef.current);
      setMoves(nextMoves);
    };
  }, [activeMove?.id, route.page, playbackSpeed]);

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

    const workerCount = DEFAULT_MOVE_SETTINGS.workerCount;
    const truckCount = DEFAULT_MOVE_SETTINGS.truckCount;
    let routeData = fallbackRouteData(formValues.startPoint, formValues.endPoint);
    let routeMode = "estimated";

    try {
      routeData = await fetchRouteData(formValues.startPoint, formValues.endPoint);
      routeMode = "live";
    } catch {
      routeMode = "estimated";
    }

    try {
      const scenarioPlans = buildScenarioPlans(logicalLoads, routeData, workerCount, truckCount);
      const bestScenario = scenarioPlans.reduce(
        (best, plan) => (!best || plan.totalMinutes < best.totalMinutes ? plan : best),
        null,
      );
      const bestPlan = bestScenario?.bestVariant || null;

      if (!bestPlan) {
        throw new Error("No valid simulation plan could be generated for this rig move.");
      }

      const move = createMoveRecord({
        name: formValues.name,
        startPoint: formValues.startPoint,
        endPoint: formValues.endPoint,
        routeMode,
        loadCount: logicalLoads.length,
        simulation: {
          startPoint: formValues.startPoint,
          endPoint: formValues.endPoint,
          workerCount: bestScenario.workerCount,
          truckCount: bestScenario.truckCount,
          routeMinutes: routeData.minutes,
          routeSource: routeData.source,
          routeGeometry: routeData.geometry,
          scenarioPlans,
          bestScenario,
          bestPlan,
        },
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
      onPlaybackSpeedChange: setPlaybackSpeed,
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

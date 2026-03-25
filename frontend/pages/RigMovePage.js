import { React, h } from "../lib/react.js";
import { AppLayout } from "../layouts/AppLayout.js";
import { Button } from "../components/ui/Button.js";
import { Card, StatCard } from "../components/ui/Card.js";
import { ProgressBar } from "../components/ui/ProgressBar.js";
import { Field, TextInput } from "../components/ui/Field.js";
import { SimulationScene3D } from "../components/map/SimulationScene3D.js";
import { LeafletMap } from "../components/map/LeafletMap.js";
import { formatMinutes } from "../lib/format.js";
import { buildScenarioPlans } from "../features/rigMoves/simulation.js";

const { useDeferredValue, useEffect, useMemo, useRef, useState } = React;

function normalizeTruckTypeLabel(type) {
  const normalized = String(type || "").trim().toLowerCase();
  if (normalized === "support") {
    return "Low bed";
  }
  return type || "Truck";
}

function normalizeTruckSetup(move) {
  const source = move?.truckSetup?.length ? move.truckSetup : move?.simulation?.truckSetup || [];

  if (source.length) {
    return source.map((item, index) => ({
      id: item.id || `truck-${index + 1}`,
      type: normalizeTruckTypeLabel(item.type),
      count: String(Math.max(1, Number.parseInt(item.count, 10) || 1)),
    }));
  }

  return [{ id: "fleet-default", type: "Heavy Haul", count: String(move?.simulation?.truckCount || 1) }];
}

function TruckSetupEditor({ truckSetup, onChange, onAddRow, onRemoveRow }) {
  return h(
    "div",
    { className: "truck-setup-list" },
    truckSetup.map((truck, index) =>
      h(
        "div",
        { key: truck.id, className: "truck-setup-row" },
        h(
          Field,
          { label: index === 0 ? "Truck Type" : "" },
          h(TextInput, {
            type: "text",
            value: truck.type,
            placeholder: "Heavy Haul",
            onChange: (event) => onChange(truck.id, "type", event.target.value),
          }),
        ),
        h(
          Field,
          { label: index === 0 ? "Count" : "" },
          h(TextInput, {
            type: "number",
            min: "1",
            value: truck.count,
            onChange: (event) => onChange(truck.id, "count", event.target.value),
          }),
        ),
        h(Button, {
          type: "button",
          variant: "ghost",
          size: "sm",
          className: "truck-row-remove",
          onClick: () => onRemoveRow(truck.id),
          children: "Remove",
        }),
      ),
    ),
    h(Button, {
      type: "button",
      variant: "ghost",
      size: "sm",
      onClick: onAddRow,
      children: "Add Truck Type",
    }),
  );
}

function ScenarioBreakdown({ scenarios, activeScenarioName, onSelect }) {
  return h(
    "div",
    { className: "scenario-list" },
    scenarios.map((scenario) =>
      h(
        "button",
        {
          key: scenario.name,
          type: "button",
          className: `scenario-card${scenario.name === activeScenarioName ? " scenario-card-active" : ""}`,
          onClick: () => onSelect(scenario.name),
        },
        h("div", { className: "scenario-head" }, h("strong", null, scenario.name), h("span", null, formatMinutes(scenario.totalMinutes))),
        h("p", { className: "muted-copy" }, `${scenario.truckCount} trucks - ${scenario.bestVariant?.name || "Best route order"}`),
      ),
    ),
  );
}

function PlanSwitcher({ scenarios, activePlanKey, onSelect }) {
  return h(
    "nav",
    { className: "plan-switcher", "aria-label": "Move plans" },
    [
      ...scenarios.map((scenario) => ({
        key: scenario.name,
        label: scenario.name,
        meta: `${scenario.truckCount} trucks`,
      })),
      { key: "customize", label: "Customize", meta: "Manual" },
    ].map((item) =>
      h(
        "button",
        {
          key: item.key,
          type: "button",
          className: `plan-switcher-button${item.key === activePlanKey ? " active" : ""}`,
          onClick: () => onSelect(item.key),
        },
        h("span", { className: "plan-switcher-label" }, item.label),
        h("span", { className: "plan-switcher-meta" }, item.meta),
      ),
    ),
  );
}

function countRoundTrips(playback) {
  return (playback?.trips || []).filter((trip) => trip.returnToSource !== null).length;
}

function getPlanSummary(scenario) {
  const playback = scenario?.bestVariant?.playback;
  const trips = playback?.trips || [];

  return {
    totalMinutes: scenario?.totalMinutes || 0,
    totalLoads: trips.length,
    roundTrips: countRoundTrips(playback),
    routeOrder: scenario?.bestVariant?.name || "Best route order",
    waves: scenario?.bestVariant?.waves?.length || scenario?.waves?.length || 0,
  };
}

function formatCurrency(value) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  }).format(Math.max(0, value));
}

function getPlanDashboardStats(scenario, move) {
  const playback = scenario?.bestVariant?.playback;
  const trips = playback?.trips || [];
  const totalMinutes = Math.max(scenario?.totalMinutes || 0, 1);
  const truckCount = Math.max(1, Number.parseInt(scenario?.truckCount, 10) || 1);
  const workerCount = Math.max(1, Number.parseInt(scenario?.workerCount, 10) || 1);
  const activeMinutes = trips.reduce(
    (sum, trip) => sum + Math.max(0, (trip.returnToSource ?? trip.rigUpFinish ?? trip.arrivalAtDestination) - trip.loadStart),
    0,
  );
  const utilization = Math.min(100, Math.round((activeMinutes / (truckCount * totalMinutes)) * 100));
  const costEstimate =
    (totalMinutes / 60) * truckCount * 185 +
    (totalMinutes / 60) * workerCount * 34 +
    (move?.routeKm || 0) * Math.max(1, countRoundTrips(playback)) * 2.4;

  return {
    utilizationValue: utilization,
    utilization: `${utilization}%`,
    costEstimate: formatCurrency(costEstimate),
    loadsPerTruck: (trips.length / truckCount).toFixed(1),
    crewHours: String(Math.round((workerCount * totalMinutes) / 60)),
  };
}

function getSliderMaxCount(currentCount) {
  return Math.max(7, currentCount + 4);
}

function buildDisplayedTruckCounts(truckSetup, targetTotal) {
  const normalized = (truckSetup || [])
    .map((truck, index) => ({
      id: truck.id || `truck-${index + 1}`,
      type: normalizeTruckTypeLabel(truck.type),
      count: Math.max(1, Number.parseInt(truck.count, 10) || 1),
    }))
    .filter((truck) => truck.type.trim());

  if (!normalized.length) {
    return [{ id: "fleet-default", type: "Heavy Haul", count: Math.max(1, targetTotal || 1) }];
  }

  const safeTotal = Math.max(1, targetTotal || 1);
  const currentTotal = normalized.reduce((sum, truck) => sum + truck.count, 0);

  if (currentTotal <= 0) {
    return normalized.map((truck, index) => ({
      ...truck,
      count: index === 0 ? safeTotal : 1,
    }));
  }

  const scaled = normalized.map((truck) => {
    const exact = (truck.count / currentTotal) * safeTotal;
    return {
      ...truck,
      count: Math.floor(exact),
      remainder: exact - Math.floor(exact),
    };
  });

  let assigned = scaled.reduce((sum, truck) => sum + truck.count, 0);
  const byRemainder = [...scaled].sort((a, b) => b.remainder - a.remainder);
  let cursor = 0;

  while (assigned < safeTotal && byRemainder.length) {
    byRemainder[cursor % byRemainder.length].count += 1;
    assigned += 1;
    cursor += 1;
  }

  return scaled.map(({ remainder, ...truck }) => truck);
}

function getRigSiteStats({ side, move, playback, currentMinute, totalMinutes }) {
  if (!side || !playback?.trips?.length) {
    return null;
  }

  const trips = playback.trips;
  const totalLoads = trips.length;
  const completedLoads = trips.filter((trip) =>
    side === "source" ? currentMinute >= trip.rigDownFinish : currentMinute >= trip.rigUpFinish,
  ).length;
  const movingLoads = trips.filter(
    (trip) => currentMinute >= trip.rigDownFinish && currentMinute < trip.arrivalAtDestination,
  ).length;
  const progress = totalLoads > 0 ? Math.round((completedLoads / totalLoads) * 100) : 0;
  const remainingLoads = Math.max(0, totalLoads - completedLoads);
  const label = side === "source" ? move?.startLabel || "Source Site" : move?.endLabel || "Destination Site";
  const stateLabel =
    side === "source"
      ? progress >= 100
        ? "Shifted Out"
        : progress > 0
          ? "Shifting"
          : "Waiting"
      : progress >= 100
        ? "Rig Up Complete"
        : progress > 0
          ? "Rigging Up"
          : "Pending";

  return {
    label,
    sideLabel: side === "source" ? "Source Rig Site" : "Destination Rig Site",
    stateLabel,
    progress,
    completedLoads,
    remainingLoads,
    movingLoads,
    timeLeft: formatMinutes(Math.max(0, Math.round(totalMinutes - currentMinute))),
  };
}

function getPhasePercentages(playback, currentMinute) {
  const trips = playback?.trips || [];
  const totalTrips = Math.max(trips.length, 1);
  const down = (trips.filter((trip) => currentMinute >= trip.rigDownFinish).length / totalTrips) * 100;
  const move = (trips.filter((trip) => currentMinute >= trip.arrivalAtDestination).length / totalTrips) * 100;
  const up = (trips.filter((trip) => currentMinute >= trip.rigUpFinish).length / totalTrips) * 100;
  return { down, move, up };
}

function getRigLoadCounts(playback, currentMinute) {
  const trips = playback?.trips || [];
  const sourceCount = trips.filter((trip) => currentMinute < trip.rigDownFinish).length;
  const movingCount = trips.filter(
    (trip) => currentMinute >= trip.rigDownFinish && currentMinute < trip.rigUpFinish,
  ).length;
  const destinationCount = trips.filter((trip) => currentMinute >= trip.rigUpFinish).length;
  return {
    sourceCount,
    movingCount,
    destinationCount,
    totalCount: trips.length,
  };
}

function buildTruckScheduleRows(playback, truckCount) {
  const trips = playback?.trips || [];
  const totalMinutes = Math.max(playback?.totalMinutes || 1, 1);

  return Array.from({ length: truckCount }, (_, index) => {
    const truckId = index + 1;
    const truckTrips = trips
      .filter((trip) => trip.truckId === truckId)
      .map((trip, tripIndex) => ({
        ...trip,
        key: `${truckId}-${trip.loadId}-${tripIndex}`,
        left: (trip.loadStart / totalMinutes) * 100,
        width: (((trip.rigUpFinish || trip.arrivalAtDestination) - trip.loadStart) / totalMinutes) * 100,
        loadWidth: ((trip.rigDownFinish - trip.loadStart) / totalMinutes) * 100,
        moveLeft: ((trip.rigDownFinish - trip.loadStart) / totalMinutes) * 100,
        moveWidth: ((trip.arrivalAtDestination - trip.rigDownFinish) / totalMinutes) * 100,
        upLeft: ((trip.arrivalAtDestination - trip.loadStart) / totalMinutes) * 100,
        upWidth: ((trip.rigUpFinish - trip.arrivalAtDestination) / totalMinutes) * 100,
      }));

    return {
      truckId,
      trips: truckTrips,
    };
  });
}

function LoadScheduleTable({ playback, currentMinute }) {
  const totalMinutes = Math.max(playback?.totalMinutes || 1, 1);
  const truckCount = Math.max(...(playback?.trips || []).map((trip) => trip.truckId), 1);
  const rows = buildTruckScheduleRows(playback, truckCount);
  const tickCount = 8;
  const ticks = Array.from({ length: tickCount + 1 }, (_, index) => {
    const ratio = index / tickCount;
    return {
      key: `tick-${index}`,
      left: `${ratio * 100}%`,
      label: formatMinutes(Math.round(totalMinutes * ratio)),
    };
  });
  const currentX = `${(Math.min(currentMinute, totalMinutes) / totalMinutes) * 100}%`;
  const minTimelineWidth = Math.max(900, rows.reduce((sum, row) => Math.max(sum, row.trips.length * 180), 900));

  return h(
    "div",
    { className: "schedule-table" },
    h(
      "div",
      { className: "schedule-scroll" },
      h(
        "div",
        { className: "schedule-canvas", style: { minWidth: `${minTimelineWidth}px` } },
        h(
          "div",
          { className: "schedule-ticks" },
          ticks.map((tick) =>
            h(
              "span",
              {
                key: tick.key,
                className: "schedule-tick",
                style: { left: tick.left },
              },
              tick.label,
            ),
          ),
        ),
        h("div", { className: "schedule-current-marker", style: { left: currentX } }),
        rows.map((row) =>
          h(
            "article",
            { key: `truck-row-${row.truckId}`, className: "schedule-row" },
            h(
              "div",
              { className: "schedule-row-copy" },
              h("strong", null, `Truck ${row.truckId}`),
              h("span", { className: "muted-copy" }, `${row.trips.length} loads in sequence`),
            ),
            h(
              "div",
              { className: "schedule-row-track" },
              ticks.map((tick) =>
                h("span", {
                  key: `grid-${row.truckId}-${tick.key}`,
                  className: "schedule-grid-line",
                  style: { left: tick.left },
                }),
              ),
              row.trips.map((trip) =>
                h(
                  "div",
                  {
                    key: trip.key,
                    className: "schedule-trip",
                    style: {
                      left: `${trip.left}%`,
                      width: `${Math.max(trip.width, 5)}%`,
                    },
                    title: `${trip.description} | ${formatMinutes(Math.round(trip.loadStart))} -> ${formatMinutes(Math.round(trip.rigUpFinish))}`,
                  },
                  h("span", { className: "schedule-trip-label" }, `#${trip.loadId}`),
                  h("span", {
                    className: "schedule-segment schedule-segment-down",
                    style: {
                      left: "0%",
                      width: `${Math.max(trip.loadWidth, 8)}%`,
                    },
                  }),
                  h("span", {
                    className: "schedule-segment schedule-segment-move",
                    style: {
                      left: `${trip.moveLeft}%`,
                      width: `${Math.max(trip.moveWidth, 8)}%`,
                    },
                  }),
                  h("span", {
                    className: "schedule-segment schedule-segment-up",
                    style: {
                      left: `${trip.upLeft}%`,
                      width: `${Math.max(trip.upWidth, 8)}%`,
                    },
                  }),
                ),
              ),
            ),
          ),
        ),
      ),
    ),
  );
}

function PlaybackActionButton({ isRunning, isBusy, isPaused, onRun, onEnd, onPauseToggle, label = "Run" }) {
  return h(
    "div",
    { className: "scene-playback-action" },
    h(Button, {
      type: "button",
      isBusy: isBusy,
      onClick: isRunning || isPaused ? onEnd : onRun,
      children: isRunning || isPaused ? "End" : label,
    }),
    (isRunning || isPaused)
      ? h(
          "button",
          {
            type: "button",
            className: "scene-pause-fab",
            onClick: onPauseToggle,
            "aria-label": isPaused ? "Resume" : "Pause",
          },
          h("span", { className: `scene-playback-icon${isPaused ? " is-resume" : ""}` }),
        )
      : null,
  );
}

export function RigMovePage({
  move,
  isLoadingMove = false,
  currentMinute,
  sceneAssetsReady,
  onScenePlaybackReadyChange,
  playbackSpeed = 1,
  isSimulating,
  isPlaybackRunning,
  isPlaybackPaused,
  sceneFocusResetKey,
  logicalLoads,
  simulationError,
  onPlaybackSpeedChange,
  onSelectPlan,
  onRunPlayback,
  onRunCustomPlan,
  onPausePlayback,
  onEndPlayback,
  onBack,
  onLogout,
  currentUser,
}) {
  const previousMoveIdRef = useRef(move?.id || null);
  const speedDropdownRef = useRef(null);
  const [hasSceneInitialized, setHasSceneInitialized] = useState(Boolean(sceneAssetsReady));
  const [truckSetup, setTruckSetup] = useState(() => normalizeTruckSetup(move));
  const [activeScenarioName, setActiveScenarioName] = useState(move?.simulation?.preferredScenarioName || "");
  const [activePlanKey, setActivePlanKey] = useState(move?.simulation?.preferredScenarioName || "");
  const [activeView, setActiveView] = useState("map");
  const [sceneMode, setSceneMode] = useState("3d");
  const [focusedRigSide, setFocusedRigSide] = useState(null);
  const [isSpeedDropdownOpen, setIsSpeedDropdownOpen] = useState(false);

  useEffect(() => {
    if (sceneAssetsReady) {
      setHasSceneInitialized(true);
    }
  }, [sceneAssetsReady]);

  useEffect(() => {
    if (!isSpeedDropdownOpen) {
      return undefined;
    }

    const handleKeyDown = (event) => {
      if (event.key === "Escape") {
        setIsSpeedDropdownOpen(false);
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [isSpeedDropdownOpen]);

  useEffect(() => {
    const isNewMove = previousMoveIdRef.current !== move?.id;

    setHasSceneInitialized(Boolean(sceneAssetsReady));
    if (isNewMove) {
      setTruckSetup(normalizeTruckSetup(move));
    }
    setActiveScenarioName(move?.simulation?.preferredScenarioName || "");
    setActivePlanKey((current) => {
      if (isNewMove) {
        previousMoveIdRef.current = move?.id || null;
        return move?.simulation?.preferredScenarioName || "";
      }

      return current === "customize" ? "customize" : move?.simulation?.preferredScenarioName || "";
    });
    setActiveView("map");
    if (isNewMove) {
      setSceneMode("3d");
      setIsSpeedDropdownOpen(false);
    }
    setFocusedRigSide(null);
  }, [move?.id, move?.updatedAt]);

  if (isLoadingMove) {
    return h(
      AppLayout,
      {
        title: "Loading rig move",
        subtitle: "Restoring the saved move from local storage.",
        currentUser,
        onLogout,
        onBack,
      },
      h(Card, { className: "empty-state" }, h("h2", null, "Loading move"), h("p", { className: "muted-copy" }, "Rebuilding the scene after refresh.")),
    );
  }

  if (!move) {
    return h(
      AppLayout,
      {
        title: "Rig move not found",
        subtitle: "The selected move is no longer available.",
        currentUser,
        onLogout,
        onBack,
      },
      h(Card, { className: "empty-state" }, h("h2", null, "Move unavailable"), h("p", { className: "muted-copy" }, "Return to the dashboard and choose another rig move.")),
    );
  }

  if (!move.simulation?.scenarioPlans?.length) {
    return h(
      AppLayout,
      {
        title: move.name,
        subtitle: move.createdLabel,
        currentUser,
        onLogout,
        onBack,
        fullBleed: true,
      },
      h(
        Card,
        { className: "empty-state" },
        h("h2", null, "Move unavailable"),
        h("p", { className: "muted-copy" }, "Open the dashboard and run the move simulation after setting the fleet."),
      ),
    );
  }

  const scenarioPlans = move.simulation.scenarioPlans || [];
  const activeScenario =
    scenarioPlans.find((scenario) => scenario.name === activeScenarioName) ||
    scenarioPlans[0];
  const totalTrucks = truckSetup.reduce((sum, item) => sum + (Number.parseInt(item.count, 10) || 0), 0);
  const isCustomizeActive = activePlanKey === "customize";
  const deferredTruckSetup = useDeferredValue(truckSetup);
  const deferredTotalTrucks = deferredTruckSetup.reduce((sum, item) => sum + (Number.parseInt(item.count, 10) || 0), 0);
  const customPreviewScenario = useMemo(() => {
    if (!isCustomizeActive || !logicalLoads?.length) {
      return null;
    }

    const routeData = {
      minutes: move.simulation?.routeMinutes || activeScenario?.routeMinutes || 0,
      geometry: move.simulation?.routeGeometry || activeScenario?.routeGeometry || [],
      source: move.simulation?.routeSource || activeScenario?.routeSource || "Preview route",
    };
    const previewWorkerCount = Math.max(move.simulation?.workerCount || 0, deferredTotalTrucks + 2);
    const previewPlans = buildScenarioPlans(logicalLoads, routeData, previewWorkerCount, deferredTotalTrucks);

    return (
      previewPlans.find((scenario) => scenario.truckCount === deferredTotalTrucks) ||
      previewPlans[0] ||
      null
    );
  }, [isCustomizeActive, logicalLoads, move.simulation, activeScenario, deferredTotalTrucks]);
  const selectedScenario = isCustomizeActive && customPreviewScenario ? customPreviewScenario : activeScenario;
  const effectiveTruckCount = isCustomizeActive
    ? (deferredTotalTrucks || totalTrucks || selectedScenario?.truckCount || 1)
    : (selectedScenario?.truckCount || totalTrucks || 1);
  const effectiveTruckSetup = isCustomizeActive
    ? deferredTruckSetup
    : buildDisplayedTruckCounts(truckSetup, effectiveTruckCount).map((truck) => ({
        ...truck,
        count: String(truck.count),
      }));

  const displaySimulation = useMemo(
    () => ({
      ...move.simulation,
      workerCount: selectedScenario.workerCount,
      truckCount: selectedScenario.truckCount,
      bestPlan: selectedScenario.bestVariant,
      bestScenario: selectedScenario,
      routeGeometry: selectedScenario.routeGeometry,
      routeMinutes: selectedScenario.routeMinutes,
      truckSetup: effectiveTruckSetup,
    }),
    [move.simulation, selectedScenario, effectiveTruckSetup],
  );

  const totalMinutes = displaySimulation.bestPlan.totalMinutes;
  const visibleMinute = sceneAssetsReady ? Math.min(currentMinute, totalMinutes) : 0;
  const canResumePlayback = visibleMinute > 0 && visibleMinute < totalMinutes;
  const completion = Math.min(100, Math.round((visibleMinute / Math.max(totalMinutes, 1)) * 100));
  const phases = getPhasePercentages(displaySimulation.bestPlan.playback, visibleMinute);
  const rigLoads = getRigLoadCounts(displaySimulation.bestPlan.playback, visibleMinute);
  const lastLog = displaySimulation.bestPlan.playback.steps.filter((step) => step.minute <= visibleMinute).slice(-1)[0] || displaySimulation.bestPlan.playback.steps[0];
  const activePlanSummary = getPlanSummary(selectedScenario);
  const activePlanDashboard = getPlanDashboardStats(selectedScenario, move);
  const displayedTruckCounts = useMemo(
    () => buildDisplayedTruckCounts(effectiveTruckSetup, effectiveTruckCount),
    [effectiveTruckSetup, effectiveTruckCount],
  );
  const focusedRigStats = useMemo(
    () =>
      getRigSiteStats({
        side: focusedRigSide,
        move,
        playback: displaySimulation.bestPlan.playback,
        currentMinute: visibleMinute,
        totalMinutes,
      }),
    [focusedRigSide, move, displaySimulation, visibleMinute, totalMinutes],
  );

  function updateTruckCount(truckId, nextCountValue) {
    const parsedCount = Math.max(1, Number.parseInt(nextCountValue, 10) || 1);

    setTruckSetup((current) =>
      current.map((item) =>
        item.id === truckId ? { ...item, count: String(parsedCount) } : item,
      ),
    );
  }

  if (!sceneAssetsReady && !hasSceneInitialized) {
    return h(
      AppLayout,
      {
        title: move.name,
        subtitle: `${move.startLabel} -> ${move.endLabel}`,
        currentUser,
        onLogout,
        fullBleed: true,
      },
      h(
        Card,
        { className: "empty-state scene-loading-card" },
        h("h2", null, "Loading 3D simulation assets"),
        h("p", { className: "muted-copy" }, "The page will open after the truck and rig models finish loading."),
      ),
    );
  }

  const playbackSpeedOptions = [
    { value: "1500", label: "Normal" },
    { value: "15000", label: "Medium" },
    { value: "50000", label: "Fast" },
  ];
  const activePlaybackSpeedOption =
    playbackSpeedOptions.find((option) => option.value === String(playbackSpeed)) ||
    playbackSpeedOptions[0];

  return activeView === "map"
    ? h(
        "main",
        { className: "scene-only-shell" },
        h(Button, {
          type: "button",
          variant: "ghost",
          className: "scene-back-button",
          onClick: onBack,
          children: "<",
        }),
        sceneMode === "3d"
          ? h(SimulationScene3D, {
              startPoint: move.startPoint,
              endPoint: move.endPoint,
              startLabel: move.startLabel,
              endLabel: move.endLabel,
              simulation: displaySimulation,
              currentMinute: visibleMinute,
              sceneFocusResetKey,
              heightClass: "scene-only-canvas",
              showOverlay: false,
              onReadyStateChange: onScenePlaybackReadyChange,
              onRigFocusChange: setFocusedRigSide,
            })
          : h(LeafletMap, {
              startPoint: move.startPoint,
              endPoint: move.endPoint,
              simulation: displaySimulation,
              currentMinute: visibleMinute,
              heightClass: "scene-only-canvas",
            }),
        h(
          "div",
          { className: "scene-move-info" },
          h(
            "div",
            { className: "scene-move-info-grid" },
            h("div", { className: "scene-dashboard-inline scene-dashboard-kpi-item scene-move-info-row-full" }, h("span", { className: "scene-dashboard-label" }, "From"), h("strong", null, move.startLabel || "Source")),
            h("div", { className: "scene-dashboard-inline scene-dashboard-kpi-item scene-move-info-row-full" }, h("span", { className: "scene-dashboard-label" }, "To"), h("strong", null, move.endLabel || "Destination")),
            h("div", { className: "scene-dashboard-inline scene-dashboard-kpi-item" }, h("span", { className: "scene-dashboard-label" }, "Distance"), h("strong", null, `${move.routeKm || 0} km`)),
            h("div", { className: "scene-dashboard-inline scene-dashboard-kpi-item" }, h("span", { className: "scene-dashboard-label" }, "Travel"), h("strong", null, move.routeTime || formatMinutes(move.simulation?.routeMinutes || 0))),
          ),
        ),
        h(
          "div",
          { className: "scene-bottom-controls" },
          h(
            "div",
            {
              ref: speedDropdownRef,
              className: `scene-speed-dropdown${isSpeedDropdownOpen ? " is-open" : ""}`,
              onPointerDown: (event) => event.stopPropagation(),
              onPointerMove: (event) => event.stopPropagation(),
            },
            h(
              "button",
              {
                type: "button",
                className: "scene-speed-select",
                onClick: () => setIsSpeedDropdownOpen((current) => !current),
                "aria-haspopup": "listbox",
                "aria-expanded": isSpeedDropdownOpen ? "true" : "false",
              },
              h("span", null, activePlaybackSpeedOption.label),
            ),
            isSpeedDropdownOpen
              ? h(
                  "div",
                  {
                    className: "scene-speed-menu",
                    role: "listbox",
                    "aria-label": "Playback speed",
                    onPointerDown: (event) => event.stopPropagation(),
                    onPointerMove: (event) => event.stopPropagation(),
                  },
                  playbackSpeedOptions.map((option) =>
                    h(
                      "button",
                      {
                        key: `speed-${option.value}`,
                        type: "button",
                        className: `scene-speed-option${String(playbackSpeed) === option.value ? " is-active" : ""}`,
                        onClick: () => {
                          onPlaybackSpeedChange?.(Number(option.value));
                          setIsSpeedDropdownOpen(false);
                        },
                      },
                      option.label,
                    ),
                  ),
                )
              : null,
          ),
          h(
            "button",
            {
              type: "button",
              className: "scene-dimension-toggle",
              onClick: () => setSceneMode((current) => (current === "3d" ? "2d" : "3d")),
            },
            sceneMode === "3d" ? "2D" : "3D",
          ),
        ),
        h(
          "aside",
          { className: "scene-panel scene-panel-left scene-panel-left-merged" },
          isCustomizeActive
            ? [
                h(
                  "div",
                  { className: "scene-plan-summary-stack" },
                  h(
                    "div",
                    { className: "scene-plan-summary-card scene-plan-summary-card-title" },
                    h("span", { className: "scene-panel-kicker" }, "Selected Plan"),
                    h("strong", { className: "scene-plan-summary-title" }, `${isCustomizeActive ? "Customize" : activeScenario.name} | ${effectiveTruckCount} Trucks`),
                  ),
                ),
                h(
                  "section",
                  { className: "scene-panel-section scene-panel-section-plain" },
                  !isPlaybackRunning && !isPlaybackPaused
                    ? truckSetup.map((truck) =>
                        h(
                          "label",
                          { key: truck.id, className: "truck-slider-card" },
                          h("div", { className: "truck-slider-head" }, h("span", null, truck.type || "Truck"), h("strong", null, truck.count)),
                          h("input", {
                            className: "truck-slider-input",
                            type: "range",
                            min: "1",
                            max: String(getSliderMaxCount(Number.parseInt(truck.count, 10) || 0)),
                            step: "1",
                            value: truck.count,
                            onInput: (event) => updateTruckCount(truck.id, event.target.value),
                          }),
                        ),
                      )
                    : truckSetup.map((truck) =>
                        h(
                          "div",
                          { key: truck.id, className: "truck-count-row" },
                          h("span", null, truck.type || "Truck"),
                          h("strong", null, truck.count),
                        ),
                      ),
                ),
                simulationError ? h("p", { className: "field-error section-spacing" }, simulationError) : null,
                h(
                  "div",
                  { className: "scene-panel-actions" },
                  h(PlaybackActionButton, {
                    isRunning: isPlaybackRunning,
                    isBusy: isSimulating,
                    isPaused: isPlaybackPaused,
                    onRun: () => onRunCustomPlan({ moveId: move.id, truckSetup }),
                    onEnd: onEndPlayback,
                    onPauseToggle: onPausePlayback,
                    label: "Run",
                  }),
                ),
              ]
            : [
                h(
                  "div",
                  { className: "scene-plan-summary-stack" },
                  h(
                    "div",
                    { className: "scene-plan-summary-card scene-plan-summary-card-title" },
                    h("span", { className: "scene-panel-kicker" }, "Selected Plan"),
                    h("strong", { className: "scene-plan-summary-title" }, `${isCustomizeActive ? "Customize" : activeScenario.name} | ${effectiveTruckCount} Trucks`),
                  ),
                ),
                h(
                  "section",
                  { className: "scene-panel-section scene-panel-section-plain" },
                  displayedTruckCounts.map((truck) =>
                    h(
                      "div",
                      { key: truck.id, className: "truck-count-row" },
                      h("span", null, truck.type || "Truck"),
                      h("strong", null, String(truck.count)),
                    ),
                  ),
                ),
                h(
                  "div",
                  { className: "scene-panel-actions" },
                  h(PlaybackActionButton, {
                    isRunning: isPlaybackRunning,
                    isPaused: isPlaybackPaused,
                    onRun: onRunPlayback,
                    onEnd: onEndPlayback,
                    onPauseToggle: onPausePlayback,
                    label: canResumePlayback ? "Resume" : "Run",
                  }),
                ),
              ],
        ),
        focusedRigStats
          ? h(
              "div",
              { className: "scene-top-info-strip" },
              h(
                "div",
                { className: "scene-plan-kpis" },
                h("div", { className: "scene-dashboard-stack-item" }, h("span", { className: "scene-dashboard-label" }, focusedRigStats.sideLabel), h("strong", null, focusedRigStats.label), h("p", { className: "scene-dashboard-copy" }, focusedRigStats.stateLabel)),
                h("div", { className: "scene-dashboard-inline scene-dashboard-kpi-item" }, h("span", { className: "scene-dashboard-label" }, "Completed Loads"), h("strong", null, String(focusedRigStats.completedLoads))),
                h("div", { className: "scene-dashboard-inline scene-dashboard-kpi-item" }, h("span", { className: "scene-dashboard-label" }, "Remaining Loads"), h("strong", null, String(focusedRigStats.remainingLoads))),
                h("div", { className: "scene-dashboard-inline scene-dashboard-kpi-item" }, h("span", { className: "scene-dashboard-label" }, "Loads Moving"), h("strong", null, String(focusedRigStats.movingLoads))),
              ),
              h(
                "div",
                { className: "scene-plan-dashboard" },
                h(
                  "div",
                  { className: "scene-plan-summary-card scene-plan-summary-card-title" },
                  h("span", { className: "scene-panel-kicker" }, "Site Progress"),
                  h("strong", { className: "scene-plan-summary-title" }, `${focusedRigStats.progress}% Complete`),
                ),
                h(
                  "div",
                  { className: "scene-dashboard-phase-stack" },
                  h(
                    "div",
                    { className: "scene-dashboard-phase-row" },
                    h("div", { className: "scene-dashboard-inline scene-dashboard-kpi-item" }, h("span", { className: "scene-dashboard-label" }, "Site Completion"), h("strong", null, `${focusedRigStats.progress}%`)),
                    h(ProgressBar, { value: focusedRigStats.progress }),
                  ),
                  h("div", { className: "scene-dashboard-inline scene-dashboard-kpi-item" }, h("span", { className: "scene-dashboard-label" }, "Time Left"), h("strong", null, focusedRigStats.timeLeft)),
                ),
              ),
            )
          : isPlaybackRunning || isPlaybackPaused
          ? h(
              "div",
              { className: "scene-top-info-strip" },
              h(
                "div",
                { className: "scene-plan-kpis" },
                h("div", { className: "scene-dashboard-inline scene-dashboard-kpi-item" }, h("span", { className: "scene-dashboard-label" }, "Total Completion"), h("strong", null, `${completion}%`)),
                h("div", { className: "scene-dashboard-inline scene-dashboard-kpi-item" }, h("span", { className: "scene-dashboard-label" }, "Hours Left"), h("strong", null, formatMinutes(Math.max(0, Math.round(totalMinutes - visibleMinute))))),
                h("div", { className: "scene-dashboard-stack-item" }, h("span", { className: "scene-dashboard-label" }, "Last Operation"), h("strong", null, lastLog?.title || "Waiting for simulation"), h("p", { className: "scene-dashboard-copy" }, lastLog?.description || "No events yet.")),
              ),
              h(
                "div",
                { className: "scene-plan-dashboard" },
                h(
                  "div",
                  { className: "scene-plan-summary-card scene-plan-summary-card-title" },
                  h("span", { className: "scene-panel-kicker" }, "Live Progress"),
                  h("strong", { className: "scene-plan-summary-title" }, isPlaybackPaused ? "Paused" : "Running"),
                ),
                h(
                  "div",
                  { className: "scene-dashboard-phase-stack" },
                  h(
                    "div",
                    { className: "scene-dashboard-phase-row" },
                    h("div", { className: "scene-dashboard-inline scene-dashboard-kpi-item" }, h("span", { className: "scene-dashboard-label" }, "Rig Down"), h("strong", null, `${Math.round(phases.down)}%`)),
                    h(ProgressBar, { value: phases.down }),
                  ),
                  h(
                    "div",
                    { className: "scene-dashboard-phase-row" },
                    h("div", { className: "scene-dashboard-inline scene-dashboard-kpi-item" }, h("span", { className: "scene-dashboard-label" }, "Move"), h("strong", null, `${Math.round(phases.move)}%`)),
                    h(ProgressBar, { value: phases.move }),
                  ),
                  h(
                    "div",
                    { className: "scene-dashboard-phase-row" },
                    h("div", { className: "scene-dashboard-inline scene-dashboard-kpi-item" }, h("span", { className: "scene-dashboard-label" }, "Rig Up"), h("strong", null, `${Math.round(phases.up)}%`)),
                    h(ProgressBar, { value: phases.up }),
                  ),
                ),
              ),
            )
          : h(
              "div",
              { className: "scene-top-info-strip" },
              h(
                "div",
                { className: "scene-plan-kpis" },
                h("div", { className: "scene-dashboard-inline scene-dashboard-kpi-item" }, h("span", { className: "scene-dashboard-label" }, "Total Time"), h("strong", null, formatMinutes(activePlanSummary.totalMinutes))),
                h("div", { className: "scene-dashboard-inline scene-dashboard-kpi-item" }, h("span", { className: "scene-dashboard-label" }, "Round Trips"), h("strong", null, String(activePlanSummary.roundTrips))),
                h("div", { className: "scene-dashboard-inline scene-dashboard-kpi-item" }, h("span", { className: "scene-dashboard-label" }, "Loads"), h("strong", null, String(activePlanSummary.totalLoads))),
                h("div", { className: "scene-dashboard-inline scene-dashboard-kpi-item" }, h("span", { className: "scene-dashboard-label" }, "Stages"), h("strong", null, String(activePlanSummary.waves))),
              ),
              h(
                "div",
                { className: "scene-plan-dashboard" },
                h(
                  "div",
                  { className: "scene-plan-summary-card scene-plan-summary-card-title" },
                  h("span", { className: "scene-panel-kicker" }, "Plan Dashboard"),
                  h("strong", { className: "scene-plan-summary-title" }, isCustomizeActive ? "Customize Stats" : "Selection Stats"),
                ),
                h(
                  "div",
                  { className: "scene-dashboard-gauge-card" },
                  h("span", { className: "scene-dashboard-label" }, "Utilization"),
                  h(
                    "div",
                    { className: "scene-utilization-gauge" },
                    h(
                      "svg",
                      {
                        className: "scene-utilization-gauge-svg",
                        viewBox: "0 0 120 70",
                        "aria-hidden": "true",
                      },
                      h("path", {
                        className: "scene-utilization-gauge-track",
                        d: "M 10 60 A 50 50 0 0 1 110 60",
                        pathLength: "100",
                      }),
                      h("path", {
                        className: "scene-utilization-gauge-progress",
                        d: "M 10 60 A 50 50 0 0 1 110 60",
                        pathLength: "100",
                        style: { "--utilization-progress": Math.max(0, Math.min(activePlanDashboard.utilizationValue, 100)) },
                      }),
                    ),
                    h("div", { className: "scene-utilization-gauge-inner" }, h("strong", null, activePlanDashboard.utilization)),
                  ),
                ),
                h(
                  "div",
                  { className: "scene-dashboard-cost" },
                  h("span", { className: "scene-dashboard-label" }, "Cost"),
                  h("strong", null, activePlanDashboard.costEstimate),
                ),
                h(
                  "div",
                  { className: "scene-dashboard-pair" },
                  h("div", { className: "scene-dashboard-inline scene-dashboard-pair-item" }, h("span", { className: "scene-dashboard-label" }, "Loads / Truck"), h("strong", null, activePlanDashboard.loadsPerTruck)),
                  h("div", { className: "scene-dashboard-inline scene-dashboard-pair-item" }, h("span", { className: "scene-dashboard-label" }, "Crew Hours"), h("strong", null, activePlanDashboard.crewHours)),
                ),
              ),
            ),
        !isPlaybackRunning && !isPlaybackPaused
          ? h(
              "div",
              { className: "scene-plan-switcher-wrap" },
              h(
                "div",
                { className: "plan-switcher-shell" },
                h(PlanSwitcher, {
                  scenarios: scenarioPlans,
                  activePlanKey,
                  onSelect: (planKey) => {
                    setActivePlanKey(planKey);
                    if (planKey === "customize") {
                      return;
                    }
                    setActiveScenarioName(planKey);
                    onSelectPlan({ moveId: move.id, scenarioName: planKey });
                  },
                }),
              ),
            )
          : null,
      )
    : h(
        AppLayout,
        {
          title: move.name,
          subtitle: `${move.startLabel} -> ${move.endLabel}`,
          currentUser,
          onLogout,
          onBack,
          fullBleed: true,
        },
        h(
          "div",
          { className: "move-legacy-grid" },
          h(
            "aside",
            { className: "move-side-column" },
            h(
              Card,
              { className: "dashboard-section-card" },
              h("div", { className: "section-heading" }, h("h2", null, "Simulation Setup"), h("span", { className: "section-pill" }, `${totalTrucks} trucks`)),
              h("p", { className: "muted-copy section-spacing" }, "Set truck types and counts, then run the move using exactly this fleet."),
              h(TruckSetupEditor, {
                truckSetup,
                onChange: (truckId, field, value) =>
                  field === "count"
                    ? updateTruckCount(truckId, value)
                    : setTruckSetup((current) =>
                        current.map((item) => (item.id === truckId ? { ...item, [field]: value } : item)),
                      ),
                onAddRow: () =>
                  setTruckSetup((current) => [...current, { id: `truck-${Date.now()}`, type: "", count: "0" }]),
                onRemoveRow: (truckId) =>
                  setTruckSetup((current) => current.filter((item) => item.id !== truckId)),
              }),
              simulationError ? h("p", { className: "field-error section-spacing" }, simulationError) : null,
              h(
                "div",
                { className: "move-setup-actions" },
                h(Button, {
                  type: "button",
                  isBusy: isSimulating,
                  onClick: () => onRunCustomPlan({ moveId: move.id, truckSetup }),
                  children: "Run",
                }),
              ),
            ),
          ),
          h(
            "section",
            { className: "move-main-column" },
            h(
              "div",
              { className: "move-view-switcher" },
              ["map", "schedule"].map((view) =>
                h(
                  "button",
                  {
                    key: view,
                    type: "button",
                    className: `move-view-switcher-button${activeView === view ? " active" : ""}`,
                    onClick: () => setActiveView(view),
                  },
                  view === "map" ? "3D View" : "Load Schedule",
                ),
              ),
            ),
            h(
              Card,
              { className: "dashboard-section-card map-stage-card" },
              h(
                "div",
                { className: "section-heading" },
                h("div", null, h("h2", null, "Load Schedule"), h("p", { className: "muted-copy" }, `${move.routeMode === "live" ? "Live routing" : "Estimated routing"} - ${move.routeTime}`)),
                h("span", { className: "section-pill" }, activeScenario.name),
              ),
              h(LoadScheduleTable, {
                playback: displaySimulation.bestPlan.playback,
                currentMinute: visibleMinute,
              }),
            ),
          ),
          h(
            "aside",
            { className: "move-side-column" },
            h(
              Card,
              { className: "dashboard-section-card" },
              h("div", { className: "section-heading" }, h("h2", null, "Rig Load Counts")),
              h(
                "div",
                { className: "rig-load-grid" },
                h(StatCard, {
                  label: "Source",
                  value: String(rigLoads.sourceCount),
                  meta: `${move.startLabel}`,
                  tone: "default",
                }),
                h(StatCard, {
                  label: "Moving",
                  value: String(rigLoads.movingCount),
                  meta: "In transfer or rig-up",
                  tone: "default",
                }),
                h(StatCard, {
                  label: "Destination",
                  value: String(rigLoads.destinationCount),
                  meta: `${move.endLabel}`,
                  tone: "green",
                }),
              ),
            ),
            h(
              Card,
              { className: "dashboard-section-card" },
              h("div", { className: "section-heading" }, h("h2", null, "Move Progress"), h("span", { className: "section-pill" }, `${completion}%`)),
              h("div", { className: "phase-stack" },
                h("div", { className: "phase-row" }, h("span", null, "Rig Down"), h("strong", null, `${Math.round(phases.down)}%`), h(ProgressBar, { value: phases.down })),
                h("div", { className: "phase-row" }, h("span", null, "Move"), h("strong", null, `${Math.round(phases.move)}%`), h(ProgressBar, { value: phases.move })),
                h("div", { className: "phase-row" }, h("span", null, "Rig Up"), h("strong", null, `${Math.round(phases.up)}%`), h(ProgressBar, { value: phases.up })),
              ),
            ),
            h(
              Card,
              { className: "dashboard-section-card latest-log-card" },
              h("div", { className: "section-heading" }, h("h2", null, "Latest Log")),
              h("p", { className: "muted-copy section-spacing" }, lastLog?.title || "Waiting for simulation"),
              h("p", { className: "muted-copy" }, lastLog?.description || "No events yet."),
            ),
          ),
          h(
            "section",
            { className: "move-full-row" },
            h(
              Card,
              { className: "dashboard-section-card" },
              h(
                "div",
                { className: "scenario-breakdown-row" },
                h(
                  "div",
                  { className: "scenario-breakdown-copy" },
                  h("div", { className: "section-heading" }, h("h2", null, "Scenario Breakdown")),
                  h("p", { className: "muted-copy section-spacing" }, "Switch between automatically generated fleet plans with different truck counts."),
                ),
                h(ScenarioBreakdown, {
                  scenarios: scenarioPlans,
                  activeScenarioName: activeScenario.name,
                  onSelect: (scenarioName) => {
                    setActivePlanKey(scenarioName);
                    setActiveScenarioName(scenarioName);
                    onSelectPlan({ moveId: move.id, scenarioName });
                  },
                }),
              ),
            ),
          ),
        ),
      );
}

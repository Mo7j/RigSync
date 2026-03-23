import { React, h } from "../lib/react.js";
import { AppLayout } from "../layouts/AppLayout.js";
import { Button } from "../components/ui/Button.js";
import { Card, StatCard } from "../components/ui/Card.js";
import { ProgressBar } from "../components/ui/ProgressBar.js";
import { Field, TextInput } from "../components/ui/Field.js";
import { LeafletMap } from "../components/map/LeafletMap.js";
import { formatMinutes } from "../lib/format.js";

const { useEffect, useMemo, useState } = React;

function normalizeTruckSetup(move) {
  const source = move?.truckSetup?.length ? move.truckSetup : move?.simulation?.truckSetup || [];

  if (source.length) {
    return source.map((item, index) => ({
      id: item.id || `truck-${index + 1}`,
      type: item.type || "Truck",
      count: String(item.count ?? 0),
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
            min: "0",
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
        h("p", { className: "muted-copy" }, `${scenario.truckCount} trucks - ${scenario.workerCount} workers`),
      ),
    ),
  );
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

export function RigMovePage({
  move,
  currentMinute,
  isSimulating,
  simulationError,
  onSimulate,
  onBack,
  onLogout,
  currentUser,
}) {
  const [truckSetup, setTruckSetup] = useState(() => normalizeTruckSetup(move));
  const [activeScenarioName, setActiveScenarioName] = useState(move?.simulation?.preferredScenarioName || "");
  const [activeView, setActiveView] = useState("map");

  useEffect(() => {
    setTruckSetup(normalizeTruckSetup(move));
    setActiveScenarioName(move?.simulation?.preferredScenarioName || "");
    setActiveView("map");
  }, [move?.id, move?.updatedAt]);

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

  const displaySimulation = useMemo(
    () => ({
      ...move.simulation,
      workerCount: activeScenario.workerCount,
      truckCount: activeScenario.truckCount,
      bestPlan: activeScenario.bestVariant,
      bestScenario: activeScenario,
      routeGeometry: activeScenario.routeGeometry,
      routeMinutes: activeScenario.routeMinutes,
    }),
    [move.simulation, activeScenario],
  );

  const totalMinutes = displaySimulation.bestPlan.totalMinutes;
  const completion = Math.min(100, Math.round((Math.min(currentMinute, totalMinutes) / Math.max(totalMinutes, 1)) * 100));
  const totalTrucks = truckSetup.reduce((sum, item) => sum + (Number.parseInt(item.count, 10) || 0), 0);
  const phases = getPhasePercentages(displaySimulation.bestPlan.playback, currentMinute);
  const rigLoads = getRigLoadCounts(displaySimulation.bestPlan.playback, currentMinute);
  const lastLog = displaySimulation.bestPlan.playback.steps.filter((step) => step.minute <= currentMinute).slice(-1)[0] || displaySimulation.bestPlan.playback.steps[0];

  return h(
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
          h("p", { className: "muted-copy section-spacing" }, "Set truck types and counts, then simulate using exactly this fleet."),
          h(TruckSetupEditor, {
            truckSetup,
            onChange: (truckId, field, value) =>
              setTruckSetup((current) =>
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
              onClick: () => onSimulate({ moveId: move.id, truckSetup }),
              children: "Simulate",
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
              view === "map" ? "Map View" : "Load Schedule",
            ),
          ),
        ),
        h(
          Card,
          { className: "dashboard-section-card map-stage-card" },
          h(
            "div",
            { className: "section-heading" },
            h("div", null, h("h2", null, activeView === "map" ? "Simulation View" : "Load Schedule"), h("p", { className: "muted-copy" }, `${move.routeMode === "live" ? "Live routing" : "Estimated routing"} - ${move.routeTime}`)),
            h("span", { className: "section-pill" }, activeScenario.name),
          ),
          activeView === "map"
            ? h(LeafletMap, {
                startPoint: move.startPoint,
                endPoint: move.endPoint,
                simulation: displaySimulation,
                currentMinute: Math.min(currentMinute, totalMinutes),
                heightClass: "map-frame map-frame-stage map-frame-stage-compact",
              })
            : h(LoadScheduleTable, {
                playback: displaySimulation.bestPlan.playback,
                currentMinute: Math.min(currentMinute, totalMinutes),
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
              h("p", { className: "muted-copy section-spacing" }, "Switch between route/order scenarios generated with the same fleet size."),
            ),
            h(ScenarioBreakdown, {
              scenarios: scenarioPlans,
              activeScenarioName: activeScenario.name,
              onSelect: setActiveScenarioName,
            }),
          ),
        ),
      ),
    ),
  );
}

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
  const [activeScenarioName, setActiveScenarioName] = useState(move?.simulation?.bestScenario?.name || "");

  useEffect(() => {
    setTruckSetup(normalizeTruckSetup(move));
    setActiveScenarioName(move?.simulation?.bestScenario?.name || "");
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

  if (!move.simulation?.bestPlan) {
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
    move.simulation.bestScenario ||
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
        h(
          Card,
          { className: "dashboard-section-card" },
          h("div", { className: "section-heading" }, h("h2", null, "Scenario Breakdown")),
          h("p", { className: "muted-copy section-spacing" }, "Switch between route/order scenarios generated with the same fleet size."),
          h(ScenarioBreakdown, {
            scenarios: scenarioPlans,
            activeScenarioName: activeScenario.name,
            onSelect: setActiveScenarioName,
          }),
        ),
      ),
      h(
        "section",
        { className: "move-main-column" },
        h(
          Card,
          { className: "dashboard-section-card map-stage-card" },
          h(
            "div",
            { className: "section-heading" },
            h("div", null, h("h2", null, "Simulation View"), h("p", { className: "muted-copy" }, `${move.routeMode === "live" ? "Live routing" : "Estimated routing"} - ${move.routeTime}`)),
            h("span", { className: "section-pill" }, activeScenario.name),
          ),
          h(LeafletMap, {
            startPoint: move.startPoint,
            endPoint: move.endPoint,
            simulation: displaySimulation,
            currentMinute: Math.min(currentMinute, totalMinutes),
            heightClass: "map-frame map-frame-stage map-frame-stage-compact",
          }),
          h(
            "div",
            { className: "map-log-card" },
            h("span", { className: "section-pill" }, "Latest Log"),
            h("strong", null, lastLog?.title || "Waiting for simulation"),
            h("p", { className: "muted-copy" }, lastLog?.description || "No events yet."),
          ),
        ),
      ),
      h(
        "aside",
        { className: "move-side-column" },
        h(
          Card,
          { className: "dashboard-section-card" },
          h("div", { className: "section-heading" }, h("h2", null, "Rig Load Counts")),
          h("p", { className: "muted-copy section-spacing" }, "Live count of loads at the source, currently moving, and completed at the destination."),
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
          h(StatCard, { label: "Total Progress", value: `${completion}%`, meta: `${formatMinutes(Math.round(Math.min(currentMinute, totalMinutes)))} of ${formatMinutes(totalMinutes)}`, tone: "green" }),
          h("div", { className: "phase-stack" },
            h("div", { className: "phase-row" }, h("span", null, "Rig Down"), h("strong", null, `${Math.round(phases.down)}%`), h(ProgressBar, { value: phases.down })),
            h("div", { className: "phase-row" }, h("span", null, "Move"), h("strong", null, `${Math.round(phases.move)}%`), h(ProgressBar, { value: phases.move })),
            h("div", { className: "phase-row" }, h("span", null, "Rig Up"), h("strong", null, `${Math.round(phases.up)}%`), h(ProgressBar, { value: phases.up })),
          ),
        ),
      ),
    ),
  );
}

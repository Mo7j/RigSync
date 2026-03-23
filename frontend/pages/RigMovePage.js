import { h } from "../lib/react.js";
import { AppLayout } from "../layouts/AppLayout.js";
import { Button } from "../components/ui/Button.js";
import { Card, StatCard } from "../components/ui/Card.js";
import { ProgressBar } from "../components/ui/ProgressBar.js";
import { SelectInput, Field } from "../components/ui/Field.js";
import { LeafletMap } from "../components/map/LeafletMap.js";
import { formatMinutes } from "../lib/format.js";
import { getTruckStatus } from "../features/rigMoves/simulation.js";

function ScenarioSummary({ scenarioPlans, bestScenario }) {
  return h(
    "div",
    { className: "scenario-list" },
    scenarioPlans.map((plan) =>
      h(
        Card,
        {
          key: plan.name,
          className: `scenario-card${plan.name === bestScenario?.name ? " scenario-card-active" : ""}`,
        },
        h("div", { className: "scenario-head" }, h("strong", null, plan.name), h("span", null, formatMinutes(plan.totalMinutes))),
        h("p", { className: "muted-copy" }, `${plan.workerCount} workers • ${plan.truckCount} trucks • Capacity ${plan.capacity}`),
      ),
    ),
  );
}

function EventFeed({ steps }) {
  return h(
    "div",
    { className: "event-feed" },
    steps.map((step, index) =>
      h(
        "article",
        { key: `${step.type}-${step.minute}-${index}`, className: "event-row" },
        h("span", { className: "event-time" }, formatMinutes(Math.round(step.minute))),
        h("div", null, h("strong", null, step.title), h("p", { className: "muted-copy" }, step.description)),
      ),
    ),
  );
}

function FleetGrid({ simulation, currentMinute }) {
  return h(
    "div",
    { className: "fleet-grid" },
    Array.from({ length: simulation.truckCount }, (_, index) => index + 1).map((truckId) =>
      h(
        Card,
        { key: truckId, className: "fleet-card" },
        h("span", { className: "section-pill" }, `Truck ${truckId}`),
        h("strong", null, getTruckStatus(simulation.bestPlan.playback, currentMinute, truckId)),
      ),
    ),
  );
}

export function RigMovePage({
  move,
  currentMinute,
  playbackSpeed,
  onPlaybackSpeedChange,
  onBack,
  onLogout,
  currentUser,
}) {
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
      },
      h(
        Card,
        { className: "empty-state" },
        h("h2", null, "Imported move"),
        h("p", { className: "muted-copy" }, "This move came from legacy history data, so only the summary metadata is available."),
      ),
    );
  }

  const totalMinutes = move.simulation.bestPlan.totalMinutes;
  const completion = Math.min(100, Math.round((currentMinute / Math.max(totalMinutes, 1)) * 100));
  const recentSteps = move.simulation.bestPlan.playback.steps
    .filter((step) => step.minute <= currentMinute)
    .slice(-6)
    .reverse();

  return h(
    AppLayout,
    {
      title: move.name,
      subtitle: `${move.startLabel} → ${move.endLabel}`,
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
          h("div", { className: "section-heading" }, h("h2", null, "Move Progress"), h("span", { className: "section-pill" }, `${completion}%`)),
          h(ProgressBar, { value: completion }),
          h("p", { className: "muted-copy section-spacing" }, `${formatMinutes(Math.round(currentMinute))} elapsed of ${formatMinutes(totalMinutes)} total ETA.`),
          h(
            "div",
            { className: "stat-grid" },
            h(StatCard, { label: "Distance", value: `${move.routeKm} km`, meta: "Route span", tone: "green" }),
            h(StatCard, { label: "Loads", value: String(move.loadCount), meta: "Logical move units", tone: "default" }),
            h(StatCard, { label: "Best plan", value: move.simulation.bestScenario.name, meta: move.eta, tone: "green" }),
          ),
        ),
        h(
          Card,
          { className: "dashboard-section-card" },
          h("div", { className: "section-heading" }, h("h2", null, "Scenario Breakdown")),
          h(ScenarioSummary, {
            scenarioPlans: move.simulation.scenarioPlans,
            bestScenario: move.simulation.bestScenario,
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
            { className: "section-heading section-heading-space" },
            h("div", null, h("h2", null, "Simulation View"), h("p", { className: "muted-copy" }, `${move.routeMode === "live" ? "Live routing" : "Estimated routing"} • ${move.routeTime}`)),
            h(
              "div",
              { className: "speed-control" },
              h(
                Field,
                { label: "Playback" },
                h(
                  SelectInput,
                  {
                    value: String(playbackSpeed),
                    onChange: (event) => onPlaybackSpeedChange(Number(event.target.value)),
                  },
                  [0.5, 1, 2, 4, 8].map((speed) => h("option", { key: speed, value: String(speed) }, `${speed}x`)),
                ),
              ),
            ),
          ),
          h(LeafletMap, {
            startPoint: move.startPoint,
            endPoint: move.endPoint,
            simulation: move.simulation,
            currentMinute,
            heightClass: "map-frame map-frame-stage",
          }),
        ),
      ),
      h(
        "aside",
        { className: "move-side-column" },
        h(
          Card,
          { className: "dashboard-section-card" },
          h("div", { className: "section-heading" }, h("h2", null, "Fleet Status")),
          h(FleetGrid, { simulation: move.simulation, currentMinute }),
        ),
        h(
          Card,
          { className: "dashboard-section-card" },
          h("div", { className: "section-heading" }, h("h2", null, "Operation Log")),
          h(EventFeed, { steps: recentSteps }),
        ),
        h(
          Card,
          { className: "dashboard-section-card" },
          h("div", { className: "section-heading" }, h("h2", null, "Controls")),
          h(Button, {
            type: "button",
            variant: "secondary",
            onClick: onBack,
            children: "Back to Dashboard",
          }),
        ),
      ),
    ),
  );
}

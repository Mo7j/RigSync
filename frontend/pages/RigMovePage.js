import { React, h } from "../lib/react.js";
import { AppLayout } from "../layouts/AppLayout.js";
import { Button } from "../components/ui/Button.js";
import { Card, StatCard } from "../components/ui/Card.js";
import { ProgressBar } from "../components/ui/ProgressBar.js";
import { Field, TextInput } from "../components/ui/Field.js";
import { Modal } from "../components/ui/Modal.js";
import { formatLocationLabel, formatMinutes } from "../lib/format.js";
import { translate } from "../lib/language.js";
import { buildScenarioPlans } from "../features/rigMoves/simulation.js";
import { buildOperatingSnapshot, buildStartupTransferSchedule } from "../features/rigMoves/operations.js";
import { persistMoveSession } from "../features/rigMoves/storage.js";

const { useDeferredValue, useEffect, useMemo, useRef, useState } = React;

function normalizeTruckTypeKey(type) {
  const normalized = String(type || "")
    .toLowerCase()
    .replace(/[^a-z]/g, "");

  if (normalized.includes("flatbed")) {
    return "flatbed";
  }
  if (normalized.includes("lowbed") || normalized.includes("support")) {
    return "lowbed";
  }
  if (normalized.includes("heavyhaul")) {
    return "heavyhauler";
  }

  return normalized;
}

function normalizeTruckTypeLabel(type) {
  const normalized = normalizeTruckTypeKey(type);
  if (normalized === "support" || normalized === "lowbed") {
    return "Low-bed";
  }
  if (normalized === "flatbed") {
    return "Flat-bed";
  }
  if (normalized === "heavyhaul" || normalized === "heavyhauler") {
    return "Heavy Hauler";
  }
  return String(type || "").trim() || "Truck";
}

function getTruckShortLabel(type) {
  const normalized = normalizeTruckTypeLabel(type);
  if (normalized === "Heavy Hauler") {
    return "HH";
  }
  if (normalized === "Flat-bed") {
    return "Flat";
  }
  if (normalized === "Low-bed") {
    return "Low";
  }
  return normalized;
}

function getLoadDisplayLabel(entity) {
  const loadCode = entity?.loadCode || entity?.code;
  if (loadCode) {
    return String(loadCode);
  }
  const loadId = entity?.loadId ?? entity?.id;
  return `#${loadId}`;
}

function formatTruckMixSummary(truckSetup = []) {
  const parts = (truckSetup || [])
    .filter((truck) => Math.max(0, Number.parseInt(truck?.count, 10) || 0) > 0)
    .map((truck) => `${getTruckShortLabel(truck.type)} x${Math.max(0, Number.parseInt(truck.count, 10) || 0)}`);

  return parts.join(", ") || "No trucks";
}

function getFleetCapacityForType(availableFleet, truckType) {
  const normalizedTruckType = normalizeTruckTypeKey(truckType);
  const matched = (availableFleet || []).find(
    (truck) => normalizeTruckTypeKey(truck?.type) === normalizedTruckType,
  );

  return Math.max(0, Number.parseInt(matched?.available ?? matched?.count, 10) || 0);
}

function formatProgressDuration(ms = 0) {
  const totalSeconds = Math.max(0, Math.round((Number(ms) || 0) / 1000));
  if (totalSeconds < 60) {
    return `${totalSeconds}s`;
  }

  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return seconds ? `${minutes}m ${seconds}s` : `${minutes}m`;
}

function normalizeTruckSetup(move, availableFleet = []) {
  const source = move?.truckSetup?.length ? move.truckSetup : move?.simulation?.truckSetup || [];
  const configuredByType = new Map();

  source.forEach((item, index) => {
    const type = normalizeTruckTypeLabel(item.type);
    const typeKey = normalizeTruckTypeKey(type);
    if (!typeKey || type === "Truck") {
      return;
    }
    configuredByType.set(typeKey, {
      id: item.id || `truck-${index + 1}`,
      type,
      count: String(Math.max(0, Number.parseInt(item.count, 10) || 0)),
      hourlyCost: Math.max(0, Number(item.hourlyCost) || 0),
    });
  });

  (availableFleet || []).forEach((item, index) => {
    const type = normalizeTruckTypeLabel(item.type);
    const key = normalizeTruckTypeKey(type);
    if (!configuredByType.has(key)) {
      configuredByType.set(key, {
        id: item.id || `fleet-${index + 1}`,
        type,
        count: "0",
        hourlyCost: Math.max(0, Number(item.hourlyCost) || 0),
      });
    }
  });

  const normalized = [...configuredByType.values()].filter((truck) => truck.type.trim());
  if (normalized.length) {
    return normalized;
  }

  return [{ id: "fleet-default", type: "Heavy Hauler", count: String(Math.max(1, move?.simulation?.truckCount || 1)), hourlyCost: 0 }];
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

function ScenarioBreakdown({ scenarios, activeScenarioName, onSelect, disabled = false }) {
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
          disabled,
          onClick: () => onSelect(scenario.name),
        },
        h("div", { className: "scenario-head" }, h("strong", null, scenario.name), h("span", null, formatDaysHours(scenario.totalMinutes))),
        h(
          "p",
          { className: "muted-copy" },
          formatTruckMixSummary(scenario.allocatedTruckSetup || scenario.truckSetup || []),
        ),
      ),
    ),
  );
}

function PlanSwitcher({ scenarios, activePlanKey, onSelect, includeCustomize = true, disabled = false }) {
  return h(
    "nav",
    { className: "plan-switcher", "aria-label": "Move plans" },
    [
      ...scenarios.map((scenario) => ({
        key: scenario.name,
        label: scenario.name,
        meta: formatTruckMixSummary(scenario.allocatedTruckSetup || scenario.truckSetup || []),
      })),
      ...(includeCustomize ? [{ key: "customize", label: "Customize", meta: "Manual" }] : []),
    ].map((item) =>
      h(
        "button",
        {
          key: item.key,
          type: "button",
          className: `plan-switcher-button${item.key === activePlanKey ? " active" : ""}`,
          disabled,
          onClick: () => onSelect(item.key),
        },
        h("span", { className: "plan-switcher-label" }, item.label),
        h("span", { className: "plan-switcher-meta" }, item.meta),
      ),
    ),
  );
}

function StartupLoadsPanel({ startupLoads, title, emptyCopy }) {
  if (!startupLoads?.length) {
    return h("p", { className: "muted-copy" }, emptyCopy || "No startup loads are configured.");
  }

  return h(
    "div",
    { className: "manager-rig-list" },
    startupLoads.map((load) =>
      h(
        "article",
        {
          key: load.id,
          className: `manager-rig-card startup-load-card startup-load-card-${load.readiness}`,
        },
        h(
          "div",
          { className: "manager-rig-head" },
          h(
            "div",
            null,
            h("strong", null, load.description),
            h("p", { className: "muted-copy" }, `${load.id} • ${load.count} loads needed`),
          ),
          h("span", { className: "section-pill" }, load.readiness === "covered" ? "Covered" : load.readiness === "partial" ? "Partial" : "Missing"),
        ),
        h(
          "div",
          { className: "manager-rig-stats" },
          h("div", { className: "manager-rig-stat" }, h("span", null, "Sourced"), h("strong", null, String(load.coveredCount))),
          h("div", { className: "manager-rig-stat" }, h("span", null, "Missing"), h("strong", null, String(load.missingCount))),
          h("div", { className: "manager-rig-stat" }, h("span", null, "Priority"), h("strong", null, `P${load.priority}`)),
          h("div", { className: "manager-rig-stat" }, h("span", null, "Truck"), h("strong", null, load.truckTypes.join(" / "))),
        ),
        h("p", { className: "muted-copy" }, load.dependencyLabel),
        load.sourcingPlan?.length
          ? h(
              "div",
              { className: "manager-note-list" },
              h("p", { className: "muted-copy" }, "Suggested source rigs"),
              ...load.sourcingPlan.map((source) =>
                h(
                  "div",
                  { key: `${load.id}-${source.moveId}`, className: "truck-count-row" },
                  h("span", null, source.rigLabel),
                  h("strong", null, `${source.assigned}/${source.available}`),
                ),
              ),
            )
          : h("p", { className: "muted-copy" }, "No completed donor rig is available yet for this load."),
      ),
    ),
  );
}

function ReusableLoadStockPanel({ reusableInventory }) {
  if (!reusableInventory?.length) {
    return h("p", { className: "muted-copy" }, "Reusable rig loads will appear here after the move data is ready.");
  }

  return h(
    "div",
    { className: "manager-rig-list" },
    reusableInventory.map((item) =>
      h(
        "article",
        { key: item.id, className: "manager-rig-card" },
        h(
          "div",
          { className: "manager-rig-head" },
          h(
            "div",
            null,
            h("strong", null, item.description),
            h("p", { className: "muted-copy" }, item.category),
          ),
          h("span", { className: "section-pill" }, `${item.count} loads`),
        ),
        h(
          "div",
          { className: "manager-rig-stats" },
          h("div", { className: "manager-rig-stat" }, h("span", null, "Reusable"), h("strong", null, String(item.count))),
          h("div", { className: "manager-rig-stat" }, h("span", null, "Truck"), h("strong", null, item.truckTypes.join(" / ") || "Assigned in plan")),
          h("div", { className: "manager-rig-stat" }, h("span", null, "Critical"), h("strong", null, item.isCritical ? "Yes" : "No")),
        ),
      ),
    ),
  );
}

function countRoundTrips(playback) {
  const journeys = playback?.journeys?.length ? playback.journeys : (playback?.trips || []);
  return journeys.filter((trip) => trip.returnToSource !== null).length;
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

function getTaskToneClass(task) {
  const phaseToneMap = {
    rig_down: "scene-timeline-segment-down",
    move: "scene-timeline-segment-move",
    pickup_load: "scene-timeline-segment-truck-lowbed",
    haul: "scene-timeline-segment-move",
    unload_drop: "scene-timeline-segment-truck-flatbed",
    rig_up: "scene-timeline-segment-up",
  };

  return phaseToneMap[task?.phase] || "scene-timeline-segment-move";
}

function getSourceKindLabel(sourceKind) {
  if (sourceKind === "startup") {
    return "Support";
  }
  if (sourceKind === "system") {
    return "System";
  }
  return "Rig";
}

function getPlannerTaskTypeCode(task) {
  if (task?.phase === "rig_down") {
    return "RD";
  }
  if (task?.phase === "pickup_load" || task?.phase === "haul" || task?.phase === "move") {
    return "RM";
  }
  return task?.sourceKind === "startup" ? "RU_SU" : "RU";
}

function getPlaybackTasks(playback) {
  const directTasks = playback?.tasks || [];
  if (directTasks.length) {
    return directTasks.map((task) => ({
      ...task,
      predecessorIds: [...(task.predecessorIds || [])],
      earliestStart: task.earliestStart ?? task.startMinute ?? 0,
      earliestFinish: task.earliestFinish ?? task.endMinute ?? 0,
      latestStart: task.latestStart ?? ((task.startMinute ?? 0) + (task.slack ?? 0)),
      latestFinish: task.latestFinish ?? ((task.endMinute ?? 0) + (task.slack ?? 0)),
      slack: task.slack ?? 0,
      isCritical: Boolean(task.isCritical),
    }));
  }

  const trips = playback?.trips || [];
  return trips.flatMap((trip) => {
    const loadCode = trip.loadCode || `#${trip.loadId}`;
    const description = trip.description || `Load ${loadCode}`;
    const rigDownStart = trip.rigDownStart ?? trip.loadStart ?? 0;
    const rigDownFinish = trip.rigDownFinish ?? rigDownStart;
    const pickupLoadStart = trip.pickupLoadStart ?? rigDownFinish;
    const pickupLoadFinish = trip.pickupLoadFinish ?? pickupLoadStart;
    const moveStart = trip.moveStart ?? pickupLoadFinish;
    const arrivalAtDestination = trip.arrivalAtDestination ?? moveStart;
    const unloadDropStart = trip.unloadDropStart ?? arrivalAtDestination;
    const unloadDropFinish = trip.unloadDropFinish ?? unloadDropStart;
    const rigUpStart = trip.rigUpStart ?? unloadDropFinish;
    const rigUpFinish = trip.rigUpFinish ?? rigUpStart;

    return [
      {
        id: `${trip.loadId}:rig_down`,
        loadId: trip.loadId,
        loadCode,
        description,
        phase: "rig_down",
        predecessorIds: [],
        startMinute: rigDownStart,
        endMinute: rigDownFinish,
        earliestStart: rigDownStart,
        earliestFinish: rigDownFinish,
        latestStart: rigDownStart,
        latestFinish: rigDownFinish,
        slack: 0,
        isCritical: false,
      },
      {
        id: `${trip.loadId}:pickup_load`,
        loadId: trip.loadId,
        loadCode,
        description,
        phase: "pickup_load",
        predecessorIds: [`${trip.loadId}:rig_down`],
        startMinute: pickupLoadStart,
        endMinute: pickupLoadFinish,
        earliestStart: pickupLoadStart,
        earliestFinish: pickupLoadFinish,
        latestStart: pickupLoadStart,
        latestFinish: pickupLoadFinish,
        slack: 0,
        isCritical: false,
      },
      {
        id: `${trip.loadId}:haul`,
        loadId: trip.loadId,
        loadCode,
        description,
        phase: "haul",
        predecessorIds: [`${trip.loadId}:pickup_load`],
        startMinute: moveStart,
        endMinute: arrivalAtDestination,
        earliestStart: moveStart,
        earliestFinish: arrivalAtDestination,
        latestStart: moveStart,
        latestFinish: arrivalAtDestination,
        slack: 0,
        isCritical: false,
      },
      {
        id: `${trip.loadId}:unload_drop`,
        loadId: trip.loadId,
        loadCode,
        description,
        phase: "unload_drop",
        predecessorIds: [`${trip.loadId}:haul`],
        startMinute: unloadDropStart,
        endMinute: unloadDropFinish,
        earliestStart: unloadDropStart,
        earliestFinish: unloadDropFinish,
        latestStart: unloadDropStart,
        latestFinish: unloadDropFinish,
        slack: 0,
        isCritical: false,
      },
      {
        id: `${trip.loadId}:rig_up`,
        loadId: trip.loadId,
        loadCode,
        description,
        phase: "rig_up",
        predecessorIds: [`${trip.loadId}:unload_drop`],
        startMinute: rigUpStart,
        endMinute: rigUpFinish,
        earliestStart: rigUpStart,
        earliestFinish: rigUpFinish,
        latestStart: rigUpStart,
        latestFinish: rigUpFinish,
        slack: 0,
        isCritical: false,
      },
    ];
  });
}

function getEffectiveCriticalTasks(playback) {
  const tasks = getPlaybackTasks(playback);
  const criticalTaskIds = new Set(playback?.planningAnalysis?.criticalTaskIds || []);
  let criticalTasks = tasks
    .filter((task) => task.isCritical || criticalTaskIds.has(task.id))
    .sort((left, right) => left.startMinute - right.startMinute || left.loadId - right.loadId);

  if (criticalTasks.length || !tasks.length) {
    return criticalTasks;
  }

  const tasksByLoad = new Map();
  tasks.forEach((task) => {
    if (!tasksByLoad.has(task.loadId)) {
      tasksByLoad.set(task.loadId, []);
    }
    tasksByLoad.get(task.loadId).push(task);
  });

  const loadRows = [...tasksByLoad.entries()]
    .map(([loadId, loadTasks]) => {
      const orderedTasks = [...loadTasks].sort((left, right) => left.startMinute - right.startMinute || left.endMinute - right.endMinute);
      const finishMinute = Math.max(...orderedTasks.map((task) => task.endMinute || 0), 0);
      const startMinute = Math.min(...orderedTasks.map((task) => task.startMinute || 0));
      return {
        loadId,
        startMinute: Number.isFinite(startMinute) ? startMinute : 0,
        finishMinute,
        tasks: orderedTasks,
      };
    })
    .sort((left, right) => right.finishMinute - left.finishMinute || left.startMinute - right.startMinute || left.loadId - right.loadId);

  const pivotLoad = loadRows[0];
  if (!pivotLoad) {
    return [];
  }

  return pivotLoad.tasks.map((task) => ({
    ...task,
    isCritical: true,
  }));
}

function getPlanDashboardStats(scenario, move) {
  const playback = scenario?.bestVariant?.playback;
  const trips = playback?.trips || [];
  const criticalTasks = getEffectiveCriticalTasks(playback);
  const criticalLoadIds = new Set(criticalTasks.map((task) => task.loadId));
  const totalMinutes = Math.max(scenario?.totalMinutes || 0, 1);
  const allocatedTruckSetup = scenario?.allocatedTruckSetup || scenario?.truckSetup || [];
  const usedTruckCount = Math.max(1, Number.parseInt(scenario?.truckCount, 10) || 1);
  const allocatedTruckCount = Math.max(
    usedTruckCount,
    allocatedTruckSetup.reduce((sum, truck) => sum + Math.max(0, Number.parseInt(truck?.count, 10) || 0), 0) ||
      Number.parseInt(scenario?.allocatedTruckCount, 10) ||
      usedTruckCount,
  );
  const utilization = Math.max(0, Number.parseInt(scenario?.utilization, 10) || 0);
  const truckUtilization = Math.max(0, Number.parseInt(scenario?.truckUtilization, 10) || utilization);
  const idleMinutes = Math.max(0, Number.parseInt(scenario?.idleMinutes, 10) || 0);
  const costEstimate = Math.max(0, Number(scenario?.costEstimate) || 0);

  return {
    utilizationValue: utilization,
    utilization: `${utilization}%`,
    truckUtilizationValue: truckUtilization,
    truckUtilization: `${truckUtilization}%`,
    rawCostEstimate: costEstimate,
    costEstimate: formatCurrency(costEstimate),
    usedTruckCount,
    allocatedTruckCount,
    truckUsageLabel: `${usedTruckCount}/${allocatedTruckCount}`,
    loadsPerTruck: (trips.length / usedTruckCount).toFixed(1),
    loadsPerAllocatedTruck: (trips.length / allocatedTruckCount).toFixed(1),
    idleMinutes,
    idleHours: (idleMinutes / 60).toFixed(1),
    criticalTaskCount: criticalTasks.length,
    criticalLoadCount: criticalLoadIds.size,
    criticalPathHours: (criticalTasks.reduce((sum, task) => sum + Math.max(0, task.endMinute - task.startMinute), 0) / 60).toFixed(1),
  };
}

function getTaskActivityLabel(task) {
  return task?.activityCode || task?.activityLabel || task?.phase || "Task";
}

function buildCriticalPathChain(playback) {
  return getEffectiveCriticalTasks(playback)
    .sort((left, right) => left.startMinute - right.startMinute || left.endMinute - right.endMinute)
    .map((task) => ({
      key: task.id,
      loadCode: task.loadCode || `#${task.loadId}`,
      activity: getTaskActivityLabel(task),
      sourceKind: task.sourceKind || "rig",
    }));
}

function buildCriticalScheduleRows(playback, limit = 10) {
  return getEffectiveCriticalTasks(playback)
    .sort((left, right) => left.startMinute - right.startMinute || left.endMinute - right.endMinute)
    .slice(0, limit)
    .map((task) => ({
      key: task.id,
      loadCode: task.loadCode || `#${task.loadId}`,
      activity: getTaskActivityLabel(task),
      sourceKind: task.sourceKind || "rig",
      start: Math.max(0, Math.round(task.startMinute || 0)),
      finish: Math.max(0, Math.round(task.endMinute || 0)),
      duration: Math.max(0, Math.round((task.endMinute || 0) - (task.startMinute || 0))),
      slack: Math.max(0, Math.round(task.slack || 0)),
    }));
}

function buildPlannerScheduleRows(playback, limit = 18) {
  return getPlaybackTasks(playback)
    .filter((task) => task.phase !== "start" && task.phase !== "finish")
    .sort((left, right) => (left.earliestStart ?? left.startMinute ?? 0) - (right.earliestStart ?? right.startMinute ?? 0) || left.loadId - right.loadId)
    .slice(0, limit)
    .map((task) => ({
      key: task.id,
      loadCode: task.loadCode || `#${task.loadId}`,
      activity: getTaskActivityLabel(task),
      sourceKind: task.sourceKind || "rig",
      es: Math.max(0, Math.round(task.earliestStart ?? task.startMinute ?? 0)),
      ef: Math.max(0, Math.round(task.earliestFinish ?? task.endMinute ?? 0)),
      ls: Math.max(0, Math.round(task.latestStart ?? task.startMinute ?? 0)),
      lf: Math.max(0, Math.round(task.latestFinish ?? task.endMinute ?? 0)),
      slack: Math.max(0, Math.round(task.slack || 0)),
      critical: Boolean(task.isCritical),
    }));
}

function buildPlannerCostRows(scenario, playback, move, limit = 8) {
  const journeys = playback?.journeys?.length ? playback.journeys : (playback?.trips || []);
  const configuredRates = new Map(
    (scenario?.allocatedTruckSetup || scenario?.truckSetup || []).map((truck) => [
      normalizeTruckTypeKey(truck?.type),
      Math.max(0, Number(truck?.hourlyCost) || 0),
    ]),
  );
  const routeKm = Math.max(0, Number(move?.routeKm) || Number(scenario?.routeDistanceKm) || 0);

  return journeys
    .map((journey, index) => {
      const truckRate = configuredRates.get(normalizeTruckTypeKey(journey.truckType)) || 0;
      const activeMinutes = Math.max(
        0,
        ((journey.moveStart || journey.dispatchStart || 0) - (journey.dispatchStart || 0)) +
        ((journey.returnStart || journey.arrivalAtDestination || 0) - (journey.moveStart || 0)) +
        ((journey.returnToSource || journey.returnStart || 0) - (journey.returnStart || 0)),
      );
      const tripCost = Math.round((activeMinutes / 60) * truckRate);

      return {
        key: journey.id || `cost-${index}`,
        label: journey.description || `Truck ${journey.truckId}`,
        truckType: journey.truckType || "Truck",
        truckId: journey.truckId,
        distanceKm: Math.round(routeKm * Math.max((journey.loadIds || []).length || 1, 1)),
        activeMinutes,
        tripCost,
      };
    })
    .sort((left, right) => right.tripCost - left.tripCost || right.activeMinutes - left.activeMinutes)
    .slice(0, limit);
}

function getPlanComparisonStats(scenarios, selectedScenario, move, currentMinute = 0) {
  const validScenarios = (scenarios || []).filter((scenario) => (scenario?.totalMinutes || 0) > 0);
  const selectedTotalMinutes = selectedScenario?.totalMinutes || 0;
  const averageMinutes = validScenarios.length
    ? Math.round(validScenarios.reduce((sum, scenario) => sum + (scenario.totalMinutes || 0), 0) / validScenarios.length)
    : selectedTotalMinutes;
  const timeSavedMinutes = Math.max(0, averageMinutes - selectedTotalMinutes);
  const timeSavedPercent = averageMinutes > 0 ? Math.round((timeSavedMinutes / averageMinutes) * 100) : 0;
  const playback = selectedScenario?.bestVariant?.playback;
  const trips = playback?.trips || [];
  const totalLoads = trips.length;
  const completedLoads = trips.filter((trip) => currentMinute >= trip.rigUpFinish).length;
  const planDashboard = getPlanDashboardStats(selectedScenario, move);
  const activeTruckIds = new Set(
    trips
      .filter((trip) => currentMinute >= (trip.dispatchStart ?? trip.pickupLoadStart ?? trip.loadStart) && currentMinute < (trip.returnToSource ?? trip.unloadDropFinish ?? trip.rigUpFinish))
      .map((trip) => trip.truckId),
  );
  const routeKm = Number(move?.routeKm) || 0;
  const costEstimate = planDashboard.rawCostEstimate || 0;
  const criticalTaskCount = getEffectiveCriticalTasks(playback).length;

  return {
    averageMinutes,
    timeSavedMinutes,
    timeSavedPercent,
    throughputLoadsPerDay: totalLoads > 0 && selectedTotalMinutes > 0 ? ((totalLoads / selectedTotalMinutes) * 1440).toFixed(1) : "0.0",
    progressPercent: totalLoads > 0 ? Math.round((completedLoads / totalLoads) * 100) : 0,
    activeFleet: activeTruckIds.size,
    costPerLoad: totalLoads > 0 ? formatCurrency(costEstimate / totalLoads) : formatCurrency(0),
    routeDistance: `${Math.round(routeKm * Math.max(totalLoads, 1))} km`,
    criticalPathTasks: criticalTaskCount,
  };
}

function getTruckFocusStats({ truckId, playback, currentMinute, totalMinutes, move }) {
  if (truckId == null || !playback?.trips?.length) {
    return null;
  }

  const truckTrips = playback.trips.filter((trip) => trip.truckId === truckId);
  if (!truckTrips.length) {
    return null;
  }

  const activeTrip = truckTrips.find(
    (trip) => currentMinute >= (trip.dispatchStart ?? trip.pickupLoadStart ?? trip.loadStart) && currentMinute < (trip.returnToSource ?? trip.unloadDropFinish ?? trip.rigUpFinish),
  ) || null;
  const completedLoads = truckTrips.filter((trip) => currentMinute >= trip.rigUpFinish).length;
  const busyMinutes = truckTrips.reduce(
    (sum, trip) => sum + Math.max(0, (trip.returnToSource ?? trip.unloadDropFinish ?? trip.rigUpFinish) - (trip.dispatchStart ?? trip.pickupLoadStart ?? trip.loadStart)),
    0,
  );
  const utilization = Math.min(100, Math.round((busyMinutes / Math.max(totalMinutes, 1)) * 100));
  const nextTrip = truckTrips.find((trip) => currentMinute < (trip.dispatchStart ?? trip.pickupLoadStart ?? trip.loadStart)) || null;
  const lastTrip = [...truckTrips].reverse().find((trip) => currentMinute >= trip.rigUpFinish) || null;
  const routeKm = Number(move?.routeKm) || 0;
  const remainingAssignedLoads = truckTrips.filter((trip) => currentMinute < trip.rigUpFinish).length;

  let statusLabel = "Idle";
  let statusDetail = "Waiting for its next assignment.";

  if (activeTrip) {
    if (currentMinute < (activeTrip.pickupLoadStart ?? activeTrip.loadStart)) {
      statusLabel = "To Pickup";
      statusDetail = `Driving to collect #${activeTrip.loadId}.`;
    } else if (currentMinute < (activeTrip.pickupLoadFinish ?? activeTrip.moveStart ?? activeTrip.arrivalAtDestination)) {
      statusLabel = "Pickup";
      statusDetail = `Securing #${activeTrip.loadId} at the source rig.`;
    } else if (currentMinute < activeTrip.arrivalAtDestination) {
      statusLabel = "In Transit";
      statusDetail = `Hauling #${activeTrip.loadId} to destination.`;
    } else if (currentMinute < (activeTrip.unloadDropFinish ?? activeTrip.rigUpStart ?? activeTrip.rigUpFinish)) {
      statusLabel = "Unload";
      statusDetail = `Dropping #${activeTrip.loadId} at destination.`;
    } else {
      statusLabel = "Returning";
      statusDetail = "Returning to the source rig.";
    }
  } else if (nextTrip) {
    statusLabel = "Queued";
    statusDetail = `Next load #${nextTrip.loadId} starts in ${formatMinutes(Math.max(0, Math.round((nextTrip.dispatchStart ?? nextTrip.pickupLoadStart ?? nextTrip.loadStart) - currentMinute)))}`;
  } else if (lastTrip) {
    statusLabel = "Complete";
    statusDetail = `Finished assigned loads by ${formatMinutes(Math.round(lastTrip.rigUpFinish))}.`;
  }

  return {
    truckId,
    truckType: truckTrips[0]?.truckType || "Truck",
    statusLabel,
    statusDetail,
    completedLoads,
    remainingAssignedLoads,
    utilization,
    busyTime: formatMinutes(Math.round(busyMinutes)),
    nextMilestone: activeTrip
      ? formatMinutes(
          Math.round(
            Math.max(
              0,
              (currentMinute < (activeTrip.pickupLoadStart ?? activeTrip.loadStart)
                ? (activeTrip.pickupLoadStart ?? activeTrip.loadStart)
                : currentMinute < (activeTrip.pickupLoadFinish ?? activeTrip.moveStart ?? activeTrip.arrivalAtDestination)
                  ? (activeTrip.pickupLoadFinish ?? activeTrip.moveStart ?? activeTrip.arrivalAtDestination)
                  : currentMinute < activeTrip.arrivalAtDestination
                    ? activeTrip.arrivalAtDestination
                    : currentMinute < (activeTrip.unloadDropFinish ?? activeTrip.rigUpStart ?? activeTrip.rigUpFinish)
                      ? (activeTrip.unloadDropFinish ?? activeTrip.rigUpStart ?? activeTrip.rigUpFinish)
                      : activeTrip.returnToSource ?? activeTrip.rigUpFinish) - currentMinute,
            ),
          ),
        )
      : nextTrip
        ? formatMinutes(Math.max(0, Math.round((nextTrip.dispatchStart ?? nextTrip.pickupLoadStart ?? nextTrip.loadStart) - currentMinute)))
        : "0m",
    assignedDistance: `${Math.round(routeKm * truckTrips.length * 2)} km`,
  };
}

function getRigInsightStats({ side, move, playback, currentMinute, totalMinutes }) {
  const base = getRigSiteStats({ side, move, playback, currentMinute, totalMinutes });
  if (!base || !playback?.trips?.length) {
    return null;
  }

  const trips = playback.trips;
  const loadingNow = trips.filter((trip) => currentMinute >= (trip.rigDownStart ?? trip.loadStart) && currentMinute < (trip.pickupLoadFinish ?? trip.rigDownFinish)).length;
  const riggingNow = trips.filter(
    (trip) => currentMinute >= (trip.unloadDropFinish ?? trip.arrivalAtDestination) && currentMinute < trip.rigUpFinish,
  ).length;
  const nextEventMinute = side === "source"
    ? trips.filter((trip) => currentMinute < trip.rigDownFinish).map((trip) => trip.rigDownFinish).sort((a, b) => a - b)[0]
    : trips.filter((trip) => currentMinute < trip.arrivalAtDestination).map((trip) => trip.arrivalAtDestination).sort((a, b) => a - b)[0];

  return {
    ...base,
    loadingNow,
    riggingNow,
    nextEventIn: nextEventMinute != null ? formatMinutes(Math.max(0, Math.round(nextEventMinute - currentMinute))) : "0m",
    sitePressure: side === "source" ? `${base.remainingLoads} still staged` : `${base.remainingLoads} still pending receipt`,
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
      count: Math.max(0, Number.parseInt(truck.count, 10) || 0),
      hourlyCost: Math.max(0, Number(truck.hourlyCost) || 0),
    }))
    .filter((truck) => truck.type.trim());

  if (!normalized.length) {
    return [{ id: "fleet-default", type: "Heavy Hauler", count: Math.max(1, targetTotal || 1) }];
  }

  return normalized;
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
  const label = side === "source"
    ? formatLocationLabel(move?.startLabel, "Source Site")
    : formatLocationLabel(move?.endLabel, "Destination Site");
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
    side,
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
  const move = (trips.filter((trip) => currentMinute >= (trip.unloadDropFinish ?? trip.arrivalAtDestination)).length / totalTrips) * 100;
  const up = (trips.filter((trip) => currentMinute >= trip.rigUpFinish).length / totalTrips) * 100;
  return { down, move, up };
}

function getRigLoadCounts(playback, currentMinute) {
  const trips = playback?.trips || [];
  const sourceCount = trips.filter((trip) => currentMinute < trip.rigDownFinish).length;
  const movingCount = trips.filter(
    (trip) => currentMinute >= (trip.moveStart ?? trip.pickupLoadFinish ?? trip.rigDownFinish) && currentMinute < trip.rigUpFinish,
  ).length;
  const destinationCount = trips.filter((trip) => currentMinute >= trip.rigUpFinish).length;
  return {
    sourceCount,
    movingCount,
    destinationCount,
    totalCount: trips.length,
  };
}

function buildTruckScheduleRows(playback) {
  const journeys = playback?.journeys?.length ? playback.journeys : (playback?.trips || []);
  const totalMinutes = Math.max(playback?.totalMinutes || 1, 1);

  function getTruckToneClass(truckType) {
    const normalized = String(truckType || "").trim().toLowerCase();
    if (normalized.includes("flat")) {
      return "scene-timeline-segment-truck-flatbed";
    }
    if (normalized.includes("low") || normalized.includes("support")) {
      return "scene-timeline-segment-truck-lowbed";
    }
    return "scene-timeline-segment-truck-heavyhaul";
  }

  const usedTruckIds = [...new Set(journeys.map((trip) => trip.truckId))].sort((left, right) => left - right);

  return usedTruckIds.map((truckId) => {
    let rowToneClass = "scene-timeline-segment-truck-heavyhaul";
    const truckItems = journeys
      .filter((trip) => trip.truckId === truckId)
      .flatMap((trip, tripIndex) => {
        const items = [];
        const toneClass = getTruckToneClass(trip.truckType);

        if ((trip.pickupLoadStart ?? 0) > (trip.dispatchStart ?? trip.pickupLoadStart ?? 0)) {
          items.push({
            key: `${truckId}-${trip.loadId}-${tripIndex}-pickup`,
            loadId: trip.loadIds?.[0] ?? trip.loadId,
            description: `${trip.description} to pickup`,
            startMinute: trip.dispatchStart ?? trip.pickupLoadStart,
            endMinute: trip.moveStart ?? trip.pickupLoadStart,
            left: (((trip.dispatchStart ?? trip.pickupLoadStart) / totalMinutes) * 100),
            width: ((((trip.moveStart ?? trip.pickupLoadStart) - (trip.dispatchStart ?? trip.pickupLoadStart)) / totalMinutes) * 100),
            toneClass,
            label: trip.description || getLoadDisplayLabel(trip),
          });
        }

        if ((trip.arrivalAtDestination ?? 0) > (trip.moveStart ?? trip.pickupLoadFinish ?? trip.rigDownFinish ?? 0)) {
          items.push({
            key: `${truckId}-${trip.loadId}-${tripIndex}-move`,
            loadId: trip.loadIds?.[0] ?? trip.loadId,
            description: `${trip.description} move`,
            startMinute: trip.moveStart ?? trip.pickupLoadFinish ?? trip.rigDownFinish,
            endMinute: trip.arrivalAtDestination,
            left: (((trip.moveStart ?? trip.pickupLoadFinish ?? trip.rigDownFinish) / totalMinutes) * 100),
            width: (((trip.arrivalAtDestination - (trip.moveStart ?? trip.pickupLoadFinish ?? trip.rigDownFinish)) / totalMinutes) * 100),
            toneClass,
            label: trip.description || getLoadDisplayLabel(trip),
          });
        }

        if ((trip.returnToSource ?? 0) > (trip.returnStart ?? trip.unloadDropFinish ?? trip.arrivalAtDestination ?? 0)) {
          items.push({
            key: `${truckId}-${trip.loadId}-${tripIndex}-return`,
            loadId: trip.loadIds?.[0] ?? trip.loadId,
            description: `${trip.description} return`,
            startMinute: trip.returnStart ?? trip.unloadDropFinish ?? trip.arrivalAtDestination,
            endMinute: trip.returnToSource,
            left: (((trip.returnStart ?? trip.unloadDropFinish ?? trip.arrivalAtDestination) / totalMinutes) * 100),
            width: (((trip.returnToSource - (trip.returnStart ?? trip.unloadDropFinish ?? trip.arrivalAtDestination)) / totalMinutes) * 100),
            toneClass,
            label: trip.description || getLoadDisplayLabel(trip),
          });
        }

        return items;
      })
      .sort((left, right) => left.startMinute - right.startMinute);

    if (truckItems[0]?.toneClass) {
      rowToneClass = truckItems[0].toneClass;
    }

    return {
      key: `truck-${truckId}`,
      truckId,
      toneClass: rowToneClass,
      items: truckItems,
      loadCount: journeys.filter((trip) => trip.truckId === truckId).length,
    };
  });
}

function buildLoadScheduleRows(playback) {
  const trips = playback?.trips || [];
  const totalMinutes = Math.max(playback?.totalMinutes || 1, 1);

  return trips
    .map((trip, index) => {
      const items = [];
      const sourceKind = trip.sourceKind || "rig";
      const sourceLabel = getSourceKindLabel(sourceKind);

      if ((trip.rigDownFinish ?? 0) > (trip.rigDownStart ?? trip.loadStart ?? 0)) {
        items.push({
          key: `load-${trip.loadId}-${index}-down`,
          loadId: trip.loadId,
          description: `${trip.description} rig down`,
          startMinute: trip.rigDownStart ?? trip.loadStart,
          endMinute: trip.rigDownFinish,
          left: (((trip.rigDownStart ?? trip.loadStart ?? 0) / totalMinutes) * 100),
          width: (((trip.rigDownFinish || 0) - (trip.rigDownStart ?? trip.loadStart ?? 0)) / totalMinutes) * 100,
          toneClass: "scene-timeline-segment-down",
          label: "Down",
        });
      }

      if ((trip.pickupLoadFinish ?? 0) > (trip.pickupLoadStart ?? trip.rigDownFinish ?? 0)) {
        items.push({
          key: `load-${trip.loadId}-${index}-pickup`,
          loadId: trip.loadId,
          description: `${trip.description} pickup`,
          startMinute: trip.pickupLoadStart ?? trip.rigDownFinish,
          endMinute: trip.pickupLoadFinish,
          left: (((trip.pickupLoadStart ?? trip.rigDownFinish ?? 0) / totalMinutes) * 100),
          width: (((trip.pickupLoadFinish || 0) - (trip.pickupLoadStart ?? trip.rigDownFinish ?? 0)) / totalMinutes) * 100,
          toneClass: "scene-timeline-segment-truck-lowbed",
          label: "Pickup",
        });
      }

      if ((trip.arrivalAtDestination ?? 0) > (trip.moveStart ?? trip.pickupLoadFinish ?? trip.rigDownFinish ?? 0)) {
        items.push({
          key: `load-${trip.loadId}-${index}-move`,
          loadId: trip.loadId,
          description: `${trip.description} move`,
          startMinute: trip.moveStart ?? trip.pickupLoadFinish ?? trip.rigDownFinish,
          endMinute: trip.arrivalAtDestination,
          left: (((trip.moveStart ?? trip.pickupLoadFinish ?? trip.rigDownFinish ?? 0) / totalMinutes) * 100),
          width: (((trip.arrivalAtDestination || 0) - (trip.moveStart ?? trip.pickupLoadFinish ?? trip.rigDownFinish ?? 0)) / totalMinutes) * 100,
          toneClass: "scene-timeline-segment-move",
          label: "Move",
        });
      }

      if ((trip.unloadDropFinish ?? 0) > (trip.unloadDropStart ?? trip.arrivalAtDestination ?? 0)) {
        items.push({
          key: `load-${trip.loadId}-${index}-drop`,
          loadId: trip.loadId,
          description: `${trip.description} unload`,
          startMinute: trip.unloadDropStart ?? trip.arrivalAtDestination,
          endMinute: trip.unloadDropFinish,
          left: (((trip.unloadDropStart ?? trip.arrivalAtDestination ?? 0) / totalMinutes) * 100),
          width: (((trip.unloadDropFinish || 0) - (trip.unloadDropStart ?? trip.arrivalAtDestination ?? 0)) / totalMinutes) * 100,
          toneClass: "scene-timeline-segment-truck-flatbed",
          label: "Drop",
        });
      }

      if ((trip.rigUpFinish ?? 0) > (trip.rigUpStart ?? trip.arrivalAtDestination ?? 0)) {
        items.push({
          key: `load-${trip.loadId}-${index}-up`,
          loadId: trip.loadId,
          description: `${trip.description} rig up`,
          startMinute: trip.rigUpStart ?? trip.arrivalAtDestination,
          endMinute: trip.rigUpFinish,
          left: (((trip.rigUpStart ?? trip.arrivalAtDestination ?? 0) / totalMinutes) * 100),
          width: (((trip.rigUpFinish || 0) - (trip.rigUpStart ?? trip.arrivalAtDestination ?? 0)) / totalMinutes) * 100,
          toneClass: "scene-timeline-segment-up",
          label: "Up",
        });
      }

      return {
        key: `load-row-${trip.loadId}-${index}`,
        loadId: trip.loadId,
        label: `${getLoadDisplayLabel(trip)} · ${trip.description || `Load ${getLoadDisplayLabel(trip)}`}`,
        subLabel: `${sourceLabel} load · ${items.length} task segment${items.length === 1 ? "" : "s"}`,
        sourceKind,
        items,
      };
    })
    .sort((left, right) => left.loadId - right.loadId);
}

function buildCriticalPathRows(playback) {
  const criticalTasks = getEffectiveCriticalTasks(playback);
  const totalMinutes = Math.max(playback?.totalMinutes || 1, 1);
  const phaseToneMap = {
    rig_down: "scene-timeline-segment-down",
    pickup_load: "scene-timeline-segment-truck-lowbed",
    haul: "scene-timeline-segment-move",
    unload_drop: "scene-timeline-segment-truck-flatbed",
    rig_up: "scene-timeline-segment-up",
  };
  const phaseLabelMap = {
    rig_down: "Down",
    pickup_load: "Pickup",
    haul: "Move",
    unload_drop: "Drop",
    rig_up: "Up",
  };

  criticalTasks.forEach((task, index) => {
    if (!rowsByLoad.has(task.loadId)) {
      rowsByLoad.set(task.loadId, {
        key: `critical-load-${task.loadId}`,
        loadId: task.loadId,
        label: task.loadCode || task.description || `#${task.loadId}`,
        items: [],
      });
    }

      rowsByLoad.get(task.loadId).items.push({
      key: `${task.id}-${index}`,
      loadId: task.loadId,
      description: `${task.description} ${task.activityLabel || phaseLabelMap[task.phase] || task.phase}`,
      startMinute: task.startMinute,
      endMinute: task.endMinute,
      left: (task.startMinute / totalMinutes) * 100,
      width: ((task.endMinute - task.startMinute) / totalMinutes) * 100,
      toneClass: phaseToneMap[task.phase] || "scene-timeline-segment-move",
      label: task.activityCode || phaseLabelMap[task.phase] || task.phase,
    });
  });

  return [...rowsByLoad.values()]
    .map((row) => ({
      ...row,
      items: row.items.sort((left, right) => left.startMinute - right.startMinute),
    }))
    .sort((left, right) => left.items[0].startMinute - right.items[0].startMinute || left.loadId - right.loadId);
}

function buildCpmScheduleRows(playback) {
  const plannerTasks = getPlaybackTasks(playback)
    .filter((task) => task.phase !== "start" && task.phase !== "finish")
    .sort((left, right) =>
      (left.startMinute - right.startMinute) ||
      (left.endMinute - right.endMinute) ||
      (left.loadId - right.loadId),
    );
  const totalMinutes = Math.max(playback?.totalMinutes || 1, 1);
  return plannerTasks.map((task, index) => ({
    key: `cpm-activity-${task.id || index}`,
    loadId: task.loadId,
    label: `${task.loadCode || `#${task.loadId}`} ${task.activityCode || task.activityLabel || task.phase || ""}`.trim(),
    subLabel: "",
    sourceKind: task.sourceKind || "rig",
    critical: Boolean(task.isCritical),
    items: [
      {
        key: `${task.id}-${index}`,
        loadId: task.loadId,
        description: task.description || "Planner task",
        startMinute: task.startMinute,
        endMinute: task.endMinute,
        left: (task.startMinute / totalMinutes) * 100,
        width: ((task.endMinute - task.startMinute) / totalMinutes) * 100,
        toneClass: getTaskToneClass(task),
        label: task.activityCode || task.activityLabel || task.phase,
        typeCode: getPlannerTaskTypeCode(task),
        floatMinutes: Math.max(0, Number(task.slack) || 0),
        sourceKind: task.sourceKind || "rig",
        critical: Boolean(task.isCritical),
      },
    ],
  }));
  const rowsByLoad = new Map();

  plannerTasks.forEach((task, index) => {
    if (!rowsByLoad.has(task.loadId)) {
      rowsByLoad.set(task.loadId, {
        key: `cpm-load-${task.loadId}`,
        loadId: task.loadId,
        label: `${task.loadCode || task.description || `#${task.loadId}`} · ${task.description || "Planner task"}`,
        subLabel: `${getSourceKindLabel(task.sourceKind)} load`,
        sourceKind: task.sourceKind || "rig",
        items: [],
      });
    }

    rowsByLoad.get(task.loadId).items.push({
      key: `${task.id}-${index}`,
      loadId: task.loadId,
      description: `${task.description} ${task.activityLabel || task.phase || "Task"}`,
      startMinute: task.startMinute,
      endMinute: task.endMinute,
      left: (task.startMinute / totalMinutes) * 100,
      width: ((task.endMinute - task.startMinute) / totalMinutes) * 100,
      toneClass: getTaskToneClass(task),
      label: task.activityCode || task.activityLabel || task.phase,
      sourceKind: task.sourceKind || "rig",
      critical: Boolean(task.isCritical),
    });
  });

  return [...rowsByLoad.values()]
    .map((row) => ({
      ...row,
      subLabel: `${row.subLabel} · ${row.items.length} planner task${row.items.length === 1 ? "" : "s"}${row.items.some((item) => item.critical) ? " · critical path active" : ""}`,
      items: row.items.sort((left, right) => left.startMinute - right.startMinute),
    }))
    .sort((left, right) => left.items[0].startMinute - right.items[0].startMinute || left.loadId - right.loadId);
}

function buildCriticalPathNetwork(playback, zoom = 1) {
  const tasks = getPlaybackTasks(playback);
  const criticalTaskIds = new Set(getEffectiveCriticalTasks(playback).map((task) => task.id));
  const taskMap = new Map(tasks.map((task) => [task.id, task]));
  const phaseRank = {
    rig_down: 0,
    move: 1,
    pickup_load: 1,
    haul: 2,
    unload_drop: 3,
    rig_up: 4,
  };
  const columnMap = new Map();

  tasks.forEach((task) => {
    const bucket = Math.round((task.earliestStart ?? task.startMinute ?? 0) / 60);
    if (!columnMap.has(bucket)) {
      columnMap.set(bucket, []);
    }
    columnMap.get(bucket).push(task);
  });

  const orderedBuckets = [...columnMap.keys()].sort((left, right) => left - right);
  const nodes = [];
  const edges = [];
  const nodeLayout = new Map();
  const scale = Math.max(0.1, Number(zoom) || 1);
  const cardWidth = Math.round(172 * scale);
  const cardHeight = Math.round(98 * scale);
  const columnGap = Math.round(78 * scale);
  const rowGap = Math.round(42 * scale);

  orderedBuckets.forEach((bucket, columnIndex) => {
    const columnTasks = columnMap.get(bucket)
      .sort((left, right) =>
        (left.loadId - right.loadId) ||
        ((phaseRank[left.phase] || 0) - (phaseRank[right.phase] || 0)) ||
        String(left.id).localeCompare(String(right.id)),
      );
    columnTasks.forEach((task, rowIndex) => {
      const x = columnIndex * (cardWidth + columnGap);
      const y = rowIndex * (cardHeight + rowGap);
      nodeLayout.set(task.id, { x, y });
      nodes.push({
        ...task,
        x,
        y,
        width: cardWidth,
        height: cardHeight,
        duration: Math.max(0, (task.endMinute ?? 0) - (task.startMinute ?? 0)),
        totalFloat: Math.max(0, Math.round(task.slack ?? 0)),
        isCritical: task.isCritical || criticalTaskIds.has(task.id),
      });
    });
  });

  nodes.forEach((task) => {
    (task.predecessorIds || []).forEach((predecessorId) => {
      const from = nodeLayout.get(predecessorId);
      const to = nodeLayout.get(task.id);
      const predecessor = taskMap.get(predecessorId);
      if (!from || !to || !predecessor) {
        return;
      }
      edges.push({
        key: `${predecessorId}->${task.id}`,
        x1: from.x + cardWidth,
        y1: from.y + (cardHeight / 2),
        x2: to.x,
        y2: to.y + (cardHeight / 2),
        isCritical: (criticalTaskIds.has(predecessorId) || predecessor.isCritical) && (task.isCritical || criticalTaskIds.has(task.id)),
      });
    });
  });

  const width = Math.max(Math.round(900 * scale), ...nodes.map((node) => node.x + node.width + 40), Math.round(900 * scale));
  const height = Math.max(Math.round(420 * scale), ...nodes.map((node) => node.y + node.height + 40), Math.round(420 * scale));

  return { nodes, edges, width, height };
}

function CPMNetworkDiagram({ playback, zoom = 1 }) {
  const network = useMemo(() => buildCriticalPathNetwork(playback, zoom), [playback, zoom]);
  const numericZoom = Math.max(0.1, Number(zoom) || 1);
  const isCompactView = numericZoom <= 0.35;
  const isMidCompactView = numericZoom > 0.35 && numericZoom <= 0.6;

  if (!network.nodes.length) {
    return h(
      "div",
      { className: "empty-state scene-loading-card" },
      h("h2", null, "No CPM Task Data"),
      h("p", { className: "muted-copy" }, "Rebuild the move so the critical path network can be generated from the latest task graph."),
    );
  }

  return h(
    "section",
    {
      className: "scene-timeline-shell",
      style: {
        display: "block",
        overflow: "auto",
        padding: "20px",
      },
    },
    h(
      "div",
      {
        style: {
          minWidth: `${network.width}px`,
          minHeight: `${network.height}px`,
          position: "relative",
        },
      },
      h(
        "svg",
        {
          width: network.width,
          height: network.height,
          style: {
            position: "absolute",
            inset: 0,
            overflow: "visible",
          },
        },
        h(
          "defs",
          null,
          h("marker", {
            id: "cpm-arrow-default",
            markerWidth: "10",
            markerHeight: "10",
            refX: "8",
            refY: "3",
            orient: "auto",
            markerUnits: "strokeWidth",
          }, h("path", { d: "M0,0 L0,6 L9,3 z", fill: "#8fa3b8" })),
          h("marker", {
            id: "cpm-arrow-critical",
            markerWidth: "10",
            markerHeight: "10",
            refX: "8",
            refY: "3",
            orient: "auto",
            markerUnits: "strokeWidth",
          }, h("path", { d: "M0,0 L0,6 L9,3 z", fill: "#d7b64a" })),
        ),
        network.edges.map((edge) =>
          h("line", {
            key: edge.key,
            x1: edge.x1,
            y1: edge.y1,
            x2: edge.x2,
            y2: edge.y2,
            stroke: edge.isCritical ? "#d7b64a" : "#8fa3b8",
            strokeWidth: edge.isCritical ? 3 : 2,
            markerEnd: `url(#${edge.isCritical ? "cpm-arrow-critical" : "cpm-arrow-default"})`,
            opacity: edge.isCritical ? 0.95 : 0.6,
          }),
        ),
      ),
      network.nodes.map((node) =>
        h(
          "div",
          {
            key: node.id,
            style: {
              position: "absolute",
              left: `${node.x}px`,
              top: `${node.y}px`,
              width: `${node.width}px`,
              borderRadius: isCompactView ? "999px" : "16px",
              overflow: "hidden",
              background: "rgba(12, 16, 22, 0.96)",
              border: node.isCritical ? "2px solid rgba(215, 182, 74, 0.9)" : "1px solid rgba(143, 163, 184, 0.35)",
              boxShadow: node.isCritical ? "0 16px 40px rgba(215, 182, 74, 0.18)" : "0 12px 32px rgba(0,0,0,0.2)",
              minHeight: isCompactView ? `${Math.max(18, Math.round(node.height * 0.3))}px` : undefined,
            },
            title: `${node.description} | ES ${formatMinutes(Math.round(node.earliestStart || 0))} | EF ${formatMinutes(Math.round(node.earliestFinish || 0))} | LS ${formatMinutes(Math.round(node.latestStart || 0))} | LF ${formatMinutes(Math.round(node.latestFinish || 0))} | TF ${formatMinutes(Math.round(node.totalFloat || 0))}`,
          },
          isCompactView
            ? h(
                "div",
                {
                  style: {
                    minHeight: `${Math.max(18, Math.round(node.height * 0.3))}px`,
                    padding: "4px 8px",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    background: node.isCritical ? "linear-gradient(135deg, rgba(189,255,72,0.92), rgba(24,180,74,0.92))" : "linear-gradient(135deg, rgba(136,196,255,0.9), rgba(69,122,227,0.88))",
                    color: "#081018",
                    fontWeight: 800,
                    fontSize: `${Math.max(0.54, 0.62 * numericZoom)}rem`,
                    letterSpacing: "0.02em",
                    textAlign: "center",
                  },
                },
                `${node.loadCode || `#${node.loadId}`}`,
              )
            : [
                h(
                  "div",
                  {
                    style: {
                      display: "grid",
                      gridTemplateColumns: "1fr 1fr 1fr",
                      background: node.isCritical ? "linear-gradient(135deg, rgba(189,255,72,0.92), rgba(24,180,74,0.92))" : "linear-gradient(135deg, rgba(136,196,255,0.9), rgba(69,122,227,0.88))",
                      color: "#091018",
                      fontWeight: 800,
                      fontSize: `${0.78 * Math.max(0.85, Math.min(numericZoom, 1.8))}rem`,
                    },
                  },
                  h("div", { style: { padding: "8px 10px", textAlign: "center", borderRight: "1px solid rgba(9,16,24,0.18)" } }, String(Math.round(node.earliestStart || 0))),
                  h("div", { style: { padding: "8px 10px", textAlign: "center", borderRight: "1px solid rgba(9,16,24,0.18)" } }, String(Math.max(1, Math.round(node.duration || 0)))),
                  h("div", { style: { padding: "8px 10px", textAlign: "center" } }, String(Math.round(node.earliestFinish || 0))),
                ),
                h(
                  "div",
                  {
                    style: {
                      padding: isMidCompactView ? "8px 10px" : "10px 12px",
                      minHeight: `${Math.round((isMidCompactView ? 40 : 54) * Math.max(0.75, numericZoom))}px`,
                      display: "grid",
                      gap: "4px",
                      alignContent: "center",
                      textAlign: "center",
                    },
                  },
                  h("strong", { style: { fontSize: `${(isMidCompactView ? 0.72 : 0.84) * Math.max(0.85, Math.min(numericZoom, 1.8))}rem`, lineHeight: 1.2 } }, `${node.loadCode || `#${node.loadId}`} · ${node.activityCode || node.phase.replace("_", " ")}`),
                  isMidCompactView
                    ? null
                    : h("span", { className: "muted-copy", style: { fontSize: `${0.72 * Math.max(0.85, Math.min(numericZoom, 1.8))}rem` } }, node.activityLabel || node.description),
                ),
                h(
                  "div",
                  {
                    style: {
                      display: "grid",
                      gridTemplateColumns: "1fr 1fr 1fr",
                      background: "linear-gradient(135deg, rgba(84,218,212,0.92), rgba(35,160,170,0.9))",
                      color: "#071016",
                      fontWeight: 800,
                      fontSize: `${0.78 * Math.max(0.85, Math.min(numericZoom, 1.8))}rem`,
                    },
                  },
                  h("div", { style: { padding: "8px 10px", textAlign: "center", borderRight: "1px solid rgba(7,16,22,0.18)" } }, String(Math.round(node.latestStart || 0))),
                  h("div", { style: { padding: "8px 10px", textAlign: "center", borderRight: "1px solid rgba(7,16,22,0.18)" } }, String(Math.round(node.totalFloat || 0))),
                  h("div", { style: { padding: "8px 10px", textAlign: "center" } }, String(Math.round(node.latestFinish || 0))),
                ),
              ],
        ),
      ),
    ),
  );
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
                    title: `${getLoadDisplayLabel(trip)} | ${trip.description} | ${formatMinutes(Math.round(trip.loadStart))} -> ${formatMinutes(Math.round(trip.rigUpFinish))}`,
                  },
                  h("span", { className: "schedule-trip-label" }, getLoadDisplayLabel(trip)),
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

function FullScreenTimeline({
  playback,
  currentMinute,
  zoom = 1,
  gapMinutes = 8 * 60,
  cpOnly = false,
  showRD = true,
  showRM = true,
  showRU = true,
  showFloatBar = true,
}) {
  const headerScrollRef = useRef(null);
  const bodyScrollRef = useRef(null);
  const fixedBodyRef = useRef(null);
  const syncingHeaderRef = useRef(false);
  const syncingBodyRef = useRef(false);
  const [hoverCard, setHoverCard] = useState(null);
  const totalMinutes = Math.max(playback?.totalMinutes || 1, 1);
  const rowType = "cpm";
  const rows = useMemo(() => {
    const baseRows = buildCpmScheduleRows(playback);
    return baseRows.filter((row) => {
      const trip = row.items?.[0];
      if (!trip) {
        return false;
      }
      if (cpOnly && !row.critical) {
        return false;
      }
      if (trip.typeCode === "RD" && !showRD) {
        return false;
      }
      if (trip.typeCode === "RM" && !showRM) {
        return false;
      }
      if ((trip.typeCode === "RU" || trip.typeCode === "RU_SU") && !showRU) {
        return false;
      }
      return true;
    });
  }, [playback, cpOnly, showRD, showRM, showRU]);
  const tickStepMinutes = 24 * 60;
  const tickCount = Math.max(1, Math.ceil(totalMinutes / tickStepMinutes));
  const ticks = useMemo(
    () => Array.from({ length: tickCount + 1 }, (_, index) => {
      const minute = Math.min(totalMinutes, index * tickStepMinutes);
      return {
        key: `timeline-tick-${index}`,
        left: `${(minute / totalMinutes) * 100}%`,
        label: `${(minute / (24 * 60)).toFixed(1)}d`,
      };
    }),
    [tickCount, tickStepMinutes, totalMinutes],
  );
  const currentX = `${(Math.min(currentMinute, totalMinutes) / totalMinutes) * 100}%`;
  const pixelsPerTick = 112;
  const timelineWidth = Math.max(Math.round(tickCount * pixelsPerTick), 1);

  function handleHeaderScroll(event) {
    if (syncingHeaderRef.current) {
      syncingHeaderRef.current = false;
      return;
    }

    const nextLeft = event.currentTarget.scrollLeft;
    if (bodyScrollRef.current) {
      syncingBodyRef.current = true;
      bodyScrollRef.current.scrollLeft = nextLeft;
    }
  }

  function handleBodyScroll(event) {
    if (syncingBodyRef.current) {
      syncingBodyRef.current = false;
    }

    const nextLeft = event.currentTarget.scrollLeft;
    const nextTop = event.currentTarget.scrollTop;

    if (headerScrollRef.current && headerScrollRef.current.scrollLeft !== nextLeft) {
      syncingHeaderRef.current = true;
      headerScrollRef.current.scrollLeft = nextLeft;
    }

    if (fixedBodyRef.current && fixedBodyRef.current.scrollTop !== nextTop) {
      fixedBodyRef.current.scrollTop = nextTop;
    }

    if (hoverCard) {
      setHoverCard(null);
    }
  }

  function handleTripHover(event, label) {
    const bodyNode = bodyScrollRef.current;
    if (!bodyNode) {
      return;
    }

    const bounds = bodyNode.getBoundingClientRect();
    const cardWidth = 280;
    const cardHeight = 44;
    const rawLeft = event.clientX - bounds.left + bodyNode.scrollLeft + 14;
    const rawTop = event.clientY - bounds.top + bodyNode.scrollTop + 16;
    const minLeft = bodyNode.scrollLeft + 8;
    const maxLeft = bodyNode.scrollLeft + bodyNode.clientWidth - cardWidth - 8;
    const minTop = bodyNode.scrollTop + 8;
    const maxTop = bodyNode.scrollTop + bodyNode.clientHeight - cardHeight - 8;

    setHoverCard({
      label,
      left: Math.max(minLeft, Math.min(maxLeft, rawLeft)),
      top: Math.max(minTop, Math.min(maxTop, rawTop)),
    });
  }

  useEffect(() => {
    const bodyNode = bodyScrollRef.current;
    const headerNode = headerScrollRef.current;
    if (!bodyNode || !headerNode || totalMinutes <= 0) {
      return;
    }

    const markerOffset = (Math.min(currentMinute, totalMinutes) / totalMinutes) * timelineWidth;
    const viewportWidth = bodyNode.clientWidth;
    const maxScrollLeft = Math.max(0, timelineWidth - viewportWidth);
    const targetScrollLeft = Math.max(0, Math.min(maxScrollLeft, markerOffset - viewportWidth * 0.65));

    if (Math.abs(bodyNode.scrollLeft - targetScrollLeft) > 1) {
      syncingBodyRef.current = true;
      bodyNode.scrollLeft = targetScrollLeft;
    }

    if (Math.abs(headerNode.scrollLeft - targetScrollLeft) > 1) {
      syncingHeaderRef.current = true;
      headerNode.scrollLeft = targetScrollLeft;
    }
  }, [currentMinute, totalMinutes, timelineWidth]);

  return h(
    "section",
    { className: "scene-timeline-shell" },
    h(
      "div",
      { className: "scene-timeline-fixed-column" },
      h(
        "div",
        { className: "scene-timeline-header-copy" },
        h("span", null, rowType === "cpm" ? "CPM" : "Schedule"),
        h("strong", null, "Chart"),
      ),
      h(
        "div",
        { ref: fixedBodyRef, className: "scene-timeline-fixed-body" },
        rows.map((row) =>
          h(
            "div",
            { key: `timeline-copy-${row.key || row.truckId}`, className: "scene-timeline-row-copy" },
            h("strong", null, rowType === "phase" ? row.label : rowType === "load" ? row.label : rowType === "cpm" ? row.label : `Truck ${row.truckId}`),
            h(
              "span",
              null,
              row.subLabel
                ? row.subLabel
                : rowType === "phase"
                ? `${row.items.length} active window${row.items.length === 1 ? "" : "s"}`
                : rowType === "load"
                  ? `${row.items.length} task segment${row.items.length === 1 ? "" : "s"}`
                  : rowType === "cpm"
                    ? row.subLabel
                    : `${row.loadCount || row.items.length} road segment${(row.loadCount || row.items.length) === 1 ? "" : "s"}`,
            ),
          ),
        ),
      ),
    ),
    h(
      "div",
      { className: "scene-timeline-main" },
      h(
        "div",
        {
          ref: headerScrollRef,
          className: "scene-timeline-header-scroll",
          onScroll: handleHeaderScroll,
        },
        h(
          "div",
          { className: "scene-timeline-header-track", style: { width: `${timelineWidth}px` } },
          h(
            "div",
            { className: "scene-timeline-header" },
            h(
              "div",
              { className: "scene-timeline-ticks" },
              ticks.map((tick) =>
                h(
                  "span",
                  {
                    key: tick.key,
                    className: "scene-timeline-tick",
                    style: { left: tick.left },
                  },
                  tick.label,
                ),
              ),
            ),
          ),
        ),
      ),
      h(
        "div",
        {
          ref: bodyScrollRef,
          className: "scene-timeline-scroll",
          onScroll: handleBodyScroll,
        },
        h(
          "div",
          { className: "scene-timeline-canvas", style: { width: `${timelineWidth}px` } },
          null,
          hoverCard
            ? h(
                "div",
                {
                  className: "scene-timeline-hover-card move-floating-card is-visible",
                  style: {
                    left: `${hoverCard.left}px`,
                    top: `${hoverCard.top}px`,
                  },
                },
                h("div", { className: "scene-timeline-hover-card-title" }, hoverCard.label),
              )
            : null,
          rows.map((row) => {
            const rowKey = row.key || row.truckId;
            const rowTrips = (row.items || row.trips || []).map((trip) => {
              const tripStartMinute =
                rowType === "phase" || rowType === "load" || rowType === "cpm"
                  ? trip.startMinute
                  : trip.startMinute ?? trip.dispatchStart ?? trip.loadStart;
              const tripEndMinute =
                rowType === "phase" || rowType === "load" || rowType === "cpm"
                  ? trip.endMinute
                  : trip.endMinute ?? trip.returnToSource ?? trip.rigUpFinish;
              const tripWidthPercent =
                rowType === "phase" || rowType === "load" || rowType === "cpm"
                  ? trip.width
                  : trip.width ?? ((((trip.returnToSource ?? trip.rigUpFinish) - (trip.dispatchStart ?? trip.loadStart)) / totalMinutes) * 100);
              const tripWidthPx = (tripWidthPercent / 100) * timelineWidth;
              const tripSizeClass = tripWidthPx < 18 ? " is-micro" : tripWidthPx < 44 ? " is-compact" : "";
              const visibleDuration = Math.max(0, Math.min(currentMinute, tripEndMinute) - tripStartMinute);
              const activeFillPercent = tripEndMinute > tripStartMinute
                ? Math.max(0, Math.min(100, (visibleDuration / (tripEndMinute - tripStartMinute)) * 100))
                : 0;
              const toneClass = trip.toneClass || row.toneClass || "scene-timeline-segment-truck-heavyhaul";
              const leftPercent =
                rowType === "phase" || rowType === "load" || rowType === "cpm"
                  ? trip.left
                  : trip.left ?? (((trip.dispatchStart ?? trip.loadStart) / totalMinutes) * 100);
              const hoverText = rowType === "phase"
                ? `${row.label} | ${getLoadDisplayLabel(trip)} | ${formatTimelineClock(tripStartMinute)} -> ${formatTimelineClock(tripEndMinute)}`
                : rowType === "load"
                    ? `${row.label} | ${trip.label} | ${formatTimelineClock(tripStartMinute)} -> ${formatTimelineClock(tripEndMinute)}`
                  : rowType === "cpm"
                    ? `${row.label} | ${trip.description || trip.label} | ${trip.critical ? "Critical path | " : ""}${formatTimelineClock(tripStartMinute)} -> ${formatTimelineClock(tripEndMinute)}`
                  : `Truck ${row.truckId} | ${getLoadDisplayLabel(trip)} | ${formatTimelineClock(tripStartMinute)} -> ${formatTimelineClock(tripEndMinute)}`;

              return [
                showFloatBar && !trip.critical && trip.floatMinutes > 0
                  ? h("div", {
                      key: `${trip.key}-float`,
                      className: "scene-timeline-float-bar",
                      style: {
                        left: `${leftPercent + tripWidthPercent}%`,
                        width: `${(trip.floatMinutes / totalMinutes) * 100}%`,
                      },
                    })
                  : null,
                h(
                  "div",
                  {
                    key: trip.key,
                    className: `scene-timeline-trip${rowType === "phase" ? " is-phase" : rowType === "load" ? " is-phase" : rowType === "cpm" ? " is-phase" : " is-truck"}${tripSizeClass}`,
                    style: {
                      left: `${leftPercent}%`,
                      width: `${tripWidthPercent}%`,
                    },
                    onPointerEnter: (event) => handleTripHover(event, hoverText),
                    onPointerMove: (event) => handleTripHover(event, hoverText),
                    onPointerLeave: () => setHoverCard(null),
                  },
                  h(
                    "div",
                    { className: "scene-timeline-trip-shell" },
                    [
                      h("span", {
                        key: `${trip.key}-future`,
                        className: `scene-timeline-segment scene-timeline-segment-future ${toneClass}`,
                        style: {
                          left: "0%",
                          width: "100%",
                        },
                      }),
                      h("span", {
                        key: `${trip.key}-active`,
                        className: `scene-timeline-segment scene-timeline-segment-active${activeFillPercent >= 99.5 ? " is-complete" : ""} ${toneClass}`,
                        style: {
                          left: "0%",
                          width: `${activeFillPercent}%`,
                        },
                      }),
                    ],
                  ),
                ),
              ];
            });

            return h(
              "article",
              { key: `timeline-row-${rowKey}`, className: `scene-timeline-row${row.critical ? " is-critical" : ""}` },
              h(
                "div",
                { className: "scene-timeline-row-track" },
                ticks.map((tick) =>
                  h("span", {
                    key: `timeline-grid-${rowKey}-${tick.key}`,
                    className: "scene-timeline-grid-line",
                    style: { left: tick.left },
                  }),
                ),
                rowTrips,
              ),
            );
          }),
        ),
      ),
    ),
  );
}

function renderPlannerMetricGrid(metrics, className = "") {
  return h(
    "div",
    { className: `scene-planner-metric-grid${className ? ` ${className}` : ""}` },
    metrics.map((metric) =>
      h(
        "article",
        {
          key: metric.label,
          className: `scene-planner-metric-card${metric.tone ? ` is-${metric.tone}` : ""}`,
        },
        h("span", { className: "scene-planner-metric-label" }, metric.label),
        h("strong", { className: "scene-planner-metric-value" }, metric.value),
        metric.meta ? h("span", { className: "scene-planner-metric-meta" }, metric.meta) : null,
      ),
    ),
  );
}

function getAssignmentExecutionMetrics(assignments = [], executionProgress = {}) {
  if (!assignments.length) {
    const completedStageCount =
      (executionProgress?.rigDownCompleted ? 1 : 0) +
      (executionProgress?.rigMoveCompleted ? 1 : 0) +
      (executionProgress?.rigUpCompleted ? 1 : 0);
    return {
      driverCount: 0,
      totalStageTasks: 3,
      completedStageTasks: completedStageCount,
      actualPercent: Math.round((completedStageCount / 3) * 100),
      stagePercents: {
        down: executionProgress?.rigDownCompleted ? 100 : 0,
        move: executionProgress?.rigMoveCompleted ? 100 : 0,
        up: executionProgress?.rigUpCompleted ? 100 : 0,
      },
    };
  }

  const driverCount = new Set(assignments.map((assignment) => assignment.driverId).filter(Boolean)).size;
  const completedDown = assignments.filter((assignment) => assignment.stageStatus?.rigDownCompleted).length;
  const completedMove = assignments.filter((assignment) => assignment.stageStatus?.rigMoveCompleted).length;
  const completedUp = assignments.filter((assignment) => assignment.stageStatus?.rigUpCompleted).length;
  const totalStageTasks = assignments.length * 3;
  const completedStageTasks = completedDown + completedMove + completedUp;

  return {
    driverCount,
    totalStageTasks,
    completedStageTasks,
    actualPercent: Math.round((completedStageTasks / Math.max(totalStageTasks, 1)) * 100),
    stagePercents: {
      down: Math.round((completedDown / Math.max(driverCount, 1)) * 100),
      move: Math.round((completedMove / Math.max(driverCount, 1)) * 100),
      up: Math.round((completedUp / Math.max(driverCount, 1)) * 100),
    },
  };
}

function formatHoursNumber(minutes = 0, digits = 1) {
  return (Math.max(0, Number(minutes) || 0) / 60).toFixed(digits);
}

function renderElapsedTimeValue(totalMinutes = 0) {
  const normalizedMinutes = Math.max(0, Number(totalMinutes) || 0);
  const wholeMinutes = Math.floor(normalizedMinutes);
  const seconds = Math.floor((normalizedMinutes - wholeMinutes) * 60);

  return h(
    "span",
    { className: "scene-time-passed-value" },
    h("span", { className: "scene-time-passed-main" }, `${wholeMinutes} min`),
    h("span", { className: "scene-time-passed-seconds" }, `${String(seconds).padStart(2, "0")}s`),
  );
}

function getProjectSummaryMetrics({ scenario, playback, move, activePlanDashboard, planComparisonStats }) {
  const journeys = playback?.journeys?.length ? playback.journeys : (playback?.trips || []);
  const tasks = getPlaybackTasks(playback).filter((task) => task.phase !== "start" && task.phase !== "finish");
  const totalMinutes = Math.max(0, Number(scenario?.totalMinutes) || Number(playback?.totalMinutes) || 0);
  const totalHours = totalMinutes / 60;
  const routeKm = Math.max(0, Number(move?.routeKm) || Number(scenario?.routeDistanceKm) || 0);
  const totalDistanceKm = journeys.reduce(
    (sum, journey) => sum + (routeKm * Math.max((journey.loadIds || []).length || 1, 1)),
    0,
  );

  return [
    {
      label: "Project Duration",
      value: totalHours.toFixed(1),
      meta: `${(totalHours / 24).toFixed(1)} days · ${(totalHours / 168).toFixed(2)} wks`,
      tone: "amber",
    },
    {
      label: "Total Transport Cost",
      value: activePlanDashboard.costEstimate,
      meta: `${journeys.length} trips`,
      tone: "amber",
    },
    {
      label: "Critical Activities",
      value: String(activePlanDashboard.criticalTaskCount),
      meta: `of ${tasks.length} total`,
      tone: "red",
    },
    {
      label: "Total Distance",
      value: `${Math.round(totalDistanceKm)}`,
      meta: "km across all trips",
      tone: "blue",
    },
    {
      label: "Cost / Load",
      value: planComparisonStats.costPerLoad,
      meta: `${planComparisonStats.throughputLoadsPerDay} loads/day`,
      tone: "green",
    },
    {
      label: "Active Fleet",
      value: String(activePlanDashboard.usedTruckCount),
      meta: `${activePlanDashboard.truckUsageLabel} trucks used`,
      tone: "purple",
    },
  ];
}

function buildTruckTypeCostBreakdown(scenario, playback, move) {
  const journeys = playback?.journeys?.length ? playback.journeys : (playback?.trips || []);
  const configuredRates = new Map(
    (scenario?.allocatedTruckSetup || scenario?.truckSetup || []).map((truck) => [
      normalizeTruckTypeKey(truck?.type),
      Math.max(0, Number(truck?.hourlyCost) || 0),
    ]),
  );
  const routeKm = Math.max(0, Number(move?.routeKm) || Number(scenario?.routeDistanceKm) || 0);
  const summary = new Map();

  journeys.forEach((journey, index) => {
    const normalizedType = normalizeTruckTypeKey(journey.truckType);
    const label = normalizeTruckTypeLabel(journey.truckType || "Truck");
    const activeMinutes = Math.max(
      0,
      ((journey.moveStart || journey.dispatchStart || 0) - (journey.dispatchStart || 0)) +
      ((journey.returnStart || journey.arrivalAtDestination || 0) - (journey.moveStart || 0)) +
      ((journey.returnToSource || journey.returnStart || 0) - (journey.returnStart || 0)),
    );
    const tripCost = Math.round((activeMinutes / 60) * (configuredRates.get(normalizedType) || 0));
    const distanceKm = Math.round(routeKm * Math.max((journey.loadIds || []).length || 1, 1));
    const key = normalizedType || `truck-${index}`;
    const existing = summary.get(key) || {
      key,
      label,
      shortLabel:
        normalizedType === "flatbed" ? "FB" : normalizedType === "lowbed" ? "LB" : normalizedType === "heavyhauler" ? "HH" : "TR",
      tone:
        normalizedType === "flatbed" ? "blue" : normalizedType === "lowbed" ? "green" : normalizedType === "heavyhauler" ? "red" : "amber",
      tripCount: 0,
      distanceKm: 0,
      tripCost: 0,
    };

    existing.tripCount += 1;
    existing.distanceKm += distanceKm;
    existing.tripCost += tripCost;
    summary.set(key, existing);
  });

  return [...summary.values()].sort((left, right) => right.tripCost - left.tripCost);
}

function buildTransportTableRows(scenario, playback, move) {
  const journeys = playback?.journeys?.length ? playback.journeys : (playback?.trips || []);
  const configuredRates = new Map(
    (scenario?.allocatedTruckSetup || scenario?.truckSetup || []).map((truck) => [
      normalizeTruckTypeKey(truck?.type),
      Math.max(0, Number(truck?.hourlyCost) || 0),
    ]),
  );
  const routeKm = Math.max(0, Number(move?.routeKm) || Number(scenario?.routeDistanceKm) || 0);

  return journeys
    .map((journey, index) => {
      const activeMinutes = Math.max(
        0,
        ((journey.moveStart || journey.dispatchStart || 0) - (journey.dispatchStart || 0)) +
        ((journey.returnStart || journey.arrivalAtDestination || 0) - (journey.moveStart || 0)) +
        ((journey.returnToSource || journey.returnStart || 0) - (journey.returnStart || 0)),
      );
      const tripCost = Math.round((activeMinutes / 60) * (configuredRates.get(normalizeTruckTypeKey(journey.truckType)) || 0));

      return {
        key: journey.id || `transport-${index}`,
        id: journey.id || `transport-${index}`,
        loadCode: (journey.loadCodes || []).join(", "),
        description: journey.description || `Truck ${journey.truckId}`,
        truck: `${normalizeTruckTypeLabel(journey.truckType || "Truck")} ${journey.truckId ?? ""}`.trim(),
        distanceKm: Math.round(routeKm * Math.max((journey.loadIds || []).length || 1, 1)),
        activeHours: formatHoursNumber(activeMinutes, 2),
        tripCost: formatCurrency(tripCost),
      };
    })
    .sort((left, right) => String(left.id).localeCompare(String(right.id), undefined, { numeric: true }));
}

function buildPlannerActivityRows(playback) {
  const tasks = getPlaybackTasks(playback).filter((task) => task.phase !== "start" && task.phase !== "finish");
  const tasksByLoad = new Map();

  tasks.forEach((task) => {
    if (!tasksByLoad.has(task.loadId)) {
      tasksByLoad.set(task.loadId, []);
    }
    tasksByLoad.get(task.loadId).push(task);
  });

  const phaseCodeMap = {
    rig_down: "RD",
    pickup_load: "RM",
    haul: "RM",
    unload_drop: "RU",
    rig_up: "RU",
  };

  return tasks
    .sort((left, right) =>
      (left.earliestStart ?? left.startMinute ?? 0) - (right.earliestStart ?? right.startMinute ?? 0) ||
      (left.loadId - right.loadId),
    )
    .map((task, index) => {
      const sameLoadTasks = [...(tasksByLoad.get(task.loadId) || [])].sort((left, right) =>
        (left.startMinute - right.startMinute) || (left.endMinute - right.endMinute),
      );
      const loadIndex = Math.max(1, sameLoadTasks.findIndex((entry) => entry.id === task.id) + 1);
      const loadCount = Math.max(1, sameLoadTasks.length);
      const typeCode = phaseCodeMap[task.phase] || (task.activityCode || task.phase || "TASK").toUpperCase();

      return {
        key: task.id || `task-${index}`,
        id: task.id || `task-${index}`,
        loadCode: task.loadCode || `#${task.loadId}`,
        description: task.description || "Planner task",
        loadPosition: `${loadIndex}/${loadCount}`,
        typeCode,
        durationHours: formatHoursNumber((task.endMinute || 0) - (task.startMinute || 0), 2),
        esHours: formatHoursNumber(task.earliestStart ?? task.startMinute ?? 0, 2),
        efHours: formatHoursNumber(task.earliestFinish ?? task.endMinute ?? 0, 2),
        lsHours: formatHoursNumber(task.latestStart ?? task.startMinute ?? 0, 2),
        lfHours: formatHoursNumber(task.latestFinish ?? task.endMinute ?? 0, 2),
        floatHours: formatHoursNumber(task.slack || 0, 2),
        critical: Boolean(task.isCritical),
      };
    });
}

function PlannerCanvas({
  playback,
  zoom = 1,
  criticalPathChain = [],
  criticalScheduleRows = [],
  plannerScheduleRows = [],
  plannerCostRows = [],
  operatingSnapshot,
  drillingReadinessPercent,
  activePlanDashboard,
  planComparisonStats,
  scenario,
  move,
  currentMinute = 0,
  timelineGapMinutes = 180,
}) {
  const [activitySearch, setActivitySearch] = useState("");
  const [ganttFilters, setGanttFilters] = useState({
    cpOnly: false,
    showRD: true,
    showRM: true,
    showRU: true,
    showDays: true,
    showFloatBar: true,
  });
  const summaryMetrics = useMemo(
    () => getProjectSummaryMetrics({ scenario, playback, move, activePlanDashboard, planComparisonStats }),
    [scenario, playback, move, activePlanDashboard, planComparisonStats],
  );
  const costBreakdownRows = useMemo(
    () => buildTruckTypeCostBreakdown(scenario, playback, move),
    [scenario, playback, move],
  );
  const transportRows = useMemo(
    () => buildTransportTableRows(scenario, playback, move),
    [scenario, playback, move],
  );
  const activityRows = useMemo(
    () => buildPlannerActivityRows(playback),
    [playback],
  );
  const filteredActivityRows = useMemo(() => {
    const query = activitySearch.trim().toLowerCase();
    if (!query) {
      return activityRows;
    }
    return activityRows.filter((row) =>
      row.id.toLowerCase().includes(query) ||
      row.loadCode.toLowerCase().includes(query) ||
      row.description.toLowerCase().includes(query) ||
      row.typeCode.toLowerCase().includes(query),
    );
  }, [activityRows, activitySearch]);
  const totalTransportCost = costBreakdownRows.reduce((sum, row) => sum + row.tripCost, 0);
  const totalTransportDistance = costBreakdownRows.reduce((sum, row) => sum + row.distanceKm, 0);
  const criticalPathRows = criticalPathChain.map((task) => `${task.loadCode}`).filter((value, index, values) => values.indexOf(value) === index);

  return h(
    "section",
    { className: "scene-planner-canvas" },
    h(
      Card,
      { className: "scene-planner-canvas-card scene-planner-summary-card" },
      h("span", { className: "scene-panel-kicker" }, "Project Summary"),
      h(
        "div",
        { className: "scene-planner-summary-layout" },
        renderPlannerMetricGrid(summaryMetrics),
        costBreakdownRows.map((row) =>
          h(
            "article",
            { key: row.key, className: `scene-planner-cost-card is-${row.tone}` },
            h("span", { className: "scene-planner-cost-label" }, `${row.label} (${row.shortLabel})`),
            h("strong", { className: "scene-planner-cost-value" }, formatCurrency(row.tripCost)),
            h("span", { className: "scene-planner-cost-meta" }, `${row.tripCount} trips - ${row.distanceKm} km`),
          ),
        ),
        h(
          "article",
          { className: "scene-planner-cost-card is-total" },
          h("span", { className: "scene-planner-cost-label" }, "TOTAL PROJECT"),
          h("strong", { className: "scene-planner-cost-value" }, formatCurrency(totalTransportCost)),
          h("span", { className: "scene-planner-cost-meta" }, `${transportRows.length} trips - ${totalTransportDistance} km total`),
        ),
      ),
    ),
    h(
      "div",
      { className: "scene-planner-grid" },
      h(
        Card,
        { className: "scene-planner-canvas-card" },
        h("span", { className: "scene-panel-kicker" }, "Cost Breakdown"),
        h("div", { className: "scene-planner-section-note" }, (scenario?.name || "Plan").toUpperCase()),
        h(
          "div",
          { className: "scene-planner-cost-grid" },
          costBreakdownRows.map((row) =>
            h(
              "article",
              { key: row.key, className: `scene-planner-cost-card is-${row.tone}` },
              h("span", { className: "scene-planner-cost-label" }, `${row.label} (${row.shortLabel})`),
              h("strong", { className: "scene-planner-cost-value" }, formatCurrency(row.tripCost)),
              h("span", { className: "scene-planner-cost-meta" }, `${row.tripCount} trips · ${row.distanceKm} km`),
            ),
          ),
          h(
            "article",
            { className: "scene-planner-cost-card is-total" },
            h("span", { className: "scene-planner-cost-label" }, "TOTAL PROJECT"),
            h("strong", { className: "scene-planner-cost-value" }, formatCurrency(totalTransportCost)),
            h("span", { className: "scene-planner-cost-meta" }, `${transportRows.length} trips · ${totalTransportDistance} km total`),
          ),
        ),
      ),
      h(
        Card,
        { className: "scene-planner-canvas-card" },
        h("span", { className: "scene-panel-kicker" }, "Critical Path"),
        h("div", { className: "scene-planner-section-note" }, `${criticalPathChain.length} activities`),
        h("p", { className: "muted-copy scene-planner-critical-copy" }, "Float = 0. Any delay on these activities delays the entire project."),
        h(
          "div",
          { className: "scene-cpm-chain" },
          criticalPathRows.length
            ? criticalPathRows.map((task, index) =>
                h(
                  "span",
                  {
                    key: `${task}-${index}`,
                    className: "scene-cpm-chain-node",
                  },
                  task,
                ),
              )
            : h("span", { className: "muted-copy" }, "No critical chain available."),
        ),
      ),
    ),
    h(
      Card,
      { className: "scene-planner-canvas-card" },
      h("span", { className: "scene-panel-kicker" }, "Transport Table"),
      h(
        "div",
        { className: "scene-planner-table-wrap is-medium" },
        h(
          "table",
          { className: "scene-planner-table" },
          h(
            "thead",
            null,
            h(
              "tr",
              null,
              h("th", null, "ID"),
              h("th", null, "Load"),
              h("th", null, "Description"),
              h("th", null, "Truck"),
              h("th", null, "Distance"),
              h("th", null, "Active"),
              h("th", null, "Cost"),
            ),
          ),
          h(
            "tbody",
            null,
            transportRows.length
              ? transportRows.map((row) =>
                  h(
                    "tr",
                    { key: row.key },
                    h("td", { className: "scene-planner-code" }, row.id),
                    h("td", { className: "scene-planner-code" }, row.loadCode),
                    h("td", null, row.description),
                    h("td", null, row.truck),
                    h("td", { className: "scene-planner-number" }, `${row.distanceKm} km`),
                    h("td", { className: "scene-planner-number" }, `${row.activeHours}h`),
                    h("td", { className: "scene-planner-number is-accent" }, row.tripCost),
                  ),
                )
              : h("tr", null, h("td", { colSpan: 7, className: "scene-cpm-table-empty muted-copy" }, "No transport rows available.")),
          ),
        ),
      ),
    ),
    h(
      Card,
      { className: "scene-planner-canvas-card" },
      h("div", { className: "scene-planner-card-head" }, h("span", { className: "scene-panel-kicker" }, "Activity Table"), h("span", { className: "scene-planner-section-note" }, `${filteredActivityRows.length} rows`)),
      h(TextInput, {
        type: "text",
        value: activitySearch,
        onChange: (event) => setActivitySearch(event.target.value),
        placeholder: "Search ID or description...",
        className: "scene-planner-search",
      }),
      h(
        "div",
        { className: "scene-planner-table-wrap is-tall" },
        h(
          "table",
          { className: "scene-planner-table" },
          h(
            "thead",
            null,
            h(
              "tr",
              null,
              h("th", null, "ID"),
              h("th", null, "Load"),
              h("th", null, "Description"),
              h("th", null, "Pos"),
              h("th", null, "Type"),
              h("th", null, "Dur"),
              h("th", null, "ES"),
              h("th", null, "EF"),
              h("th", null, "LS"),
              h("th", null, "LF"),
              h("th", null, "Float"),
              h("th", null, "CP"),
            ),
          ),
          h(
            "tbody",
            null,
            filteredActivityRows.length
              ? filteredActivityRows.map((row) =>
                  h(
                    "tr",
                    { key: row.key, className: row.critical ? "is-critical" : "" },
                    h("td", { className: "scene-planner-code" }, row.id),
                    h("td", { className: "scene-planner-code" }, row.loadCode),
                    h("td", null, row.description),
                    h("td", { className: "scene-planner-number" }, row.loadPosition),
                    h("td", null, row.typeCode),
                    h("td", { className: "scene-planner-number" }, row.durationHours),
                    h("td", { className: "scene-planner-number" }, row.esHours),
                    h("td", { className: "scene-planner-number" }, row.efHours),
                    h("td", { className: "scene-planner-number" }, row.lsHours),
                    h("td", { className: "scene-planner-number" }, row.lfHours),
                    h("td", { className: "scene-planner-number" }, row.floatHours),
                    h("td", { className: "scene-planner-number is-accent" }, row.critical ? "★" : ""),
                  ),
                )
              : h("tr", null, h("td", { colSpan: 12, className: "scene-cpm-table-empty muted-copy" }, "No activity rows available.")),
          ),
        ),
      ),
    ),
    h(
      Card,
      { className: "scene-planner-canvas-card scene-planner-gantt-card" },
      h("span", { className: "scene-panel-kicker" }, "Gantt Chart"),
      h(
        "div",
        { className: "scene-gantt-toolbar" },
        h("label", { className: "scene-gantt-check" }, h("input", {
          type: "checkbox",
          checked: ganttFilters.cpOnly,
          onChange: (event) => setGanttFilters((current) => ({ ...current, cpOnly: event.target.checked })),
        }), h("span", null, "CP only")),
        h("label", { className: "scene-gantt-check" }, h("input", {
          type: "checkbox",
          checked: ganttFilters.showRD,
          onChange: (event) => setGanttFilters((current) => ({ ...current, showRD: event.target.checked })),
        }), h("span", null, "RD")),
        h("label", { className: "scene-gantt-check" }, h("input", {
          type: "checkbox",
          checked: ganttFilters.showRM,
          onChange: (event) => setGanttFilters((current) => ({ ...current, showRM: event.target.checked })),
        }), h("span", null, "RM")),
        h("label", { className: "scene-gantt-check" }, h("input", {
          type: "checkbox",
          checked: ganttFilters.showRU,
          onChange: (event) => setGanttFilters((current) => ({ ...current, showRU: event.target.checked })),
        }), h("span", null, "RU")),
        h("label", { className: "scene-gantt-check" }, h("input", {
          type: "checkbox",
          checked: true,
          disabled: true,
          readOnly: true,
        }), h("span", null, "Days")),
        h("label", { className: "scene-gantt-check" }, h("input", {
          type: "checkbox",
          checked: ganttFilters.showFloatBar,
          onChange: (event) => setGanttFilters((current) => ({ ...current, showFloatBar: event.target.checked })),
        }), h("span", null, "Float bar")),
      ),
      h(
        "div",
        { className: "scene-gantt-legend" },
        h("span", { className: "scene-gantt-legend-item" }, h("i", { className: "scene-gantt-legend-dot is-rd" }), "Rig Down"),
        h("span", { className: "scene-gantt-legend-item" }, h("i", { className: "scene-gantt-legend-dot is-rm" }), "Moving"),
        h("span", { className: "scene-gantt-legend-item" }, h("i", { className: "scene-gantt-legend-dot is-ru" }), "Rig Up (RL)"),
        h("span", { className: "scene-gantt-legend-item" }, h("i", { className: "scene-gantt-legend-dot is-su" }), "Rig Up (SU)"),
        h("span", { className: "scene-gantt-legend-item" }, h("i", { className: "scene-gantt-legend-dot is-critical" }), "Critical"),
      ),
      h(FullScreenTimeline, {
        playback,
        currentMinute,
        zoom,
        gapMinutes: timelineGapMinutes,
        cpOnly: ganttFilters.cpOnly,
        showRD: ganttFilters.showRD,
        showRM: ganttFilters.showRM,
        showRU: ganttFilters.showRU,
        showFloatBar: ganttFilters.showFloatBar,
      }),
    ),
  );
}

function formatTimelineClock(totalMinutes) {
  const safeMinutes = Math.max(0, Math.round(totalMinutes || 0));
  const hours = Math.floor(safeMinutes / 60);
  const minutes = safeMinutes % 60;

  return `${hours}:${String(minutes).padStart(2, "0")}`;
}

function getTimelineWorkingMinutes(playback, rowType) {
  const trips = playback?.trips || [];

  if (rowType === "phase") {
    const phaseRanges = [
      (trip) => [trip.rigDownStart ?? trip.loadStart, trip.rigDownFinish],
      (trip) => [trip.moveStart ?? trip.pickupLoadFinish ?? trip.rigDownFinish, trip.arrivalAtDestination],
      (trip) => [trip.rigUpStart ?? trip.unloadDropFinish ?? trip.arrivalAtDestination, trip.rigUpFinish],
    ];

    return phaseRanges.reduce((sum, getRange) => {
      const ranges = trips
        .map((trip) => {
          const [start, end] = getRange(trip);
          return { start, end };
        })
        .filter((item) => item.end > item.start)
        .sort((a, b) => a.start - b.start);

      const merged = [];
      ranges.forEach((item) => {
        const previous = merged[merged.length - 1];
        if (previous && item.start <= previous.end) {
          previous.end = Math.max(previous.end, item.end);
          return;
        }
        merged.push({ ...item });
      });

      return sum + merged.reduce((phaseSum, item) => phaseSum + (item.end - item.start), 0);
    }, 0);
  }

  if (rowType === "load") {
    return trips.reduce(
      (sum, trip) =>
        sum +
        Math.max(0, (trip.rigDownFinish || 0) - (trip.rigDownStart ?? trip.loadStart ?? 0)) +
        Math.max(0, (trip.pickupLoadFinish || 0) - (trip.pickupLoadStart ?? trip.rigDownFinish ?? 0)) +
        Math.max(0, (trip.arrivalAtDestination || 0) - (trip.moveStart || trip.pickupLoadFinish || trip.rigDownFinish || 0)) +
        Math.max(0, (trip.unloadDropFinish || 0) - (trip.unloadDropStart ?? trip.arrivalAtDestination ?? 0)) +
        Math.max(0, (trip.rigUpFinish || 0) - (trip.rigUpStart || trip.unloadDropFinish || trip.arrivalAtDestination || 0)),
      0,
    );
  }

  if (rowType === "cpm") {
    return (playback?.tasks || [])
      .filter((task) => task.isCritical)
      .reduce((sum, task) => sum + Math.max(0, task.endMinute - task.startMinute), 0);
  }

  return trips.reduce(
    (sum, trip) =>
      sum +
      Math.max(0, (trip.pickupLoadStart || trip.loadStart || 0) - (trip.dispatchStart || trip.pickupLoadStart || trip.loadStart || 0)) +
      Math.max(0, (trip.arrivalAtDestination || 0) - (trip.moveStart || trip.pickupLoadFinish || trip.rigDownFinish || 0)) +
      Math.max(0, (trip.returnToSource || 0) - (trip.returnStart || trip.unloadDropFinish || trip.arrivalAtDestination || 0)),
    0,
  );
}

function parseFirstInteger(value) {
  const match = String(value || "").match(/\d+/);
  return match ? Number.parseInt(match[0], 10) : null;
}

function findLoadTrip(playback, loadId) {
  return (playback?.trips || []).find((trip) => trip.loadId === loadId) || null;
}

function getLoadStage(trip, currentMinute) {
  if (!trip) {
    return null;
  }

  if (currentMinute < (trip.rigDownStart ?? trip.loadStart)) {
    return "queued";
  }
  if (currentMinute < trip.rigDownFinish) {
    return "loading";
  }
  if (currentMinute < (trip.pickupLoadFinish ?? trip.moveStart ?? trip.arrivalAtDestination)) {
    return "loading";
  }
  if (currentMinute < trip.arrivalAtDestination) {
    return "in-transit";
  }
  if (currentMinute < (trip.unloadDropFinish ?? trip.rigUpStart ?? trip.rigUpFinish)) {
    return "rig-up";
  }
  if (currentMinute < trip.rigUpFinish) {
    return "rig-up";
  }
  return "delivered";
}

function formatMinutePoint(value) {
  return formatMinutes(Math.max(0, Math.round(value || 0)));
}

function normalizePlanningDate(value, fallbackIso) {
  const matched = String(value || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (matched) {
    return `${matched[1]}-${matched[2]}-${matched[3]}`;
  }

  const fallbackDate = fallbackIso ? new Date(fallbackIso) : new Date();
  if (Number.isNaN(fallbackDate.getTime())) {
    return "2026-03-27";
  }

  const year = fallbackDate.getFullYear();
  const month = String(fallbackDate.getMonth() + 1).padStart(2, "0");
  const day = String(fallbackDate.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function normalizePlanningTime(value) {
  const matched = String(value || "").match(/^(\d{1,2}):(\d{2})$/);
  if (!matched) {
    return "06:00";
  }

  const hours = Math.min(23, Math.max(0, Number.parseInt(matched[1], 10) || 0));
  const minutes = Math.min(59, Math.max(0, Number.parseInt(matched[2], 10) || 0));
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
}

function parsePlanningTimeMinutes(value) {
  const normalized = normalizePlanningTime(value);
  const [hours, minutes] = normalized.split(":").map((part) => Number.parseInt(part, 10) || 0);
  return (hours * 60) + minutes;
}

function formatPlanningDateLabel(value) {
  const normalized = normalizePlanningDate(value);
  const date = new Date(`${normalized}T00:00:00`);
  if (Number.isNaN(date.getTime())) {
    return normalized;
  }

  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(date);
}

function formatPlanningDateTime(dateValue, timeValue) {
  const normalizedDate = normalizePlanningDate(dateValue);
  const normalizedTime = normalizePlanningTime(timeValue);
  const date = new Date(`${normalizedDate}T${normalizedTime}:00`);
  if (Number.isNaN(date.getTime())) {
    return `${normalizedDate} ${normalizedTime}`;
  }

  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

function formatDaysHours(totalMinutes) {
  const safeMinutes = Math.max(0, Math.round(totalMinutes || 0));
  const totalHours = Math.ceil(safeMinutes / 60);
  const days = Math.floor(totalHours / 24);
  const hours = totalHours % 24;

  if (days <= 0) {
    return `${hours}h`;
  }

  if (hours <= 0) {
    return `${days}d`;
  }

  return `${days}d ${hours}h`;
}

function getPlanEtaLabel(dateValue, timeValue, durationMinutes) {
  const normalizedDate = normalizePlanningDate(dateValue);
  const planningStartMinutes = parsePlanningTimeMinutes(timeValue);
  const date = new Date(`${normalizedDate}T00:00:00`);
  if (Number.isNaN(date.getTime())) {
    return formatPlanningDateTime(normalizedDate, normalizePlanningTime(timeValue));
  }

  date.setMinutes(planningStartMinutes + Math.max(0, Math.round(durationMinutes || 0)));
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

function answerLoadLocation({ trip, currentMinute, move }) {
  const stage = getLoadStage(trip, currentMinute);
  const sourceLabel = formatLocationLabel(move?.startLabel, "source");
  const destinationLabel = formatLocationLabel(move?.endLabel, "destination");
  const loadLabel = getLoadDisplayLabel(trip);

  if (stage === "queued") {
    return `${loadLabel} is queued at ${sourceLabel}. Truck ${trip.truckId} is scheduled to start it at ${formatMinutePoint(trip.loadStart)}.`;
  }
  if (stage === "loading") {
    return `${loadLabel} is at ${sourceLabel} and currently loading on truck ${trip.truckId}. It should leave at ${formatMinutePoint(trip.rigDownFinish)}.`;
  }
  if (stage === "in-transit") {
    return `${loadLabel} is in transit on truck ${trip.truckId} between ${sourceLabel} and ${destinationLabel}. ETA is ${formatMinutePoint(trip.arrivalAtDestination)}.`;
  }
  if (stage === "rig-up") {
    return `${loadLabel} has reached ${destinationLabel} and is in rig-up on truck ${trip.truckId}. Rig-up should finish at ${formatMinutePoint(trip.rigUpFinish)}.`;
  }
  return `${loadLabel} has been delivered to ${destinationLabel}. Rig-up finished at ${formatMinutePoint(trip.rigUpFinish)}.`;
}

function answerLoadTiming({ trip, currentMinute }) {
  const stage = getLoadStage(trip, currentMinute);
  const loadLabel = getLoadDisplayLabel(trip);

  if (stage === "queued") {
    return `${loadLabel} starts at ${formatMinutePoint(trip.loadStart)}, departs at ${formatMinutePoint(trip.rigDownFinish)}, arrives at ${formatMinutePoint(trip.arrivalAtDestination)}, and finishes rig-up at ${formatMinutePoint(trip.rigUpFinish)}.`;
  }
  if (stage === "loading") {
    return `${loadLabel} is loading now. It should arrive in ${formatMinutePoint(trip.arrivalAtDestination - currentMinute)} at ${formatMinutePoint(trip.arrivalAtDestination)}.`;
  }
  if (stage === "in-transit") {
    return `${loadLabel} is already on the road. It should arrive in ${formatMinutePoint(trip.arrivalAtDestination - currentMinute)} at ${formatMinutePoint(trip.arrivalAtDestination)}.`;
  }
  if (stage === "rig-up") {
    return `${loadLabel} already arrived at ${formatMinutePoint(trip.arrivalAtDestination)}. Rig-up should complete in ${formatMinutePoint(trip.rigUpFinish - currentMinute)} at ${formatMinutePoint(trip.rigUpFinish)}.`;
  }
  return `${loadLabel} already arrived at ${formatMinutePoint(trip.arrivalAtDestination)} and finished at ${formatMinutePoint(trip.rigUpFinish)}.`;
}

function answerTruckStatus({ playback, truckId, currentMinute, move }) {
  const truckTrips = (playback?.trips || []).filter((trip) => trip.truckId === truckId);
  if (!truckTrips.length) {
    return `Truck ${truckId} is not part of the current plan.`;
  }

  const activeTrip = truckTrips.find((trip) => {
    const tripEnd = trip.returnToSource ?? trip.arrivalAtDestination;
    return currentMinute >= trip.loadStart && currentMinute <= tripEnd;
  });

  if (!activeTrip) {
    const nextTrip = truckTrips.find((trip) => currentMinute < trip.loadStart);
    if (nextTrip) {
      return `Truck ${truckId} is waiting at ${formatLocationLabel(move?.startLabel, "source")} and will start ${getLoadDisplayLabel(nextTrip)} at ${formatMinutePoint(nextTrip.loadStart)}.`;
    }

    const lastTrip = truckTrips[truckTrips.length - 1];
    return `Truck ${truckId} completed its last assigned load, ${getLoadDisplayLabel(lastTrip)}.`;
  }

  return answerLoadLocation({ trip: activeTrip, currentMinute, move }).replace(getLoadDisplayLabel(activeTrip), `Truck ${truckId} with ${getLoadDisplayLabel(activeTrip)}`);
}

function buildAssistantReply({ question, move, playback, currentMinute, rigLoads, lastLog, completion }) {
  const normalized = String(question || "").trim().toLowerCase();

  if (!normalized) {
    return "Ask about a load, a truck, ETA, or current move status.";
  }

  if (/(status|summary|what.*happening|update|progress)/.test(normalized) && !/(load|truck)\s*#?\d+/.test(normalized)) {
    return `Move progress is ${completion}% complete. ${rigLoads.movingCount} loads are moving, ${rigLoads.sourceCount} are still at source, and ${rigLoads.destinationCount} are at destination. Latest event: ${lastLog?.title || "No live event yet"}.`;
  }

  if (/(how many|loads left|remaining|left)/.test(normalized)) {
    const remaining = Math.max(0, rigLoads.totalCount - rigLoads.destinationCount);
    return `${remaining} loads are still not fully finished. ${rigLoads.movingCount} are currently moving and ${rigLoads.sourceCount} are still at source.`;
  }

  if (/(what'?s moving|which loads are moving|in transit|moving now)/.test(normalized)) {
    const movingTrips = (playback?.trips || []).filter(
      (trip) => currentMinute >= trip.rigDownFinish && currentMinute < trip.arrivalAtDestination,
    );

    if (!movingTrips.length) {
      return "No loads are in transit right now.";
    }

    const summary = movingTrips
      .slice(0, 5)
      .map((trip) => `${getLoadDisplayLabel(trip)} on truck ${trip.truckId}`)
      .join(", ");
    return movingTrips.length > 5 ? `Loads currently moving: ${summary}, and ${movingTrips.length - 5} more.` : `Loads currently moving: ${summary}.`;
  }

  if (normalized.includes("truck")) {
    const truckId = parseFirstInteger(normalized);
    if (truckId !== null) {
      return answerTruckStatus({ playback, truckId, currentMinute, move });
    }
  }

  if (normalized.includes("load") || normalized.includes("#")) {
    const loadId = parseFirstInteger(normalized);
    if (loadId === null) {
      return "Tell me the load number, for example: where is load 56?";
    }

    const trip = findLoadTrip(playback, loadId);
    if (!trip) {
      return `I can't find load #${loadId} in the current move plan.`;
    }

    if (/(where|location|located|status)/.test(normalized)) {
      return answerLoadLocation({ trip, currentMinute, move });
    }

    if (/(when|eta|arrive|arrival|how long|finish)/.test(normalized)) {
      return answerLoadTiming({ trip, currentMinute });
    }

    return `${answerLoadLocation({ trip, currentMinute, move })} ${answerLoadTiming({ trip, currentMinute })}`;
  }

  if (/(eta|arrive|arrival|how long)/.test(normalized)) {
    return "Ask with a load number, for example: when does load 56 arrive?";
  }

  return "I can answer questions like: where is load 56, when does load 56 arrive, what is moving now, how many loads are left, or where is truck 2.";
}

function MoveAssistant({ move, playback, currentMinute, rigLoads, lastLog, completion }) {
  const [draft, setDraft] = useState("");
  const [isOpen, setIsOpen] = useState(false);
  const [messages, setMessages] = useState([]);

  function toggleOpen() {
    setIsOpen((current) => {
      const next = !current;
      if (!next) {
        setMessages([]);
        setDraft("");
      }
      return next;
    });
  }

  function submitQuestion(event) {
    event?.preventDefault?.();

    const question = draft.trim();
    if (!question) {
      return;
    }

    const reply = buildAssistantReply({
      question,
      move,
      playback,
      currentMinute,
      rigLoads,
      lastLog,
      completion,
    });

    setMessages((current) => [
      ...current,
      { id: `user-${Date.now()}`, role: "user", text: question },
      { id: `assistant-${Date.now() + 1}`, role: "assistant", text: reply },
    ]);
    setDraft("");
    setIsOpen(true);
  }

  return h(
    "div",
    { className: `move-assistant-overlay${isOpen ? " is-open" : ""}` },
    isOpen && messages.length
      ? h(
          "div",
          { className: "move-assistant-chat" },
          messages.slice(-2).map((message) =>
            h(
              "div",
              {
                key: message.id,
                className: `move-assistant-row move-assistant-row-${message.role}`,
              },
              h(
                "p",
                {
                  className: `move-assistant-bubble move-assistant-bubble-${message.role}`,
                },
                message.role === "assistant" ? h(TypewriterText, { text: message.text }) : message.text,
              ),
            ),
          ),
        )
      : null,
    h(
      "div",
      { className: "move-assistant-dock" },
      isOpen
        ? h(
            "form",
            { className: "move-assistant-form", onSubmit: submitQuestion },
            h("input", {
              className: "move-assistant-input",
              type: "text",
              value: draft,
              placeholder: "help ?",
              onInput: (event) => setDraft(event.target.value),
            }),
          )
        : null,
      h(
        "button",
        {
          type: "button",
          className: "move-assistant-trigger",
          "aria-label": isOpen ? "Close assistant" : "Open assistant",
          onClick: toggleOpen,
        },
        isOpen ? "x" : "?",
      ),
    ),
  );
}

function TypewriterText({ text, speed = 16 }) {
  const [visibleText, setVisibleText] = useState("");

  useEffect(() => {
    const content = String(text || "");
    setVisibleText("");

    if (!content) {
      return undefined;
    }

    let index = 0;
    const timer = window.setInterval(() => {
      index += 1;
      setVisibleText(content.slice(0, index));

      if (index >= content.length) {
        window.clearInterval(timer);
      }
    }, speed);

    return () => window.clearInterval(timer);
  }, [text, speed]);

  return visibleText;
}

function PlaybackActionButton({ isRunning, isBusy, isPaused, onRun, onEnd, onPauseToggle, label = "Run" }) {
  return h(
    "div",
    { className: "scene-playback-action" },
    h(Button, {
      type: "button",
      className: `scene-playback-main-button${!isRunning && !isPaused && label === "Resume" ? " is-resume" : ""}`,
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
  simulationProgress = { percent: 0, message: "" },
  onPlaybackSpeedChange,
  onSelectPlan,
  onRunPlayback,
  onRunCustomPlan,
  onPausePlayback,
  onEndPlayback,
  onStartExecution,
  onDeleteMove,
  onBack,
  onLogout,
  currentUser,
  readOnly = false,
  availableFleet = [],
  truckSpecs = [],
  executionState = "planning",
  operatingState = "standby",
  executionProgress = {},
  executionAssignments = [],
  teamMoves = [],
  startupRequirements = [],
  language = "en",
  onToggleLanguage,
}) {
  const t = (key, fallback) => translate(language, key, fallback);
  const previousMoveIdRef = useRef(move?.id || null);
  const speedDropdownRef = useRef(null);
  const [hasSceneInitialized, setHasSceneInitialized] = useState(Boolean(sceneAssetsReady));
  const [SimulationScene3DComponent, setSimulationScene3DComponent] = useState(null);
  const [LeafletMapComponent, setLeafletMapComponent] = useState(null);
  const [truckSetup, setTruckSetup] = useState(() => normalizeTruckSetup(move, availableFleet));
  const [activeScenarioName, setActiveScenarioName] = useState(move?.simulation?.preferredScenarioName || "");
  const [activePlanKey, setActivePlanKey] = useState(move?.simulation?.preferredScenarioName || "");
  const [activeView, setActiveView] = useState(move?.activeView || "map");
  const [sceneMode, setSceneMode] = useState(move?.sceneMode || "3d");
  const [previousSceneMode, setPreviousSceneMode] = useState(
    move?.previousSceneMode || (move?.sceneMode === "2d" || move?.sceneMode === "3d" ? move.sceneMode : "3d"),
  );
  const [activeStageKey, setActiveStageKey] = useState(
    executionState === "completed" ? "operations" : executionState === "active" ? "execution" : "planning",
  );
  const [timelineZoom, setTimelineZoom] = useState(move?.timelineZoom || 0.5);
  const [timelineRowType, setTimelineRowType] = useState(move?.timelineRowType || "cpm");
  const [timelineGapMinutes, setTimelineGapMinutes] = useState(move?.timelineGapMinutes || 3 * 60);
  const [planningStartDate, setPlanningStartDate] = useState(normalizePlanningDate(move?.planningStartDate, move?.createdAt));
  const planningStartTime = "06:00";
  const [focusTarget, setFocusTarget] = useState(null);
  const [isSpeedDropdownOpen, setIsSpeedDropdownOpen] = useState(false);
  const [isDeleteConfirmOpen, setIsDeleteConfirmOpen] = useState(false);
  const [executionNow, setExecutionNow] = useState(() => Date.now());

  function handleSceneModeChange(nextMode) {
    if (nextMode === "timeline") {
      setPreviousSceneMode((current) => (sceneMode === "timeline" ? current : sceneMode));
      setSceneMode("timeline");
      return;
    }

    setPreviousSceneMode(nextMode);
    setSceneMode(nextMode);
  }

  useEffect(() => {
    if (sceneAssetsReady) {
      setHasSceneInitialized(true);
    }
  }, [sceneAssetsReady]);

  useEffect(() => {
    let cancelled = false;

    async function ensureSceneComponent() {
      if (sceneMode === "3d" && !SimulationScene3DComponent) {
        const module = await import("../components/map/SimulationScene3D.js");
        if (!cancelled) {
          setSimulationScene3DComponent(() => module.SimulationScene3D);
        }
      }

      if (sceneMode === "2d" && !LeafletMapComponent) {
        const module = await import("../components/map/LeafletMap.js");
        if (!cancelled) {
          setLeafletMapComponent(() => module.LeafletMap);
        }
      }
    }

    void ensureSceneComponent();

    return () => {
      cancelled = true;
    };
  }, [sceneMode, SimulationScene3DComponent, LeafletMapComponent]);

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
      setTruckSetup(normalizeTruckSetup(move, availableFleet));
    }
    if (isNewMove) {
      setActiveScenarioName(move?.simulation?.preferredScenarioName || "");
    } else if (
      activeScenarioName &&
      !(move?.simulation?.scenarioPlans || []).some((scenario) => scenario.name === activeScenarioName)
    ) {
      setActiveScenarioName(move?.simulation?.preferredScenarioName || "");
    }
    setActivePlanKey((current) => {
      if (isNewMove) {
        previousMoveIdRef.current = move?.id || null;
        return move?.simulation?.preferredScenarioName || "";
      }
      if (current === "customize") {
        return "customize";
      }
      if (current && (move?.simulation?.scenarioPlans || []).some((scenario) => scenario.name === current)) {
        return current;
      }
      return move?.simulation?.preferredScenarioName || "";
    });
    if (isNewMove) {
      setActiveView(move?.activeView || "map");
      setSceneMode(move?.sceneMode || "3d");
      setPreviousSceneMode(
        move?.previousSceneMode || (move?.sceneMode === "2d" || move?.sceneMode === "3d" ? move.sceneMode : "3d"),
      );
      setTimelineZoom(move?.timelineZoom || 0.5);
      setTimelineRowType(move?.timelineRowType || "cpm");
      setTimelineGapMinutes(move?.timelineGapMinutes || 3 * 60);
      setPlanningStartDate(normalizePlanningDate(move?.planningStartDate, move?.createdAt));
      setActiveStageKey(
        move?.executionState === "completed" ? "operations" : move?.executionState === "active" ? "execution" : "planning",
      );
      setIsSpeedDropdownOpen(false);
      setIsDeleteConfirmOpen(false);
    }
    if (isNewMove) {
      setFocusTarget(null);
    }
  }, [move?.id, move?.updatedAt, availableFleet, activeScenarioName, move?.simulation]);

  useEffect(() => {
    setFocusTarget(null);
  }, [sceneFocusResetKey]);

  useEffect(() => {
    setActiveStageKey(
      executionState === "completed" ? "operations" : executionState === "active" ? "execution" : "planning",
    );
  }, [executionState]);

  useEffect(() => {
    if (executionState !== "active" && executionState !== "completed") {
      return undefined;
    }

    setExecutionNow(Date.now());
    const intervalId = window.setInterval(() => {
      setExecutionNow(Date.now());
    }, 1000);

    return () => {
      window.clearInterval(intervalId);
    };
  }, [executionState, move?.executionStartedAt, move?.executionCompletedAt]);

  useEffect(() => {
    if (!move?.id) {
      return;
    }

    const timeoutId = window.setTimeout(() => {
      void persistMoveSession(move.id, {
        activeView,
        sceneMode,
        previousSceneMode,
        timelineZoom,
        timelineRowType,
        timelineGapMinutes,
        planningStartDate,
        planningStartTime,
      }).catch(() => {});
    }, 500);

    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [move?.id, activeView, sceneMode, previousSceneMode, timelineZoom, timelineRowType, timelineGapMinutes, planningStartDate, planningStartTime]);

  const fallbackPlayback = {
    totalMinutes: 0,
    journeys: [],
    trips: [],
    steps: [],
    tasks: [],
    planningAnalysis: { criticalTaskIds: [], projectFinish: 0 },
  };
  const totalTrucks = truckSetup.reduce((sum, item) => sum + (Number.parseInt(item.count, 10) || 0), 0);
  const safeMove = move || {
    id: null,
    name: "Rig move",
    createdLabel: "",
    startLabel: "",
    endLabel: "",
    startPoint: null,
    endPoint: null,
    routeKm: 0,
    routeTime: "",
    simulation: {
      routeMinutes: 0,
      routeDistanceKm: 0,
      routeGeometry: [],
      routeSource: "Preview route",
      supportRoutes: [],
      scenarioPlans: [],
    },
    executionProgress: {},
  };
  const hasScenarioPlans = Boolean(move?.simulation?.scenarioPlans?.length);
  const fallbackScenario = {
    name: "",
    truckCount: Math.max(totalTrucks, 1),
    allocatedTruckCount: Math.max(totalTrucks, 1),
    allocatedTruckSetup: truckSetup,
    truckSetup,
    routeGeometry: safeMove.simulation?.routeGeometry || [],
    routeMinutes: safeMove.simulation?.routeMinutes || 0,
    totalMinutes: 0,
    utilization: 0,
    truckUtilization: 0,
    idleMinutes: 0,
    costEstimate: 0,
    bestVariant: {
      name: "",
      routeMinutes: safeMove.simulation?.routeMinutes || 0,
      processingMinutes: 0,
      totalMinutes: 0,
      playback: fallbackPlayback,
    },
  };
  const baseScenarioPlans = hasScenarioPlans ? safeMove.simulation.scenarioPlans : [];
  const baseActiveScenario =
    baseScenarioPlans.find((scenario) => scenario.name === activeScenarioName) ||
    baseScenarioPlans[0] ||
    fallbackScenario;
  const isCustomizeActive = !readOnly && activePlanKey === "customize";
  const deferredTruckSetup = useDeferredValue(truckSetup);
  const deferredTotalTrucks = deferredTruckSetup.reduce((sum, item) => sum + (Number.parseInt(item.count, 10) || 0), 0);
  const planningRouteData = {
    minutes: safeMove.simulation?.routeMinutes || baseActiveScenario?.routeMinutes || 0,
    distanceKm: safeMove.simulation?.routeDistanceKm || baseActiveScenario?.routeDistanceKm || safeMove.routeKm || 0,
    geometry: safeMove.simulation?.routeGeometry || baseActiveScenario?.routeGeometry || [],
    source: safeMove.simulation?.routeSource || baseActiveScenario?.routeSource || "Preview route",
  };
  const scenarioPlans = baseScenarioPlans;
  const activeScenario =
    scenarioPlans.find((scenario) => scenario.name === activeScenarioName) ||
    scenarioPlans[0] ||
    baseActiveScenario;
  const selectedScenario = activeScenario;
  const selectedAllocatedTruckSetup = selectedScenario?.allocatedTruckSetup || selectedScenario?.truckSetup || truckSetup;
  const effectiveTruckCount = isCustomizeActive
    ? (deferredTotalTrucks || totalTrucks || selectedScenario?.allocatedTruckCount || selectedScenario?.truckCount || 1)
    : (
        selectedAllocatedTruckSetup.reduce((sum, truck) => sum + Math.max(0, Number.parseInt(truck?.count, 10) || 0), 0) ||
        selectedScenario?.allocatedTruckCount ||
        selectedScenario?.truckCount ||
        totalTrucks ||
        1
      );
  const effectiveTruckSetup = isCustomizeActive
    ? deferredTruckSetup
    : buildDisplayedTruckCounts(selectedAllocatedTruckSetup, effectiveTruckCount).map((truck) => ({
        ...truck,
        count: String(truck.count),
      }));

  const displaySimulation = useMemo(
    () => ({
      ...(safeMove.simulation || {}),
      truckCount: selectedScenario.truckCount,
      bestPlan: safeMove.simulation?.bestPlan || selectedScenario.bestVariant,
      bestScenario: selectedScenario,
      routeGeometry: selectedScenario.routeGeometry,
      routeMinutes: selectedScenario.routeMinutes,
      truckSetup: effectiveTruckSetup,
    }),
    [safeMove.simulation, selectedScenario, effectiveTruckSetup],
  );

  const totalMinutes = displaySimulation.bestPlan.totalMinutes;
  const visibleMinute = sceneAssetsReady ? Math.min(currentMinute, totalMinutes) : 0;
  const canResumePlayback = visibleMinute > 0 && visibleMinute < totalMinutes;
  const completion = Math.min(100, Math.round((visibleMinute / Math.max(totalMinutes, 1)) * 100));
  const phases = useMemo(
    () => getPhasePercentages(displaySimulation.bestPlan.playback, visibleMinute),
    [displaySimulation.bestPlan.playback, visibleMinute],
  );
  const rigLoads = useMemo(
    () => getRigLoadCounts(displaySimulation.bestPlan.playback, visibleMinute),
    [displaySimulation.bestPlan.playback, visibleMinute],
  );
  const lastLog = useMemo(
    () => displaySimulation.bestPlan.playback.steps.filter((step) => step.minute <= visibleMinute).slice(-1)[0] || displaySimulation.bestPlan.playback.steps[0],
    [displaySimulation.bestPlan.playback, visibleMinute],
  );
  const activePlanSummary = useMemo(
    () => getPlanSummary(selectedScenario),
    [selectedScenario],
  );
  const activePlanDashboard = useMemo(
    () => getPlanDashboardStats(selectedScenario, safeMove),
    [selectedScenario, safeMove],
  );
  const displayedTruckCounts = useMemo(
    () => buildDisplayedTruckCounts(effectiveTruckSetup, effectiveTruckCount),
    [effectiveTruckSetup, effectiveTruckCount],
  );
  const focusedRigStats = useMemo(
    () =>
      getRigInsightStats({
        side: focusTarget?.kind === "rig" ? focusTarget.side : null,
        move: safeMove,
        playback: displaySimulation.bestPlan.playback,
        currentMinute: visibleMinute,
        totalMinutes,
      }),
    [focusTarget, safeMove, displaySimulation, visibleMinute, totalMinutes],
  );
  const focusedTruckStats = useMemo(
    () =>
      getTruckFocusStats({
        truckId: focusTarget?.kind === "truck" ? focusTarget.truckId : null,
        move: safeMove,
        playback: displaySimulation.bestPlan.playback,
        currentMinute: visibleMinute,
        totalMinutes,
      }),
    [focusTarget, safeMove, displaySimulation, visibleMinute, totalMinutes],
  );
  const planComparisonStats = useMemo(
    () => getPlanComparisonStats(scenarioPlans, selectedScenario, safeMove, visibleMinute),
    [scenarioPlans, selectedScenario, safeMove, visibleMinute],
  );
  const criticalPathChain = useMemo(
    () => buildCriticalPathChain(displaySimulation.bestPlan.playback),
    [displaySimulation.bestPlan.playback],
  );
  const criticalScheduleRows = useMemo(
    () => buildCriticalScheduleRows(displaySimulation.bestPlan.playback),
    [displaySimulation.bestPlan.playback],
  );
  const plannerScheduleRows = useMemo(
    () => buildPlannerScheduleRows(displaySimulation.bestPlan.playback),
    [displaySimulation.bestPlan.playback],
  );
  const plannerCostRows = useMemo(
    () => buildPlannerCostRows(selectedScenario, displaySimulation.bestPlan.playback, safeMove),
    [selectedScenario, displaySimulation.bestPlan.playback, safeMove],
  );
  const isPlaybackActiveState = isPlaybackRunning || isPlaybackPaused;
  const operatingSnapshot = useMemo(
    () =>
      buildOperatingSnapshot({
        move: safeMove,
        teamMoves,
        logicalLoads,
        startupRequirements,
      }),
    [safeMove, teamMoves, logicalLoads, startupRequirements],
  );
  const drillingReadinessPercent = operatingSnapshot.startupSummary.totalUnits
    ? Math.round((operatingSnapshot.startupSummary.coveredUnits / operatingSnapshot.startupSummary.totalUnits) * 100)
    : 0;
  const startupTransferSchedule = useMemo(
    () =>
      safeMove?.simulation?.supportRoutes?.length
        ? safeMove.simulation.supportRoutes
        : buildStartupTransferSchedule(operatingSnapshot.startupLoads, formatLocationLabel(safeMove?.endLabel, "Destination")),
    [safeMove?.simulation?.supportRoutes, operatingSnapshot, safeMove?.endLabel],
  );
  const focusedTruckOverviewTitle = !isPlaybackActiveState
    ? "Truck Overview"
    : focusedTruckStats && (focusedTruckStats.statusLabel === "In Transit" || focusedTruckStats.statusLabel === "Returning")
      ? "Moving"
      : "Idle";
  const focusedRigOverviewTitle = !isPlaybackActiveState
    ? "Rig Overview"
    : focusedRigStats?.side === "source" && focusedRigStats.loadingNow > 0
      ? "Rigging Down"
      : focusedRigStats?.side === "destination" && focusedRigStats.riggingNow > 0
        ? "Rigging Up"
        : "Idle";

  function updateTruckCount(truckId, nextCountValue) {
    const parsedCount = Math.max(0, Number.parseInt(nextCountValue, 10) || 0);

    setTruckSetup((current) =>
      current.map((item) =>
        item.id === truckId ? { ...item, count: String(parsedCount) } : item,
      ),
    );
  }

  if (sceneMode === "3d" && !sceneAssetsReady && !hasSceneInitialized) {
    return h(
      AppLayout,
      {
        title: move.name,
        subtitle: `${formatLocationLabel(move.startLabel, "Source")} -> ${formatLocationLabel(move.endLabel, "Destination")}`,
        currentUser,
        onLogout,
        language,
        onToggleLanguage,
        fullBleed: true,
      },
      h(
        Card,
        { className: "empty-state scene-loading-card" },
        h("h2", null, "Loading 3D operation assets"),
        h("p", { className: "muted-copy" }, "The page will open after the truck and rig models finish loading."),
      ),
    );
  }

  const playbackSpeedOptions = [
    { value: "1500", label: "Normal" },
    { value: "15000", label: "Medium" },
    { value: "50000", label: "Fast" },
  ];
  const timelineGapOptions = [
    { value: 60, label: "1h" },
    { value: 180, label: "3h" },
    { value: 360, label: "6h" },
    { value: 480, label: "8h" },
    { value: 720, label: "12h" },
    { value: 1440, label: "24h" },
  ];
  const activePlaybackSpeedOption =
    playbackSpeedOptions.find((option) => option.value === String(playbackSpeed)) ||
    playbackSpeedOptions[0];
  const activePlaybackSpeedIndex = Math.max(
    0,
    playbackSpeedOptions.findIndex((option) => option.value === String(playbackSpeed)),
  );
  const isTimelineMode = sceneMode === "timeline";
  const canEditPlan = !readOnly && executionState === "planning" && !isPlaybackRunning && !isPlaybackPaused;
  const loadTimelineRows = useMemo(
    () => (isTimelineMode && timelineRowType === "load" ? buildLoadScheduleRows(displaySimulation.bestPlan.playback) : []),
    [isTimelineMode, timelineRowType, displaySimulation.bestPlan.playback],
  );
  const cpmTimelineRows = useMemo(
    () => (isTimelineMode && timelineRowType === "cpm" ? buildCpmScheduleRows(displaySimulation.bestPlan.playback) : []),
    [isTimelineMode, timelineRowType, displaySimulation.bestPlan.playback],
  );
  const timelineRowsCount = !isTimelineMode
    ? 0
    : timelineRowType === "phase"
      ? 3
      : timelineRowType === "load"
          ? Math.max(loadTimelineRows.length, 1)
          : timelineRowType === "cpm"
            ? Math.max(cpmTimelineRows.length, 1)
          : effectiveTruckCount;
  const timelineWorkingMinutes = useMemo(
    () => (isTimelineMode ? getTimelineWorkingMinutes(displaySimulation.bestPlan.playback, timelineRowType) : 0),
    [isTimelineMode, displaySimulation.bestPlan.playback, timelineRowType],
  );
  const truckTimelineWorkingMinutes = useMemo(
    () => (isTimelineMode ? getTimelineWorkingMinutes(displaySimulation.bestPlan.playback, "truck") : 0),
    [isTimelineMode, displaySimulation.bestPlan.playback],
  );
  const loadTimelineWorkingMinutes = useMemo(
    () => (isTimelineMode && timelineRowType === "load" ? getTimelineWorkingMinutes(displaySimulation.bestPlan.playback, "load") : 0),
    [isTimelineMode, timelineRowType, displaySimulation.bestPlan.playback],
  );
  const criticalPathTimelineWorkingMinutes = useMemo(
    () => (isTimelineMode && timelineRowType === "cpm" ? getTimelineWorkingMinutes(displaySimulation.bestPlan.playback, "cpm") : 0),
    [isTimelineMode, timelineRowType, displaySimulation.bestPlan.playback],
  );
  const timelineWorkingMinutesPerTruck = Math.round(
    truckTimelineWorkingMinutes / Math.max(effectiveTruckCount, 1),
  );
  const timelineWorkingMinutesPerLoad = Math.round(
    loadTimelineWorkingMinutes / Math.max(loadTimelineRows.length, 1),
  );
  const timelineWorkingMinutesPerCriticalLoad = Math.round(
    criticalPathTimelineWorkingMinutes / Math.max(cpmTimelineRows.length, 1),
  );
  const timelineUtilizationPercent = Math.min(
    100,
    Math.round((timelineWorkingMinutes / Math.max(timelineRowsCount * totalMinutes, 1)) * 100),
  );
  const planningStartDateLabel = formatPlanningDateLabel(planningStartDate);
  const planEtaLabel = getPlanEtaLabel(planningStartDate, planningStartTime, activePlanSummary.totalMinutes);
  const executionAssignmentMetrics = useMemo(
    () => getAssignmentExecutionMetrics(executionAssignments, executionProgress),
    [executionAssignments, executionProgress],
  );
  const fallbackExecutionStartedAt = move?.executionStartedAt || executionAssignments[0]?.assignedAt || null;
  const executionStartedAtMs = fallbackExecutionStartedAt ? new Date(fallbackExecutionStartedAt).getTime() : null;
  const executionCompletedAtMs = move?.executionCompletedAt ? new Date(move.executionCompletedAt).getTime() : null;
  const executionElapsedMinutes = executionStartedAtMs
    ? Math.max(0, ((executionCompletedAtMs || executionNow) - executionStartedAtMs) / 60000)
    : 0;
  const executionVisibleMinute =
    executionState === "active" || executionState === "completed"
      ? Math.min(executionElapsedMinutes, totalMinutes)
      : visibleMinute;
  const plannedCompletionPercent = Math.min(100, Math.round((executionVisibleMinute / Math.max(totalMinutes, 1)) * 100));
  const actualCompletionPercent = executionAssignmentMetrics.actualPercent;
  const completionVariance = actualCompletionPercent - plannedCompletionPercent;
  const completionVarianceLabel = `${completionVariance >= 0 ? "+" : ""}${completionVariance}%`;
  const executionPaceLabel = completionVariance >= 5 ? "Ahead of plan" : completionVariance <= -5 ? "Behind plan" : "On plan";
  const plannedTasksByNow = Math.round((plannedCompletionPercent / 100) * executionAssignmentMetrics.totalStageTasks);
  const actualTasksDone = executionAssignmentMetrics.completedStageTasks;
  const nextExecutionAssignment = executionAssignments.find((assignment) => assignment.status !== "completed") || null;
  const nextExecutionTaskLabel = nextExecutionAssignment
    ? `${nextExecutionAssignment.driverName || "Driver"} • ${nextExecutionAssignment.currentStage === "rigDown" ? "Rig Down" : nextExecutionAssignment.currentStage === "rigMove" ? "Rig Move" : "Rig Up"}`
    : "All assigned tasks complete";
  const timeLeftLabel = formatMinutes(Math.max(0, Math.round(totalMinutes - executionVisibleMinute)));
  const isExecutionActive = executionState === "active";
  const isExecutionCompleted = executionState === "completed";
  const isPlanningStage = executionState === "planning";
  const isOperationsStage = executionState === "completed";
  const rigDownCompleted = Boolean(executionProgress?.rigDownCompleted);
  const rigUpCompleted = Boolean(executionProgress?.rigUpCompleted);
  const executionDetailRows = isPlanningStage
    ? []
    : [
        { key: "reserved", label: "Trucks Reserved", value: executionProgress?.trucksReserved ? "Yes" : "Pending" },
        { key: "manager", label: "Manager Notified", value: executionProgress?.managerNotified ? "Sent" : "Pending" },
        { key: "live", label: "Driver Live Data", value: executionProgress?.liveDataRequested ? "Waiting on backend" : "Not requested" },
        { key: "rigdown", label: "Rig Down", value: rigDownCompleted ? "Completed" : "Pending" },
        { key: "rigup", label: "Rig Up", value: rigUpCompleted ? "Completed" : "Pending" },
      ];
  const readOnlyBanner = readOnly
    ? h("p", { className: "muted-copy section-spacing" }, "Manager inspection mode. Planning and playback controls are disabled for this rig.")
    : null;
  const progressPercent = Math.max(1, Number(simulationProgress?.percent) || 0);
  const progressStageLabel =
    simulationProgress?.totalStages > 0
      ? `${simulationProgress?.completedStages || 0}/${simulationProgress.totalStages} stages`
      : "Planning";
  const progressElapsedLabel = formatProgressDuration(simulationProgress?.elapsedMs || 0);
  const progressRemainingLabel =
    progressPercent >= 100 ? "0s" : formatProgressDuration(simulationProgress?.remainingMs || 0);
  const simulationOverlay = isSimulating
    ? h(
        "div",
        {
          className: "scene-loading-overlay",
          style: {
            position: "fixed",
            inset: "0",
            background: "rgba(7, 10, 14, 0.86)",
            backdropFilter: "blur(10px)",
            zIndex: "1200",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: "24px",
          },
        },
        h(
          "div",
          {
            className: "scene-loading-card",
            style: {
              width: "min(520px, 100%)",
              padding: "24px",
              borderRadius: "20px",
              background: "rgba(15, 19, 26, 0.96)",
              border: "1px solid rgba(210, 180, 70, 0.22)",
              boxShadow: "0 20px 60px rgba(0,0,0,0.35)",
              display: "grid",
              gap: "14px",
          },
        },
        h("span", { className: "scene-panel-kicker" }, "Planning Engine"),
        h("strong", { style: { fontSize: "1.15rem" } }, simulationProgress?.message || "Building execution plan"),
          h("p", { className: "muted-copy", style: { margin: 0 } }, simulationProgress?.detail || "The planner is still running. Large fleet comparisons can take longer."),
          h(ProgressBar, { value: progressPercent }),
          h(
            "div",
            { className: "scene-dashboard-pair" },
            h("div", { className: "scene-dashboard-inline scene-dashboard-pair-item" }, h("span", { className: "scene-dashboard-label" }, "Completed"), h("strong", null, progressStageLabel)),
            h("div", { className: "scene-dashboard-inline scene-dashboard-pair-item" }, h("span", { className: "scene-dashboard-label" }, "Elapsed"), h("strong", null, progressElapsedLabel)),
          ),
          h(
            "div",
            { className: "scene-dashboard-pair" },
            h("div", { className: "scene-dashboard-inline scene-dashboard-pair-item" }, h("span", { className: "scene-dashboard-label" }, "Progress"), h("strong", null, `${progressPercent}%`)),
            h("div", { className: "scene-dashboard-inline scene-dashboard-pair-item" }, h("span", { className: "scene-dashboard-label" }, "Remaining"), h("strong", null, progressRemainingLabel)),
          ),
        ),
      )
    : null;
  const operatingStatusLabel = operatingState === "drilling" ? "Drilling" : "Standby";
  const executionStatusLabel = isExecutionCompleted ? "Drilling" : isExecutionActive ? "Reserved and active" : "Planning only";
  const executionStatusRow = !isPlanningStage
    ? h("div", { className: "truck-count-row" }, h("span", null, "Execution Status"), h("strong", null, executionStatusLabel))
    : null;
  const executionStatusOverlayRow = !isPlanningStage
    ? h("div", { className: "truck-count-row scene-passive-overlay" }, h("span", null, "Execution Status"), h("strong", null, executionStatusLabel))
    : null;
  const executionSummary = !isPlanningStage
    ? h(
        "section",
        { className: "scene-panel-section scene-panel-section-plain" },
        executionDetailRows.map((item) =>
          h(
            "div",
            { key: item.key, className: "truck-count-row" },
            h("span", null, item.label),
            h("strong", null, item.value),
          ),
        ),
      )
    : null;
  const executionActions = !readOnly && isExecutionActive
    ? h(
        "div",
        { className: "scene-panel-actions scene-panel-actions-inline" },
        h(
          "span",
          { className: "muted-copy" },
          "Execution completion is controlled by assigned drivers in the driver app.",
        ),
      )
    : null;
  const startupKpiSection = h(
    "section",
    { className: "scene-panel-section" },
    h(
      "div",
      { className: "scene-panel-head" },
      h("span", { className: "scene-panel-kicker" }, isOperationsStage ? "Drilling Readiness" : "Extra Loads"),
      h("strong", null, `${operatingSnapshot.startupSummary.missingUnits} Missing`),
    ),
    h(
      "div",
      { className: "scene-stat-grid" },
      h("div", { className: "scene-stat-card" }, h("span", null, "Needed"), h("strong", null, String(operatingSnapshot.startupSummary.totalUnits))),
      h("div", { className: "scene-stat-card" }, h("span", null, "Sourced"), h("strong", null, String(operatingSnapshot.startupSummary.coveredUnits))),
      h("div", { className: "scene-stat-card" }, h("span", null, "Missing"), h("strong", null, String(operatingSnapshot.startupSummary.missingUnits))),
      h("div", { className: "scene-stat-card" }, h("span", null, "Readiness"), h("strong", null, `${drillingReadinessPercent}%`)),
    ),
  );
  const reusableKpiSection = isOperationsStage
    ? h(
        "section",
        { className: "scene-panel-section" },
        h(
          "div",
          { className: "scene-panel-head" },
          h("span", { className: "scene-panel-kicker" }, "Reusable Stock"),
          h("strong", null, operatingStatusLabel),
        ),
        h(
          "div",
          { className: "scene-stat-grid" },
          h("div", { className: "scene-stat-card" }, h("span", null, "Units"), h("strong", null, String(operatingSnapshot.reusableSummary.totalUnits))),
          h("div", { className: "scene-stat-card" }, h("span", null, "Categories"), h("strong", null, String(operatingSnapshot.reusableSummary.categoryCount))),
          h("div", { className: "scene-stat-card" }, h("span", null, "Critical"), h("strong", null, String(operatingSnapshot.reusableSummary.criticalUnits))),
        ),
      )
    : null;

  if (isLoadingMove) {
    return h(
      AppLayout,
      {
        title: "Loading rig move",
        subtitle: "Restoring the saved move from the database.",
        currentUser,
        onLogout,
        onBack,
        language,
        onToggleLanguage,
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
        language,
        onToggleLanguage,
      },
      h(Card, { className: "empty-state" }, h("h2", null, "Move unavailable"), h("p", { className: "muted-copy" }, "Return to the dashboard and choose another rig move.")),
    );
  }

  if (!hasScenarioPlans) {
    return h(
      AppLayout,
      {
        title: move.name,
        subtitle: move.createdLabel,
        currentUser,
        onLogout,
        onBack,
        language,
        onToggleLanguage,
        fullBleed: true,
      },
      h(
        Card,
        { className: "empty-state" },
        h("h2", null, "Move unavailable"),
        h("p", { className: "muted-copy" }, "Open the dashboard and start execution after setting the fleet plan."),
      ),
    );
  }

  function handleFocusChange(nextFocusTarget) {
    setFocusTarget(nextFocusTarget || null);
  }

  const pageContent = activeView === "map"
    ? h(
        "main",
        { className: `scene-only-shell${isTimelineMode ? " scene-only-shell-timeline" : ""}` },
        !isTimelineMode
          ? h(
              "div",
              { className: "scene-top-bar" },
              h(
                "div",
                { className: "scene-top-left-actions" },
                h(Button, {
                  type: "button",
                  variant: "ghost",
                  className: "scene-back-button",
                  onClick: onBack,
                  children: h(
                    "svg",
                    {
                      className: "scene-back-icon",
                      viewBox: "0 0 16 16",
                      "aria-hidden": "true",
                    },
                    h("path", {
                      d: "M 10.5 3.5 L 6 8 L 10.5 12.5",
                      fill: "none",
                      stroke: "currentColor",
                      "stroke-width": "2.2",
                      "stroke-linecap": "round",
                      "stroke-linejoin": "round",
                    }),
                  ),
                }),
                !readOnly
                  ? h(
                      Button,
                      {
                        type: "button",
                        variant: "ghost",
                        className: "scene-back-button scene-back-button-inline scene-delete-button",
                        onClick: () => setIsDeleteConfirmOpen(true),
                        "aria-label": "Delete move",
                      },
                      h(
                        "svg",
                        {
                          className: "scene-back-icon",
                          viewBox: "0 0 16 16",
                          "aria-hidden": "true",
                        },
                        h("path", {
                          d: "M 5.2 5.2 L 10.8 10.8 M 10.8 5.2 L 5.2 10.8",
                          fill: "none",
                          stroke: "currentColor",
                          "stroke-width": "2",
                          "stroke-linecap": "round",
                        }),
                      ),
                    )
                  : null,
                h(Button, {
                  type: "button",
                  variant: "ghost",
                  className: "scene-top-action-button",
                  onClick: () => handleSceneModeChange("timeline"),
                  children: "Timeline",
                }),
              ),
              h(
                "div",
                { className: "scene-top-title scene-passive-overlay" },
                h("span", { className: "scene-panel-kicker" }, "Move"),
                h("strong", { className: "scene-top-title-text" }, move.name || "Rig Move"),
                h(
                  "div",
                  { className: "scene-stage-progress" },
                  [
                    {
                      key: "planning",
                      label: "Planning",
                      icon: h(
                        "svg",
                        { className: "scene-stage-icon", viewBox: "0 0 16 16", "aria-hidden": "true" },
                        h("path", {
                          d: "M 3.5 4.5 H 12.5 M 3.5 8 H 12.5 M 3.5 11.5 H 9.5",
                          fill: "none",
                          stroke: "currentColor",
                          "stroke-width": "1.8",
                          "stroke-linecap": "round",
                        }),
                      ),
                    },
                    {
                      key: "execution",
                      label: "Execution",
                      icon: h(
                        "svg",
                        { className: "scene-stage-icon", viewBox: "0 0 16 16", "aria-hidden": "true" },
                        h("path", {
                          d: "M 8 3.5 C 5.2 3.5 3.3 5.4 3.3 8 C 3.3 10.6 5.2 12.5 8 12.5 C 10.8 12.5 12.7 10.6 12.7 8 C 12.7 5.4 10.8 3.5 8 3.5 Z",
                          fill: "none",
                          stroke: "currentColor",
                          "stroke-width": "1.6",
                        }),
                        h("path", {
                          d: "M 8 5.6 V 8 L 9.9 9.4",
                          fill: "none",
                          stroke: "currentColor",
                          "stroke-width": "1.6",
                          "stroke-linecap": "round",
                          "stroke-linejoin": "round",
                        }),
                      ),
                    },
                    {
                      key: "operations",
                      label: "Drilling",
                      icon: h(
                        "svg",
                        { className: "scene-stage-icon", viewBox: "0 0 16 16", "aria-hidden": "true" },
                        h("path", {
                          d: "M 8 2.8 V 13.2 M 4.8 6.3 H 11.2 M 5.6 3.8 H 10.4 M 5.6 12.2 H 10.4",
                          fill: "none",
                          stroke: "currentColor",
                          "stroke-width": "1.6",
                          "stroke-linecap": "round",
                        }),
                      ),
                    },
                  ].map((stage, index, stages) => {
                    const activeStageIndex = stages.findIndex((item) => item.key === activeStageKey);
                    const isCompleted = activeStageIndex > index;
                    const isActive = activeStageIndex === index;

                    return h(
                      "div",
                      {
                        key: stage.key,
                        className: `scene-stage-item${isActive ? " is-active" : ""}${isCompleted ? " is-completed" : ""}`,
                      },
                      h(
                        "button",
                        {
                          type: "button",
                          className: "scene-stage-button",
                          onClick: () => setActiveStageKey(stage.key),
                        },
                        h("div", { className: "scene-stage-node" }, stage.icon),
                        h("span", { className: "scene-stage-label" }, stage.label),
                      ),
                      index < stages.length - 1 ? h("span", { className: "scene-stage-link", "aria-hidden": "true" }) : null,
                    );
                  }),
                ),
              ),
            )
          : null,
        isTimelineMode
          ? h(
              "div",
              { className: "scene-top-left-actions scene-top-left-actions-timeline" },
              h(Button, {
                type: "button",
                variant: "ghost",
                className: "scene-back-button scene-back-button-inline",
                onClick: () => handleSceneModeChange(previousSceneMode || "2d"),
                children: h(
                  "svg",
                  {
                    className: "scene-back-icon",
                    viewBox: "0 0 16 16",
                    "aria-hidden": "true",
                  },
                  h("path", {
                    d: "M 10.5 3.5 L 6 8 L 10.5 12.5",
                    fill: "none",
                    stroke: "currentColor",
                    "stroke-width": "2.2",
                    "stroke-linecap": "round",
                    "stroke-linejoin": "round",
                  }),
                ),
              }),
            )
          : null,
        isTimelineMode
          ? h(
              "section",
              { className: "scene-timeline-layout" },
              h(PlannerCanvas, {
                playback: displaySimulation.bestPlan.playback,
                zoom: timelineZoom,
                criticalPathChain,
                criticalScheduleRows,
                plannerScheduleRows,
                plannerCostRows,
                operatingSnapshot,
                drillingReadinessPercent,
                activePlanDashboard,
                planComparisonStats,
                scenario: selectedScenario,
                move: safeMove,
                currentMinute: visibleMinute,
                timelineGapMinutes,
              }),
            )
          : sceneMode === "3d"
          ? (SimulationScene3DComponent
            ? h(SimulationScene3DComponent, {
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
                onFocusChange: handleFocusChange,
              })
            : h(
                Card,
                { className: "empty-state scene-loading-card" },
                h("h2", null, "Loading 3D view"),
                h("p", { className: "muted-copy" }, "3D loads only when you open it."),
              ))
          : sceneMode === "2d"
            ? (LeafletMapComponent
              ? h(LeafletMapComponent, {
                  startPoint: move.startPoint,
                  endPoint: move.endPoint,
                  simulation: displaySimulation,
                  currentMinute: visibleMinute,
                  supportRoutes: startupTransferSchedule,
                  heightClass: "scene-only-canvas",
                  onFocusChange: handleFocusChange,
                })
              : h(
                  Card,
                  { className: "empty-state scene-loading-card" },
                  h("h2", null, "Loading map"),
                  h("p", { className: "muted-copy" }, "The map view is loading."),
                ))
            : h(FullScreenTimeline, {
                playback: displaySimulation.bestPlan.playback,
                currentMinute: visibleMinute,
                zoom: timelineZoom,
              }),
        !isTimelineMode
          ? h(
          "div",
          { className: "scene-move-info" },
          h(
            "div",
            { className: "scene-move-info-grid" },
            h("div", { className: "scene-dashboard-inline scene-dashboard-kpi-item scene-move-info-row-full" }, h("span", { className: "scene-dashboard-label" }, "From"), h("strong", null, formatLocationLabel(move.startLabel, "Source"))),
            h("div", { className: "scene-dashboard-inline scene-dashboard-kpi-item scene-move-info-row-full" }, h("span", { className: "scene-dashboard-label" }, "To"), h("strong", null, formatLocationLabel(move.endLabel, "Destination"))),
            h("div", { className: "scene-dashboard-inline scene-dashboard-kpi-item" }, h("span", { className: "scene-dashboard-label" }, "Distance"), h("strong", null, `${move.routeKm || 0} km`)),
            h("div", { className: "scene-dashboard-inline scene-dashboard-kpi-item" }, h("span", { className: "scene-dashboard-label" }, "Travel"), h("strong", null, move.routeTime || formatMinutes(move.simulation?.routeMinutes || 0))),
          ),
        )
          : null,
        !isTimelineMode && isPlanningStage
          ? h(
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
              h("span", null, "Speed"),
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
            "div",
            { className: "scene-mode-switcher" },
            h(
              "div",
              { className: "scene-mode-mini-nav" },
              ["3d", "2d"].map((mode) =>
                h(
                  "button",
                {
                  key: `scene-mode-${mode}`,
                  type: "button",
                  className: `scene-dimension-toggle scene-mode-mini-nav-button${sceneMode === mode ? " is-active" : ""}`,
                  onClick: () => handleSceneModeChange(mode),
                },
                mode === "3d" ? "3D" : "2D",
              ),
              ),
            ),
          ),
          sceneMode === "timeline"
            ? h(
                "div",
                { className: "scene-timeline-zoom-controls" },
                h(
                  "button",
                  {
                    type: "button",
                    className: "scene-dimension-toggle",
                    disabled: timelineZoom <= 0.1,
                    onClick: () => setTimelineZoom((current) => Math.max(0.1, Math.round((current / 2) * 100) / 100)),
                  },
                  "-",
                ),
                h("span", { className: "scene-timeline-zoom-label" }, `${timelineZoom}x`),
                h(
                  "button",
                  {
                    type: "button",
                    className: "scene-dimension-toggle",
                    disabled: timelineZoom >= 8,
                    onClick: () => setTimelineZoom((current) => Math.min(8, Math.round((current * 2) * 100) / 100)),
                  },
                      "+",
                    ),
                  )
            : null,
        )
          : null,
        !isTimelineMode
          ? h(
          "aside",
          { className: "scene-panel scene-panel-left scene-panel-left-merged" },
          isCustomizeActive
            ? [
                h(
                  "div",
                  { className: "scene-plan-summary-stack scene-passive-overlay" },
                  h(
                  "div",
                  { className: "scene-plan-summary-card scene-plan-summary-card-title" },
                  h("span", { className: "scene-panel-kicker" }, "Selected Plan"),
                  h("strong", { className: "scene-plan-summary-title" }, isCustomizeActive ? "Custom Plan" : activeScenario.name),
                ),
                ),
                h(
                  "section",
                  { className: "scene-panel-section scene-panel-section-plain" },
                  canEditPlan
                    ? h(
                        "div",
                        { className: "truck-slider-grid" },
                        truckSetup.map((truck) =>
                          h(
                            "label",
                            { key: truck.id, className: "truck-slider-card truck-slider-card-compact" },
                            h(
                              "div",
                              { className: "truck-slider-head truck-slider-head-compact" },
                              h("span", { title: truck.type || "Truck" }, getTruckShortLabel(truck.type)),
                              h("strong", null, truck.count),
                            ),
                            (() => {
                              const min = 1;
                              const max = getSliderMaxCount(Number.parseInt(truck.count, 10) || 0);
                              const currentValue = Number.parseInt(truck.count, 10) || min;
                              const progress = max > min ? ((currentValue - min) / (max - min)) * 100 : 100;

                              return h("input", {
                                className: "truck-slider-input",
                                type: "range",
                                min: String(min),
                                max: String(max),
                                step: "1",
                                value: truck.count,
                                style: { "--truck-slider-progress": `${progress}%` },
                                onInput: (event) => updateTruckCount(truck.id, event.target.value),
                              });
                            })(),
                          ),
                        ),
                      )
                    : isPlanningStage
                      ? truckSetup.map((truck) =>
                          h(
                            "div",
                            { key: truck.id, className: "truck-count-row" },
                            h("span", null, truck.type || "Truck"),
                            h("strong", null, truck.count),
                          ),
                      )
                    : null,
                  canEditPlan
                    ? h(
                        "div",
                        { className: "truck-time-controls" },
                        h(
                          "label",
                          { className: "truck-time-card" },
                          h(
                            "div",
                            { className: "truck-slider-head" },
                            h("span", null, "Start Date"),
                            h("strong", null, planningStartDateLabel),
                          ),
                          h("input", {
                            className: "truck-time-input",
                            type: "date",
                            value: planningStartDate,
                            onInput: (event) => setPlanningStartDate(normalizePlanningDate(event.target.value, move?.createdAt)),
                          }),
                        ),
                      )
                    : null,
                ),
                executionStatusRow,
                executionSummary,
                simulationError ? h("p", { className: "field-error section-spacing" }, simulationError) : null,
                readOnlyBanner,
                !readOnly && isPlanningStage
                  ? h(
                      "div",
                      { className: "scene-panel-actions" },
                      h(PlaybackActionButton, {
                        isRunning: isPlaybackRunning,
                        isBusy: isSimulating,
                        isPaused: isPlaybackPaused,
                        onRun: () => onRunCustomPlan({ moveId: move.id, truckSetup }),
                        onEnd: onEndPlayback,
                        onPauseToggle: onPausePlayback,
                        label: canResumePlayback ? "Resume Simulation" : "Run Simulation",
                      }),
                      h(Button, {
                        type: "button",
                        variant: "ghost",
                        className: "scene-top-action-button",
                        onClick: () => onStartExecution?.(move.id),
                        children: "Start Execution",
                      }),
                    )
                  : executionActions,
              ]
            : [
                h(
                  "div",
                  { className: "scene-plan-summary-stack scene-passive-overlay" },
                  h(
                  "div",
                  { className: "scene-plan-summary-card scene-plan-summary-card-title" },
                  h("span", { className: "scene-panel-kicker" }, "Selected Plan"),
                  h("strong", { className: "scene-plan-summary-title" }, isCustomizeActive ? "Custom Plan" : activeScenario.name),
                ),
                ),
                h(
                  "section",
                  { className: "scene-panel-section scene-panel-section-plain scene-passive-overlay" },
                  isPlanningStage
                    ? [
                        h(
                          "div",
                          { className: "truck-slider-grid scene-passive-overlay" },
                          displayedTruckCounts.map((truck) =>
                            h(
                              "div",
                              { key: `summary-${truck.id}`, className: "truck-slider-card truck-slider-card-compact" },
                              h(
                                "div",
                                { className: "truck-slider-head truck-slider-head-compact" },
                                h("span", { title: truck.type || "Truck" }, getTruckShortLabel(truck.type)),
                                h("strong", null, `${truck.count}/${getFleetCapacityForType(availableFleet, truck.type)}`),
                              ),
                            ),
                          ),
                        ),
                        h(
                          "div",
                          { key: "planning-start-date", className: "truck-count-row scene-passive-overlay" },
                          h("span", null, "Start Date"),
                          h("strong", null, planningStartDateLabel),
                        ),
                      ]
                    : [],
                ),
                executionStatusOverlayRow,
                executionSummary,
                readOnlyBanner,
                !readOnly && isPlanningStage
                  ? h(
                      "div",
                      { className: "scene-panel-actions" },
                      h(PlaybackActionButton, {
                        isRunning: isPlaybackRunning,
                        isPaused: isPlaybackPaused,
                        onRun: onRunPlayback,
                        onEnd: onEndPlayback,
                        onPauseToggle: onPausePlayback,
                        label: canResumePlayback ? "Resume Playback" : "Run Playback",
                      }),
                      h(Button, {
                        type: "button",
                        variant: "ghost",
                        className: "scene-top-action-button",
                        onClick: () => onStartExecution?.(move.id),
                        children: "Start Execution",
                      }),
                    )
                  : executionActions,
              ],
        )
          : null,
        !isTimelineMode && focusedTruckStats
          ? h(
              "div",
              { className: "scene-top-info-strip" },
              h(
                "div",
                { className: "scene-plan-kpis" },
                h("div", { className: "scene-dashboard-stack-item" }, h("span", { className: "scene-dashboard-label" }, `Truck ${focusedTruckStats.truckId}`), h("strong", null, focusedTruckStats.truckType), h("p", { className: "scene-dashboard-copy" }, focusedTruckStats.statusDetail)),
                h("div", { className: "scene-dashboard-inline scene-dashboard-kpi-item" }, h("span", { className: "scene-dashboard-label" }, "Status"), h("strong", null, focusedTruckStats.statusLabel)),
                h("div", { className: "scene-dashboard-inline scene-dashboard-kpi-item" }, h("span", { className: "scene-dashboard-label" }, "Completed Loads"), h("strong", null, String(focusedTruckStats.completedLoads))),
                h("div", { className: "scene-dashboard-inline scene-dashboard-kpi-item" }, h("span", { className: "scene-dashboard-label" }, "Remaining Assignments"), h("strong", null, String(focusedTruckStats.remainingAssignedLoads))),
              ),
              h(
                "div",
                { className: "scene-plan-dashboard" },
                h(
                  "div",
                  { className: "scene-plan-summary-card scene-plan-summary-card-title" },
                  h("span", { className: "scene-panel-kicker" }, "Truck Focus"),
                  h("strong", { className: "scene-plan-summary-title" }, focusedTruckOverviewTitle),
                ),
                h(
                  "div",
                  { className: "scene-dashboard-pair" },
                  h("div", { className: "scene-dashboard-inline scene-dashboard-pair-item" }, h("span", { className: "scene-dashboard-label" }, "Busy Time"), h("strong", null, focusedTruckStats.busyTime)),
                  h("div", { className: "scene-dashboard-inline scene-dashboard-pair-item" }, h("span", { className: "scene-dashboard-label" }, "Next Milestone"), h("strong", null, focusedTruckStats.nextMilestone)),
                ),
                h(
                  "div",
                  { className: "scene-dashboard-pair" },
                  h("div", { className: "scene-dashboard-inline scene-dashboard-pair-item" }, h("span", { className: "scene-dashboard-label" }, "Assigned Distance"), h("strong", null, focusedTruckStats.assignedDistance)),
                  h("div", { className: "scene-dashboard-inline scene-dashboard-pair-item" }, h("span", { className: "scene-dashboard-label" }, "Plan Share"), h("strong", null, `${Math.round((focusedTruckStats.completedLoads / Math.max(activePlanSummary.totalLoads, 1)) * 100)}%`)),
                ),
              ),
            )
          : !isTimelineMode && focusedRigStats
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
                  h("strong", { className: "scene-plan-summary-title" }, focusedRigOverviewTitle),
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
                  h(
                    "div",
                    { className: "scene-dashboard-pair" },
                    h("div", { className: "scene-dashboard-inline scene-dashboard-pair-item" }, h("span", { className: "scene-dashboard-label" }, focusedRigStats.side === "source" ? "Loading Now" : "Rigging Now"), h("strong", null, String(focusedRigStats.side === "source" ? focusedRigStats.loadingNow : focusedRigStats.riggingNow))),
                    h("div", { className: "scene-dashboard-inline scene-dashboard-pair-item" }, h("span", { className: "scene-dashboard-label" }, "Next Event"), h("strong", null, focusedRigStats.nextEventIn)),
                  ),
                  h("div", { className: "scene-dashboard-stack-item" }, h("span", { className: "scene-dashboard-label" }, "Site Pressure"), h("strong", null, focusedRigStats.sitePressure)),
                ),
              ),
            )
          : !isTimelineMode && (isPlaybackRunning || isPlaybackPaused) && !isPlanningStage
          ? h(
              "div",
              { className: "scene-top-info-strip" },
              h(
                "div",
                { className: "scene-plan-kpis" },
                h("div", { className: "scene-dashboard-inline scene-dashboard-kpi-item" }, h("span", { className: "scene-dashboard-label" }, "Actual Completion"), h("strong", null, `${actualCompletionPercent}%`)),
                h("div", { className: "scene-dashboard-inline scene-dashboard-kpi-item" }, h("span", { className: "scene-dashboard-label" }, "Planned By Now"), h("strong", null, `${plannedCompletionPercent}%`)),
                h("div", { className: "scene-dashboard-inline scene-dashboard-kpi-item" }, h("span", { className: "scene-dashboard-label" }, "Variance"), h("strong", null, completionVarianceLabel)),
                h("div", { className: "scene-dashboard-stack-item" }, h("span", { className: "scene-dashboard-label" }, "Execution Pace"), h("strong", null, executionPaceLabel), h("p", { className: "scene-dashboard-copy" }, `${actualTasksDone}/${executionAssignmentMetrics.totalStageTasks} stage tasks complete against ${plannedTasksByNow} planned by now.`)),
              ),
              h(
                "div",
                { className: "scene-plan-dashboard" },
                h(
                  "div",
                  { className: "scene-plan-summary-card scene-plan-summary-card-title" },
                  h("span", { className: "scene-panel-kicker" }, t("executionTracking", "Execution Tracking")),
                  h("strong", { className: "scene-plan-summary-title" }, isPlaybackPaused ? t("pausedVsPlan", "Paused vs Plan") : t("actualVsPlanned", "Actual vs Planned")),
                ),
                h(
                  "div",
                  { className: "scene-dashboard-phase-stack" },
                  h(
                    "div",
                    { className: "scene-dashboard-phase-row" },
                    h("div", { className: "scene-dashboard-inline scene-dashboard-kpi-item" }, h("span", { className: "scene-dashboard-label" }, "Rig Down"), h("strong", null, `${executionAssignmentMetrics.stagePercents.down}% actual / ${Math.round(phases.down)}% plan`)),
                    h(ProgressBar, { value: executionAssignmentMetrics.stagePercents.down }),
                  ),
                  h(
                    "div",
                    { className: "scene-dashboard-phase-row" },
                    h("div", { className: "scene-dashboard-inline scene-dashboard-kpi-item" }, h("span", { className: "scene-dashboard-label" }, "Move"), h("strong", null, `${executionAssignmentMetrics.stagePercents.move}% actual / ${Math.round(phases.move)}% plan`)),
                    h(ProgressBar, { value: executionAssignmentMetrics.stagePercents.move }),
                  ),
                  h(
                    "div",
                    { className: "scene-dashboard-phase-row" },
                    h("div", { className: "scene-dashboard-inline scene-dashboard-kpi-item" }, h("span", { className: "scene-dashboard-label" }, "Rig Up"), h("strong", null, `${executionAssignmentMetrics.stagePercents.up}% actual / ${Math.round(phases.up)}% plan`)),
                    h(ProgressBar, { value: executionAssignmentMetrics.stagePercents.up }),
                  ),
                ),
                h(
                  "div",
                  { className: "scene-dashboard-pair" },
                  h("div", { className: "scene-dashboard-inline scene-dashboard-pair-item" }, h("span", { className: "scene-dashboard-label" }, t("driversAssigned", "Drivers Assigned")), h("strong", null, String(executionAssignmentMetrics.driverCount))),
                  h("div", { className: "scene-dashboard-inline scene-dashboard-pair-item" }, h("span", { className: "scene-dashboard-label" }, "Stage Tasks Done"), h("strong", null, `${actualTasksDone}/${executionAssignmentMetrics.totalStageTasks}`)),
                ),
                h(
                  "div",
                  { className: "scene-dashboard-pair" },
                  h("div", { className: "scene-dashboard-inline scene-dashboard-pair-item" }, h("span", { className: "scene-dashboard-label" }, "Planned Tasks By Now"), h("strong", null, String(plannedTasksByNow))),
                  h("div", { className: "scene-dashboard-inline scene-dashboard-pair-item" }, h("span", { className: "scene-dashboard-label" }, "Time Left"), h("strong", null, formatMinutes(Math.max(0, Math.round(totalMinutes - visibleMinute))))),
                ),
                isOperationsStage
                  ? h(
                      "div",
                      { className: "scene-dashboard-pair" },
                      h("div", { className: "scene-dashboard-inline scene-dashboard-pair-item" }, h("span", { className: "scene-dashboard-label" }, "Completed Loads"), h("strong", null, String(rigLoads.completedLoads))),
                      h("div", { className: "scene-dashboard-inline scene-dashboard-pair-item" }, h("span", { className: "scene-dashboard-label" }, "Last Operation"), h("strong", null, lastLog?.title || "Waiting for execution")),
                    )
                  : null,
              ),
            )
          : !isTimelineMode && !isPlanningStage ? h(
              "div",
              { className: "scene-top-info-strip" },
              h(
                "div",
                { className: "scene-plan-kpis" },
                h("div", { className: "scene-dashboard-inline scene-dashboard-kpi-item" }, h("span", { className: "scene-dashboard-label" }, t("timePassed", "Time Passed")), h("strong", null, renderElapsedTimeValue(executionVisibleMinute))),
                h("div", { className: "scene-dashboard-inline scene-dashboard-kpi-item" }, h("span", { className: "scene-dashboard-label" }, "Completion"), h("strong", null, `${actualCompletionPercent}%`)),
                h("div", { className: "scene-dashboard-inline scene-dashboard-kpi-item" }, h("span", { className: "scene-dashboard-label" }, "Plan By Now"), h("strong", null, `${plannedCompletionPercent}%`)),
                h("div", { className: "scene-dashboard-stack-item" }, h("span", { className: "scene-dashboard-label" }, "Next Task"), h("strong", null, nextExecutionTaskLabel), h("p", { className: "scene-dashboard-copy" }, `${executionPaceLabel} • variance ${completionVarianceLabel}`)),
              ),
              h(
                "div",
                { className: "scene-plan-dashboard" },
                h(
                  "div",
                  { className: "scene-plan-summary-card scene-plan-summary-card-title" },
                  h("span", { className: "scene-panel-kicker" }, t("executionTracking", "Execution Tracking")),
                  h("strong", { className: "scene-plan-summary-title" }, t("actualVsPlanned", "Actual vs Planned")),
                ),
                h(
                  "div",
                  { className: "scene-dashboard-pair" },
                  h("div", { className: "scene-dashboard-inline scene-dashboard-pair-item" }, h("span", { className: "scene-dashboard-label" }, t("aheadBehind", "Ahead / Behind")), h("strong", null, completionVarianceLabel)),
                  h("div", { className: "scene-dashboard-inline scene-dashboard-pair-item" }, h("span", { className: "scene-dashboard-label" }, t("timeLeft", "Time Left")), h("strong", null, timeLeftLabel)),
                ),
                h(
                  "div",
                  { className: "scene-dashboard-pair" },
                  h("div", { className: "scene-dashboard-inline scene-dashboard-pair-item" }, h("span", { className: "scene-dashboard-label" }, t("driversAssigned", "Drivers Assigned")), h("strong", null, String(executionAssignmentMetrics.driverCount))),
                  h("div", { className: "scene-dashboard-inline scene-dashboard-pair-item" }, h("span", { className: "scene-dashboard-label" }, t("tasksDone", "Tasks Done")), h("strong", null, `${actualTasksDone}/${executionAssignmentMetrics.totalStageTasks}`)),
                ),
                h(
                  "div",
                  { className: "scene-dashboard-pair" },
                  h("div", { className: "scene-dashboard-inline scene-dashboard-pair-item" }, h("span", { className: "scene-dashboard-label" }, t("rigDown", "Rig Down")), h("strong", null, `${executionAssignmentMetrics.stagePercents.down}% / ${Math.round(phases.down)}%`)),
                  h("div", { className: "scene-dashboard-inline scene-dashboard-pair-item" }, h("span", { className: "scene-dashboard-label" }, t("move", "Move")), h("strong", null, `${executionAssignmentMetrics.stagePercents.move}% / ${Math.round(phases.move)}%`)),
                ),
                h(
                  "div",
                  { className: "scene-dashboard-pair" },
                  h("div", { className: "scene-dashboard-inline scene-dashboard-pair-item" }, h("span", { className: "scene-dashboard-label" }, t("rigUp", "Rig Up")), h("strong", null, `${executionAssignmentMetrics.stagePercents.up}% / ${Math.round(phases.up)}%`)),
                  h("div", { className: "scene-dashboard-inline scene-dashboard-pair-item" }, h("span", { className: "scene-dashboard-label" }, t("plannedTasks", "Planned Tasks")), h("strong", null, String(plannedTasksByNow))),
                ),
              ),
            )
          : !isTimelineMode ? h(
              "div",
              { className: "scene-top-info-strip" },
              h(
                "div",
                { className: "scene-plan-kpis" },
                h("div", { className: "scene-dashboard-inline scene-dashboard-kpi-item" }, h("span", { className: "scene-dashboard-label" }, t("rigDown", "Rig Down")), h("strong", null, `${Math.round(phases.down)}%`)),
                h("div", { className: "scene-dashboard-inline scene-dashboard-kpi-item" }, h("span", { className: "scene-dashboard-label" }, t("move", "Move")), h("strong", null, `${Math.round(phases.move)}%`)),
                h("div", { className: "scene-dashboard-inline scene-dashboard-kpi-item" }, h("span", { className: "scene-dashboard-label" }, t("rigUp", "Rig Up")), h("strong", null, `${Math.round(phases.up)}%`)),
                h("div", { className: "scene-dashboard-inline scene-dashboard-kpi-item" }, h("span", { className: "scene-dashboard-label" }, "ETA"), h("strong", null, planEtaLabel)),
              ),
              h(
                "div",
                { className: "scene-plan-dashboard" },
                h(
                  "div",
                  { className: "scene-plan-summary-card scene-plan-summary-card-title" },
                  h("span", { className: "scene-panel-kicker" }, t("executionPlan", "Execution Plan")),
                  h("strong", { className: "scene-plan-summary-title" }, isCustomizeActive ? t("customExecutionPlan", "Custom Execution Plan") : t("planOverview", "Plan Overview")),
                ),
                h(
                  "div",
                  { className: "scene-dashboard-pair" },
                  h("div", { className: "scene-dashboard-inline scene-dashboard-pair-item" }, h("span", { className: "scene-dashboard-label" }, t("totalTime", "Total Time")), h("strong", null, formatDaysHours(activePlanSummary.totalMinutes))),
                  h("div", { className: "scene-dashboard-inline scene-dashboard-pair-item" }, h("span", { className: "scene-dashboard-label" }, t("roundTrips", "Round Trips")), h("strong", null, String(activePlanSummary.roundTrips))),
                ),
                h(
                  "div",
                  { className: "scene-dashboard-pair" },
                  h("div", { className: "scene-dashboard-inline scene-dashboard-pair-item" }, h("span", { className: "scene-dashboard-label" }, t("planCost", "Plan Cost")), h("strong", null, activePlanDashboard.costEstimate)),
                  h("div", { className: "scene-dashboard-inline scene-dashboard-pair-item" }, h("span", { className: "scene-dashboard-label" }, t("criticalPath", "Critical Path")), h("strong", null, `${activePlanDashboard.criticalPathHours}h`)),
                ),
                h(
                  "div",
                  { className: "scene-dashboard-pair" },
                  h("div", { className: "scene-dashboard-inline scene-dashboard-pair-item" }, h("span", { className: "scene-dashboard-label" }, t("rigDown", "Rig Down")), h("strong", null, `${Math.round(phases.down)}%`)),
                  h("div", { className: "scene-dashboard-inline scene-dashboard-pair-item" }, h("span", { className: "scene-dashboard-label" }, t("move", "Move")), h("strong", null, `${Math.round(phases.move)}%`)),
                ),
                h(
                  "div",
                  { className: "scene-dashboard-pair" },
                  h("div", { className: "scene-dashboard-inline scene-dashboard-pair-item" }, h("span", { className: "scene-dashboard-label" }, t("rigUp", "Rig Up")), h("strong", null, `${Math.round(phases.up)}%`)),
                  h("div", { className: "scene-dashboard-inline scene-dashboard-pair-item" }, h("span", { className: "scene-dashboard-label" }, "Preview"), h("strong", null, isPlaybackRunning || isPlaybackPaused ? "Running" : "Ready")),
                ),
                null,
              ),
            ) : null,
        !readOnly && executionState === "planning" && !isTimelineMode && !isPlaybackRunning && !isPlaybackPaused
          ? h(
              "div",
              { className: "scene-plan-switcher-wrap" },
              h(
                "div",
                { className: "plan-switcher-shell" },
                h(PlanSwitcher, {
                  scenarios: scenarioPlans,
                  activePlanKey,
                  includeCustomize: !readOnly,
                  onSelect: (planKey) => {
                    setActivePlanKey(planKey);
                    if (planKey === "customize") {
                      setTruckSetup(normalizeTruckSetup({
                        ...move,
                        truckSetup: activeScenario?.allocatedTruckSetup || activeScenario?.truckSetup || move?.truckSetup || [],
                      }, availableFleet));
                      return;
                    }
                    setActiveScenarioName(planKey);
                    onSelectPlan({ moveId: move.id, scenarioName: planKey });
                  },
                }),
              ),
            )
          : null,
        isPlaybackRunning || isPlaybackPaused
          ? h(MoveAssistant, {
              move,
              playback: displaySimulation.bestPlan.playback,
              currentMinute: visibleMinute,
              rigLoads,
              lastLog,
              completion,
            })
          : null,
      )
    : h(
        AppLayout,
        {
          title: move.name,
          subtitle: `${formatLocationLabel(move.startLabel, "Source")} -> ${formatLocationLabel(move.endLabel, "Destination")}`,
          currentUser,
          onLogout,
          onBack,
          language,
          onToggleLanguage,
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
              h("div", { className: "section-heading" }, h("h2", null, "Execution Plan"), h("span", { className: "section-pill" }, `${effectiveTruckCount} trucks`)),
              h("p", { className: "muted-copy section-spacing" }, readOnly ? "Assigned fleet summary for this rig." : "Choose the plan for this rig. Trucks remain unreserved until execution starts."),
              !canEditPlan || readOnly
                ? h(
                    "section",
                    { className: "scene-panel-section scene-panel-section-plain" },
                    [
                      ...displayedTruckCounts.map((truck) =>
                        h(
                          "div",
                          { key: truck.id, className: "truck-count-row" },
                          h("span", null, truck.type || "Truck"),
                          h("strong", null, `${truck.count}/${getFleetCapacityForType(availableFleet, truck.type)}`),
                        ),
                      ),
                      h(
                        "div",
                        { key: "planning-start-date", className: "truck-count-row" },
                        h("span", null, "Start Date"),
                        h("strong", null, planningStartDateLabel),
                      ),
                    ],
                  )
                : h(TruckSetupEditor, {
                    truckSetup,
                    onChange: (truckId, field, value) =>
                      field === "count"
                        ? updateTruckCount(truckId, value)
                        : setTruckSetup((current) =>
                            current.map((item) => (item.id === truckId ? { ...item, [field]: value } : item)),
                          ),
                    onAddRow: () =>
                      setTruckSetup((current) => [...current, { id: `truck-${Date.now()}`, type: "", count: "0", hourlyCost: 0 }]),
                    onRemoveRow: (truckId) =>
                      setTruckSetup((current) => current.filter((item) => item.id !== truckId)),
                  }),
              executionStatusRow,
              executionSummary,
              simulationError ? h("p", { className: "field-error section-spacing" }, simulationError) : null,
              readOnlyBanner,
              !readOnly && isPlanningStage
                ? h(
                    "div",
                    { className: "move-setup-actions" },
                    h(PlaybackActionButton, {
                      isRunning: isPlaybackRunning,
                      isBusy: isSimulating,
                      isPaused: isPlaybackPaused,
                      onRun: () => onRunCustomPlan({ moveId: move.id, truckSetup }),
                      onEnd: onEndPlayback,
                      onPauseToggle: onPausePlayback,
                      label: canResumePlayback ? "Resume Simulation" : "Run Simulation",
                    }),
                    h(Button, {
                      type: "button",
                      variant: "ghost",
                      onClick: () => onStartExecution?.(move.id),
                      children: "Start Execution",
                    }),
                  )
                : executionActions,
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
                  meta: `${formatLocationLabel(move.startLabel, "Source")}`,
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
                  meta: `${formatLocationLabel(move.endLabel, "Destination")}`,
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
              h("p", { className: "muted-copy section-spacing" }, lastLog?.title || "Waiting for execution"),
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
                  h("div", { className: "section-heading" }, h("h2", null, "Plan Selection")),
                  h("p", { className: "muted-copy section-spacing" }, readOnly ? "The selected foreman plan is shown for inspection only." : "Compare candidate plans before starting execution. Planning does not reserve trucks."),
                ),
                h(ScenarioBreakdown, {
                  scenarios: scenarioPlans,
                  activeScenarioName: activeScenario.name,
                  disabled: readOnly,
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
        isPlaybackRunning || isPlaybackPaused
          ? h(MoveAssistant, {
              move,
              playback: displaySimulation.bestPlan.playback,
              currentMinute: visibleMinute,
              rigLoads,
              lastLog,
              completion,
            })
          : null,
      );

  return h(
    React.Fragment,
    null,
    pageContent,
    simulationOverlay,
    !readOnly && isDeleteConfirmOpen
      ? h(
          Modal,
          {
            eyebrow: "Move",
            title: "Delete Move",
            description: `Delete "${move.name}"? This cannot be undone.`,
            className: "modal-shell-compact",
            onClose: () => setIsDeleteConfirmOpen(false),
          },
          h(
            "div",
            { className: "auth-actions" },
            h(Button, {
              type: "button",
              variant: "ghost",
              className: "dashboard-field-button",
              onClick: () => setIsDeleteConfirmOpen(false),
              children: "Cancel",
            }),
            h(Button, {
              type: "button",
              className: "scene-top-action-button scene-delete-confirm-button",
              onClick: () => {
                setIsDeleteConfirmOpen(false);
                onDeleteMove?.(move.id);
              },
              children: "Delete",
            }),
          ),
        )
      : null,
  );
}

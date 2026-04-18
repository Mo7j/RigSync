import { React, h } from "../lib/react.js";
import { AppLayout } from "../layouts/AppLayout.js";
import { Button } from "../components/ui/Button.js";
import { Card, StatCard } from "../components/ui/Card.js";
import { ProgressBar } from "../components/ui/ProgressBar.js";
import { Field, TextInput } from "../components/ui/Field.js";
import { Modal } from "../components/ui/Modal.js";
import { formatLocationLabel, formatMinutes } from "../lib/format.js";
import { translate } from "../lib/language.js";
import { buildScenarioPlans } from "../features/rigMoves/isePlanner.js";
import { buildOperatingSnapshot, buildStartupTransferSchedule } from "../features/rigMoves/operations.js";
import { persistMoveSession } from "../features/rigMoves/storage.js";

const { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } = React;

const PROJECT_OVERHEAD_SAR_PER_DAY = 5000;
const WORKER_ROLE_RATES = {
  driller: 70,
  bop_tech: 60,
  assistant_driller: 55,
  forklift_crane_operator: 50,
  derrickman: 55,
  operator: 50,
  floorman: 50,
  camp_foreman: 48,
  crane_operator: 60,
  yard_foreman: 48,
  rigger: 45,
  roustabout: 38,
  mechanic: 50,
  truck_driver: 40,
  welder: 48,
  electrician: 50,
  pumpman_mechanic: 50,
};

function normalizeTruckTypeKey(type) {
  const normalized = String(type || "")
    .toLowerCase()
    .replace(/[^a-z]/g, "");

  if (normalized === "fb" || normalized.includes("flatbed")) {
    return "flatbed";
  }
  if (normalized === "lb" || normalized.includes("lowbed") || normalized.includes("support")) {
    return "lowbed";
  }
  if (normalized === "hh" || normalized.includes("heavyhaul")) {
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
  if (entity?.executionLoadLabel || entity?.simpleLoadLabel) {
    return String(entity.executionLoadLabel || entity.simpleLoadLabel);
  }
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

function parseDistanceCm(value) {
  const matched = String(value || "").match(/-?\d+(?:\.\d+)?/);
  if (!matched) {
    return null;
  }

  const parsed = Number(matched[0]);
  if (!Number.isFinite(parsed)) {
    return null;
  }

  return Math.max(0, parsed);
}

function formatDistanceCm(value) {
  if (value == null || !Number.isFinite(Number(value))) {
    return "--";
  }

  const safeValue = Math.max(0, Number(value));
  return `${Number.isInteger(safeValue) ? safeValue : safeValue.toFixed(1)} cm`;
}

function getExecutionMoveState(assignment = {}) {
  if (assignment?.taskType === "return") {
    if (!assignment?.moveStartedAt) {
      return "readyOutbound";
    }
    if (!assignment?.returnedToSourceAt) {
      return "movingReturn";
    }
    return "returned";
  }

  if (!assignment?.moveStartedAt) {
    return "readyOutbound";
  }
  if (!assignment?.outboundArrivedAt) {
    return "movingOutbound";
  }
  if (!assignment?.returnMoveStartedAt) {
    return "readyReturn";
  }
  if (!assignment?.returnedToSourceAt) {
    return "movingReturn";
  }
  return "returned";
}

function getPrimaryTransportAssignment(executionAssignments = []) {
  const visibleAssignments = (executionAssignments || []).filter(
    (assignment) => assignment?.status === "active" || assignment?.status === "foreman",
  );
  if (!visibleAssignments.length) {
    return null;
  }

  const returnAssignmentsBySourceId = new Map(
    (executionAssignments || [])
      .filter((assignment) => assignment?.taskType === "return" && (assignment?.linkedAssignmentId || assignment?.returnForAssignmentId))
      .map((assignment) => [String(assignment.linkedAssignmentId || assignment.returnForAssignmentId), assignment]),
  );

  const candidates = visibleAssignments
    .map((assignment) => {
      const moveState = getExecutionMoveState(assignment);
      if (assignment?.taskType === "return") {
        const statePriority = moveState === "movingReturn"
          ? 5
          : moveState === "readyOutbound"
            ? 4
            : moveState === "returned"
              ? 2
              : 0;
        return {
          assignment,
          moveState,
          statePriority,
          statusPriority: assignment?.status === "active" ? 1 : 0,
          returnPriority: 1,
        };
      }

      const linkedReturnAssignment = returnAssignmentsBySourceId.get(String(assignment.id)) || null;
      let transportState = moveState;
      if (linkedReturnAssignment) {
        const linkedReturnState = getExecutionMoveState(linkedReturnAssignment);
        if (linkedReturnAssignment?.returnedToSourceAt || linkedReturnAssignment?.status === "completed") {
          transportState = "returned";
        } else if (linkedReturnState === "readyOutbound" || linkedReturnState === "movingReturn") {
          return null;
        }
      }

      const statePriority = transportState === "movingOutbound"
        ? 5
        : transportState === "readyOutbound"
          ? 3
          : transportState === "readyReturn"
            ? 2
            : transportState === "returned"
              ? 1
              : 0;
      return {
        assignment,
        moveState: transportState,
        statePriority,
        statusPriority: assignment?.status === "active" ? 1 : 0,
        returnPriority: 0,
      };
    })
    .filter((item) => item && item.statePriority > 0)
    .sort((left, right) =>
      right.statePriority - left.statePriority ||
      right.returnPriority - left.returnPriority ||
      right.statusPriority - left.statusPriority ||
      ((left.assignment?.sequence || 0) - (right.assignment?.sequence || 0))
    );

  return candidates[0] || null;
}

function getLiveTripDirection(executionAssignments = []) {
  const activeTransport = getPrimaryTransportAssignment(executionAssignments);
  if (!activeTransport) {
    return "outbound";
  }

  return activeTransport.moveState === "movingReturn" ||
    activeTransport.moveState === "returned" ||
    activeTransport.assignment?.returnMoveStartedAt
    ? "return"
    : "outbound";
}

function getUltrasonicDemoSummary(executionProgress = {}, executionAssignments = []) {
  const startCm = Math.max(0, Number(executionProgress?.ultrasonicStartCm) || 45);
  const arrivalCm = Math.max(0, Number(executionProgress?.ultrasonicArrivalCm) || 8);
  const latestCm = executionProgress?.ultrasonicLatestCm == null
    ? null
    : Math.max(0, Number(executionProgress.ultrasonicLatestCm) || 0);
  const progressStartCm = startCm;
  const progressEndCm = Math.min(arrivalCm, progressStartCm);
  const totalWindow = Math.max(progressStartCm - progressEndCm, 0.001);
  const tripDirection = getLiveTripDirection(executionAssignments);
  const hasReading = latestCm != null;
  const outboundProgressPercent = hasReading
    ? Math.max(0, Math.min(100, Math.round(((progressStartCm - latestCm) / totalWindow) * 100)))
    : 0;
  const progressPercent = tripDirection === "return"
    ? Math.max(0, Math.min(100, 100 - outboundProgressPercent))
    : outboundProgressPercent;
  const roadProgressRatio = Math.max(0, Math.min(1, progressPercent / 100));
  const arrived = hasReading && progressPercent >= 100;

  return {
    startCm,
    arrivalCm,
    latestCm,
    progressStartCm,
    progressEndCm,
    tripDirection,
    hasReading,
    progressPercent,
    roadProgressRatio,
    arrived,
  };
}

function getActiveSensorTripWindow(playback, executionAssignments = []) {
  if (!playback?.trips?.length || !executionAssignments.length) {
    return null;
  }

  const activeTransport = getPrimaryTransportAssignment(executionAssignments);
  const candidateAssignment = activeTransport?.assignment || null;
  const moveState = activeTransport?.moveState || null;

  if (!candidateAssignment || !moveState) {
    return null;
  }

  const isReturnTrip = candidateAssignment?.taskType === "return" || moveState === "movingReturn" || moveState === "returned";
  const sourceAssignment = isReturnTrip && candidateAssignment?.linkedAssignmentId
    ? executionAssignments.find((assignment) => String(assignment?.id) === String(candidateAssignment.linkedAssignmentId))
    : candidateAssignment;
  const sourceLoadId = sourceAssignment?.loadId;
  const trip = (playback.trips || []).find((item) => String(item?.loadId) === String(sourceLoadId));

  if (!trip) {
    return null;
  }

  if (moveState === "readyOutbound") {
    if (candidateAssignment?.taskType === "return") {
      const destinationMinute = trip.arrivalAtDestination ?? trip.moveStart ?? 0;
      return {
        direction: "return",
        startMinute: destinationMinute,
        endMinute: destinationMinute,
      };
    }

    const sourceMinute = trip.moveStart ?? trip.pickupLoadFinish ?? trip.rigDownFinish ?? 0;
    return {
      direction: "outbound",
      startMinute: sourceMinute,
      endMinute: sourceMinute,
    };
  }

  if (moveState === "readyReturn") {
    const destinationMinute = trip.arrivalAtDestination ?? trip.moveStart ?? 0;
    return {
      direction: "outbound",
      startMinute: destinationMinute,
      endMinute: destinationMinute,
    };
  }

  if (moveState === "returned") {
    const sourceMinute = trip.returnToSource ?? trip.returnStart ?? trip.arrivalAtDestination ?? 0;
    return {
      direction: "return",
      startMinute: sourceMinute,
      endMinute: sourceMinute,
    };
  }

  if (isReturnTrip || moveState === "movingReturn") {
    const startMinute = trip.returnStart ?? trip.rigUpFinish ?? trip.arrivalAtDestination ?? null;
    const endMinute = trip.returnToSource ?? null;
    if (startMinute == null || endMinute == null) {
      return null;
    }
    return {
      direction: "return",
      startMinute,
      endMinute,
    };
  }

  const startMinute = trip.moveStart ?? trip.pickupLoadFinish ?? trip.rigDownFinish ?? null;
  const endMinute = trip.arrivalAtDestination ?? null;
  if (startMinute == null || endMinute == null) {
    return null;
  }

  return {
    direction: "outbound",
    startMinute,
    endMinute,
  };
}

function shouldUseDemoSensorTracking(executionAssignments = []) {
  const activeTransport = getPrimaryTransportAssignment(executionAssignments);
  if (!activeTransport) {
    return false;
  }

  return (
    activeTransport.moveState === "movingOutbound" ||
    activeTransport.moveState === "readyReturn" ||
    activeTransport.moveState === "movingReturn"
  );
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
      })),
      ...(includeCustomize ? [{ key: "customize", label: "Customize" }] : []),
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
    routeOrder: scenario?.name || scenario?.bestVariant?.name || "Selected plan",
    waves: 0,
  };
}

function formatCurrency(value) {
  return new Intl.NumberFormat("en-SA", {
    style: "currency",
    currency: "SAR",
    maximumFractionDigits: 0,
  }).format(Math.max(0, value));
}

function formatWholeNumber(value) {
  return new Intl.NumberFormat("en-US", {
    maximumFractionDigits: 0,
  }).format(Math.max(0, Number(value) || 0));
}

function formatPercentLabel(value, digits = 1) {
  const safeValue = Math.max(0, Number(value) || 0);
  return `${Number(safeValue.toFixed(digits))}%`;
}

function getDefaultTruckHourlyCost(type) {
  const normalized = normalizeTruckTypeKey(type);
  if (normalized === "flatbed") {
    return 150;
  }
  if (normalized === "lowbed" || normalized === "support") {
    return 220;
  }
  if (normalized === "heavyhauler") {
    return 320;
  }
  return 0;
}

function getScenarioTruckRateMap(scenario) {
  return new Map(
    (scenario?.allocatedTruckSetup || scenario?.truckSetup || []).map((truck) => [
      normalizeTruckTypeKey(truck?.type),
      Math.max(0, Number(truck?.hourlyCost) || 0) || getDefaultTruckHourlyCost(truck?.type),
    ]),
  );
}

function getDerivedLaborCost(playback) {
  return Math.round(
    (playback?.tasks || []).reduce((sum, task) => {
      if (task?.phaseCode === "RM") {
        return sum;
      }

      return sum + Object.entries(task?.roleCounts || {}).reduce((roleSum, [roleId, count]) => {
        const rate = WORKER_ROLE_RATES[roleId] || 0;
        return roleSum + ((Math.max(0, Number.parseInt(count, 10) || 0) * rate * Math.max(0, Number(task?.durationMinutes) || 0)) / 60);
      }, 0);
    }, 0),
  );
}

function getDerivedTransportCost(scenario, playback) {
  const rateMap = getScenarioTruckRateMap(scenario);
  const journeys = playback?.journeys?.length ? playback.journeys : (playback?.trips || []);

  return Math.round(
    journeys.reduce((sum, journey) => {
      const truckTypeKey = normalizeTruckTypeKey(journey?.truckType);
      const hourlyRate = rateMap.get(truckTypeKey) || getDefaultTruckHourlyCost(journey?.truckType);
      const activeMinutes = Math.max(
        0,
        Number(journey?.routeMinutes) ||
          ((journey?.arrivalAtDestination || 0) - (journey?.moveStart || journey?.dispatchStart || 0)),
      );
      return sum + ((activeMinutes / 60) * hourlyRate);
    }, 0),
  );
}

function getScenarioCostSummary(scenario, playback) {
  const totalMinutes = Math.max(0, Number(scenario?.totalMinutes) || Number(playback?.totalMinutes) || 0);
  const derivedTransportCost = getDerivedTransportCost(scenario, playback);
  const derivedLaborCost = getDerivedLaborCost(playback);
  const derivedOverheadCost = Math.round(Math.ceil(totalMinutes / (24 * 60)) * PROJECT_OVERHEAD_SAR_PER_DAY);
  const transportCost = Math.max(0, Number(scenario?.transportCost));
  const laborCost = Math.max(0, Number(scenario?.laborCost));
  const overheadCost = Math.max(0, Number(scenario?.overheadCost));
  const normalizedTransportCost = transportCost > 0 ? transportCost : derivedTransportCost;
  const normalizedLaborCost = laborCost > 0 ? laborCost : derivedLaborCost;
  const normalizedOverheadCost = overheadCost > 0 ? overheadCost : derivedOverheadCost;
  const computedTotalCost = normalizedTransportCost + normalizedLaborCost + normalizedOverheadCost;
  const totalProjectCost = Math.max(0, Number(scenario?.costEstimate) || computedTotalCost);

  return {
    totalProjectCost,
    transportCost: normalizedTransportCost,
    laborCost: normalizedLaborCost,
    overheadCost: normalizedOverheadCost,
  };
}

function getScenarioUtilizationScore(scenario) {
  return Math.max(
    0,
    Number(scenario?.utilizationEfficiency) ||
      Number(scenario?.utilization) ||
      Number(scenario?.truckUtilization) ||
      0,
  );
}

function buildTruckTripUtilizationRows(playback, totalMinutes) {
  const truckMap = new Map();

  (playback?.trips || []).forEach((trip) => {
    const truckId = trip?.truckId;
    if (truckId == null) {
      return;
    }

    const key = String(truckId);
    const existing = truckMap.get(key) || {
      key,
      truckId: key,
      truckType: trip?.truckType || "Truck",
      loadCount: 0,
      activeMinutes: 0,
    };

    existing.loadCount += 1;
    existing.activeMinutes += Math.max(
      0,
      (trip?.arrivalAtDestination || 0) - (trip?.moveStart || trip?.dispatchStart || 0),
    );
    truckMap.set(key, existing);
  });

  return [...truckMap.values()]
    .map((truck) => ({
      ...truck,
      utilizationPercent: Math.min(100, Math.round((truck.activeMinutes / Math.max(totalMinutes, 1)) * 100)),
    }))
    .sort((left, right) => right.loadCount - left.loadCount || right.utilizationPercent - left.utilizationPercent || left.truckId.localeCompare(right.truckId));
}

function getAverageTruckMoveHours(playback) {
  const trips = playback?.trips || [];
  if (!trips.length) {
    return 0;
  }

  const totalMoveMinutes = trips.reduce(
    (sum, trip) => sum + Math.max(0, (trip?.arrivalAtDestination || 0) - (trip?.moveStart || trip?.dispatchStart || 0)),
    0,
  );
  return totalMoveMinutes / trips.length / 60;
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
      predecessorIds: [...(task.criticalPredecessorIds || task.predecessorIds || [])],
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
  const usedTruckCount = Math.max(
    1,
    new Set(trips.map((trip) => trip.truckId).filter(Boolean)).size ||
      (scenario?.usedTruckSetup || []).reduce((sum, truck) => sum + Math.max(0, Number.parseInt(truck?.count, 10) || 0), 0) ||
      Number.parseInt(scenario?.truckCount, 10) ||
      1,
  );
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

function getPlanRadarComparisonModel(scenarios, selectedScenario, move) {
  const completedPlans = (scenarios || [])
    .filter((scenario) => (scenario?.totalMinutes || 0) > 0)
    .map((scenario) => {
      const truckCount = Math.max(
        1,
        Number(scenario?.allocatedTruckCount) ||
          Number(scenario?.truckCount) ||
          (scenario?.allocatedTruckSetup || scenario?.truckSetup || []).reduce(
            (sum, truck) => sum + Math.max(0, Number.parseInt(truck?.count, 10) || 0),
            0,
          ) ||
          1,
      );
      const totalLoads = scenario?.bestVariant?.playback?.trips?.length || 0;
      const baselineCost = Math.max(0, Number(scenario?.manualBaseline?.costEstimate) || 0);
      const savingsPercent =
        baselineCost > 0
          ? Math.max(0, Math.round((((baselineCost - Math.max(0, Number(scenario?.costEstimate) || 0)) / baselineCost) * 100)))
          : Math.max(0, Number(scenario?.savingsVsBaselinePercent) || 0);

      return {
        key: scenario.name,
        name: scenario.name,
        totalMinutes: Math.max(0, Number(scenario?.totalMinutes) || 0),
        totalCost: Math.max(0, Number(scenario?.costEstimate) || 0),
        utilization: getScenarioUtilizationScore(scenario),
        savings: savingsPercent,
        idleMinutes: Math.max(0, Number(scenario?.idleMinutes) || 0),
        fleetUse: totalLoads > 0 ? Math.round((totalLoads / truckCount) * 10) / 10 : 0,
        isSelected: scenario?.name === selectedScenario?.name,
      };
    });

  const metrics = [
    { key: "totalMinutes", label: "Time", invert: true },
    { key: "totalCost", label: "Cost", invert: true },
    { key: "utilization", label: "Utilization", invert: false },
    { key: "savings", label: "Savings", invert: false },
    { key: "idleMinutes", label: "Idle", invert: true },
  ];
  const bounds = metrics.reduce((result, metric) => {
    const values = completedPlans.map((plan) => plan[metric.key]);
    const min = values.length ? Math.min(...values) : 0;
    const max = values.length ? Math.max(...values) : 0;
    result[metric.key] = { min, max };
    return result;
  }, {});

  return {
    metrics,
    plans: completedPlans.map((plan, index) => ({
      ...plan,
      color: plan.isSelected ? "#f5b63a" : ["#58c4dd", "#7ddc84", "#9ab0c0", "#ef8b5d"][index % 4],
      displayScores: metrics.map((metric) => {
        const { min, max } = bounds[metric.key];
        if (max === min) {
          return 90;
        }
        const normalized = (plan[metric.key] - min) / Math.max(max - min, 1);
        const score = metric.invert ? 1 - normalized : normalized;
        return Math.round(55 + (score * 42));
      }),
      values: metrics.map((metric) => {
        const { min, max } = bounds[metric.key];
        if (max === min) {
          return 0.82;
        }
        const normalized = (plan[metric.key] - min) / Math.max(max - min, 1);
        const score = metric.invert ? 1 - normalized : normalized;
        return 0.28 + (score * 0.64);
      }),
    })),
  };
}

function getRadarPoint(cx, cy, radius, index, total, value = 1) {
  const angle = (-Math.PI / 2) + ((Math.PI * 2 * index) / Math.max(total, 1));
  return {
    x: cx + Math.cos(angle) * radius * value,
    y: cy + Math.sin(angle) * radius * value,
  };
}

function PlanComparisonRadar({ model }) {
  const metrics = model?.metrics || [];
  const plans = model?.plans || [];
  const orderedPlans = [...plans].sort((left, right) => Number(left.isSelected) - Number(right.isSelected));
  const size = 300;
  const center = size / 2;
  const radius = 88;
  const rings = [0.2, 0.4, 0.6, 0.8, 1];

  if (!metrics.length || !plans.length) {
    return h("p", { className: "scene-radar-empty" }, "Plan comparison will appear after simulation results are available.");
  }

  return h(
    "div",
    { className: "scene-radar-card" },
    h(
      "div",
      { className: "scene-radar-frame" },
      metrics.map((metric, index) => {
        const point = getRadarPoint(center, center, radius + 42, index, metrics.length);
        return h(
          "div",
          {
            key: `stat-${metric.key}`,
            className: "scene-radar-stat",
            style: {
              left: `${(point.x / size) * 100}%`,
              top: `${(point.y / size) * 100}%`,
            },
          },
          h("span", { className: "scene-radar-stat-label" }, metric.label),
        );
      }),
      h(
        "svg",
        {
          className: "scene-radar-svg",
          viewBox: `0 0 ${size} ${size}`,
          role: "img",
          "aria-label": "Plan comparison radar chart",
        },
        rings.map((ring) =>
          h("polygon", {
            key: `ring-${ring}`,
            className: "scene-radar-ring",
            points: metrics.map((metric, index) => {
              const point = getRadarPoint(center, center, radius, index, metrics.length, ring);
              return `${point.x},${point.y}`;
            }).join(" "),
          }),
        ),
        metrics.map((metric, index) => {
          const point = getRadarPoint(center, center, radius, index, metrics.length);
          return h("line", {
            key: `axis-${metric.key}`,
            className: "scene-radar-axis",
            x1: center,
            y1: center,
            x2: point.x,
            y2: point.y,
          });
        }),
        orderedPlans.map((plan) =>
          h("polygon", {
            key: plan.key,
            className: "scene-radar-shape",
            points: plan.values.map((value, index) => {
              const point = getRadarPoint(center, center, radius, index, metrics.length, value);
              return `${point.x},${point.y}`;
            }).join(" "),
            style: {
              fill: plan.isSelected ? "rgba(245, 182, 58, 0.20)" : "rgba(154, 163, 176, 0.08)",
              stroke: plan.color,
              opacity: plan.isSelected ? 1 : 0.42,
            },
          }),
        ),
      ),
    ),
  );
}

function getTruckFocusStats({ truckId, playback, currentMinute, totalMinutes, move }) {
  if (truckId == null || !playback?.trips?.length) {
    return null;
  }

  const truckTrips = playback.trips.filter((trip) => trip.truckId === truckId);
  if (!truckTrips.length) {
    return null;
  }

  const getTripEndMinute = (trip) => {
    if (trip?.returnToSource != null) {
      return trip.returnToSource;
    }
    if (trip?.returnStart != null) {
      return trip.returnStart;
    }
    return trip?.rigUpFinish ?? trip?.unloadDropFinish ?? trip?.arrivalAtDestination;
  };

  const activeTrip = truckTrips.find(
    (trip) => currentMinute >= (trip.dispatchStart ?? trip.pickupLoadStart ?? trip.loadStart) && currentMinute < getTripEndMinute(trip),
  ) || null;
  const completedLoads = truckTrips.filter((trip) => currentMinute >= trip.rigUpFinish).length;
  const busyMinutes = truckTrips.reduce(
    (sum, trip) => sum + Math.max(0, getTripEndMinute(trip) - (trip.dispatchStart ?? trip.pickupLoadStart ?? trip.loadStart)),
    0,
  );
  const utilization = Math.min(100, Math.round((busyMinutes / Math.max(totalMinutes, 1)) * 100));
  const nextTrip = truckTrips.find((trip) => currentMinute < (trip.dispatchStart ?? trip.pickupLoadStart ?? trip.loadStart)) || null;
  const lastTrip = [...truckTrips].reverse().find((trip) => currentMinute >= getTripEndMinute(trip)) || null;
  const routeKm = Number(move?.routeKm) || 0;
  const remainingAssignedLoads = truckTrips.filter((trip) => currentMinute < getTripEndMinute(trip)).length;

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
    } else if (activeTrip.returnStart != null && currentMinute >= activeTrip.returnStart) {
      statusLabel = "Returning";
      statusDetail = "Returning to the source rig.";
    } else {
      statusLabel = "At Destination";
      statusDetail = "Parked at destination and waiting for the return trip to start.";
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

  const usedTruckIds = [...new Set(journeys.map((trip) => trip.truckId).filter(Boolean))].sort((left, right) => String(left).localeCompare(String(right)));

  return usedTruckIds.map((truckId) => {
    let rowToneClass = "scene-timeline-segment-truck-heavyhaul";
    const truckTrips = journeys.filter((trip) => trip.truckId === truckId);
    const truckTypeLabel = truckTrips[0]?.truckType || "Truck";
    const rawTruckItems = truckTrips
      .flatMap((trip, tripIndex) => {
        const items = [];
        const toneClass = getTruckToneClass(trip.truckType);

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

        if ((trip.returnToSource ?? 0) > (trip.returnStart ?? trip.arrivalAtDestination ?? 0)) {
          items.push({
            key: `${truckId}-${trip.loadId}-${tripIndex}-return`,
            loadId: trip.loadIds?.[0] ?? trip.loadId,
            description: `${trip.description} return`,
            startMinute: trip.returnStart ?? trip.arrivalAtDestination,
            endMinute: trip.returnToSource,
            left: (((trip.returnStart ?? trip.arrivalAtDestination ?? 0) / totalMinutes) * 100),
            width: (((trip.returnToSource - (trip.returnStart ?? trip.arrivalAtDestination ?? 0)) / totalMinutes) * 100),
            toneClass: `${toneClass} scene-timeline-segment-return`,
            label: `Return ${trip.description || getLoadDisplayLabel(trip)}`,
          });
        }

        return items;
      })
      .sort((left, right) => left.startMinute - right.startMinute);

    const laneEndMinutes = [];
    let overlapConflictCount = 0;
    const truckItems = rawTruckItems.map((item) => {
      const nextLane = laneEndMinutes.findIndex((endMinute) => endMinute <= (item.startMinute ?? 0));
      const stackLane = nextLane >= 0 ? nextLane : laneEndMinutes.length;
      if (stackLane > 0) {
        overlapConflictCount += 1;
      }
      laneEndMinutes[stackLane] = item.endMinute ?? item.startMinute ?? 0;
      return {
        ...item,
        stackLane,
        overlapConflict: stackLane > 0,
      };
    });

    if (truckItems[0]?.toneClass) {
      rowToneClass = truckItems[0].toneClass;
    }

    return {
      key: `truck-${truckId}`,
      truckId,
      label: String(truckId),
      subLabel: `${truckTypeLabel} | ${truckItems.length} move${truckItems.length === 1 ? "" : "s"}`,
      subLabel: `${truckTypeLabel} · ${truckItems.length} move segment${truckItems.length === 1 ? "" : "s"}`,
      subLabel: `${truckTypeLabel} | ${truckItems.length} move${truckItems.length === 1 ? "" : "s"}`,
      toneClass: rowToneClass,
      subLabel: overlapConflictCount
        ? `${truckTypeLabel} | planner conflict: ${overlapConflictCount + 1} overlapping move segments`
        : `${truckTypeLabel} | ${truckItems.length} move${truckItems.length === 1 ? "" : "s"}`,
      items: truckItems,
      laneCount: Math.max(laneEndMinutes.length, 1),
      hasOverlapConflict: overlapConflictCount > 0,
      loadCount: truckTrips.length,
    };
  }).sort((left, right) => {
    const leftStart = left.items[0]?.startMinute ?? Number.MAX_SAFE_INTEGER;
    const rightStart = right.items[0]?.startMinute ?? Number.MAX_SAFE_INTEGER;
    return leftStart - rightStart || String(left.truckId).localeCompare(String(right.truckId));
  });
}

function buildLoadScheduleRows(playback) {
  const trips = playback?.trips || [];
  const totalMinutes = Math.max(playback?.totalMinutes || 1, 1);

  return trips
    .map((trip, index) => {
      const items = [];
      const sourceKind = trip.sourceKind || "rig";
      const loadLabel = getLoadDisplayLabel(trip) || `Load ${index + 1}`;

      if ((trip.rigDownFinish ?? 0) > (trip.rigDownStart ?? trip.loadStart ?? 0)) {
        items.push({
          key: `load-${trip.loadId}-${index}-down`,
          loadId: trip.loadId,
          description: `${loadLabel} rig down`,
          startMinute: trip.rigDownStart ?? trip.loadStart,
          endMinute: trip.rigDownFinish,
          left: (((trip.rigDownStart ?? trip.loadStart ?? 0) / totalMinutes) * 100),
          width: (((trip.rigDownFinish || 0) - (trip.rigDownStart ?? trip.loadStart ?? 0)) / totalMinutes) * 100,
          toneClass: "scene-timeline-segment-down",
          label: "RD",
        });
      }

      if ((trip.arrivalAtDestination ?? 0) > (trip.moveStart ?? trip.pickupLoadFinish ?? trip.rigDownFinish ?? 0)) {
        items.push({
          key: `load-${trip.loadId}-${index}-move`,
          loadId: trip.loadId,
          description: `${loadLabel} move`,
          startMinute: trip.moveStart ?? trip.pickupLoadFinish ?? trip.rigDownFinish,
          endMinute: trip.arrivalAtDestination,
          left: (((trip.moveStart ?? trip.pickupLoadFinish ?? trip.rigDownFinish ?? 0) / totalMinutes) * 100),
          width: (((trip.arrivalAtDestination || 0) - (trip.moveStart ?? trip.pickupLoadFinish ?? trip.rigDownFinish ?? 0)) / totalMinutes) * 100,
          toneClass: "scene-timeline-segment-move",
          label: "RM",
        });
      }

      if ((trip.rigUpFinish ?? 0) > (trip.rigUpStart ?? trip.arrivalAtDestination ?? 0)) {
        items.push({
          key: `load-${trip.loadId}-${index}-up`,
          loadId: trip.loadId,
          description: `${loadLabel} rig up`,
          startMinute: trip.rigUpStart ?? trip.arrivalAtDestination,
          endMinute: trip.rigUpFinish,
          left: (((trip.rigUpStart ?? trip.arrivalAtDestination ?? 0) / totalMinutes) * 100),
          width: (((trip.rigUpFinish || 0) - (trip.rigUpStart ?? trip.arrivalAtDestination ?? 0)) / totalMinutes) * 100,
          toneClass: "scene-timeline-segment-up",
          label: "RU",
        });
      }

      return {
        key: `load-row-${trip.loadId}-${index}`,
        loadId: trip.loadId,
        label: loadLabel,
        subLabel: "Rig",
        sourceKind,
        items,
      };
    })
    .sort((left, right) => {
      const leftStart = left.items[0]?.startMinute ?? Number.MAX_SAFE_INTEGER;
      const rightStart = right.items[0]?.startMinute ?? Number.MAX_SAFE_INTEGER;
      return leftStart - rightStart || left.loadId - right.loadId;
    });
}

function getExecutionAssignmentMinute(assignment, timestamp) {
  const executionStartedAtMs = assignment?.executionStartedAt ? new Date(assignment.executionStartedAt).getTime() : null;
  if (!timestamp || executionStartedAtMs == null) {
    return null;
  }
  return Math.max(0, Math.round((new Date(timestamp).getTime() - executionStartedAtMs) / 60000));
}

function buildDisplayExecutionAssignments(assignments = [], currentMinute = 0) {
  if (!assignments.length) {
    return assignments;
  }

  const sourceAssignments = (assignments || [])
    .filter((assignment) => assignment?.taskType !== "return")
    .sort((left, right) => (left.sequence || 0) - (right.sequence || 0));
  const returnAssignmentsBySourceId = new Map(
    (assignments || [])
      .filter((assignment) => assignment?.taskType === "return" && (assignment?.linkedAssignmentId || assignment?.returnForAssignmentId))
      .map((assignment) => [String(assignment.linkedAssignmentId || assignment.returnForAssignmentId), assignment]),
  );

  const orderedAssignments = sourceAssignments.flatMap((assignment) => {
    const linkedReturn = returnAssignmentsBySourceId.get(String(assignment.id));
    return linkedReturn ? [assignment, linkedReturn] : [assignment];
  });

  const recalculatedAssignments = [];
  let sequenceCursor = 0;

  orderedAssignments.forEach((assignment) => {
    if (!assignment?.stagePlan) {
      recalculatedAssignments.push(assignment);
      return;
    }

    const stagePlan = assignment.stagePlan || {};
    const rigDownDuration = Math.max(1, (stagePlan.rigDown?.finishMinute ?? 0) - (stagePlan.rigDown?.startMinute ?? 0) || 1);
    const rigMoveDuration = Math.max(1, (stagePlan.rigMove?.finishMinute ?? 0) - (stagePlan.rigMove?.startMinute ?? 0) || 1);
    const rigUpDuration = Math.max(1, (stagePlan.rigUp?.finishMinute ?? 0) - (stagePlan.rigUp?.startMinute ?? 0) || 1);
    const currentStage = getExecutionAssignmentStage(assignment?.stageStatus || {});
    const isVisibleAssignment = assignment?.status === "active" || assignment?.status === "foreman";

    if (assignment.taskType === "return") {
      const actualReturnStart = getExecutionAssignmentMinute(
        assignment,
        assignment?.returnMoveStartedAt || assignment?.moveStartedAt,
      );
      const actualReturnFinish = getExecutionAssignmentMinute(
        assignment,
        assignment?.returnedToSourceAt || assignment?.stageCompletedAt?.rigMove,
      );
      const moveStartMinute = actualReturnStart ?? sequenceCursor;
      const moveFinishMinute = actualReturnFinish ?? (moveStartMinute + rigMoveDuration);
      sequenceCursor = moveFinishMinute;
      recalculatedAssignments.push({
        ...assignment,
        plannedStartMinute: moveStartMinute,
        plannedFinishMinute: moveFinishMinute,
        stagePlan: {
          ...stagePlan,
          rigMove: {
            startMinute: moveStartMinute,
            finishMinute: moveFinishMinute,
          },
        },
      });
      return;
    }

    const actualRigDownFinish = getExecutionAssignmentMinute(assignment, assignment?.stageCompletedAt?.rigDown);
    const actualMoveStart = getExecutionAssignmentMinute(assignment, assignment?.moveStartedAt);
    const actualMoveFinish = getExecutionAssignmentMinute(assignment, assignment?.outboundArrivedAt || assignment?.stageCompletedAt?.rigMove);
    const actualRigUpFinish = getExecutionAssignmentMinute(assignment, assignment?.stageCompletedAt?.rigUp);

    const rigDownStartMinute = actualRigDownFinish != null
      ? Math.max(sequenceCursor, actualRigDownFinish - rigDownDuration)
      : sequenceCursor;
    const rigDownFinishMinute = actualRigDownFinish ?? (rigDownStartMinute + rigDownDuration);
    const rigMoveStartMinute = actualMoveStart ?? rigDownFinishMinute;
    const rigMoveFinishMinute = actualMoveFinish ?? (rigMoveStartMinute + rigMoveDuration);
    const rigUpStartMinute = rigMoveFinishMinute;
    const rigUpFinishMinute = actualRigUpFinish ?? (rigUpStartMinute + rigUpDuration);
    sequenceCursor = rigUpFinishMinute;

    recalculatedAssignments.push({
      ...assignment,
      plannedStartMinute: rigDownStartMinute,
      plannedFinishMinute: rigUpFinishMinute,
      stagePlan: {
        ...stagePlan,
        rigDown: {
          startMinute: rigDownStartMinute,
          finishMinute: rigDownFinishMinute,
        },
        rigMove: {
          startMinute: rigMoveStartMinute,
          finishMinute: rigMoveFinishMinute,
        },
        rigUp: {
          startMinute: rigUpStartMinute,
          finishMinute: rigUpFinishMinute,
        },
      },
    });
  });

  const recalculatedById = new Map(recalculatedAssignments.map((assignment) => [assignment.id, assignment]));
  return (assignments || []).map((assignment) => recalculatedById.get(assignment.id) || assignment);
}

function buildExecutionTimelinePlayback(playback, executionAssignments = [], currentMinute = 0) {
  if (!playback?.trips?.length || !executionAssignments.length) {
    return playback;
  }

  const truckIdMap = new Map();
  playback.trips.forEach((trip) => {
    const rawTruckId = String(trip?.truckId ?? "").trim();
    if (!rawTruckId || truckIdMap.has(rawTruckId)) {
      return;
    }
    truckIdMap.set(rawTruckId, truckIdMap.size + 1);
  });

  const assignmentByLoadId = new Map(
    executionAssignments
      .filter((assignment) => assignment?.taskType !== "return" && assignment?.loadId != null)
      .map((assignment) => [String(assignment.loadId), assignment]),
  );
  const returnAssignmentByLinkedId = new Map(
    executionAssignments
      .filter((assignment) => assignment?.taskType === "return" && assignment?.linkedAssignmentId)
      .map((assignment) => [String(assignment.linkedAssignmentId), assignment]),
  );

  const remappedTrips = playback.trips.map((trip, index) => {
    const assignment = assignmentByLoadId.get(String(trip?.loadId));
    const returnAssignment = assignment?.id ? returnAssignmentByLinkedId.get(String(assignment.id)) : null;
    const executionLoadLabel = assignment?.simpleLoadLabel || `Load ${index + 1}`;
    if (!assignment?.stagePlan) {
      return {
        ...trip,
        executionLoadLabel,
        description: executionLoadLabel,
      };
    }

    const rigDown = assignment.stagePlan.rigDown || {};
    const rigMove = assignment.stagePlan.rigMove || {};
    const rigUp = assignment.stagePlan.rigUp || {};
    const executionStartedAtMs = assignment?.executionStartedAt ? new Date(assignment.executionStartedAt).getTime() : null;
    const getActualMinute = (timestamp) =>
      timestamp && executionStartedAtMs != null
        ? Math.max(0, Math.round((new Date(timestamp).getTime() - executionStartedAtMs) / 60000))
        : null;
    const rigDownDuration = Math.max(1, (rigDown.finishMinute ?? 0) - (rigDown.startMinute ?? 0) || 1);
    const rigMoveDuration = Math.max(1, (rigMove.finishMinute ?? 0) - (rigMove.startMinute ?? 0) || 1);
    const rigUpDuration = Math.max(1, (rigUp.finishMinute ?? 0) - (rigUp.startMinute ?? 0) || 1);
    const actualRigDownFinish = getActualMinute(assignment?.stageCompletedAt?.rigDown);
    const actualMoveStart = getActualMinute(assignment?.moveStartedAt);
    const actualOutboundArrival = getActualMinute(assignment?.outboundArrivedAt || assignment?.stageCompletedAt?.rigMove);
    const actualReturnStart = getActualMinute(returnAssignment?.moveStartedAt || returnAssignment?.returnMoveStartedAt || assignment?.returnMoveStartedAt);
    const actualReturnFinish = getActualMinute(
      returnAssignment?.returnedToSourceAt ||
      returnAssignment?.stageCompletedAt?.rigMove ||
      assignment?.returnedToSourceAt,
    );
    const actualRigUpFinish = getActualMinute(assignment?.stageCompletedAt?.rigUp);
    const returnRigMove = returnAssignment?.stagePlan?.rigMove || {};
    const plannedReturnStart = returnRigMove.startMinute ?? trip.returnStart ?? trip.arrivalAtDestination ?? 0;
    const plannedReturnFinish = returnRigMove.finishMinute ?? trip.returnToSource ?? plannedReturnStart;
    const returnDuration = Math.max(1, plannedReturnFinish - plannedReturnStart || 1);
    const rigDownStartMinute = rigDown.startMinute ?? trip.rigDownStart ?? trip.loadStart ?? 0;
    const rigDownFinishMinute = actualRigDownFinish ?? rigDown.finishMinute ?? (rigDownStartMinute + rigDownDuration);
    const moveStartMinute = actualMoveStart == null
      ? Math.max(currentMinute + 1, rigMove.startMinute ?? rigDownFinishMinute)
      : actualMoveStart;
    const moveFinishMinute = actualOutboundArrival != null
      ? actualOutboundArrival
      : actualMoveStart != null
        ? Math.max(moveStartMinute + rigMoveDuration, currentMinute + 1)
        : moveStartMinute + rigMoveDuration;
    const returnStartMinute = actualReturnStart != null
      ? actualReturnStart
      : actualReturnFinish != null
        ? Math.max(moveFinishMinute, actualReturnFinish - returnDuration)
        : null;
    const returnFinishMinute = actualReturnFinish != null
      ? actualReturnFinish
      : actualReturnStart != null
        ? Math.max(returnStartMinute + returnDuration, currentMinute + 1)
        : null;
    const rigUpStartMinute = moveFinishMinute;
    const rigUpFinishMinute = actualRigUpFinish != null
      ? actualRigUpFinish
      : assignment?.stageStatus?.rigMoveCompleted
        ? Math.max(rigUpStartMinute + rigUpDuration, currentMinute + 1)
        : rigUp.startMinute ?? rigUp.finishMinute ?? (rigUpStartMinute + rigUpDuration);

    return {
      ...trip,
      truckId: truckIdMap.get(String(trip?.truckId ?? "").trim()) || 1,
      originalTruckId: trip?.truckId ?? null,
      executionLoadLabel,
      description: executionLoadLabel,
      loadStart: rigDownStartMinute,
      dispatchStart: moveStartMinute,
      rigDownStart: rigDownStartMinute,
      rigDownFinish: rigDownFinishMinute,
      pickupLoadFinish: rigDownFinishMinute,
      moveStart: moveStartMinute,
      arrivalAtDestination: moveFinishMinute,
      unloadDropStart: moveFinishMinute,
      unloadDropFinish: moveFinishMinute,
      rigUpStart: rigUpStartMinute,
      rigUpFinish: rigUpFinishMinute,
      moveFinish: moveFinishMinute,
      returnStart: returnStartMinute,
      returnToSource: returnFinishMinute,
    };
  });

  const totalMinutes = remappedTrips.reduce(
    (maxValue, trip) => Math.max(
      maxValue,
      trip?.returnToSource ??
      trip?.rigUpFinish ??
      trip?.arrivalAtDestination ??
      0,
    ),
    0,
  );

  return {
    ...playback,
    trips: remappedTrips,
    journeys: remappedTrips,
    totalMinutes: Math.max(totalMinutes, 1),
  };
}

function normalizeScenePlayback(playback) {
  if (!playback?.trips?.length) {
    return playback;
  }

  const truckIdMap = new Map();
  const normalizedTrips = playback.trips.map((trip) => {
    const rawTruckId = String(trip?.truckId ?? "").trim() || "truck-1";
    if (!truckIdMap.has(rawTruckId)) {
      truckIdMap.set(rawTruckId, truckIdMap.size + 1);
    }
    return {
      ...trip,
      truckId: truckIdMap.get(rawTruckId) || 1,
      originalTruckId: trip?.truckId ?? null,
    };
  });

  const normalizedJourneys = (playback.journeys || playback.trips || []).map((trip) => {
    const rawTruckId = String(trip?.truckId ?? "").trim() || "truck-1";
    if (!truckIdMap.has(rawTruckId)) {
      truckIdMap.set(rawTruckId, truckIdMap.size + 1);
    }
    return {
      ...trip,
      truckId: truckIdMap.get(rawTruckId) || 1,
      originalTruckId: trip?.truckId ?? null,
    };
  });

  return {
    ...playback,
    trips: normalizedTrips,
    journeys: normalizedJourneys,
    truckCount: Math.max(truckIdMap.size, 1),
  };
}

function buildPhaseScheduleRows(playback) {
  const trips = playback?.trips || [];
  const totalMinutes = Math.max(playback?.totalMinutes || 1, 1);
  const phaseBuckets = new Map([
    ["rigDown", []],
    ["move", []],
    ["rigUp", []],
  ]);

  trips.forEach((trip, index) => {
    const loadLabel = getLoadDisplayLabel(trip);
    const description = trip.description || `Load ${loadLabel}`;

    if ((trip.rigDownFinish ?? 0) > (trip.rigDownStart ?? trip.loadStart ?? 0)) {
      phaseBuckets.get("rigDown").push({
        key: `phase-rd-item-${trip.loadId}-${index}`,
        loadId: trip.loadId,
        description: `${description} rig down`,
        startMinute: trip.rigDownStart ?? trip.loadStart ?? 0,
        endMinute: trip.rigDownFinish ?? 0,
        left: (((trip.rigDownStart ?? trip.loadStart ?? 0) / totalMinutes) * 100),
        width: (((trip.rigDownFinish || 0) - (trip.rigDownStart ?? trip.loadStart ?? 0)) / totalMinutes) * 100,
        toneClass: "scene-timeline-segment-down",
        label: loadLabel,
        typeCode: "RD",
        subLabel: description,
      });
    }

    if ((trip.arrivalAtDestination ?? 0) > (trip.moveStart ?? trip.pickupLoadFinish ?? trip.rigDownFinish ?? 0)) {
      phaseBuckets.get("move").push({
        key: `phase-rm-item-${trip.loadId}-${index}`,
        loadId: trip.loadId,
        description: `${description} move`,
        startMinute: trip.moveStart ?? trip.pickupLoadFinish ?? trip.rigDownFinish ?? 0,
        endMinute: trip.arrivalAtDestination ?? 0,
        left: (((trip.moveStart ?? trip.pickupLoadFinish ?? trip.rigDownFinish ?? 0) / totalMinutes) * 100),
        width: (((trip.arrivalAtDestination || 0) - (trip.moveStart ?? trip.pickupLoadFinish ?? trip.rigDownFinish ?? 0)) / totalMinutes) * 100,
        toneClass: "scene-timeline-segment-move",
        label: loadLabel,
        typeCode: "RM",
        truckId: trip.truckId,
        truckType: trip.truckType,
        subLabel: trip.truckType || "Truck",
      });
    }

    if ((trip.rigUpFinish ?? 0) > (trip.rigUpStart ?? trip.arrivalAtDestination ?? 0)) {
      phaseBuckets.get("rigUp").push({
        key: `phase-ru-item-${trip.loadId}-${index}`,
        loadId: trip.loadId,
        description: `${description} rig up`,
        startMinute: trip.rigUpStart ?? trip.arrivalAtDestination ?? 0,
        endMinute: trip.rigUpFinish ?? 0,
        left: (((trip.rigUpStart ?? trip.arrivalAtDestination ?? 0) / totalMinutes) * 100),
        width: (((trip.rigUpFinish || 0) - (trip.rigUpStart ?? trip.arrivalAtDestination ?? 0)) / totalMinutes) * 100,
        toneClass: "scene-timeline-segment-up",
        label: loadLabel,
        typeCode: "RU",
        subLabel: description,
      });
    }
  });

  const phaseLabels = {
    rigDown: "Rig Down",
    move: "Move",
    rigUp: "Rig Up",
  };
  return ["rigDown", "move", "rigUp"].map((phaseKey) => {
    const items = [...(phaseBuckets.get(phaseKey) || [])].sort((left, right) => {
      const leftStart = left.startMinute ?? Number.MAX_SAFE_INTEGER;
      const rightStart = right.startMinute ?? Number.MAX_SAFE_INTEGER;
      return leftStart - rightStart || String(left.label).localeCompare(String(right.label));
    });
    let stackedItems = [];
    let laneCount = 1;

    if (phaseKey === "move") {
      const truckLaneMap = new Map();
      items.forEach((item) => {
        const truckKey = `${item.truckType || "Truck"}::${item.truckId ?? "0"}`;
        if (!truckLaneMap.has(truckKey)) {
          truckLaneMap.set(truckKey, truckLaneMap.size);
        }
      });
      stackedItems = items.map((item) => {
        const truckKey = `${item.truckType || "Truck"}::${item.truckId ?? "0"}`;
        return {
          ...item,
          stackLane: truckLaneMap.get(truckKey) || 0,
        };
      });
      laneCount = Math.max(truckLaneMap.size, 1);
    } else {
      const laneEndMinutes = [0, 0, 0];
      stackedItems = items.map((item) => {
        const startMinute = item.startMinute ?? 0;
        let nextLane = laneEndMinutes.findIndex((endMinute) => endMinute <= startMinute);
        if (nextLane < 0) {
          nextLane = 0;
          for (let index = 1; index < laneEndMinutes.length; index += 1) {
            if (laneEndMinutes[index] <= laneEndMinutes[nextLane]) {
              nextLane = index;
            }
          }
        }
        laneEndMinutes[nextLane] = item.endMinute ?? startMinute;
        return {
          ...item,
          stackLane: nextLane,
        };
      });
      laneCount = 3;
    }

    return {
      key: `phase-row-${phaseKey}`,
      phaseKey,
      label: phaseLabels[phaseKey],
      subLabel: "",
      items: stackedItems,
      laneCount,
    };
  });
}

function getTimelineBarLabel(rowType, row, trip) {
  if (rowType === "load") {
    return `${row.label} ${trip.label || ""}`.trim();
  }
  if (rowType === "truck") {
    return getLoadDisplayLabel(trip);
  }
  if (rowType === "phase") {
    return `${trip.label || ""}${trip.subLabel ? ` | ${trip.subLabel}` : ""}`.trim();
  }
  return trip.label || trip.description || row.label || "";
}

function getExecutionAssignmentStage(stageStatus = {}) {
  if (!stageStatus.rigDownCompleted) {
    return "rigDown";
  }
  if (!stageStatus.rigMoveCompleted) {
    return "rigMove";
  }
  if (!stageStatus.rigUpCompleted) {
    return "rigUp";
  }
  return "completed";
}

function isDemoExecutionAssignment(assignment) {
  return Boolean(
    assignment?.isDemoMove ||
    (Number.isFinite(Number(assignment?.delayThresholdMinutes)) && Number(assignment.delayThresholdMinutes) < 1) ||
    String(assignment?.loadCode || "").toUpperCase().startsWith("DM-"),
  );
}

function getExecutionDelayThresholdMinutes(assignment) {
  if (isDemoExecutionAssignment(assignment)) {
    return 20 / 60;
  }
  if (Number.isFinite(Number(assignment?.delayThresholdMinutes))) {
    return Math.max(0, Number(assignment.delayThresholdMinutes));
  }
  return 20;
}

function formatExecutionDelayAmount(minutes, assignment) {
  const safeMinutes = Math.max(0, Number(minutes) || 0);
  if (safeMinutes < 1 || isDemoExecutionAssignment(assignment)) {
    return `${Math.round(safeMinutes * 60)} sec`;
  }
  return `${Math.round(safeMinutes)} min`;
}

function formatExecutionTimeAmount(minutes, assignment) {
  const safeMinutes = Math.max(0, Number(minutes) || 0);
  if (isDemoExecutionAssignment(assignment)) {
    const totalSeconds = Math.round(safeMinutes * 60);
    const wholeMinutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    if (wholeMinutes > 0) {
      return `${wholeMinutes} min ${seconds} sec`;
    }
    return `${seconds} sec`;
  }
  return formatMinutes(Math.round(safeMinutes));
}

function getExecutionStageTitle(stage) {
  if (stage === "rigDown") {
    return "Rig Down";
  }
  if (stage === "rigMove") {
    return "Move";
  }
  if (stage === "rigUp") {
    return "Rig Up";
  }
  return "Task";
}

function buildTimelineHoverCard(rowType, row, trip, startMinute, endMinute) {
  if (rowType === "phase") {
    return {
      title: row.label,
      lines: [
        `${trip.label || ""}${trip.subLabel ? ` | ${trip.subLabel}` : ""}`.trim(),
        `${formatTimelineWindowLabel(startMinute)} -> ${formatTimelineWindowLabel(endMinute)}`,
      ].filter(Boolean),
    };
  }

  if (rowType === "load") {
    return {
      title: row.label || getLoadDisplayLabel(trip),
      lines: [
        trip.description || row.subLabel || "Load segment",
        `${trip.label || "Task"} | ${formatTimelineWindowLabel(startMinute)} -> ${formatTimelineWindowLabel(endMinute)}`,
      ],
    };
  }

  if (rowType === "truck") {
    return {
      title: `Truck ${row.truckId}`,
      lines: [
        `${trip.description || getLoadDisplayLabel(trip)} | ${row.subLabel || "Truck move"}`,
        trip.overlapConflict ? "Planner conflict: overlaps another move on the same truck" : null,
        `${formatTimelineWindowLabel(startMinute)} -> ${formatTimelineWindowLabel(endMinute)}`,
      ].filter(Boolean),
    };
  }

  return {
    title: row.label || trip.label || "Timeline item",
    lines: [
      trip.description || trip.label || "",
      `${trip.critical ? "Critical path | " : ""}${formatTimelineWindowLabel(startMinute)} -> ${formatTimelineWindowLabel(endMinute)}`,
    ].filter(Boolean),
  };
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
  rowType = "cpm",
  title = null,
  windowStartMinute = 0,
  windowMinutes = null,
  tickMinutes = null,
  cpOnly = false,
  showRD = true,
  showRM = true,
  showRU = true,
  showFloatBar = true,
  hideFixedColumn = false,
}) {
  const headerScrollRef = useRef(null);
  const bodyScrollRef = useRef(null);
  const fixedBodyRef = useRef(null);
  const syncingHeaderRef = useRef(false);
  const syncingBodyRef = useRef(false);
  const [hoverCard, setHoverCard] = useState(null);
  const totalMinutes = Math.max(playback?.totalMinutes || 1, 1);
  const visibleStartMinute = Math.max(0, Math.min(windowStartMinute, Math.max(0, totalMinutes - 1)));
  const visibleDurationMinutes = Math.max(60, Math.min(windowMinutes || totalMinutes, totalMinutes));
  const visibleEndMinute = Math.min(totalMinutes, visibleStartMinute + visibleDurationMinutes);
  const visibleRangeMinutes = Math.max(1, visibleEndMinute - visibleStartMinute);
  const shouldShowTrip = useCallback((trip) => {
    if (!trip) {
      return false;
    }
    if ((trip.typeCode === "RD" || trip.label === "RD") && !showRD) {
      return false;
    }
    if ((trip.typeCode === "RM" || trip.label === "RM") && !showRM) {
      return false;
    }
    if ((trip.typeCode === "RU" || trip.typeCode === "RU_SU" || trip.label === "RU") && !showRU) {
      return false;
    }
    return true;
  }, [showRD, showRM, showRU]);
  const rows = useMemo(() => {
    const baseRows =
      rowType === "phase"
        ? buildPhaseScheduleRows(playback)
        : rowType === "load"
        ? buildLoadScheduleRows(playback)
        : rowType === "truck"
          ? buildTruckScheduleRows(playback)
          : buildCpmScheduleRows(playback);
    const filteredRows = baseRows
      .map((row) => {
        const visibleItems = (row.items || []).filter((trip) =>
          (trip.endMinute ?? 0) > visibleStartMinute &&
          (trip.startMinute ?? 0) < visibleEndMinute &&
          shouldShowTrip(trip));
        return {
          ...row,
          items: visibleItems,
          laneCount: row.laneCount,
        };
      })
      .filter((row) => {
        if (rowType === "phase") {
          return true;
        }
        if ((rowType === "load" || rowType === "truck") && !cpOnly) {
          return true;
        }
        if (!row.items?.length) {
          return false;
        }
        if (rowType === "cpm" && cpOnly && !row.critical) {
          return false;
        }
        return true;
      });
    return filteredRows;
  }, [playback, rowType, cpOnly, shouldShowTrip, visibleStartMinute, visibleEndMinute]);
  const tickStepMinutes = Math.max(60, tickMinutes || (visibleRangeMinutes <= 12 * 60 ? 2 * 60 : 4 * 60));
  const tickCount = Math.max(1, Math.ceil(visibleRangeMinutes / tickStepMinutes));
  const ticks = useMemo(
    () => Array.from({ length: tickCount + 1 }, (_, index) => {
      const minute = Math.min(visibleEndMinute, visibleStartMinute + (index * tickStepMinutes));
      return {
        key: `timeline-tick-${index}`,
        left: `${((minute - visibleStartMinute) / visibleRangeMinutes) * 100}%`,
        label: formatTimelineWindowLabel(minute),
      };
    }),
    [tickCount, tickStepMinutes, visibleStartMinute, visibleEndMinute, visibleRangeMinutes],
  );
  const currentX = `${((Math.min(Math.max(currentMinute, visibleStartMinute), visibleEndMinute) - visibleStartMinute) / visibleRangeMinutes) * 100}%`;
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

  function handleTripHover(event, card) {
    const bodyNode = bodyScrollRef.current;
    if (!bodyNode) {
      return;
    }

    const bounds = bodyNode.getBoundingClientRect();
    const cardWidth = 280;
    const cardHeight = 84;
    const rawLeft = event.clientX - bounds.left + bodyNode.scrollLeft + 14;
    const rawTop = event.clientY - bounds.top + bodyNode.scrollTop + 16;
    const minLeft = bodyNode.scrollLeft + 8;
    const maxLeft = bodyNode.scrollLeft + bodyNode.clientWidth - cardWidth - 8;
    const minTop = bodyNode.scrollTop + 8;
    const maxTop = bodyNode.scrollTop + bodyNode.clientHeight - cardHeight - 8;

    setHoverCard({
      ...card,
      left: Math.max(minLeft, Math.min(maxLeft, rawLeft)),
      top: Math.max(minTop, Math.min(maxTop, rawTop)),
    });
  }

  useEffect(() => {
    const bodyNode = bodyScrollRef.current;
    const headerNode = headerScrollRef.current;
    if (!bodyNode || !headerNode || visibleRangeMinutes <= 0) {
      return;
    }

    const markerOffset = ((Math.min(Math.max(currentMinute, visibleStartMinute), visibleEndMinute) - visibleStartMinute) / visibleRangeMinutes) * timelineWidth;
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
  }, [currentMinute, visibleStartMinute, visibleEndMinute, visibleRangeMinutes, timelineWidth]);

  return h(
    "section",
    { className: `scene-timeline-shell${hideFixedColumn ? " scene-timeline-shell-wide" : ""}` },
    !hideFixedColumn
      ? h(
          "div",
          { className: "scene-timeline-fixed-column" },
          h(
            "div",
            { className: "scene-timeline-header-copy" },
            h("span", null, title || (rowType === "cpm" ? "CPM" : rowType === "load" ? "Load" : "Truck")),
            h("strong", null, "Chart"),
          ),
          h(
            "div",
            { ref: fixedBodyRef, className: "scene-timeline-fixed-body" },
            rows.map((row) =>
              (() => {
                const phaseLaneCount = rowType === "phase"
                  ? Math.max(
                      Number(row.laneCount) || 0,
                      ...((row.items || []).map((item) => (Number(item.stackLane) || 0) + 1)),
                      1,
                    )
                  : rowType === "truck" && Number(row.laneCount) > 1
                    ? Math.max(
                        Number(row.laneCount) || 0,
                        ...((row.items || []).map((item) => (Number(item.stackLane) || 0) + 1)),
                        1,
                      )
                  : 1;
                const rowHeightPx = rowType === "phase" || (rowType === "truck" && phaseLaneCount > 1)
                  ? Math.max(phaseLaneCount * 28 + 16, 48)
                  : null;
                return h(
                  "div",
                  {
                    key: `timeline-copy-${row.key || row.truckId}`,
                    className: "scene-timeline-row-copy",
                    style: rowHeightPx ? { height: `${rowHeightPx}px` } : undefined,
                  },
                  h("strong", null, rowType === "phase" ? row.label : rowType === "load" ? row.label : rowType === "cpm" ? row.label : row.label || `Truck ${row.truckId}`),
                  rowType === "phase"
                    ? null
                    : h(
                        "span",
                        null,
                        row.subLabel
                          ? row.subLabel
                          : rowType === "load"
                            ? `${row.items.length} task segment${row.items.length === 1 ? "" : "s"}`
                            : rowType === "cpm"
                              ? row.subLabel
                              : `${row.loadCount || row.items.length} road segment${(row.loadCount || row.items.length) === 1 ? "" : "s"}`,
                      ),
                )
              })(),
            ),
          ),
        )
      : null,
    h(
      "div",
      { className: "scene-timeline-main" },
      h(
        "div",
        { className: "scene-timeline-window-banner" },
        h("strong", null, formatTimelineWindowRange(visibleStartMinute, visibleEndMinute)),
        h("span", null, visibleDurationMinutes === (12 * 60) ? "12-hour shift window" : "24-hour day window"),
      ),
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
                h("div", { className: "scene-timeline-hover-card-title" }, hoverCard.title),
                ...(hoverCard.lines || []).map((line, index) =>
                  h("div", { key: `timeline-hover-line-${index}`, className: "scene-timeline-hover-card-line" }, line),
                ),
              )
            : null,
          rows.map((row) => {
            const rowKey = row.key || row.truckId;
            const phaseLaneCount = rowType === "phase"
              ? Math.max(
                  Number(row.laneCount) || 0,
                  ...((row.items || []).map((item) => (Number(item.stackLane) || 0) + 1)),
                  1,
                )
              : rowType === "truck" && Number(row.laneCount) > 1
                ? Math.max(
                    Number(row.laneCount) || 0,
                    ...((row.items || []).map((item) => (Number(item.stackLane) || 0) + 1)),
                    1,
                  )
              : 1;
            const rowHeightPx = rowType === "phase" || (rowType === "truck" && phaseLaneCount > 1)
              ? Math.max(phaseLaneCount * 28 + 16, 48)
              : null;
            const rowTrips = (row.items || row.trips || []).map((trip) => {
              const tripIndex = rowType === "phase" || rowType === "truck"
                ? Math.max(0, Number(trip.stackLane) || 0)
                : 0;
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
                  ? (((Math.min(tripEndMinute, visibleEndMinute) - Math.max(tripStartMinute, visibleStartMinute)) / visibleRangeMinutes) * 100)
                  : (((Math.min(tripEndMinute, visibleEndMinute) - Math.max(tripStartMinute, visibleStartMinute)) / visibleRangeMinutes) * 100);
              const tripWidthPx = (tripWidthPercent / 100) * timelineWidth;
              const tripSizeClass = tripWidthPx < 18 ? " is-micro" : tripWidthPx < 44 ? " is-compact" : "";
              const visibleDuration = Math.max(0, Math.min(currentMinute, tripEndMinute) - Math.max(tripStartMinute, visibleStartMinute));
              const activeFillPercent = tripEndMinute > tripStartMinute
                ? Math.max(0, Math.min(100, (visibleDuration / (tripEndMinute - tripStartMinute)) * 100))
                : 0;
              const toneClass = trip.toneClass || row.toneClass || "scene-timeline-segment-truck-heavyhaul";
              const leftPercent = ((Math.max(tripStartMinute, visibleStartMinute) - visibleStartMinute) / visibleRangeMinutes) * 100;
              const hoverCardData = buildTimelineHoverCard(rowType, row, trip, tripStartMinute, tripEndMinute);
              const barLabel = getTimelineBarLabel(rowType, row, trip);

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
                      top: rowType === "phase" || (rowType === "truck" && phaseLaneCount > 1)
                        ? `${8 + (tripIndex * 28)}px`
                        : undefined,
                    },
                    onPointerEnter: (event) => handleTripHover(event, hoverCardData),
                    onPointerMove: (event) => handleTripHover(event, hoverCardData),
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
                      !tripSizeClass
                        ? h("span", { key: `${trip.key}-label`, className: "scene-timeline-trip-label" }, barLabel)
                        : null,
                    ],
                  ),
                ),
              ];
            });

            return h(
              "article",
              {
                key: `timeline-row-${rowKey}`,
                className: `scene-timeline-row${rowType === "phase" || (rowType === "truck" && phaseLaneCount > 1) ? " is-phase-row" : ""}${row.hasOverlapConflict ? " is-conflict" : ""}${row.critical ? " is-critical" : ""}`,
                style: rowHeightPx ? { height: `${rowHeightPx}px`, minHeight: `${rowHeightPx}px` } : undefined,
              },
              h(
                "div",
                { className: `scene-timeline-row-track${rowType === "phase" || (rowType === "truck" && phaseLaneCount > 1) ? " is-phase-row-track" : ""}`, style: rowHeightPx ? { height: `${rowHeightPx}px` } : undefined },
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

function getProjectSummaryDashboardModel({
  scenario,
  playback,
  move,
  activePlanDashboard,
  planningStartDate,
  planningStartTime,
  scenarios = [],
}) {
  const journeys = playback?.journeys?.length ? playback.journeys : (playback?.trips || []);
  const trips = playback?.trips || [];
  const totalMinutes = Math.max(0, Number(scenario?.totalMinutes) || Number(playback?.totalMinutes) || 0);
  const totalHours = totalMinutes / 60;
  const totalDays = totalMinutes / (24 * 60);
  const routeKm = Math.max(0, Number(move?.routeKm) || Number(scenario?.routeDistanceKm) || 0);
  const averageMoveHours = getAverageTruckMoveHours(playback);
  const totalDistanceKm = Math.round(
    journeys.reduce(
      (sum, journey) => sum + (Number(journey?.routeDistanceKm) || (routeKm * Math.max((journey.loadIds || []).length || 1, 1))),
      0,
    ),
  );
  const { totalProjectCost, transportCost, laborCost, overheadCost } = getScenarioCostSummary(scenario, playback);
  const truckUtilization = Math.max(0, Number(scenario?.truckUtilization) || Number(activePlanDashboard?.truckUtilizationValue) || 0);
  const crewUtilization = Math.max(0, Number(scenario?.workerUtilization) || Number(scenario?.utilization) || 0);
  const baselineCost = Math.max(0, Number(scenario?.manualBaseline?.costEstimate) || 0);
  const baselineMinutes = Math.max(0, Number(scenario?.manualBaseline?.totalMinutes) || 0);
  const hasBaseline = baselineCost > 0;
  const savingsPercent = hasBaseline
    ? Math.max(0, ((baselineCost - totalProjectCost) / baselineCost) * 100)
    : null;
  const savingsAmount = Math.max(0, baselineCost - totalProjectCost);
  const truckTripRows = buildTruckTripUtilizationRows(playback, totalMinutes);
  const scenarioPlans = (scenarios || [])
    .filter((item) => (Number(item?.totalMinutes) || 0) > 0)
    .map((item) => ({
      key: item.name || "scenario",
      name: item.name || "Plan",
      totalMinutes: Math.max(0, Number(item?.totalMinutes) || 0),
      costEstimate: getScenarioCostSummary(item, item?.bestVariant?.playback || item?.playback || playback).totalProjectCost,
      truckUtilization: getScenarioUtilizationScore(item),
      savingsPercent: Math.max(0, Number(item?.manualBaseline?.costEstimate) || 0) > 0
        ? Math.max(0, (((Number(item?.manualBaseline?.costEstimate) || 0) - getScenarioCostSummary(item, item?.bestVariant?.playback || item?.playback || playback).totalProjectCost) / Math.max(Number(item?.manualBaseline?.costEstimate) || 1, 1)) * 100)
        : null,
      isSelected: item?.name === scenario?.name,
    }));
  const selectedPlan = scenarioPlans.find((item) => item.isSelected) || {
    key: scenario?.name || "selected-plan",
    name: scenario?.name || "Selected Plan",
    totalMinutes,
    costEstimate: totalProjectCost,
    truckUtilization,
    savingsPercent,
    isSelected: true,
  };
  const fastestPlan = scenarioPlans.reduce((best, item) => (!best || item.totalMinutes < best.totalMinutes ? item : best), null);
  const cheapestPlan = scenarioPlans.reduce((best, item) => (!best || item.costEstimate < best.costEstimate ? item : best), null);
  let scenarioNarrative = "Scenario selected for review.";

  if (selectedPlan.name === "Cheapest" && fastestPlan) {
    const slowerDays = Math.max(0, (selectedPlan.totalMinutes - fastestPlan.totalMinutes) / (24 * 60));
    const savingsVsFastest = fastestPlan.costEstimate > 0
      ? Math.max(0, ((fastestPlan.costEstimate - selectedPlan.costEstimate) / fastestPlan.costEstimate) * 100)
      : 0;
    scenarioNarrative = `Lowest total cost. Saves ${formatPercentLabel(savingsVsFastest)} against ${fastestPlan.name}${slowerDays > 0.1 ? `, but runs ${slowerDays.toFixed(1)} days longer.` : "."}`;
  } else if (selectedPlan.name === "Fastest" && cheapestPlan) {
    const daysSaved = Math.max(0, (cheapestPlan.totalMinutes - selectedPlan.totalMinutes) / (24 * 60));
    const costPremium = cheapestPlan.costEstimate > 0
      ? Math.max(0, ((selectedPlan.costEstimate - cheapestPlan.costEstimate) / cheapestPlan.costEstimate) * 100)
      : 0;
    scenarioNarrative = `Shortest makespan. Finishes ${daysSaved.toFixed(1)} days ahead of ${cheapestPlan.name}${costPremium > 0.1 ? `, with a ${formatPercentLabel(costPremium)} cost premium.` : "."}`;
  } else if (selectedPlan.name === "Utilized" && cheapestPlan) {
    const extraDays = Math.max(0, (selectedPlan.totalMinutes - cheapestPlan.totalMinutes) / (24 * 60));
    scenarioNarrative = `Best fleet loading profile. Truck utilization reaches ${formatPercentLabel(selectedPlan.truckUtilization)}${extraDays > 0.1 ? `, with ${extraDays.toFixed(1)} extra days over ${cheapestPlan.name}.` : "."}`;
  }

  const maxScenarioMinutes = Math.max(...scenarioPlans.map((item) => item.totalMinutes), selectedPlan.totalMinutes, 1);
  const maxScenarioCost = Math.max(...scenarioPlans.map((item) => item.costEstimate), selectedPlan.costEstimate, 1);

  return {
    coreKpis: [
      {
        key: "duration",
        label: "Project Duration",
        value: `${totalDays.toFixed(1)} days`,
        meta: `${totalHours.toFixed(1)} hrs`,
        subtext: `ETA: ${getPlanEtaLabel(planningStartDate, planningStartTime, totalMinutes)}`,
        tone: "amber",
      },
      {
        key: "cost",
        label: "Total Project Cost",
        value: formatCurrency(totalProjectCost),
        meta: "Includes labor + transport + overhead",
        subtext: `Transport ${formatCurrency(transportCost)} · Labor ${formatCurrency(laborCost)} · Overhead ${formatCurrency(overheadCost)}`,
        tone: "green",
      },
      {
        key: "savings",
        label: "Savings vs Baseline",
        value: hasBaseline ? formatPercentLabel(savingsPercent) : "N/A",
        meta: "vs manual scheduling",
        subtext: baselineCost > 0 ? `${formatCurrency(savingsAmount)} saved vs ${formatCurrency(baselineCost)} baseline` : "Baseline scenario not available",
        tone: "blue",
      },
    ],
    operationalKpis: [
      {
        key: "utilization",
        label: "Fleet Utilization",
        value: `${formatPercentLabel(truckUtilization)} trucks · ${formatPercentLabel(crewUtilization)} crews`,
        meta: `${activePlanDashboard.usedTruckCount}/${activePlanDashboard.allocatedTruckCount} trucks active`,
        tone: "purple",
      },
      {
        key: "trips",
        label: "Total Trips",
        value: `${formatWholeNumber(trips.length)} trips`,
        meta: `${truckTripRows.length} trucks assigned in this plan`,
        tone: "amber",
      },
      {
        key: "distance",
        label: "Total Distance",
        value: `${formatWholeNumber(routeKm)} km`,
        meta: `${averageMoveHours.toFixed(1)}h average truck travel time`,
        subtext: `${formatWholeNumber(totalDistanceKm)} km cumulative across all trips`,
        tone: "blue",
      },
      {
        key: "scenario",
        label: "Makespan Scenario",
        value: selectedPlan.name,
        meta: scenarioNarrative,
        subtext: baselineMinutes > 0 ? `Manual baseline: ${(baselineMinutes / (24 * 60)).toFixed(1)} days` : "",
        tone: "red",
      },
    ],
    costBreakdown: [
      { key: "transport", label: "Transport", value: transportCost, color: "#f0b34a" },
      { key: "labor", label: "Labor", value: laborCost, color: "#62c98a" },
      { key: "overhead", label: "Overhead", value: overheadCost, color: "#6fb3ff" },
    ],
    utilization: {
      truck: truckUtilization,
      crew: crewUtilization,
    },
    hasBaseline,
    truckTripRows,
    selectedPlan,
    scenarioNarrative,
    scenarioRows: scenarioPlans.map((item) => ({
      ...item,
      timeWidth: `${Math.max(16, Math.round((item.totalMinutes / maxScenarioMinutes) * 100))}%`,
      costWidth: `${Math.max(16, Math.round((item.costEstimate / maxScenarioCost) * 100))}%`,
      utilizationWidth: `${Math.max(16, Math.round(item.truckUtilization))}%`,
      durationLabel: `${(item.totalMinutes / (24 * 60)).toFixed(1)} d`,
      costLabel: formatCurrency(item.costEstimate),
      utilizationLabel: formatPercentLabel(item.truckUtilization),
      savingsLabel: item.savingsPercent == null ? "N/A" : formatPercentLabel(item.savingsPercent),
    })),
  };
}

function renderProjectSummaryDashboard({ model, radarModel }) {
  const costTotal = Math.max(1, model.costBreakdown.reduce((sum, item) => sum + item.value, 0));
  const radarConcepts = [
    { key: "time", label: "Time", description: "Shorter project duration is better." },
    { key: "cost", label: "Cost", description: "Lower total project cost is better." },
    { key: "utilization", label: "Utilization", description: "Higher truck usage is better." },
    { key: "idle", label: "Idle", description: "Lower idle minutes are better." },
    { key: "savings", label: "Savings", description: model.hasBaseline ? "Higher reduction versus manual baseline is better." : "Shown when a manual baseline exists." },
  ];

  return h(
    "div",
    { className: "scene-project-summary-dashboard" },
    h(
      "div",
      { className: "scene-project-summary-grid scene-project-summary-grid-core" },
      model.coreKpis.map((metric) =>
        h(
          "article",
          { key: metric.key, className: `scene-project-kpi-card is-${metric.tone}` },
          h("span", { className: "scene-project-kpi-label" }, metric.label),
          h("strong", { className: "scene-project-kpi-value" }, metric.value),
          h("span", { className: "scene-project-kpi-meta" }, metric.meta),
          metric.key === "cost"
            ? h(
                "div",
                { className: "scene-project-cost-stack" },
                h(
                  "div",
                  { className: "scene-project-cost-bar" },
                  model.costBreakdown.map((item) =>
                    h("span", {
                      key: item.key,
                      className: "scene-project-cost-bar-segment",
                      style: {
                        width: `${(item.value / costTotal) * 100}%`,
                        background: item.color,
                      },
                    }),
                  ),
                ),
                h(
                  "div",
                  { className: "scene-project-cost-legend" },
                  model.costBreakdown.map((item) =>
                    h(
                      "span",
                      { key: `${item.key}-legend`, className: "scene-project-cost-legend-item" },
                      h("i", { style: { background: item.color } }),
                      `${item.label} ${formatCurrency(item.value)}`,
                    ),
                  ),
                ),
              )
            : null,
          metric.subtext ? h("span", { className: "scene-project-kpi-subtext" }, metric.subtext) : null,
        ),
      ),
    ),
    h(
      "div",
      { className: "scene-project-summary-grid scene-project-summary-grid-ops" },
      model.operationalKpis.map((metric) =>
        h(
          "article",
          { key: metric.key, className: `scene-project-kpi-card is-${metric.tone}` },
          h("span", { className: "scene-project-kpi-label" }, metric.label),
          h("strong", { className: "scene-project-kpi-value" }, metric.value),
          h("span", { className: "scene-project-kpi-meta" }, metric.meta),
          metric.key === "utilization"
            ? h(
                "div",
                { className: "scene-project-utilization-chart" },
                h(
                  "div",
                  { className: "scene-project-utilization-row" },
                  h("span", null, "Trucks"),
                  h("div", { className: "scene-project-utilization-bar" }, h("span", { style: { width: `${Math.max(4, model.utilization.truck)}%` } })),
                  h("strong", null, formatPercentLabel(model.utilization.truck)),
                ),
                h(
                  "div",
                  { className: "scene-project-utilization-row" },
                  h("span", null, "Crews"),
                  h("div", { className: "scene-project-utilization-bar is-crew" }, h("span", { style: { width: `${Math.max(4, model.utilization.crew)}%` } })),
                  h("strong", null, formatPercentLabel(model.utilization.crew)),
                ),
              )
            : metric.key === "trips"
              ? h(
                  "div",
                  { className: "scene-project-trip-list" },
                  model.truckTripRows.slice(0, 4).map((truck) =>
                    h(
                      "div",
                      { key: `trip-${truck.key}`, className: "scene-project-trip-row" },
                      h("strong", null, `${truck.truckType} ${truck.truckId}`),
                      h("span", null, `${truck.loadCount} loads`),
                      h("span", null, `${truck.utilizationPercent}% util.`),
                    ),
                  ),
                  model.truckTripRows.length > 4
                    ? h("span", { className: "scene-project-trip-more" }, `+${model.truckTripRows.length - 4} more trucks`)
                    : null,
                )
            : null,
          metric.subtext ? h("span", { className: "scene-project-kpi-subtext" }, metric.subtext) : null,
        ),
      ),
    ),
    h(
      "div",
      { className: "scene-project-summary-bottom" },
      h(
        "article",
        { className: "scene-project-summary-panel scene-project-summary-panel-radar" },
        h("span", { className: "scene-project-panel-label" }, "Scenario Comparison"),
        h("strong", { className: "scene-project-panel-title" }, "How to read the comparison"),
        h(
          "div",
          { className: "scene-project-radar-concepts" },
          radarConcepts.map((concept) =>
            h(
              "div",
              { key: concept.key, className: "scene-project-radar-concept" },
              h("strong", null, concept.label),
              h("span", null, concept.description),
            ),
          ),
        ),
        h("p", { className: "scene-radar-subtitle" }, `${model.selectedPlan.name} is currently selected. ${model.scenarioNarrative}`),
        h(PlanComparisonRadar, { model: radarModel }),
      ),
      h(
        "article",
        { className: "scene-project-summary-panel" },
        h("span", { className: "scene-project-panel-label" }, "Scenario Benchmarks"),
        h("strong", { className: "scene-project-panel-title" }, "Time, cost, and utilization"),
        h(
          "div",
          { className: "scene-project-bar-legend" },
          h("span", { className: "scene-project-bar-legend-item" }, h("i", { className: "is-time" }), "Blue = Time"),
          h("span", { className: "scene-project-bar-legend-item" }, h("i", { className: "is-cost" }), "Amber = Cost"),
          h("span", { className: "scene-project-bar-legend-item" }, h("i", { className: "is-utilization" }), "Green = Utilization"),
        ),
        h(
          "div",
          { className: "scene-project-plan-list" },
          model.scenarioRows.map((plan) =>
            h(
              "div",
              { key: plan.key, className: `scene-project-plan-row${plan.isSelected ? " is-selected" : ""}` },
              h(
                "div",
                { className: "scene-project-plan-head" },
                h("strong", null, plan.name),
                h("span", null, `${plan.costLabel} · ${plan.durationLabel} · ${plan.utilizationLabel}`),
              ),
              h(
                "div",
                { className: "scene-project-plan-bars" },
                h("span", { className: "scene-project-plan-bar is-time", style: { width: plan.timeWidth } }),
                h("span", { className: "scene-project-plan-bar is-cost", style: { width: plan.costWidth } }),
                h("span", { className: "scene-project-plan-bar is-utilization", style: { width: plan.utilizationWidth } }),
              ),
              h("div", { className: "scene-project-plan-meta" }, h("span", null, `Baseline savings ${plan.savingsLabel}`)),
            ),
          ),
        ),
      ),
    ),
  );
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
  planRadarModel,
  scenarios = [],
  scenario,
  move,
  planningStartDate,
  planningStartTime,
  currentMinute = 0,
  timelineGapMinutes = 180,
}) {
  const [activitySearch, setActivitySearch] = useState("");
  const [ganttWindowHours, setGanttWindowHours] = useState(24);
  const [ganttWindowIndex, setGanttWindowIndex] = useState(0);
  const [ganttFilters, setGanttFilters] = useState({
    cpOnly: false,
    showRD: true,
    showRM: true,
    showRU: true,
    showDays: true,
    showFloatBar: true,
  });
  const [ganttView, setGanttView] = useState("load");
  const projectSummaryModel = useMemo(
    () => getProjectSummaryDashboardModel({
      scenario,
      playback,
      move,
      activePlanDashboard,
      planningStartDate,
      planningStartTime,
      scenarios,
    }),
    [scenario, playback, move, activePlanDashboard, planningStartDate, planningStartTime, scenarios],
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
  const ganttWindowMinutes = ganttWindowHours * 60;
  const ganttWindowCount = Math.max(1, Math.ceil(Math.max(playback?.totalMinutes || 0, 1) / ganttWindowMinutes));
  const boundedGanttWindowIndex = Math.max(0, Math.min(ganttWindowIndex, ganttWindowCount - 1));
  const ganttWindowStartMinute = boundedGanttWindowIndex * ganttWindowMinutes;
  const ganttTickMinutes = ganttWindowHours === 12 ? 60 : 120;

  useEffect(() => {
    if (ganttWindowIndex !== boundedGanttWindowIndex) {
      setGanttWindowIndex(boundedGanttWindowIndex);
    }
  }, [ganttWindowIndex, boundedGanttWindowIndex]);

  useEffect(() => {
    setGanttWindowIndex((value) => Math.min(value, Math.max(0, ganttWindowCount - 1)));
  }, [ganttWindowHours, ganttWindowCount]);

  return h(
    "section",
    { className: "scene-planner-canvas" },
    h(
      Card,
      { className: "scene-planner-canvas-card scene-planner-summary-card" },
      h("span", { className: "scene-panel-kicker" }, "Project Summary"),
      renderProjectSummaryDashboard({ model: projectSummaryModel, radarModel: planRadarModel }),
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
      h("span", { className: "scene-panel-kicker" }, "Gantt"),
      h(
        "div",
        { className: "scene-gantt-toolbar" },
        h("span", { className: "scene-planner-section-note" }, `${ganttWindowHours === 12 ? "Shift" : "Day"} ${boundedGanttWindowIndex + 1}/${ganttWindowCount}`),
        h("span", { className: "scene-planner-section-note is-plain" }, formatTimelineWindowRange(ganttWindowStartMinute, Math.min((playback?.totalMinutes || 0), ganttWindowStartMinute + ganttWindowMinutes))),
        h("button", {
          type: "button",
          className: "scene-timeline-back-button",
          disabled: boundedGanttWindowIndex <= 0,
          onClick: () => setGanttWindowIndex((value) => Math.max(0, value - 1)),
          children: "Prev",
        }),
        h("button", {
          type: "button",
          className: "scene-timeline-back-button",
          onClick: () => setGanttWindowHours(12),
          disabled: ganttWindowHours === 12,
          children: "12h",
        }),
        h("button", {
          type: "button",
          className: "scene-timeline-back-button",
          onClick: () => setGanttWindowHours(24),
          disabled: ganttWindowHours === 24,
          children: "24h",
        }),
        h("button", {
          type: "button",
          className: "scene-timeline-back-button",
          disabled: boundedGanttWindowIndex >= (ganttWindowCount - 1),
          onClick: () => setGanttWindowIndex((value) => Math.min(ganttWindowCount - 1, value + 1)),
          children: "Next",
        }),
      ),
      h(
        "div",
        { className: "scene-gantt-toolbar" },
        h("label", { className: "scene-gantt-check" }, h("input", {
          type: "checkbox",
          checked: ganttView === "load",
          onChange: () => setGanttView("load"),
        }), h("span", null, "Loads")),
        h("label", { className: "scene-gantt-check" }, h("input", {
          type: "checkbox",
          checked: ganttView === "truck",
          onChange: () => setGanttView("truck"),
        }), h("span", null, "Trucks")),
        h("label", { className: "scene-gantt-check" }, h("input", {
          type: "checkbox",
          checked: ganttView === "phase",
          onChange: () => setGanttView("phase"),
        }), h("span", null, "Phases")),
        h("label", { className: "scene-gantt-check" }, h("input", {
          type: "checkbox",
          checked: ganttFilters.showRD,
          disabled: ganttView === "truck",
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
          disabled: ganttView === "truck",
          onChange: (event) => setGanttFilters((current) => ({ ...current, showRU: event.target.checked })),
        }), h("span", null, "RU")),
        h("label", { className: "scene-gantt-check" }, h("input", {
          type: "checkbox",
          checked: true,
          disabled: true,
          readOnly: true,
        }), h("span", null, ganttWindowHours === 12 ? "Shift view" : "Day view")),
        h("label", { className: "scene-gantt-check" }, h("input", {
          type: "checkbox",
          checked: ganttFilters.showFloatBar,
          onChange: (event) => setGanttFilters((current) => ({ ...current, showFloatBar: event.target.checked })),
        }), h("span", null, "Float bar")),
      ),
      h(
        "div",
        { className: "scene-gantt-legend" },
        ganttView === "truck"
          ? h("span", { className: "scene-gantt-legend-item" }, h("i", { className: "scene-gantt-legend-dot is-rm" }), "Truck Moving")
          : [
              h("span", { key: "legend-rd", className: "scene-gantt-legend-item" }, h("i", { className: "scene-gantt-legend-dot is-rd" }), "Rig Down"),
              h("span", { key: "legend-rm", className: "scene-gantt-legend-item" }, h("i", { className: "scene-gantt-legend-dot is-rm" }), "Moving"),
              h("span", { key: "legend-ru", className: "scene-gantt-legend-item" }, h("i", { className: "scene-gantt-legend-dot is-ru" }), "Rig Up"),
            ],
      ),
      h(FullScreenTimeline, {
        playback,
        currentMinute,
        zoom,
        rowType: ganttView,
        title: ganttView === "load" ? "Load" : ganttView === "truck" ? "Truck" : "Phase",
        windowStartMinute: ganttWindowStartMinute,
        windowMinutes: ganttWindowMinutes,
        tickMinutes: ganttTickMinutes,
        gapMinutes: timelineGapMinutes,
        showRD: ganttView === "truck" ? false : ganttFilters.showRD,
        showRM: ganttFilters.showRM,
        showRU: ganttView === "truck" ? false : ganttFilters.showRU,
        showFloatBar: ganttView === "load" ? ganttFilters.showFloatBar : false,
        hideFixedColumn: false,
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

function formatTimelineWindowLabel(minute) {
  const safeMinutes = Math.max(0, Math.round(minute || 0));
  const day = Math.floor(safeMinutes / (24 * 60)) + 1;
  const dayMinute = safeMinutes % (24 * 60);
  return `D${day} ${formatTimelineClock(dayMinute)}`;
}

function formatTimelineWindowRange(startMinute, endMinute) {
  const safeStart = Math.max(0, Math.round(startMinute || 0));
  const safeEnd = Math.max(safeStart, Math.round(endMinute || 0));
  const startDay = Math.floor(safeStart / (24 * 60)) + 1;
  const startDayMinute = safeStart % (24 * 60);
  const endDay = Math.floor(Math.max(0, safeEnd - 1) / (24 * 60)) + 1;
  const endDayMinute = safeEnd % (24 * 60);
  if (safeEnd - safeStart <= 12 * 60) {
    return `Shift view | D${startDay} ${formatTimelineClock(startDayMinute)} - D${endDay} ${formatTimelineClock(endDayMinute)}`;
  }
  if (startDay === endDay && startDayMinute === 0 && endDayMinute === 0) {
    return `Day ${startDay}`;
  }
  return `Day view | D${startDay} ${formatTimelineClock(startDayMinute)} - D${endDay} ${formatTimelineClock(endDayMinute)}`;
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
  onUpdateExecutionProgress,
  onCompleteAssignmentStage,
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
  const [trackingMode, setTrackingMode] = useState(executionProgress?.trackingMode === "demoUltrasonic" ? "demoUltrasonic" : "driverApp");
  const [ultrasonicStartInput, setUltrasonicStartInput] = useState(String(Math.max(0, Number(executionProgress?.ultrasonicStartCm) || 45)));
  const [ultrasonicArrivalInput, setUltrasonicArrivalInput] = useState(String(Math.max(0, Number(executionProgress?.ultrasonicArrivalCm) || 8)));
  const [liveDemoMinute, setLiveDemoMinute] = useState(0);
  const [customScenario, setCustomScenario] = useState(null);
  const [isCalculatingCustomPlan, setIsCalculatingCustomPlan] = useState(false);
  const [customPlanError, setCustomPlanError] = useState("");
  const stableDemoTargetMinuteRef = useRef(null);

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
      setTrackingMode(move?.executionProgress?.trackingMode === "demoUltrasonic" ? "demoUltrasonic" : "driverApp");
      setUltrasonicStartInput(String(Math.max(0, Number(move?.executionProgress?.ultrasonicStartCm) || 45)));
      setUltrasonicArrivalInput(String(Math.max(0, Number(move?.executionProgress?.ultrasonicArrivalCm) || 8)));
    }
  }, [move?.id, move?.updatedAt, availableFleet, activeScenarioName, move?.simulation]);

  useEffect(() => {
    setFocusTarget(null);
  }, [sceneFocusResetKey]);

  useEffect(() => {
    setTrackingMode(executionProgress?.trackingMode === "demoUltrasonic" ? "demoUltrasonic" : "driverApp");
    setUltrasonicStartInput(String(Math.max(0, Number(executionProgress?.ultrasonicStartCm) || 45)));
    setUltrasonicArrivalInput(String(Math.max(0, Number(executionProgress?.ultrasonicArrivalCm) || 8)));
  }, [
    executionProgress?.trackingMode,
    executionProgress?.ultrasonicStartCm,
    executionProgress?.ultrasonicArrivalCm,
  ]);

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

  useEffect(() => {
    setCustomScenario(null);
    setCustomPlanError("");
    setIsCalculatingCustomPlan(false);
  }, [move?.id]);

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
  const planningRouteData = useMemo(() => ({
    minutes: safeMove.simulation?.routeMinutes || baseActiveScenario?.routeMinutes || 0,
    distanceKm: safeMove.simulation?.routeDistanceKm || baseActiveScenario?.routeDistanceKm || safeMove.routeKm || 0,
    geometry: safeMove.simulation?.routeGeometry || baseActiveScenario?.routeGeometry || [],
    source: safeMove.simulation?.routeSource || baseActiveScenario?.routeSource || "Preview route",
  }), [safeMove.simulation, baseActiveScenario, safeMove.routeKm]);
  useEffect(() => {
    if (!isCustomizeActive || readOnly || !move?.id) {
      setIsCalculatingCustomPlan(false);
      setCustomPlanError("");
      return undefined;
    }

    const sanitizedTruckSetup = deferredTruckSetup
      .map((item) => ({
        ...item,
        type: normalizeTruckTypeLabel(item?.type),
        count: Math.max(0, Number.parseInt(item?.count, 10) || 0),
        hourlyCost: Math.max(0, Number(item?.hourlyCost) || 0),
      }))
      .filter((item) => item.type && item.count > 0);

    if (!sanitizedTruckSetup.length || !logicalLoads.length) {
      setCustomScenario(null);
      setIsCalculatingCustomPlan(false);
      setCustomPlanError(sanitizedTruckSetup.length ? "" : "Add at least one truck type to preview a custom plan.");
      return undefined;
    }

    let cancelled = false;
    const timeoutId = window.setTimeout(() => {
      setIsCalculatingCustomPlan(true);
      setCustomPlanError("");

      void buildScenarioPlans(
        logicalLoads,
        planningRouteData,
        4,
        sanitizedTruckSetup.reduce((sum, item) => sum + item.count, 0),
        sanitizedTruckSetup,
        truckSpecs,
        {
          dayShift: 4,
          nightShift: 4,
          roles: {},
          averageHourlyCost: 0,
          startHour: Number.parseInt((planningStartTime || "06:00").split(":")[0], 10) || 6,
          startMinute: Number.parseInt((planningStartTime || "06:00").split(":")[1], 10) || 0,
          enforceExactFleet: true,
        },
      ).then((plans) => {
        if (cancelled) {
          return;
        }

        const bestCustomScenario = (plans || []).reduce(
          (best, plan) => (!best || (plan?.totalMinutes || Infinity) < (best?.totalMinutes || Infinity) ? plan : best),
          null,
        );

        if (!bestCustomScenario?.bestVariant) {
          setCustomScenario(null);
          setCustomPlanError("No feasible custom plan was found for this truck mix.");
          return;
        }

        setCustomScenario({
          ...bestCustomScenario,
          allocatedTruckSetup: sanitizedTruckSetup,
          truckSetup: sanitizedTruckSetup,
          allocatedTruckCount: sanitizedTruckSetup.reduce((sum, item) => sum + item.count, 0),
        });
      }).catch((error) => {
        if (!cancelled) {
          setCustomScenario(null);
          setCustomPlanError(error?.message || "Failed to calculate the custom plan.");
        }
      }).finally(() => {
        if (!cancelled) {
          setIsCalculatingCustomPlan(false);
        }
      });
    }, 450);

    return () => {
      cancelled = true;
      window.clearTimeout(timeoutId);
    };
  }, [isCustomizeActive, readOnly, move?.id, deferredTruckSetup, logicalLoads, planningRouteData, truckSpecs, planningStartTime]);
  const scenarioPlans = baseScenarioPlans;
  const activeScenario =
    scenarioPlans.find((scenario) => scenario.name === activeScenarioName) ||
    scenarioPlans[0] ||
    baseActiveScenario;
  const selectedScenario = isCustomizeActive ? (customScenario || activeScenario) : activeScenario;
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

  const displaySimulation = useMemo(() => {
    const rawBestPlan = selectedScenario?.bestVariant || safeMove.simulation?.bestPlan || fallbackScenario.bestVariant;
    const normalizedBestPlanPlayback = normalizeScenePlayback(rawBestPlan?.playback || fallbackPlayback);
    return {
      ...(safeMove.simulation || {}),
      truckCount: Math.max(
        selectedScenario?.truckCount || 0,
        safeMove.simulation?.truckCount || 0,
        normalizedBestPlanPlayback?.truckCount || 0,
      ),
      bestPlan: {
        ...(rawBestPlan || {}),
        playback: normalizedBestPlanPlayback,
      },
      bestScenario: selectedScenario || safeMove.simulation?.bestScenario || fallbackScenario,
      routeGeometry: selectedScenario?.routeGeometry || safeMove.simulation?.routeGeometry || [],
      routeMinutes: selectedScenario?.routeMinutes || safeMove.simulation?.routeMinutes || 0,
      truckSetup: effectiveTruckSetup,
    };
  }, [safeMove.simulation, selectedScenario, effectiveTruckSetup, fallbackScenario, fallbackPlayback]);
  const activeBestPlan = displaySimulation.bestPlan || fallbackScenario.bestVariant;
  const activePlayback = activeBestPlan?.playback || fallbackPlayback;

  const activeTrackingMode = executionProgress?.trackingMode === "demoUltrasonic" ? "demoUltrasonic" : "driverApp";
  const ultrasonicDemo = getUltrasonicDemoSummary(executionProgress, executionAssignments);
  const totalMinutes = activeBestPlan?.totalMinutes || 0;
  const baseVisibleMinute = sceneAssetsReady ? Math.min(currentMinute, totalMinutes) : 0;
  const hasStartedLiveMove = executionAssignments.some((assignment) => Boolean(assignment?.moveStartedAt));
  const isOutboundSensorTracking = shouldUseDemoSensorTracking(executionAssignments);
  const sensorTripWindow = useMemo(
    () => getActiveSensorTripWindow(activePlayback, executionAssignments),
    [activePlayback, executionAssignments],
  );
  const demoCompletionPercent = Math.max(
    0,
    Math.min(
      100,
      Number(
        activeTrackingMode === "demoUltrasonic"
          ? ultrasonicDemo.progressPercent
          : 0,
      ) || ultrasonicDemo.progressPercent,
    ),
  );
  const isLiveDemoTracking =
    activeTrackingMode === "demoUltrasonic" &&
    (executionState === "active" || executionState === "completed") &&
    hasStartedLiveMove &&
    isOutboundSensorTracking;
  const roadProgressRatio = Math.max(
    0,
    Math.min(
      1,
      activeTrackingMode === "demoUltrasonic"
        ? ultrasonicDemo.roadProgressRatio
        : demoCompletionPercent / 100,
    ),
  );
  const rawDemoTargetMinute = sensorTripWindow
    ? (
        Number(sensorTripWindow.startMinute) +
        ((Number(sensorTripWindow.endMinute) - Number(sensorTripWindow.startMinute)) * roadProgressRatio)
      )
    : Math.min(totalMinutes, Math.max(0, roadProgressRatio * Math.max(totalMinutes, 0)));
  const demoTargetMinute =
    !isLiveDemoTracking || !ultrasonicDemo.hasReading
      ? null
      : rawDemoTargetMinute;

  useEffect(() => {
    if (!isLiveDemoTracking) {
      stableDemoTargetMinuteRef.current = null;
      return;
    }

    if (demoTargetMinute == null) {
      return;
    }

    stableDemoTargetMinuteRef.current = demoTargetMinute;
  }, [demoTargetMinute, isLiveDemoTracking]);

  useEffect(() => {
    if (!isLiveDemoTracking) {
      setLiveDemoMinute(baseVisibleMinute);
      return undefined;
    }

    setLiveDemoMinute((current) => {
      const targetMinute = demoTargetMinute ?? current ?? baseVisibleMinute;
      if (!Number.isFinite(current) || Math.abs(current - targetMinute) > Math.max(totalMinutes * 0.35, 120)) {
        return targetMinute;
      }
      return current;
    });

    const intervalId = window.setInterval(() => {
      setLiveDemoMinute((current) => {
        const targetMinute = demoTargetMinute ?? current ?? baseVisibleMinute;
        const delta = targetMinute - current;
        if (Math.abs(delta) < 0.35) {
          return targetMinute;
        }

        const step = Math.sign(delta) * Math.max(0.45, Math.abs(delta) * 0.22);
        const nextValue = current + step;
        if (delta > 0) {
          return Math.min(nextValue, targetMinute);
        }
        return Math.max(nextValue, targetMinute);
      });
    }, 50);

    return () => {
      window.clearInterval(intervalId);
    };
  }, [isLiveDemoTracking, demoTargetMinute, totalMinutes, baseVisibleMinute]);

  const visibleMinute = isLiveDemoTracking ? Math.min(liveDemoMinute, totalMinutes) : baseVisibleMinute;
  const canResumePlayback = visibleMinute > 0 && visibleMinute < totalMinutes;
  const completion = Math.min(100, Math.round((visibleMinute / Math.max(totalMinutes, 1)) * 100));
  const phases = useMemo(
    () => getPhasePercentages(activePlayback, visibleMinute),
    [activePlayback, visibleMinute],
  );
  const rigLoads = useMemo(
    () => getRigLoadCounts(activePlayback, visibleMinute),
    [activePlayback, visibleMinute],
  );
  const lastLog = useMemo(
    () => activePlayback.steps.filter((step) => step.minute <= visibleMinute).slice(-1)[0] || activePlayback.steps[0],
    [activePlayback, visibleMinute],
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
  const planComparisonStats = useMemo(
    () => getPlanComparisonStats(scenarioPlans, selectedScenario, safeMove, visibleMinute),
    [scenarioPlans, selectedScenario, safeMove, visibleMinute],
  );
  const planRadarModel = useMemo(
    () => getPlanRadarComparisonModel(scenarioPlans, selectedScenario, safeMove),
    [scenarioPlans, selectedScenario, safeMove],
  );
  const previewPlanCard = planRadarModel.plans.find((plan) => plan.isSelected) || planRadarModel.plans[0] || null;
  const previewRoundTrips = activePlanSummary.roundTrips;
  const previewTruckUsageLabel = activePlanDashboard.truckUsageLabel;
  const previewCostPerLoad = planComparisonStats.costPerLoad;
  const criticalPathChain = useMemo(
    () => buildCriticalPathChain(activePlayback),
    [activePlayback],
  );
  const criticalScheduleRows = useMemo(
    () => buildCriticalScheduleRows(activePlayback),
    [activePlayback],
  );
  const plannerScheduleRows = useMemo(
    () => buildPlannerScheduleRows(activePlayback),
    [activePlayback],
  );
  const plannerCostRows = useMemo(
    () => buildPlannerCostRows(selectedScenario, activePlayback, safeMove),
    [selectedScenario, activePlayback, safeMove],
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
  const preliminaryExecutionMinute = move?.executionStartedAt
    ? Math.max(
        0,
        ((move?.executionCompletedAt ? new Date(move.executionCompletedAt).getTime() : executionNow) - new Date(move.executionStartedAt).getTime()) / 60000,
      )
    : visibleMinute;
  const displayExecutionAssignments = useMemo(
    () => (executionState !== "planning" ? buildDisplayExecutionAssignments(executionAssignments, preliminaryExecutionMinute) : executionAssignments),
    [executionAssignments, executionState, preliminaryExecutionMinute],
  );
  const timelinePlayback = useMemo(
    () => (executionState !== "planning" ? buildExecutionTimelinePlayback(activePlayback, displayExecutionAssignments, preliminaryExecutionMinute) : activePlayback),
    [activePlayback, displayExecutionAssignments, executionState, preliminaryExecutionMinute],
  );
  const loadTimelineRows = useMemo(
    () => (isTimelineMode && timelineRowType === "load" ? buildLoadScheduleRows(timelinePlayback) : []),
    [isTimelineMode, timelineRowType, timelinePlayback],
  );
  const cpmTimelineRows = useMemo(
    () => (isTimelineMode && timelineRowType === "cpm" ? buildCpmScheduleRows(timelinePlayback) : []),
    [isTimelineMode, timelineRowType, timelinePlayback],
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
    () => (isTimelineMode ? getTimelineWorkingMinutes(timelinePlayback, timelineRowType) : 0),
    [isTimelineMode, timelinePlayback, timelineRowType],
  );
  const truckTimelineWorkingMinutes = useMemo(
    () => (isTimelineMode ? getTimelineWorkingMinutes(timelinePlayback, "truck") : 0),
    [isTimelineMode, timelinePlayback],
  );
  const loadTimelineWorkingMinutes = useMemo(
    () => (isTimelineMode && timelineRowType === "load" ? getTimelineWorkingMinutes(timelinePlayback, "load") : 0),
    [isTimelineMode, timelineRowType, timelinePlayback],
  );
  const criticalPathTimelineWorkingMinutes = useMemo(
    () => (isTimelineMode && timelineRowType === "cpm" ? getTimelineWorkingMinutes(timelinePlayback, "cpm") : 0),
    [isTimelineMode, timelineRowType, timelinePlayback],
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
  const previewPlanEtaLabel = getPlanEtaLabel(planningStartDate, planningStartTime, previewPlanCard?.totalMinutes || 0);
  const executionAssignmentMetrics = useMemo(
    () => getAssignmentExecutionMetrics(displayExecutionAssignments, executionProgress),
    [displayExecutionAssignments, executionProgress],
  );
  const executionTimelineTotalMinutes = executionState === "planning"
    ? totalMinutes
    : Math.max(timelinePlayback?.totalMinutes || 0, 1);
  const fallbackExecutionStartedAt = move?.executionStartedAt || executionAssignments[0]?.assignedAt || null;
  const executionStartedAtMs = fallbackExecutionStartedAt ? new Date(fallbackExecutionStartedAt).getTime() : null;
  const executionCompletedAtMs = move?.executionCompletedAt ? new Date(move.executionCompletedAt).getTime() : null;
  const executionElapsedMinutes = executionStartedAtMs
    ? Math.max(0, ((executionCompletedAtMs || executionNow) - executionStartedAtMs) / 60000)
    : 0;
  const executionVisibleMinute =
    executionState === "active" || executionState === "completed"
      ? Math.min(executionElapsedMinutes, executionTimelineTotalMinutes)
      : visibleMinute;
  const liveSceneMinute = isLiveDemoTracking ? visibleMinute : executionVisibleMinute;
  const sceneMinute = executionState === "planning" ? visibleMinute : liveSceneMinute;
  // Keep demo ultrasonic motion on the original route playback so 100% maps to the real road endpoint.
  const scenePlayback = executionState === "planning"
    ? activePlayback
    : isLiveDemoTracking
      ? activePlayback
      : timelinePlayback;
  const sceneSimulation = useMemo(
    () => (
      executionState === "planning"
        ? displaySimulation
        : {
            ...displaySimulation,
            bestPlan: {
              ...(displaySimulation.bestPlan || {}),
              playback: scenePlayback,
              totalMinutes: scenePlayback?.totalMinutes || displaySimulation.bestPlan?.totalMinutes || 0,
            },
          }
    ),
    [displaySimulation, executionState, scenePlayback],
  );
  const focusedRigStats = useMemo(
    () =>
      getRigInsightStats({
        side: focusTarget?.kind === "rig" ? focusTarget.side : null,
        move: safeMove,
        playback: scenePlayback,
        currentMinute: sceneMinute,
        totalMinutes,
      }),
    [focusTarget, safeMove, scenePlayback, sceneMinute, totalMinutes],
  );
  const focusedTruckStats = useMemo(
    () =>
      getTruckFocusStats({
        truckId: focusTarget?.kind === "truck" ? focusTarget.truckId : null,
        move: safeMove,
        playback: scenePlayback,
        currentMinute: sceneMinute,
        totalMinutes,
      }),
    [focusTarget, safeMove, scenePlayback, sceneMinute, totalMinutes],
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
  const plannedCompletionPercent = Math.min(100, Math.round((executionVisibleMinute / Math.max(executionTimelineTotalMinutes, 1)) * 100));
  const actualCompletionPercent = executionAssignmentMetrics.actualPercent;
  const completionVariance = actualCompletionPercent - plannedCompletionPercent;
  const completionVarianceLabel = `${completionVariance >= 0 ? "+" : ""}${completionVariance}%`;
  const executionPaceLabel = completionVariance >= 5 ? "Ahead of plan" : completionVariance <= -5 ? "Behind plan" : "On plan";
  const plannedTasksByNow = Math.round((plannedCompletionPercent / 100) * executionAssignmentMetrics.totalStageTasks);
  const actualTasksDone = executionAssignmentMetrics.completedStageTasks;
  const nextExecutionAssignment = displayExecutionAssignments.find((assignment) => assignment.status !== "completed") || null;
  const nextExecutionTaskLabel = nextExecutionAssignment
    ? `${nextExecutionAssignment.driverName || "Driver"} • ${nextExecutionAssignment.currentStage === "rigDown" ? "Rig Down" : nextExecutionAssignment.currentStage === "rigMove" ? "Rig Move" : "Rig Up"}`
    : "All assigned tasks complete";
  const timeLeftLabel = formatMinutes(Math.max(0, Math.round(executionTimelineTotalMinutes - executionVisibleMinute)));
  const executionProjectedFinishMs = executionStartedAtMs != null
    ? executionStartedAtMs + (executionTimelineTotalMinutes * 60000)
    : null;
  const executionEtcLabel = executionProjectedFinishMs != null
    ? new Date(executionProjectedFinishMs).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })
    : "--";
  const isExecutionActive = executionState === "active";
  const isExecutionCompleted = executionState === "completed";
  const isPlanningStage = executionState === "planning";
  const isOperationsStage = executionState === "completed";
  const rigDownCompleted = Boolean(executionProgress?.rigDownCompleted);
  const rigMoveCompleted = Boolean(executionProgress?.rigMoveCompleted);
  const rigUpCompleted = Boolean(executionProgress?.rigUpCompleted);
  const trackingStatusLabel = activeTrackingMode === "demoUltrasonic"
    ? !hasStartedLiveMove
      ? "Waiting for driver to start moving"
      : !isOutboundSensorTracking
        ? "Return trip uses driver start/arrival states"
        : ultrasonicDemo.tripDirection === "return"
          ? (ultrasonicDemo.hasReading ? "Returning to source" : "Waiting for return reading")
        : ultrasonicDemo.arrived
            ? "Arrived at destination"
            : ultrasonicDemo.hasReading
              ? `${formatDistanceCm(ultrasonicDemo.latestCm)} remaining`
              : "Holding last valid reading"
    : executionProgress?.liveDataRequested
      ? "Waiting on driver app"
      : "Driver app not requested";
  const executionDetailRows = isPlanningStage
    ? []
    : [
        { key: "reserved", label: "Trucks Reserved", value: executionProgress?.trucksReserved ? "Yes" : "Pending" },
        { key: "manager", label: "Manager Notified", value: executionProgress?.managerNotified ? "Sent" : "Pending" },
        { key: "tracking-status", label: "Tracking Status", value: trackingStatusLabel },
        { key: "rigdown", label: "Rig Down", value: rigDownCompleted ? "Completed" : "Pending" },
        { key: "rigmove", label: "Rig Move", value: rigMoveCompleted ? "Completed" : "Pending" },
        { key: "rigup", label: "Rig Up", value: rigUpCompleted ? "Completed" : "Pending" },
      ];
  const executionAlerts = useMemo(() => {
    if (isPlanningStage) {
      return [];
    }

    const alerts = [];
    const stageKeys = ["rigDown", "rigMove", "rigUp"];
    const activeTripAssignment = (displayExecutionAssignments || []).find((assignment) => {
      if (assignment?.status !== "active" && assignment?.status !== "foreman") {
        return false;
      }

      const moveState = !assignment?.moveStartedAt
        ? "readyOutbound"
        : !assignment?.outboundArrivedAt
          ? "movingOutbound"
          : !assignment?.returnMoveStartedAt
            ? "readyReturn"
            : !assignment?.returnedToSourceAt
              ? "movingReturn"
              : "returned";

      return moveState === "movingOutbound" || moveState === "movingReturn";
    });

    if (activeTripAssignment) {
      const isReturnTrip = activeTripAssignment?.taskType === "return" || Boolean(activeTripAssignment?.returnMoveStartedAt);
      const linkedSourceAssignment = isReturnTrip
        ? (displayExecutionAssignments || []).find((assignment) =>
            String(assignment?.id) === String(activeTripAssignment?.linkedAssignmentId || activeTripAssignment?.returnForAssignmentId || ""),
          ) || null
        : null;
      const timingAssignment = linkedSourceAssignment || activeTripAssignment;
      const tripPlan = activeTripAssignment?.stagePlan?.rigMove || {};
      const plannedTripFinish = Number(tripPlan?.finishMinute);
      const tripTimeLeftMinutes = Math.max(0, plannedTripFinish - executionVisibleMinute);
      const tripLateMinutes = Math.max(0, executionVisibleMinute - plannedTripFinish);
      const tripDelayThresholdMinutes = getExecutionDelayThresholdMinutes(timingAssignment);
      const tripTone = tripLateMinutes > tripDelayThresholdMinutes ? "red" : tripLateMinutes > 0 ? "amber" : "blue";
      const tripIcon = tripLateMinutes > tripDelayThresholdMinutes ? "danger" : tripLateMinutes > 0 ? "warning" : "task";

      alerts.push({
        key: `execution-alert-trip-${activeTripAssignment?.id || "active"}`,
        order: 0,
        actionable: false,
        tone: tripTone,
        icon: tripIcon,
        title: isReturnTrip ? "Trip: Return to source" : "Trip: To destination",
        meta: activeTripAssignment?.driverName || activeTripAssignment?.simpleLoadLabel || "Active trip",
        copy: tripLateMinutes > tripDelayThresholdMinutes
          ? `${formatExecutionDelayAmount(tripLateMinutes, timingAssignment)} late.`
          : tripLateMinutes > 0
            ? `${formatExecutionDelayAmount(tripLateMinutes, timingAssignment)} late.`
            : `${formatExecutionTimeAmount(tripTimeLeftMinutes, timingAssignment)} left to finish this trip.`,
        detail: Number.isFinite(plannedTripFinish)
          ? `Planned finish ${formatExecutionTimeAmount(plannedTripFinish, timingAssignment)}`
          : "Live trip in progress",
      });
    }

    (displayExecutionAssignments || []).forEach((assignment, assignmentIndex) => {
      const currentStage = getExecutionAssignmentStage(assignment?.stageStatus || {});
      const isExecutionVisibleAssignment = assignment?.status === "active" || assignment?.status === "foreman";
      if (!isExecutionVisibleAssignment || currentStage === "completed") {
        return;
      }
      if (currentStage === "rigMove") {
        return;
      }

      const currentStageIndex = stageKeys.indexOf(currentStage);
      const stepNumber = ((assignment.sequence || (assignmentIndex + 1)) - 1) * 3 + Math.max(currentStageIndex, 0) + 1;
      const stagePlan = assignment?.stagePlan?.[currentStage];
      const plannedStart = Number(stagePlan?.startMinute);
      const plannedFinish = Number(stagePlan?.finishMinute);
      const loadLabel = assignment?.simpleLoadLabel || `Load ${assignmentIndex + 1}`;
      const timeLeftMinutes = Math.max(0, plannedFinish - executionVisibleMinute);
      const lateMinutes = Math.max(0, executionVisibleMinute - plannedFinish);
      const delayThresholdMinutes = getExecutionDelayThresholdMinutes(assignment);
      const tone = lateMinutes > delayThresholdMinutes ? "red" : lateMinutes > 0 ? "amber" : "blue";
      const icon = lateMinutes > delayThresholdMinutes ? "danger" : lateMinutes > 0 ? "warning" : "task";
      const isForemanActionableStage = currentStage === "rigDown" || currentStage === "rigUp";

      alerts.push({
        key: `execution-alert-${assignment?.id || `${loadLabel}-${currentStage}`}-${currentStage}`,
        order: stepNumber,
        assignmentId: assignment?.id || null,
        stage: currentStage,
        actionable: isForemanActionableStage,
        tone,
        icon,
        title: `Step ${stepNumber}: ${loadLabel} ${getExecutionStageTitle(currentStage)}`,
        meta: loadLabel,
        copy: lateMinutes > delayThresholdMinutes
          ? `${formatExecutionDelayAmount(lateMinutes, assignment)} late. Mark done when finished.`
          : lateMinutes > 0
            ? `${formatExecutionDelayAmount(lateMinutes, assignment)} late.`
            : `${formatExecutionTimeAmount(timeLeftMinutes, assignment)} left.`,
        detail: Number.isFinite(plannedFinish)
          ? `Planned finish ${formatExecutionTimeAmount(plannedFinish, assignment)}`
          : Number.isFinite(plannedStart)
            ? `Started ${formatExecutionTimeAmount(plannedStart, assignment)}`
            : "",
      });
    });

    return alerts
      .sort((left, right) => (left.order ?? 0) - (right.order ?? 0))
      .slice(0, 3);
  }, [displayExecutionAssignments, executionVisibleMinute, isPlanningStage]);
  const activeTripAlertState = useMemo(() => {
    if (isPlanningStage) {
      return null;
    }

    const activeTripAssignment = (displayExecutionAssignments || []).find((assignment) => {
      if (assignment?.status !== "active" && assignment?.status !== "foreman") {
        return false;
      }

      const moveState = !assignment?.moveStartedAt
        ? "readyOutbound"
        : !assignment?.outboundArrivedAt
          ? "movingOutbound"
          : !assignment?.returnMoveStartedAt
            ? "readyReturn"
            : !assignment?.returnedToSourceAt
              ? "movingReturn"
              : "returned";

      return moveState === "movingOutbound" || moveState === "movingReturn";
    });

    if (!activeTripAssignment) {
      return null;
    }

    const isReturnTrip = activeTripAssignment?.taskType === "return" || Boolean(activeTripAssignment?.returnMoveStartedAt);
    const linkedSourceAssignment = isReturnTrip
      ? (displayExecutionAssignments || []).find((assignment) =>
          String(assignment?.id) === String(activeTripAssignment?.linkedAssignmentId || activeTripAssignment?.returnForAssignmentId || ""),
        ) || null
      : null;
    const timingAssignment = linkedSourceAssignment || activeTripAssignment;
    const plannedTripFinish = Number(activeTripAssignment?.stagePlan?.rigMove?.finishMinute);
    const lateMinutes = Math.max(0, executionVisibleMinute - plannedTripFinish);
    const delayThresholdMinutes = getExecutionDelayThresholdMinutes(timingAssignment);

    return {
      assignmentId: activeTripAssignment.id || null,
      sourceAssignmentId: linkedSourceAssignment?.id || activeTripAssignment.id || null,
      linkedAssignmentId: activeTripAssignment.linkedAssignmentId || activeTripAssignment.returnForAssignmentId || null,
      loadId: activeTripAssignment.loadId ?? linkedSourceAssignment?.loadId ?? null,
      tone: lateMinutes > delayThresholdMinutes ? "red" : lateMinutes > 0 ? "amber" : "blue",
      lateMinutes,
      plannedFinishMinute: plannedTripFinish,
    };
  }, [displayExecutionAssignments, executionVisibleMinute, isPlanningStage]);

  function renderDelayAlertIcon(tone, icon = "task") {
    const stroke = tone === "red" ? "#fda4af" : tone === "blue" ? "#93c5fd" : "#fcd34d";
    if (icon === "danger") {
      return h(
        "svg",
        { viewBox: "0 0 24 24", className: "scene-delay-alert-icon", "aria-hidden": "true" },
        h("path", {
          d: "M12 7.75v4.5m0 3.25h.01M10.05 4.78l-6.2 10.74A1.5 1.5 0 0 0 5.15 17.75h13.7a1.5 1.5 0 0 0 1.3-2.23l-6.2-10.74a1.5 1.5 0 0 0-2.6 0Z",
          fill: "none",
          stroke,
          strokeWidth: "1.7",
          strokeLinecap: "round",
          strokeLinejoin: "round",
        }),
      );
    }
    if (icon === "task") {
      return h(
        "svg",
        { viewBox: "0 0 24 24", className: "scene-delay-alert-icon", "aria-hidden": "true" },
        h("path", {
          d: "M8 6.75h8M8 12h8M8 17.25h5M6.75 4.5h10.5A2.25 2.25 0 0 1 19.5 6.75v10.5a2.25 2.25 0 0 1-2.25 2.25H6.75A2.25 2.25 0 0 1 4.5 17.25V6.75A2.25 2.25 0 0 1 6.75 4.5Z",
          fill: "none",
          stroke,
          strokeWidth: "1.8",
          strokeLinecap: "round",
          strokeLinejoin: "round",
        }),
      );
    }
    if (icon === "warning") {
      return h(
        "svg",
        { viewBox: "0 0 24 24", className: "scene-delay-alert-icon", "aria-hidden": "true" },
        h("path", {
          d: "M12 7.75v4.5m0 3.25h.01M10.05 4.78l-6.2 10.74A1.5 1.5 0 0 0 5.15 17.75h13.7a1.5 1.5 0 0 0 1.3-2.23l-6.2-10.74a1.5 1.5 0 0 0-2.6 0Z",
          fill: "none",
          stroke,
          strokeWidth: "1.7",
          strokeLinecap: "round",
          strokeLinejoin: "round",
        }),
      );
    }
    return null;
  }
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
  const simulationOverlay = (isSimulating || isCalculatingCustomPlan)
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
        h("strong", { style: { fontSize: "1.15rem" } }, isCalculatingCustomPlan ? "Updating custom plan" : (simulationProgress?.message || "Building execution plan")),
          h("p", { className: "muted-copy", style: { margin: 0 } }, isCalculatingCustomPlan ? "Recalculating the strict planner as you change the truck mix." : (simulationProgress?.detail || "The planner is still running. Large fleet comparisons can take longer.")),
          h(ProgressBar, { value: isCalculatingCustomPlan ? 65 : progressPercent }),
          h(
            "div",
            { className: "scene-dashboard-pair" },
            h("div", { className: "scene-dashboard-inline scene-dashboard-pair-item" }, h("span", { className: "scene-dashboard-label" }, "Completed"), h("strong", null, isCalculatingCustomPlan ? "Custom preview" : progressStageLabel)),
            h("div", { className: "scene-dashboard-inline scene-dashboard-pair-item" }, h("span", { className: "scene-dashboard-label" }, "Elapsed"), h("strong", null, isCalculatingCustomPlan ? "Live" : progressElapsedLabel)),
          ),
          h(
            "div",
            { className: "scene-dashboard-pair" },
            h("div", { className: "scene-dashboard-inline scene-dashboard-pair-item" }, h("span", { className: "scene-dashboard-label" }, "Progress"), h("strong", null, `${isCalculatingCustomPlan ? 65 : progressPercent}%`)),
            h("div", { className: "scene-dashboard-inline scene-dashboard-pair-item" }, h("span", { className: "scene-dashboard-label" }, "Remaining"), h("strong", null, isCalculatingCustomPlan ? "Refreshing..." : progressRemainingLabel)),
          ),
        ),
      )
    : null;
  const operatingStatusLabel = operatingState === "drilling" ? "Drilling" : "Standby";
  const executionStatusLabel = isExecutionCompleted ? "Drilling" : isExecutionActive ? "Reserved and active" : "Planning only";
  const executionStatusRow = null;
  const executionStatusOverlayRow = null;
  const executionSummary = null;
  const delayAlertsPanel = !isPlanningStage
    ? h(
        "section",
        { className: "scene-panel-section scene-panel-section-plain scene-delay-alerts-panel" },
        h(
          "div",
          { className: "scene-delay-alerts-head" },
          h("strong", null, "Execution Alerts"),
          h("span", { className: "scene-delay-alerts-count" }, `${executionAlerts.length} active`),
        ),
        h(
          "div",
          { className: "scene-delay-alerts" },
          executionAlerts.map((alert) =>
            h(
              "article",
              { key: alert.key, className: `scene-delay-alert scene-delay-alert-${alert.tone}` },
              h(
                "div",
                { className: "scene-delay-alert-badge", "aria-hidden": "true" },
                renderDelayAlertIcon(alert.tone, alert.icon),
              ),
              h(
                "div",
                { className: "scene-delay-alert-body" },
                h("strong", null, alert.title),
                h(
                  "p",
                  null,
                  h("span", { className: "scene-delay-alert-meta" }, alert.meta),
                  h("span", null, alert.copy),
                ),
                alert.detail ? h("p", { className: "muted-copy" }, alert.detail) : null,
              ),
              alert.actionable
                ? h(
                    "button",
                    {
                      type: "button",
                      className: "scene-delay-alert-check",
                      "aria-label": `Mark ${alert.title} done`,
                      disabled: readOnly || typeof onCompleteAssignmentStage !== "function" || !alert.assignmentId || !alert.stage,
                      onClick: () => {
                        if (!alert.assignmentId || !alert.stage) {
                          return;
                        }
                        onCompleteAssignmentStage?.({
                          assignmentId: alert.assignmentId,
                          stage: alert.stage,
                        });
                      },
                    },
                    h("span", { className: "scene-delay-alert-check-box", "aria-hidden": "true" }),
                  )
                : null,
            ),
          ),
        ),
      )
    : null;
  const startExecutionSetup = null;
  const executionActions = null;
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
                playback: activePlayback,
                zoom: timelineZoom,
                criticalPathChain,
                criticalScheduleRows,
                plannerScheduleRows,
                plannerCostRows,
                operatingSnapshot,
                drillingReadinessPercent,
                activePlanDashboard,
                planRadarModel,
                scenarios: scenarioPlans,
                scenario: selectedScenario,
                move: safeMove,
                planningStartDate,
                planningStartTime,
                currentMinute: sceneMinute,
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
                simulation: sceneSimulation,
                currentMinute: sceneMinute,
                delayMinute: executionVisibleMinute,
                executionAssignments: displayExecutionAssignments,
                activeTripAlert: activeTripAlertState,
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
                  simulation: sceneSimulation,
                  currentMinute: sceneMinute,
                  delayMinute: executionVisibleMinute,
                  executionAssignments: displayExecutionAssignments,
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
                playback: timelinePlayback,
                currentMinute: executionState === "planning" ? visibleMinute : liveSceneMinute,
                zoom: timelineZoom,
              }),
        !isTimelineMode
          ? h(
          "div",
          { className: "scene-move-info" },
          h(
            "div",
            { className: "scene-move-info-grid" },
            h(
              "div",
              { className: "scene-dashboard-inline scene-dashboard-kpi-item" },
              h("span", { className: "scene-dashboard-label" }, "Sensor"),
              h(
                "strong",
                null,
                activeTrackingMode === "demoUltrasonic"
                  ? (ultrasonicDemo.hasReading ? formatDistanceCm(ultrasonicDemo.latestCm) : "--")
                  : "--",
              ),
            ),
            h(
              "div",
              { className: "scene-dashboard-inline scene-dashboard-kpi-item" },
              h("span", { className: "scene-dashboard-label" }, "Progress"),
              h(
                "strong",
                null,
                activeTrackingMode === "demoUltrasonic"
                  ? (ultrasonicDemo.hasReading ? `${ultrasonicDemo.progressPercent}%` : "--")
                  : "--",
              ),
            ),
            h("div", { className: "scene-dashboard-inline scene-dashboard-kpi-item scene-move-info-row-full" }, h("span", { className: "scene-dashboard-label" }, "From"), h("strong", null, formatLocationLabel(move.startLabel, "Source"))),
            h("div", { className: "scene-dashboard-inline scene-dashboard-kpi-item scene-move-info-row-full" }, h("span", { className: "scene-dashboard-label" }, "To"), h("strong", null, formatLocationLabel(move.endLabel, "Destination"))),
            h("div", { className: "scene-dashboard-inline scene-dashboard-kpi-item" }, h("span", { className: "scene-dashboard-label" }, "Distance"), h("strong", null, `${move.routeKm || 0} km`)),
            h("div", { className: "scene-dashboard-inline scene-dashboard-kpi-item" }, h("span", { className: "scene-dashboard-label" }, "Travel"), h("strong", null, move.routeTime || formatMinutes(move.simulation?.routeMinutes || 0))),
          ),
        )
          : null,
        !isTimelineMode
          ? h(
          "div",
          { className: "scene-bottom-controls" },
          isPlanningStage
            ? h(
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
              )
            : null,
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
          { className: `scene-panel scene-panel-left scene-panel-left-merged${isPlanningStage ? " scene-panel-left-merged-planning" : " scene-panel-left-merged-execution"}` },
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
                delayAlertsPanel,
                startExecutionSetup,
                simulationError || customPlanError ? h("p", { className: "field-error section-spacing" }, customPlanError || simulationError) : null,
                readOnlyBanner,
                !readOnly && isPlanningStage
                  ? h(
                      "div",
                      { className: "scene-panel-actions" },
                      h(PlaybackActionButton, {
                        isRunning: isPlaybackRunning,
                        isBusy: isSimulating || isCalculatingCustomPlan,
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
                        onClick: () => {
                          const startDistanceCm = Math.max(0, parseDistanceCm(ultrasonicStartInput) ?? 45);
                          const arrivalDistanceCm = Math.min(startDistanceCm, Math.max(0, parseDistanceCm(ultrasonicArrivalInput) ?? 8));
                          onStartExecution?.(move.id, {
                            trackingMode,
                            ultrasonicStartCm: startDistanceCm,
                            ultrasonicArrivalCm: arrivalDistanceCm,
                          });
                        },
                        children: "Start Execution",
                      }),
                    )
                  : executionActions,
              ]
            : [
                isPlanningStage
                  ? h(
                      "div",
                      { className: "scene-plan-summary-stack scene-passive-overlay" },
                      h(
                        "div",
                        { className: "scene-plan-summary-card scene-plan-summary-card-title" },
                        h("span", { className: "scene-panel-kicker" }, "Selected Plan"),
                        h("strong", { className: "scene-plan-summary-title" }, isCustomizeActive ? "Custom Plan" : activeScenario.name),
                      ),
                    )
                  : null,
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
                delayAlertsPanel,
                startExecutionSetup,
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
                        onClick: () => {
                          const startDistanceCm = Math.max(0, parseDistanceCm(ultrasonicStartInput) ?? 45);
                          const arrivalDistanceCm = Math.min(startDistanceCm, Math.max(0, parseDistanceCm(ultrasonicArrivalInput) ?? 8));
                          onStartExecution?.(move.id, {
                            trackingMode,
                            ultrasonicStartCm: startDistanceCm,
                            ultrasonicArrivalCm: arrivalDistanceCm,
                          });
                        },
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
                h("div", { className: "scene-dashboard-inline scene-dashboard-kpi-item" }, h("span", { className: "scene-dashboard-label" }, "ETC"), h("strong", null, executionEtcLabel)),
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
                h("div", { className: "scene-dashboard-inline scene-dashboard-kpi-item" }, h("span", { className: "scene-dashboard-label" }, "ETC"), h("strong", null, executionEtcLabel)),
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
                  h("div", { className: "scene-dashboard-inline scene-dashboard-pair-item" }, h("span", { className: "scene-dashboard-label" }, "Support Readiness"), h("strong", null, `${drillingReadinessPercent}%`)),
                ),
                h(
                  "div",
                  { className: "scene-dashboard-pair" },
                  h("div", { className: "scene-dashboard-inline scene-dashboard-pair-item" }, h("span", { className: "scene-dashboard-label" }, t("plannedTasks", "Planned Tasks")), h("strong", null, String(plannedTasksByNow))),
                  h("div", { className: "scene-dashboard-inline scene-dashboard-pair-item" }, h("span", { className: "scene-dashboard-label" }, "Missing Resources"), h("strong", null, String(operatingSnapshot.startupSummary.missingUnits))),
                ),
              ),
            )
          : !isTimelineMode ? h(
              "div",
              { className: "scene-top-info-strip" },
              h(
                "div",
                { className: "scene-plan-kpis" },
                h(
                  "div",
                  { className: "scene-plan-kpi-card" },
                  h("span", { className: "scene-dashboard-label" }, t("totalTime", "Total Time")),
                  h("strong", { className: "scene-plan-kpi-value" }, formatDaysHours(previewPlanCard?.totalMinutes || 0)),
                  h("span", { className: "scene-plan-kpi-meta" }, `${previewRoundTrips} round trips - ETA ${previewPlanEtaLabel}`),
                ),
                h(
                  "div",
                  { className: "scene-plan-kpi-card" },
                  h("span", { className: "scene-dashboard-label" }, "Total Cost"),
                  h("strong", { className: "scene-plan-kpi-value" }, formatCurrency(previewPlanCard?.totalCost || 0)),
                  h("span", { className: "scene-plan-kpi-meta" }, `${previewCostPerLoad} per load`),
                ),
                h(
                  "div",
                  { className: "scene-plan-kpi-card" },
                  h("span", { className: "scene-dashboard-label" }, "Utilization"),
                  h("strong", { className: "scene-plan-kpi-value" }, `${previewPlanCard?.utilization || 0}%`),
                  h("span", { className: "scene-plan-kpi-meta" }, `${previewTruckUsageLabel} trucks used`),
                ),
              ),
              h(
                "div",
                { className: "scene-plan-dashboard" },
                h(
                  "div",
                  { className: "scene-plan-summary-card scene-plan-summary-card-title" },
                  h("span", { className: "scene-panel-kicker" }, t("executionPlan", "Execution Plan")),
                  h("strong", { className: "scene-plan-summary-title" }, "Plan Comparison"),
                  h("p", { className: "scene-radar-subtitle" }, isCustomizeActive ? t("customExecutionPlan", "Custom Execution Plan") : t("planOverview", "Plan Overview")),
                ),
                h(PlanComparisonRadar, { model: planRadarModel }),
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
        (isPlaybackRunning || isPlaybackPaused || (!isTimelineMode && !isPlanningStage))
          ? h(MoveAssistant, {
              move,
              playback: activePlayback,
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
              delayAlertsPanel,
              simulationError ? h("p", { className: "field-error section-spacing" }, simulationError) : null,
              readOnlyBanner,
              !readOnly && isPlanningStage
                ? [
                    startExecutionSetup,
                    h(
                      "div",
                      { className: "move-setup-actions" },
                      h(PlaybackActionButton, {
                        isRunning: isPlaybackRunning,
                        isBusy: isSimulating || isCalculatingCustomPlan,
                        isPaused: isPlaybackPaused,
                        onRun: onRunPlayback,
                        onEnd: onEndPlayback,
                        onPauseToggle: onPausePlayback,
                        label: canResumePlayback ? "Resume Playback" : "Run Playback",
                      }),
                      h(Button, {
                        type: "button",
                        variant: "ghost",
                        onClick: () => {
                          const startDistanceCm = Math.max(0, parseDistanceCm(ultrasonicStartInput) ?? 45);
                          const arrivalDistanceCm = Math.min(startDistanceCm, Math.max(0, parseDistanceCm(ultrasonicArrivalInput) ?? 8));
                          onStartExecution?.(move.id, {
                            trackingMode,
                            ultrasonicStartCm: startDistanceCm,
                            ultrasonicArrivalCm: arrivalDistanceCm,
                          });
                        },
                        children: "Start Execution",
                      }),
                    ),
                  ]
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
                playback: activePlayback,
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
        (isPlaybackRunning || isPlaybackPaused || (!isTimelineMode && !isPlanningStage))
          ? h(MoveAssistant, {
              move,
              playback: activePlayback,
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

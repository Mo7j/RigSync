import { React, h } from "../lib/react.js";
import { AppLayout } from "../layouts/AppLayout.js";
import { Button } from "../components/ui/Button.js";
import { Card, StatCard } from "../components/ui/Card.js";
import { ProgressBar } from "../components/ui/ProgressBar.js";
import { Field, TextInput } from "../components/ui/Field.js";
import { Modal } from "../components/ui/Modal.js";
import { SimulationScene3D } from "../components/map/SimulationScene3D.js";
import { LeafletMap } from "../components/map/LeafletMap.js";
import { formatLocationLabel, formatMinutes } from "../lib/format.js";
import { buildScenarioPlans } from "../features/rigMoves/simulation.js";
import { persistMoveSession } from "../features/rigMoves/storage.js";

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

  return Array.from({ length: truckCount }, (_, index) => {
    const truckId = index + 1;
    let rowToneClass = "scene-timeline-segment-truck-heavyhaul";
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
        toneClass: getTruckToneClass(trip.truckType),
      }));

    if (truckTrips[0]?.toneClass) {
      rowToneClass = truckTrips[0].toneClass;
    }

    return {
      truckId,
      toneClass: rowToneClass,
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

function FullScreenTimeline({ playback, currentMinute, zoom = 1, rowType = "truck", gapMinutes = 8 * 60 }) {
  const headerScrollRef = useRef(null);
  const bodyScrollRef = useRef(null);
  const fixedBodyRef = useRef(null);
  const syncingHeaderRef = useRef(false);
  const syncingBodyRef = useRef(false);
  const [hoverCard, setHoverCard] = useState(null);
  const totalMinutes = Math.max(playback?.totalMinutes || 1, 1);
  const trips = playback?.trips || [];
  const buildMergedPhaseItems = (phaseKey, toneClass, getRange) => {
    const intervals = trips
      .map((trip, index) => {
        const [startMinute, endMinute] = getRange(trip);
        return {
          key: `${phaseKey}-${trip.truckId}-${trip.loadId}-${index}`,
          startMinute,
          endMinute,
        };
      })
      .filter((item) => item.endMinute > item.startMinute)
      .sort((a, b) => a.startMinute - b.startMinute);

    const merged = [];
    intervals.forEach((item) => {
      const previous = merged[merged.length - 1];
      if (previous && item.startMinute <= previous.endMinute) {
        previous.endMinute = Math.max(previous.endMinute, item.endMinute);
        return;
      }

      merged.push({ ...item });
    });

    return merged.map((item, index) => ({
      key: `${phaseKey}-merged-${index}`,
      loadId: phaseKey,
      startMinute: item.startMinute,
      endMinute: item.endMinute,
      left: (item.startMinute / totalMinutes) * 100,
      width: ((item.endMinute - item.startMinute) / totalMinutes) * 100,
      title: `${phaseKey} active | ${formatMinutes(Math.round(item.startMinute))} -> ${formatMinutes(Math.round(item.endMinute))}`,
      toneClass,
      label: `${formatTimelineClock(item.startMinute)} to ${formatTimelineClock(item.endMinute)}`,
    }));
  };
  const rows = rowType === "phase"
    ? [
        {
          key: "rig-down",
          label: "Rig Down",
          items: buildMergedPhaseItems("Rig Down", "scene-timeline-segment-down", (trip) => [trip.loadStart, trip.rigDownFinish]),
        },
        {
          key: "move",
          label: "Move",
          items: buildMergedPhaseItems("Move", "scene-timeline-segment-move", (trip) => [trip.rigDownFinish, trip.arrivalAtDestination]),
        },
        {
          key: "rig-up",
          label: "Rig Up",
          items: buildMergedPhaseItems("Rig Up", "scene-timeline-segment-up", (trip) => [trip.arrivalAtDestination, trip.rigUpFinish]),
        },
      ]
    : buildTruckScheduleRows(playback, Math.max(...trips.map((trip) => trip.truckId), 1));
  const tickStepMinutes = Math.max(30, gapMinutes);
  const tickCount = Math.max(1, Math.ceil(totalMinutes / tickStepMinutes));
  const ticks = Array.from({ length: tickCount + 1 }, (_, index) => {
    const minute = Math.min(totalMinutes, index * tickStepMinutes);
    return {
      key: `timeline-tick-${index}`,
      left: `${(minute / totalMinutes) * 100}%`,
      label: formatMinutes(minute),
    };
  });
  const currentX = `${(Math.min(currentMinute, totalMinutes) / totalMinutes) * 100}%`;
  const pixelsPerTick = 180;
  const timelineWidth = Math.max(Math.round(tickCount * pixelsPerTick * zoom), 1);

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
        h("span", null, rowType === "phase" ? "Phase" : "Truck"),
        h("strong", null, "Schedule"),
      ),
      h(
        "div",
        { ref: fixedBodyRef, className: "scene-timeline-fixed-body" },
        rows.map((row) =>
          h(
            "div",
            { key: `timeline-copy-${row.key || row.truckId}`, className: "scene-timeline-row-copy" },
            h("strong", null, rowType === "phase" ? row.label : `Truck ${row.truckId}`),
            h("span", null, rowType === "phase" ? `${row.items.length} active window${row.items.length === 1 ? "" : "s"}` : `${row.trips.length} loads in sequence`),
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
          h("div", { className: "scene-timeline-current-marker", style: { left: currentX } }),
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
              const tripStartMinute = rowType === "phase" ? trip.startMinute : trip.rigDownFinish;
              const tripEndMinute = rowType === "phase" ? trip.endMinute : trip.arrivalAtDestination;
              const tripWidthPercent = rowType === "phase"
                ? trip.width
                : (((trip.arrivalAtDestination - trip.rigDownFinish) / totalMinutes) * 100);
              const tripWidthPx = (tripWidthPercent / 100) * timelineWidth;
              const tripSizeClass = tripWidthPx < 72 ? " is-micro" : tripWidthPx < 132 ? " is-compact" : "";
              const visibleDuration = Math.max(0, Math.min(currentMinute, tripEndMinute) - tripStartMinute);
              const activeFillPercent = tripEndMinute > tripStartMinute
                ? Math.max(0, Math.min(100, (visibleDuration / (tripEndMinute - tripStartMinute)) * 100))
                : 0;
              const toneClass = rowType === "phase" ? trip.toneClass : (trip.toneClass || row.toneClass || "scene-timeline-segment-truck-heavyhaul");

              return h(
                "div",
                {
                  key: trip.key,
                  className: `scene-timeline-trip${rowType === "phase" ? " is-phase" : " is-truck"}${tripSizeClass}`,
                  style: {
                    left: `${rowType === "phase" ? trip.left : ((trip.rigDownFinish / totalMinutes) * 100)}%`,
                    width: `${tripWidthPercent}%`,
                  },
                  onPointerEnter: (event) =>
                    handleTripHover(
                      event,
                      `${rowType === "phase" ? row.label : trip.description} | ${formatTimelineClock(tripStartMinute)} -> ${formatTimelineClock(tripEndMinute)}`,
                    ),
                  onPointerMove: (event) =>
                    handleTripHover(
                      event,
                      `${rowType === "phase" ? row.label : trip.description} | ${formatTimelineClock(tripStartMinute)} -> ${formatTimelineClock(tripEndMinute)}`,
                    ),
                  onPointerLeave: () => setHoverCard(null),
                },
                h(
                  "div",
                  { className: "scene-timeline-trip-shell" },
                  h("span", {
                    className: `scene-timeline-segment scene-timeline-segment-future ${toneClass}`,
                    style: {
                      left: "0%",
                      width: "100%",
                    },
                  }),
                  h("span", {
                    className: `scene-timeline-segment scene-timeline-segment-active${activeFillPercent >= 99.5 ? " is-complete" : ""} ${toneClass}`,
                    style: {
                      left: "0%",
                      width: `${activeFillPercent}%`,
                    },
                  }),
                  h(
                    "span",
                    { className: "scene-timeline-trip-pill" },
                    rowType === "phase" ? row.label : `#${trip.loadId}`,
                  ),
                  h(
                    "span",
                    { className: "scene-timeline-trip-label" },
                    rowType === "phase"
                      ? trip.label
                      : `${formatTimelineClock(trip.rigDownFinish)} to ${formatTimelineClock(trip.arrivalAtDestination)}`,
                  ),
                ),
              );
            });

            return h(
              "article",
              { key: `timeline-row-${rowKey}`, className: "scene-timeline-row" },
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
      (trip) => [trip.loadStart, trip.rigDownFinish],
      (trip) => [trip.rigDownFinish, trip.arrivalAtDestination],
      (trip) => [trip.arrivalAtDestination, trip.rigUpFinish],
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

  return trips.reduce((sum, trip) => sum + Math.max(0, trip.arrivalAtDestination - trip.rigDownFinish), 0);
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

  if (currentMinute < trip.loadStart) {
    return "queued";
  }
  if (currentMinute < trip.rigDownFinish) {
    return "loading";
  }
  if (currentMinute < trip.arrivalAtDestination) {
    return "in-transit";
  }
  if (currentMinute < trip.rigUpFinish) {
    return "rig-up";
  }
  return "delivered";
}

function formatMinutePoint(value) {
  return formatMinutes(Math.max(0, Math.round(value || 0)));
}

function answerLoadLocation({ trip, currentMinute, move }) {
  const stage = getLoadStage(trip, currentMinute);
  const sourceLabel = formatLocationLabel(move?.startLabel, "source");
  const destinationLabel = formatLocationLabel(move?.endLabel, "destination");

  if (stage === "queued") {
    return `Load #${trip.loadId} is queued at ${sourceLabel}. Truck ${trip.truckId} is scheduled to start it at ${formatMinutePoint(trip.loadStart)}.`;
  }
  if (stage === "loading") {
    return `Load #${trip.loadId} is at ${sourceLabel} and currently loading on truck ${trip.truckId}. It should leave at ${formatMinutePoint(trip.rigDownFinish)}.`;
  }
  if (stage === "in-transit") {
    return `Load #${trip.loadId} is in transit on truck ${trip.truckId} between ${sourceLabel} and ${destinationLabel}. ETA is ${formatMinutePoint(trip.arrivalAtDestination)}.`;
  }
  if (stage === "rig-up") {
    return `Load #${trip.loadId} has reached ${destinationLabel} and is in rig-up on truck ${trip.truckId}. Rig-up should finish at ${formatMinutePoint(trip.rigUpFinish)}.`;
  }
  return `Load #${trip.loadId} has been delivered to ${destinationLabel}. Rig-up finished at ${formatMinutePoint(trip.rigUpFinish)}.`;
}

function answerLoadTiming({ trip, currentMinute }) {
  const stage = getLoadStage(trip, currentMinute);

  if (stage === "queued") {
    return `Load #${trip.loadId} starts at ${formatMinutePoint(trip.loadStart)}, departs at ${formatMinutePoint(trip.rigDownFinish)}, arrives at ${formatMinutePoint(trip.arrivalAtDestination)}, and finishes rig-up at ${formatMinutePoint(trip.rigUpFinish)}.`;
  }
  if (stage === "loading") {
    return `Load #${trip.loadId} is loading now. It should arrive in ${formatMinutePoint(trip.arrivalAtDestination - currentMinute)} at ${formatMinutePoint(trip.arrivalAtDestination)}.`;
  }
  if (stage === "in-transit") {
    return `Load #${trip.loadId} is already on the road. It should arrive in ${formatMinutePoint(trip.arrivalAtDestination - currentMinute)} at ${formatMinutePoint(trip.arrivalAtDestination)}.`;
  }
  if (stage === "rig-up") {
    return `Load #${trip.loadId} already arrived at ${formatMinutePoint(trip.arrivalAtDestination)}. Rig-up should complete in ${formatMinutePoint(trip.rigUpFinish - currentMinute)} at ${formatMinutePoint(trip.rigUpFinish)}.`;
  }
  return `Load #${trip.loadId} already arrived at ${formatMinutePoint(trip.arrivalAtDestination)} and finished at ${formatMinutePoint(trip.rigUpFinish)}.`;
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
      return `Truck ${truckId} is waiting at ${formatLocationLabel(move?.startLabel, "source")} and will start load #${nextTrip.loadId} at ${formatMinutePoint(nextTrip.loadStart)}.`;
    }

    const lastTrip = truckTrips[truckTrips.length - 1];
    return `Truck ${truckId} completed its last assigned load, #${lastTrip.loadId}.`;
  }

  return answerLoadLocation({ trip: activeTrip, currentMinute, move }).replace(`Load #${activeTrip.loadId}`, `Truck ${truckId} with load #${activeTrip.loadId}`);
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
      .map((trip) => `#${trip.loadId} on truck ${trip.truckId}`)
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
  onPlaybackSpeedChange,
  onSelectPlan,
  onRunPlayback,
  onRunCustomPlan,
  onPausePlayback,
  onEndPlayback,
  onDeleteMove,
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
  const [activeView, setActiveView] = useState(move?.activeView || "map");
  const [sceneMode, setSceneMode] = useState(move?.sceneMode || "3d");
  const [previousSceneMode, setPreviousSceneMode] = useState(
    move?.previousSceneMode || (move?.sceneMode === "2d" || move?.sceneMode === "3d" ? move.sceneMode : "3d"),
  );
  const [activeStageKey, setActiveStageKey] = useState("planning");
  const [timelineZoom, setTimelineZoom] = useState(move?.timelineZoom || 1);
  const [timelineRowType, setTimelineRowType] = useState(move?.timelineRowType || "truck");
  const [timelineGapMinutes, setTimelineGapMinutes] = useState(move?.timelineGapMinutes || 3 * 60);
  const [focusedRigSide, setFocusedRigSide] = useState(null);
  const [isSpeedDropdownOpen, setIsSpeedDropdownOpen] = useState(false);
  const [isDeleteConfirmOpen, setIsDeleteConfirmOpen] = useState(false);

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
    if (isNewMove) {
      setActiveView(move?.activeView || "map");
      setSceneMode(move?.sceneMode || "3d");
      setPreviousSceneMode(
        move?.previousSceneMode || (move?.sceneMode === "2d" || move?.sceneMode === "3d" ? move.sceneMode : "3d"),
      );
      setTimelineZoom(move?.timelineZoom || 1);
      setTimelineRowType(move?.timelineRowType || "truck");
      setTimelineGapMinutes(move?.timelineGapMinutes || 3 * 60);
      setIsSpeedDropdownOpen(false);
      setIsDeleteConfirmOpen(false);
    }
    setFocusedRigSide(null);
  }, [move?.id, move?.updatedAt]);

  useEffect(() => {
    if (!move?.id) {
      return;
    }

    persistMoveSession(move.id, {
      activeView,
      sceneMode,
      previousSceneMode,
      timelineZoom,
      timelineRowType,
      timelineGapMinutes,
    });
  }, [move?.id, activeView, sceneMode, previousSceneMode, timelineZoom, timelineRowType, timelineGapMinutes]);

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
    const previewPlans = buildScenarioPlans(logicalLoads, routeData, previewWorkerCount, deferredTotalTrucks, deferredTruckSetup);

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
        subtitle: `${formatLocationLabel(move.startLabel, "Source")} -> ${formatLocationLabel(move.endLabel, "Destination")}`,
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
  const timelineRowsCount = timelineRowType === "phase" ? 3 : effectiveTruckCount;
  const timelineWorkingMinutes = getTimelineWorkingMinutes(displaySimulation.bestPlan.playback, timelineRowType);
  const timelineWorkingMinutesPerTruck = Math.round(
    getTimelineWorkingMinutes(displaySimulation.bestPlan.playback, "truck") / Math.max(effectiveTruckCount, 1),
  );
  const timelineUtilizationPercent = Math.min(
    100,
    Math.round((timelineWorkingMinutes / Math.max(timelineRowsCount * totalMinutes, 1)) * 100),
  );

  const pageContent = activeView === "map"
    ? h(
        "main",
        { className: "scene-only-shell" },
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
                h(
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
                ),
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
                      key: "tracking",
                      label: "Tracking",
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
                      key: "analysing",
                      label: "Analysing",
                      icon: h(
                        "svg",
                        { className: "scene-stage-icon", viewBox: "0 0 16 16", "aria-hidden": "true" },
                        h("path", {
                          d: "M 4 11.5 L 6.3 8.6 L 8 9.8 L 11.5 5.8",
                          fill: "none",
                          stroke: "currentColor",
                          "stroke-width": "1.8",
                          "stroke-linecap": "round",
                          "stroke-linejoin": "round",
                        }),
                        h("path", {
                          d: "M 4 4.5 V 11.5 H 12",
                          fill: "none",
                          stroke: "currentColor",
                          "stroke-width": "1.5",
                          "stroke-linecap": "round",
                          "stroke-linejoin": "round",
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
                onClick: () => handleSceneModeChange(previousSceneMode || "3d"),
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
              h(FullScreenTimeline, {
                playback: displaySimulation.bestPlan.playback,
                currentMinute: visibleMinute,
                zoom: timelineZoom,
                rowType: timelineRowType,
                gapMinutes: timelineGapMinutes,
              }),
              h(
                "aside",
                { className: "scene-timeline-sidebar" },
                h(
                  Card,
                  { className: "scene-timeline-sidebar-card" },
                  h(
                    "div",
                    { className: "scene-timeline-sidebar-section" },
                    h("span", { className: "scene-panel-kicker" }, "Stats"),
                    timelineRowType === "phase"
                      ? [
                          h("div", { className: "scene-dashboard-inline scene-dashboard-kpi-item" }, h("span", { className: "scene-dashboard-label" }, "Completion"), h("strong", null, `${completion}%`)),
                          h("div", { className: "scene-dashboard-inline scene-dashboard-kpi-item" }, h("span", { className: "scene-dashboard-label" }, "Current Time"), h("strong", null, formatMinutes(Math.round(visibleMinute)))),
                          h("div", { className: "scene-dashboard-inline scene-dashboard-kpi-item" }, h("span", { className: "scene-dashboard-label" }, "Time Left"), h("strong", null, formatMinutes(Math.max(0, Math.round(totalMinutes - visibleMinute))))),
                          h("div", { className: "scene-dashboard-inline scene-dashboard-kpi-item" }, h("span", { className: "scene-dashboard-label" }, "Phase Rows"), h("strong", null, "3")),
                          h("div", { className: "scene-dashboard-inline scene-dashboard-kpi-item" }, h("span", { className: "scene-dashboard-label" }, "Gap"), h("strong", null, `${timelineGapMinutes / 60}h`)),
                          h("div", { className: "scene-dashboard-inline scene-dashboard-kpi-item" }, h("span", { className: "scene-dashboard-label" }, "Loads"), h("strong", null, String(activePlanSummary.totalLoads))),
                          h("div", { className: "scene-dashboard-inline scene-dashboard-kpi-item" }, h("span", { className: "scene-dashboard-label" }, "At Source"), h("strong", null, String(rigLoads.sourceCount))),
                          h("div", { className: "scene-dashboard-inline scene-dashboard-kpi-item" }, h("span", { className: "scene-dashboard-label" }, "Rig Down"), h("strong", null, `${Math.round(phases.down)}%`)),
                          h("div", { className: "scene-dashboard-inline scene-dashboard-kpi-item" }, h("span", { className: "scene-dashboard-label" }, "Move"), h("strong", null, `${Math.round(phases.move)}%`)),
                          h("div", { className: "scene-dashboard-inline scene-dashboard-kpi-item" }, h("span", { className: "scene-dashboard-label" }, "Rig Up"), h("strong", null, `${Math.round(phases.up)}%`)),
                          h("div", { className: "scene-dashboard-inline scene-dashboard-kpi-item" }, h("span", { className: "scene-dashboard-label" }, "Round Trips"), h("strong", null, String(activePlanSummary.roundTrips))),
                          h("div", { className: "scene-dashboard-inline scene-dashboard-kpi-item" }, h("span", { className: "scene-dashboard-label" }, "Total Time"), h("strong", null, formatMinutes(activePlanSummary.totalMinutes))),
                          h("div", { className: "scene-dashboard-inline scene-dashboard-kpi-item" }, h("span", { className: "scene-dashboard-label" }, "Phase Utilization"), h("strong", null, `${timelineUtilizationPercent}%`)),
                        ]
                      : [
                          h("div", { className: "scene-dashboard-inline scene-dashboard-kpi-item" }, h("span", { className: "scene-dashboard-label" }, "Completion"), h("strong", null, `${completion}%`)),
                          h("div", { className: "scene-dashboard-inline scene-dashboard-kpi-item" }, h("span", { className: "scene-dashboard-label" }, "Current Time"), h("strong", null, formatMinutes(Math.round(visibleMinute)))),
                          h("div", { className: "scene-dashboard-inline scene-dashboard-kpi-item" }, h("span", { className: "scene-dashboard-label" }, "Time Left"), h("strong", null, formatMinutes(Math.max(0, Math.round(totalMinutes - visibleMinute))))),
                          h("div", { className: "scene-dashboard-inline scene-dashboard-kpi-item" }, h("span", { className: "scene-dashboard-label" }, "Rows"), h("strong", null, String(timelineRowsCount))),
                          h("div", { className: "scene-dashboard-inline scene-dashboard-kpi-item" }, h("span", { className: "scene-dashboard-label" }, "Row Mode"), h("strong", null, "Truck")),
                          h("div", { className: "scene-dashboard-inline scene-dashboard-kpi-item" }, h("span", { className: "scene-dashboard-label" }, "Gap"), h("strong", null, `${timelineGapMinutes / 60}h`)),
                          h("div", { className: "scene-dashboard-inline scene-dashboard-kpi-item" }, h("span", { className: "scene-dashboard-label" }, "Loads"), h("strong", null, String(activePlanSummary.totalLoads))),
                          h("div", { className: "scene-dashboard-inline scene-dashboard-kpi-item" }, h("span", { className: "scene-dashboard-label" }, "Moving Now"), h("strong", null, String(rigLoads.movingCount))),
                          h("div", { className: "scene-dashboard-inline scene-dashboard-kpi-item" }, h("span", { className: "scene-dashboard-label" }, "Completed"), h("strong", null, String(rigLoads.destinationCount))),
                          h("div", { className: "scene-dashboard-inline scene-dashboard-kpi-item" }, h("span", { className: "scene-dashboard-label" }, "Round Trips"), h("strong", null, String(activePlanSummary.roundTrips))),
                          h("div", { className: "scene-dashboard-inline scene-dashboard-kpi-item" }, h("span", { className: "scene-dashboard-label" }, "Total Time"), h("strong", null, formatMinutes(activePlanSummary.totalMinutes))),
                          h("div", { className: "scene-dashboard-inline scene-dashboard-kpi-item" }, h("span", { className: "scene-dashboard-label" }, "Avg / Truck"), h("strong", null, formatMinutes(timelineWorkingMinutesPerTruck))),
                          h("div", { className: "scene-dashboard-inline scene-dashboard-kpi-item" }, h("span", { className: "scene-dashboard-label" }, "Utilization"), h("strong", null, `${timelineUtilizationPercent}%`)),
                        ],
                  ),
                  h(
                    "div",
                    { className: "scene-timeline-sidebar-section" },
                    h("span", { className: "scene-panel-kicker" }, "Controls"),
                    h(
                      "div",
                      { className: "scene-timeline-control-row" },
                      h(
                        "div",
                        { className: "scene-timeline-zoom-controls" },
                        h(
                          "button",
                          {
                            type: "button",
                            className: "scene-dimension-toggle",
                            disabled: timelineZoom <= 1,
                            onClick: () => setTimelineZoom((current) => Math.max(1, current / 2)),
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
                            onClick: () => setTimelineZoom((current) => Math.min(8, current * 2)),
                          },
                          "+",
                        ),
                      ),
                      h(
                        "div",
                        { className: "scene-speed-button-wrap" },
                        h(
                          "button",
                          {
                            type: "button",
                            className: "scene-speed-button",
                            onClick: () => {
                              const nextOption = playbackSpeedOptions[(activePlaybackSpeedIndex + 1) % playbackSpeedOptions.length];
                              onPlaybackSpeedChange?.(Number(nextOption.value));
                            },
                          },
                          h("span", null, `Speed ${activePlaybackSpeedOption.label}`),
                        ),
                      ),
                    ),
                    h(
                      "div",
                      { className: "scene-timeline-control-row" },
                      h(
                        "div",
                        { className: "scene-timeline-compact-switcher" },
                        timelineGapOptions.map((option) =>
                          h(
                            "button",
                            {
                              key: `timeline-gap-${option.value}`,
                              type: "button",
                              className: `scene-dimension-toggle${timelineGapMinutes === option.value ? " is-active" : ""}`,
                              onClick: () => setTimelineGapMinutes(option.value),
                            },
                            option.label,
                          ),
                        ),
                      ),
                    ),
                    h(
                      "div",
                      { className: "scene-timeline-type-controls" },
                      h(
                        "div",
                        { className: "scene-timeline-compact-switcher" },
                        ["truck", "phase"].map((type) =>
                          h(
                            "button",
                            {
                              key: `timeline-row-type-${type}`,
                              type: "button",
                              className: `scene-dimension-toggle${timelineRowType === type ? " is-active" : ""}`,
                              onClick: () => setTimelineRowType(type),
                            },
                            type === "truck" ? "Truck" : "Phase",
                          ),
                        ),
                      ),
                    ),
                  ),
                  h(
                    "div",
                    { className: "scene-timeline-sidebar-section scene-timeline-sidebar-actions" },
                    simulationError ? h("p", { className: "field-error" }, simulationError) : null,
                    h(PlaybackActionButton, {
                      isRunning: isPlaybackRunning,
                      isBusy: false,
                      isPaused: isPlaybackPaused,
                      onRun: canResumePlayback ? onRunPlayback : onRunPlayback,
                      onEnd: onEndPlayback,
                      onPauseToggle: onPausePlayback,
                      label: canResumePlayback ? "Resume" : "Run",
                    }),
                  ),
                ),
              ),
            )
          : sceneMode === "3d"
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
          : sceneMode === "2d"
            ? h(LeafletMap, {
                startPoint: move.startPoint,
                endPoint: move.endPoint,
                simulation: displaySimulation,
                currentMinute: visibleMinute,
                heightClass: "scene-only-canvas",
              })
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
        !isTimelineMode
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
                    onClick: () => setTimelineZoom((current) => Math.max(1, current / 2)),
                  },
                  "-",
                ),
                h("span", { className: "scene-timeline-zoom-label" }, `${timelineZoom}x`),
                h(
                  "button",
                  {
                    type: "button",
                    className: "scene-dimension-toggle",
                    onClick: () => setTimelineZoom((current) => Math.min(8, current * 2)),
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
                  { className: "scene-plan-summary-stack scene-passive-overlay" },
                  h(
                    "div",
                    { className: "scene-plan-summary-card scene-plan-summary-card-title" },
                    h("span", { className: "scene-panel-kicker" }, "Selected Plan"),
                    h("strong", { className: "scene-plan-summary-title" }, `${isCustomizeActive ? "Customize" : activeScenario.name} | ${effectiveTruckCount} Trucks`),
                  ),
                ),
                h(
                  "section",
                  { className: "scene-panel-section scene-panel-section-plain scene-passive-overlay" },
                  displayedTruckCounts.map((truck) =>
                    h(
                      "div",
                      { key: truck.id, className: "truck-count-row scene-passive-overlay" },
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
        )
          : null,
        !isTimelineMode && focusedRigStats
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
          : !isTimelineMode && (isPlaybackRunning || isPlaybackPaused)
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
          : !isTimelineMode ? h(
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
            ) : null,
        !isTimelineMode && !isPlaybackRunning && !isPlaybackPaused
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
    isDeleteConfirmOpen
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

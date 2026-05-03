import { React, h } from "../lib/react.js";
import { AppLayout } from "../layouts/AppLayout.js";
import { Button } from "../components/ui/Button.js";
import { Card } from "../components/ui/Card.js";
import { Modal } from "../components/ui/Modal.js";
import { ProgressBar } from "../components/ui/ProgressBar.js";
import { LeafletMap } from "../components/map/LeafletMap.js";
import { ManagerRigsMap } from "../components/map/ManagerRigsMap.js";
import { ManagerRigsScene3D } from "../components/map/ManagerRigsScene3D.js";
import { formatCoordinate, formatDate, formatLocationLabel } from "../lib/format.js";
import { buildFleetAvailability } from "../features/resources/storage.js";
import { fetchLocationLabel } from "../features/rigMoves/api.js";
import { translate } from "../lib/language.js";
import { navigateTo } from "../lib/router.js";

const { useMemo, useRef, useState } = React;

const DRIVER_TRUCK_TYPE_OPTIONS = ["Heavy Hauler", "Flat-bed", "Low-bed"];

function getMoveStatus(move) {
  if (move?.operatingState === "drilling") {
    return "Drilling";
  }
  if (move?.executionState === "active") {
    return "Executing";
  }
  return "Planning";
}

function getManagerStats(moves) {
  const totalMoves = moves.length;
  const activeMoves = moves.filter((move) => move?.executionState === "active").length;
  const drillingMoves = moves.filter((move) => move?.operatingState === "drilling").length;
  const planningMoves = moves.filter((move) => getMoveStatus(move) === "Planning").length;
  const totalLoads = moves.reduce((sum, move) => sum + (move.loadCount || 0), 0);

  return {
    totalMoves,
    activeMoves,
    drillingMoves,
    planningMoves,
    totalLoads,
  };
}

function normalizeTypeKey(type) {
  return String(type || "").trim().toLowerCase().replace(/[^a-z]/g, "");
}

function getTypePrefix(type) {
  const normalizedType = normalizeTypeKey(type);
  if (normalizedType.includes("heavy")) {
    return "HH";
  }
  if (normalizedType.includes("flat")) {
    return "FB";
  }
  if (normalizedType.includes("low")) {
    return "LB";
  }
  return "TR";
}

function buildTypeAllocationMap(fleetAvailability) {
  return (fleetAvailability || []).reduce((map, item) => {
    map.set(normalizeTypeKey(item.type), Math.max(0, Number.parseInt(item.allocated, 10) || 0));
    return map;
  }, new Map());
}

function annotateTrucks(trucks, fleetAvailability) {
  const remainingAssigned = buildTypeAllocationMap(fleetAvailability);

  return (trucks || []).map((truck) => {
    const key = normalizeTypeKey(truck.type);
    const assignedLeft = remainingAssigned.get(key) || 0;
    const isAssigned = assignedLeft > 0;
    if (isAssigned) {
      remainingAssigned.set(key, assignedLeft - 1);
    }

    return {
      ...truck,
      status: isAssigned ? "Assigned" : "Available",
    };
  });
}

function annotateDrivers(drivers, trucks) {
  const truckById = new Map((trucks || []).map((truck) => [truck.id, truck]));
  const assignedByType = new Map();

  (trucks || []).forEach((truck) => {
    if (truck.status === "Assigned") {
      const key = normalizeTypeKey(truck.type);
      assignedByType.set(key, (assignedByType.get(key) || 0) + 1);
    }
  });

  return (drivers || []).map((driver) => {
    const linkedTruck = driver.truckId ? truckById.get(driver.truckId) : null;
    const typeKey = normalizeTypeKey(driver.truckType || linkedTruck?.type);
    const assignedLeft = assignedByType.get(typeKey) || 0;
    const isAssigned = linkedTruck ? linkedTruck.status === "Assigned" : assignedLeft > 0;

    if (!linkedTruck && isAssigned) {
      assignedByType.set(typeKey, assignedLeft - 1);
    }

    return {
      ...driver,
      linkedTruck,
      status: isAssigned ? "Assigned" : "Available",
    };
  });
}

function getExecutionTaskSummary(moves) {
  const totals = { rigDown: 0, move: 0, rigUp: 0, completed: 0 };

  (moves || []).forEach((move) => {
    if (move.executionState !== "active" && move.executionState !== "completed") {
      return;
    }

    totals.rigDown += 1;
    totals.move += 1;
    totals.rigUp += 1;

    const executionProgress = move.executionProgress || {};
    if (executionProgress.rigDownCompleted) {
      totals.completed += 1;
    }
    if (executionProgress.rigMoveCompleted || move.executionState === "completed") {
      totals.completed += 1;
    }
    if (executionProgress.rigUpCompleted || move.executionState === "completed") {
      totals.completed += 1;
    }
  });

  return totals;
}

function formatSceneStatus(move) {
  if (!move) {
    return "Idle";
  }
  if (move?.operatingState === "drilling") {
    return "Drilling";
  }
  if (move?.executionState === "completed") {
    return "Completed";
  }
  if (move?.executionState === "active") {
    return "Transferring";
  }
  return "Planning";
}

function getLatestForemanMove(moves, foremanId) {
  return [...(moves || [])]
    .filter((move) => move?.createdBy?.id === foremanId)
    .sort((left, right) => new Date(right.updatedAt || right.createdAt || 0) - new Date(left.updatedAt || left.createdAt || 0))[0] || null;
}

function buildTruckAssignments(trucks, moves) {
  const enrichedTrucks = (trucks || []).map((truck) => ({
    ...truck,
    assignedMove: null,
    assignedForeman: null,
    destinationLabel: "",
    assignmentEta: "--",
    assignmentProgress: 0,
  }));
  const indicesByType = new Map();

  enrichedTrucks.forEach((truck, index) => {
    const key = normalizeTypeKey(truck.type);
    if (!indicesByType.has(key)) {
      indicesByType.set(key, []);
    }
    indicesByType.get(key).push(index);
  });

  (moves || [])
    .filter((move) => move?.executionState === "active")
    .forEach((move) => {
      const truckSetup = move.truckSetup?.length ? move.truckSetup : move.simulation?.truckSetup || [];
      truckSetup.forEach((entry) => {
        const typeKey = normalizeTypeKey(entry.type);
        const queue = indicesByType.get(typeKey) || [];
        const count = Math.max(0, Number.parseInt(entry.count, 10) || 0);

        for (let index = 0; index < count; index += 1) {
          const truckIndex = queue.shift();
          if (truckIndex == null) {
            break;
          }
          const currentTruck = enrichedTrucks[truckIndex];
          enrichedTrucks[truckIndex] = {
            ...currentTruck,
            status: "Assigned",
            assignedMove: move.name,
            assignedForeman: move.createdBy?.name || "Foreman",
            destinationLabel: formatLocationLabel(move.endLabel, "Destination"),
            assignmentEta: move.eta || "--",
            assignmentProgress: Math.round(move.completionPercentage || 0),
          };
        }
      });
    });

  return enrichedTrucks;
}

function buildReportPlan(moves) {
  const activeMoves = (moves || []).filter((move) => move?.executionState === "active");
  const completedMoves = (moves || []).filter((move) => move?.executionState === "completed");

  return {
    activeMoves: activeMoves.length,
    expectedPerDay: activeMoves.length * 4,
    expectedShiftReports: activeMoves.length * 2,
    finalReportsPending: activeMoves.length,
    finalReportsCompleted: completedMoves.length,
  };
}

function getMoveStageItems(move) {
  const progress = move?.executionProgress || {};
  return [
    { key: "rigDown", label: "Rig Down", done: Boolean(progress.rigDownCompleted) },
    { key: "move", label: "Move", done: Boolean(progress.rigMoveCompleted) || move?.executionState === "completed" },
    { key: "rigUp", label: "Rig Up", done: Boolean(progress.rigUpCompleted) || move?.executionState === "completed" },
  ];
}

function getMoveStagePercent(move) {
  const doneCount = getMoveStageItems(move).filter((item) => item.done).length;
  return Math.round((doneCount / 3) * 100);
}

function getMoveDelayMinutes(taskAssignments, moveId) {
  return (taskAssignments || [])
    .filter((assignment) => assignment.moveId === moveId)
    .reduce((sum, assignment) => {
      const notes = assignment.stageDelayNotes || {};
      return sum
        + (Number(notes.rigDown?.lateMinutes) || 0)
        + (Number(notes.rigMove?.lateMinutes) || 0)
        + (Number(notes.rigUp?.lateMinutes) || 0);
    }, 0);
}

function ManagerIcon({ name }) {
  const baseProps = {
    className: "manager-nav-icon-svg",
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: "1.8",
    strokeLinecap: "round",
    strokeLinejoin: "round",
    "aria-hidden": "true",
  };

  if (name === "dashboard") {
    return h(
      "svg",
      baseProps,
      h("rect", { x: "3", y: "3", width: "7", height: "7", rx: "2" }),
      h("rect", { x: "14", y: "3", width: "7", height: "7", rx: "2" }),
      h("rect", { x: "3", y: "14", width: "7", height: "7", rx: "2" }),
      h("rect", { x: "14", y: "14", width: "7", height: "7", rx: "2" }),
    );
  }

  if (name === "trucks") {
    return h(
      "svg",
      baseProps,
      h("path", { d: "M3 8h11v7H3z" }),
      h("path", { d: "M14 11h3l2 2v2h-5z" }),
      h("circle", { cx: "7.5", cy: "17.5", r: "1.5" }),
      h("circle", { cx: "17.5", cy: "17.5", r: "1.5" }),
    );
  }

  if (name === "foremen") {
    return h(
      "svg",
      baseProps,
      h("circle", { cx: "9", cy: "8", r: "3" }),
      h("path", { d: "M4.5 18c.8-2.5 2.7-4 4.5-4s3.7 1.5 4.5 4" }),
      h("circle", { cx: "17", cy: "9", r: "2.5" }),
      h("path", { d: "M14.5 18c.4-1.6 1.6-2.8 3.5-3" }),
    );
  }

  return h(
    "svg",
    baseProps,
    h("path", { d: "M7 4h10" }),
    h("path", { d: "M7 9h10" }),
    h("path", { d: "M7 14h10" }),
    h("path", { d: "M7 19h6" }),
    h("rect", { x: "4", y: "3", width: "16", height: "18", rx: "3" }),
  );
}

function MetricStrip({ items, className = "" }) {
  return h(
    "div",
    { className: `manager-metric-strip${className ? ` ${className}` : ""}` },
    items.map((item) =>
      h(
        "article",
        { key: item.label, className: "manager-metric-card" },
        h("span", { className: "manager-metric-label" }, item.label),
        h("strong", { className: "manager-metric-value" }, item.value),
        h("span", { className: "manager-metric-meta" }, item.meta),
      ),
    ),
  );
}

function getFleetMixValue(item) {
  return Math.max(0, Number(item?.value) || 0);
}

function getFleetMixPoints(items = []) {
  if (!items.length) {
    return [];
  }

  const chartWidth = 240;
  const chartHeight = 120;
  const paddingX = 18;
  const paddingY = 14;
  const maxValue = Math.max(...items.map((item) => getFleetMixValue(item)), 1);
  const usableWidth = chartWidth - paddingX * 2;
  const usableHeight = chartHeight - paddingY * 2;

  return items.map((item, index) => ({
    x: paddingX + (items.length === 1 ? usableWidth / 2 : (usableWidth * index) / (items.length - 1)),
    y: chartHeight - paddingY - (getFleetMixValue(item) / maxValue) * usableHeight,
  }));
}

function buildSmoothPath(points = []) {
  if (!points.length) {
    return "";
  }
  if (points.length === 1) {
    return `M ${points[0].x} ${points[0].y}`;
  }

  let path = `M ${points[0].x} ${points[0].y}`;
  for (let index = 0; index < points.length - 1; index += 1) {
    const current = points[index];
    const next = points[index + 1];
    const midX = (current.x + next.x) / 2;
    const midY = (current.y + next.y) / 2;
    path += ` Q ${current.x} ${current.y} ${midX} ${midY}`;
  }
  const last = points[points.length - 1];
  path += ` T ${last.x} ${last.y}`;
  return path;
}

function getInitials(name) {
  const parts = String(name || "").trim().split(/\s+/).filter(Boolean);
  if (!parts.length) {
    return "FM";
  }
  return parts.slice(0, 2).map((part) => part[0]?.toUpperCase() || "").join("");
}

function buildFleetMixLinePath(items = []) {
  return buildSmoothPath(getFleetMixPoints(items));
}

function buildFleetMixAreaPath(items = []) {
  if (!items.length) {
    return "";
  }

  const points = getFleetMixPoints(items);
  const linePath = buildSmoothPath(points);
  const chartHeight = 120;
  const bottomY = chartHeight - 14;
  const first = points[0];
  const last = points[points.length - 1];
  return `${linePath} L ${last.x} ${bottomY} L ${first.x} ${bottomY} Z`;
}

export function ManagerDashboardPage({
  currentUser,
  currentDate,
  moves,
  foremen,
  managerResources,
  managerFleet,
  dashboardError,
  onOpenMove,
  onCreateTruck,
  onCreateForeman,
  onUpdateForeman,
  onDeleteForeman,
  onSaveResources,
  onLogout,
  language = "en",
  onToggleLanguage,
}) {
  const t = (key, fallback) => translate(language, key, fallback);
  const [activeSection, setActiveSection] = useState("dashboard");
  const [showForemanForm, setShowForemanForm] = useState(false);
  const [isTruckModalOpen, setIsTruckModalOpen] = useState(false);
  const [isForemanLocationPickerOpen, setIsForemanLocationPickerOpen] = useState(false);
  const [isMapOpen, setIsMapOpen] = useState(false);
  const [viewAllMode, setViewAllMode] = useState("3d");
  const [selectedRigId, setSelectedRigId] = useState(null);
  const [activePulseMoveId, setActivePulseMoveId] = useState(null);
  const [hoveredFleetMixMoveId, setHoveredFleetMixMoveId] = useState(null);
  const [editingForemanId, setEditingForemanId] = useState(null);
  const [foremanDraft, setForemanDraft] = useState({
    name: "",
    email: "",
    password: "",
    rigName: "",
    startLabel: "",
    latitude: "",
    longitude: "",
  });
  const [truckDraft, setTruckDraft] = useState({
    name: "",
    type: "Heavy Hauler",
    driverName: "",
    driverEmail: "",
    driverPassword: "",
  });
  const [truckFilter, setTruckFilter] = useState({
    query: "",
    status: "all",
    type: "all",
  });
  const foremanLocationLookupRequestRef = useRef(0);

  const stats = getManagerStats(moves);
  const fleetAvailability = useMemo(
    () => buildFleetAvailability({ managerFleet, moves }),
    [managerFleet, moves],
  );
  const trucks = useMemo(
    () => annotateTrucks(managerResources?.trucks || [], fleetAvailability),
    [managerResources?.trucks, fleetAvailability],
  );
  const drivers = useMemo(
    () => annotateDrivers(managerResources?.drivers || [], trucks),
    [managerResources?.drivers, trucks],
  );
  const truckAssignments = useMemo(
    () => buildTruckAssignments(trucks, moves),
    [trucks, moves],
  );
  const activeMoves = moves.filter((move) => move?.executionState === "active");
  const fleetAssigned = trucks.filter((truck) => truck.status === "Assigned").length;
  const fleetFree = trucks.length - fleetAssigned;
  const driversAssigned = drivers.filter((driver) => driver.status === "Assigned").length;
  const taskSummary = getExecutionTaskSummary(moves);
  const activeForemen = foremen.filter((foreman) => moves.some((move) => move.createdBy?.id === foreman.id && move.executionState === "active")).length;
  const truckTypeOptions = [...new Set([...(managerFleet || []).map((truck) => truck.type), ...DRIVER_TRUCK_TYPE_OPTIONS])];

  const summaryCards = [
    { label: "Drilling Rigs", value: String(stats.drillingMoves), meta: "Operating", tone: "green" },
    { label: "Moving Rigs", value: String(stats.activeMoves), meta: "Executing", tone: "default" },
    { label: "Planning Rigs", value: String(stats.planningMoves), meta: "Queued", tone: "default" },
    { label: "Assigned Trucks", value: String(fleetAssigned), meta: "On active moves", tone: "default" },
    { label: "Trucks Available", value: String(Math.max(fleetFree, 0)), meta: `${trucks.length} total trucks`, tone: "default" },
  ];

  const rigMapItems = useMemo(
    () =>
      (foremen || [])
        .map((foreman) => {
          const latestMove = getLatestForemanMove(moves, foreman.id);
          const assignedRig = foreman.assignedRig || null;
          const fallbackPoint = assignedRig?.startPoint || null;
          const fallbackLabel = formatLocationLabel(assignedRig?.startLabel, "Current site");

          return {
            id: assignedRig?.id || latestMove?.id || foreman.id,
            foremanId: foreman.id,
            moveId: latestMove?.id || null,
            name: assignedRig?.name || latestMove?.name || `${foreman.name} Rig`,
            startPoint: latestMove?.startPoint || fallbackPoint,
            endPoint: latestMove?.endPoint || null,
            startLabel: formatLocationLabel(latestMove?.startLabel, fallbackLabel || "Current site"),
            endLabel: formatLocationLabel(latestMove?.endLabel, latestMove ? "Destination" : "No planned destination"),
            routeGeometry: latestMove?.simulation?.routeGeometry || [],
            executionState: latestMove?.executionState || "idle",
            operatingState: latestMove?.operatingState || "standby",
            completionPercentage: Number(latestMove?.completionPercentage) || 0,
            loadCount: latestMove?.loadCount || 0,
            eta: latestMove?.eta || "--",
            routeTime: latestMove?.routeTime || "--",
            phase: latestMove ? formatSceneStatus(latestMove) : "Idle",
          };
        })
        .filter((item) => item.startPoint || item.endPoint),
    [foremen, moves],
  );

  const selectedRig = useMemo(() => {
    if (!rigMapItems.length) {
      return null;
    }
    return rigMapItems.find((item) => item.id === selectedRigId)
      || rigMapItems.find((item) => item.executionState === "active")
      || rigMapItems[0];
  }, [rigMapItems, selectedRigId]);

  const liveRigs = rigMapItems.filter((item) => item.executionState === "active").length;
  const completedRigs = rigMapItems.filter((item) => item.operatingState === "drilling" || item.executionState === "completed").length;
  const averageProgress = rigMapItems.length
    ? Math.round(rigMapItems.reduce((sum, item) => sum + (Number(item.completionPercentage) || 0), 0) / rigMapItems.length)
    : 0;
  const totalTrackedTasks = taskSummary.rigDown + taskSummary.move + taskSummary.rigUp;
  const completedTaskPercent = totalTrackedTasks ? Math.round((taskSummary.completed / totalTrackedTasks) * 100) : 0;
  const utilizationPercent = trucks.length ? Math.round((fleetAssigned / trucks.length) * 100) : 0;
  const waitingTasks = Math.max(0, totalTrackedTasks - taskSummary.completed);
  const prioritizedMoves = [...moves].sort((left, right) => {
    const leftScore = left.executionState === "active" ? 3 : left.operatingState === "drilling" ? 2 : 1;
    const rightScore = right.executionState === "active" ? 3 : right.operatingState === "drilling" ? 2 : 1;
    if (leftScore !== rightScore) {
      return rightScore - leftScore;
    }
    return new Date(right.updatedAt || right.createdAt || 0) - new Date(left.updatedAt || left.createdAt || 0);
  });
  const spotlightMoves = prioritizedMoves.slice(0, 4);
  const managerSidebarStats = [
    { label: t("fleetReady", "Fleet Ready"), value: `${fleetFree}/${trucks.length || 0}`, meta: t("trucksFreeToAssign", "Trucks free to assign") },
    { label: t("driverReadiness", "Driver Readiness"), value: `${Math.max(0, drivers.length - driversAssigned)}/${drivers.length || 0}`, meta: t("readyForDispatch", "Ready for dispatch") },
    { label: t("taskCompletion", "Task Completion"), value: `${completedTaskPercent}%`, meta: `${taskSummary.completed}/${totalTrackedTasks || 0} ${t("tasksDone", "tasks done")}` },
  ];
  const operationPulseRows = [
    { label: t("rigDown", "Rig Down"), value: taskSummary.rigDown, percent: totalTrackedTasks ? Math.round((taskSummary.rigDown / totalTrackedTasks) * 100) : 0 },
    { label: t("move", "Move"), value: taskSummary.move, percent: totalTrackedTasks ? Math.round((taskSummary.move / totalTrackedTasks) * 100) : 0 },
    { label: t("rigUp", "Rig Up"), value: taskSummary.rigUp, percent: totalTrackedTasks ? Math.round((taskSummary.rigUp / totalTrackedTasks) * 100) : 0 },
  ];
  const fleetMixItems = prioritizedMoves
    .filter((move) => move?.executionState === "active")
    .map((move) => {
      const setup = move.truckSetup?.length ? move.truckSetup : move.simulation?.truckSetup || [];
      const mix = setup
        .filter((entry) => (Number.parseInt(entry.count, 10) || 0) > 0)
        .map((entry) => `${entry.type}: ${Number.parseInt(entry.count, 10) || 0}`);
      return {
        id: move.id,
        label: move.name || "Rig move",
        shortLabel: (move.name || "Rig").replace(/\s+/g, " ").trim(),
        value: move.simulation?.truckCount || setup.reduce((sum, entry) => sum + (Number.parseInt(entry.count, 10) || 0), 0),
        mix,
      };
    });
  const activeFleetMixItem = fleetMixItems.find((item) => item.id === hoveredFleetMixMoveId) || fleetMixItems[0] || null;
  const foremanSnapshots = foremen.map((foreman) => {
    const latestMove = getLatestForemanMove(moves, foreman.id);
    return {
      foreman,
      latestMove,
      status: latestMove ? getMoveStatus(latestMove) : "Idle",
    };
  });
  const reportPlan = buildReportPlan(moves);
  const pulseMove = activeMoves.find((move) => move.id === activePulseMoveId) || activeMoves[0] || null;
  const pulseStageItems = pulseMove ? getMoveStageItems(pulseMove) : [];
  const delayChartItems = prioritizedMoves
    .slice(0, 6)
    .map((move) => ({
      id: move.id,
      name: move.name || "Rig move",
      delayMinutes: getMoveDelayMinutes(managerResources?.taskAssignments || [], move.id),
    }));
  const maxDelayMinutes = Math.max(...delayChartItems.map((item) => item.delayMinutes), 1);
  const fleetTimelineItems = prioritizedMoves
    .filter((move) => move?.executionState === "active" || move?.operatingState === "drilling")
    .slice(0, 5)
    .map((move) => ({
      id: move.id,
      name: move.name || "Rig move",
      route: `${formatLocationLabel(move.startLabel, "From")} to ${formatLocationLabel(move.endLabel, "To")}`,
      truckCount: move.simulation?.truckCount || 0,
      eta: move.eta || "--",
      progress: Math.round(move.completionPercentage || 0),
      utilization: trucks.length ? Math.round(((move.simulation?.truckCount || 0) / trucks.length) * 100) : 0,
      status: getMoveStatus(move),
    }));

  const navItems = [
    {
      key: "dashboard",
      label: "Dashboard",
      icon: "dashboard",
      count: `${stats.totalMoves}`,
      description: "High-level operations view",
    },
    {
      key: "trucks",
      label: "Trucks",
      icon: "trucks",
      count: `${fleetAssigned}/${trucks.length || 0}`,
      description: "Fleet and driver control",
    },
    {
      key: "foremen",
      label: "Foremen",
      icon: "foremen",
      count: `${activeForemen}/${foremen.length || 0}`,
      description: "Rig ownership and field leads",
    },
    {
      key: "reports",
      label: "Reports",
      icon: "reports",
      count: `${reportPlan.expectedPerDay}`,
      description: "Shift and closeout reporting",
    },
  ];

  const activeNavItem = navItems.find((item) => item.key === activeSection) || navItems[0];
  const truckRows = useMemo(() => {
    const driverByTruckId = new Map((drivers || []).map((driver) => [driver.truckId, driver]));
    return truckAssignments.map((truck) => ({
      ...truck,
      linkedDriver: driverByTruckId.get(truck.id) || null,
    }));
  }, [truckAssignments, drivers]);
  const filteredTruckAssignments = truckRows.filter((truck) => {
    const matchesQuery = !truckFilter.query
      || truck.name.toLowerCase().includes(truckFilter.query.toLowerCase())
      || truck.type.toLowerCase().includes(truckFilter.query.toLowerCase())
      || (truck.assignedMove || "").toLowerCase().includes(truckFilter.query.toLowerCase())
      || (truck.destinationLabel || "").toLowerCase().includes(truckFilter.query.toLowerCase())
      || (truck.linkedDriver?.name || "").toLowerCase().includes(truckFilter.query.toLowerCase())
      || (truck.linkedDriver?.email || "").toLowerCase().includes(truckFilter.query.toLowerCase());
    const matchesStatus = truckFilter.status === "all" || truck.status.toLowerCase() === truckFilter.status;
    const matchesType = truckFilter.type === "all" || truck.type === truckFilter.type;
    return matchesQuery && matchesStatus && matchesType;
  });

  async function saveResources(nextPartial) {
    const nextResources = {
      ...(managerResources || {}),
      ...nextPartial,
    };
    await onSaveResources?.(nextResources);
  }

  async function handleAddTruck(event) {
    event.preventDefault();
    const name = truckDraft.name.trim();
    const type = truckDraft.type.trim();
    const driverName = truckDraft.driverName.trim();
    const driverEmail = truckDraft.driverEmail.trim().toLowerCase();
    const driverPassword = truckDraft.driverPassword.trim();
    if (!type || !driverName || !driverEmail || !driverPassword) {
      return;
    }

    const existingOfType = truckAssignments.filter((truck) => truck.type === type).length;
    const nextTruck = {
      id: `truck-${normalizeTypeKey(type)}-${Date.now()}`,
      name: name || `${getTypePrefix(type)}-${String(existingOfType + 1).padStart(2, "0")}`,
      type,
    };

    await onCreateTruck?.({
      truck: nextTruck,
      driver: {
        name: driverName,
        email: driverEmail,
        password: driverPassword,
      },
    });

    setTruckDraft({
      name: "",
      type,
      driverName: "",
      driverEmail: "",
      driverPassword: "",
    });
    setIsTruckModalOpen(false);
  }

  async function handleAddForeman(event) {
    event.preventDefault();
    const name = foremanDraft.name.trim();
    const email = foremanDraft.email.trim().toLowerCase();
    const password = foremanDraft.password.trim();
    const rigName = foremanDraft.rigName.trim();
    const startLabel = foremanDraft.startLabel.trim();
    const latitude = Number.parseFloat(foremanDraft.latitude);
    const longitude = Number.parseFloat(foremanDraft.longitude);
    if (!name || !email || !password) {
      return;
    }

    const hasExplicitLocation = Number.isFinite(latitude) && Number.isFinite(longitude);
    const assignedRig = hasExplicitLocation || rigName || startLabel
      ? {
          id: `rig-${email.replace(/[^a-z0-9]+/gi, "-").replace(/^-+|-+$/g, "") || "foreman"}`,
          name: rigName || `${name} Rig`,
          startLabel: startLabel || (hasExplicitLocation ? `${latitude.toFixed(5)}, ${longitude.toFixed(5)}` : ""),
          startPoint: hasExplicitLocation ? { lat: latitude, lng: longitude } : null,
        }
      : null;

    if (editingForemanId) {
      await onUpdateForeman?.({
        id: editingForemanId,
        name,
        email,
        assignedRig,
      });
    } else {
      await onCreateForeman?.({
        name,
        email,
        password,
        assignedRig,
      });
    }

    setForemanDraft({
      name: "",
      email: "",
      password: "",
      rigName: "",
      startLabel: "",
      latitude: "",
      longitude: "",
    });
    setEditingForemanId(null);
    setShowForemanForm(false);
  }

  function handleEditForeman(foreman) {
    if (!foreman) {
      return;
    }

    const point = foreman.assignedRig?.startPoint || null;
    setEditingForemanId(foreman.id);
    setForemanDraft({
      name: foreman.name || "",
      email: foreman.email || "",
      password: "",
      rigName: foreman.assignedRig?.name || "",
      startLabel: foreman.assignedRig?.startLabel || "",
      latitude: point?.lat != null ? String(point.lat) : "",
      longitude: point?.lng != null ? String(point.lng) : "",
    });
    setShowForemanForm(true);
  }

  async function handleRemoveForeman(foremanId) {
    if (!foremanId) {
      return;
    }

    await onDeleteForeman?.(foremanId);
  }

  async function resolveForemanLocationLabelWithRetry(point) {
    const requestId = foremanLocationLookupRequestRef.current + 1;
    foremanLocationLookupRequestRef.current = requestId;
    const maxAttempts = 4;

    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      try {
        const resolvedLabel = await fetchLocationLabel(point);
        if (foremanLocationLookupRequestRef.current !== requestId) {
          return;
        }
        if (resolvedLabel) {
          setForemanDraft((current) => ({ ...current, startLabel: resolvedLabel }));
          return;
        }
      } catch {
        // Keep coordinate fallback if lookup fails.
      }

      if (attempt < maxAttempts - 1) {
        await new Promise((resolve) => window.setTimeout(resolve, 1200 * (attempt + 1)));
      }
    }
  }

  async function handleForemanMapPick({ point }) {
    setForemanDraft((current) => ({
      ...current,
      latitude: String(point?.lat ?? ""),
      longitude: String(point?.lng ?? ""),
      startLabel: formatCoordinate(point),
    }));
    setIsForemanLocationPickerOpen(false);
    void resolveForemanLocationLabelWithRetry(point);
  }

  async function handleRemoveTruck(truck) {
    if (!truck || truck.status === "Assigned") {
      return;
    }

    await saveResources({
      trucks: (managerResources?.trucks || []).filter((entry) => entry.id !== truck.id),
      drivers: (managerResources?.drivers || []).filter((driver) => driver.truckId !== truck.id),
    });
  }

  function renderDashboardSection() {
    return [
      h(MetricStrip, { key: "overview-strip", items: summaryCards, className: "manager-metric-strip-dashboard" }),
      h(
        Card,
        { className: "dashboard-section-card manager-dashboard-panel manager-dashboard-panel-emphasis", key: "pulse-row" },
        h(
          "div",
          { className: "section-heading" },
          h("div", null, h("h2", null, "Operations Pulse"), h("p", { className: "muted-copy" }, "Per active move execution status and stage completion.")),
          pulseMove ? h("span", { className: "section-pill" }, `${getMoveStagePercent(pulseMove)}% complete`) : null,
        ),
        activeMoves.length
          ? h(
              "div",
              { className: "manager-pulse-switcher" },
              activeMoves.map((move) =>
                h(
                  "button",
                  {
                    key: move.id,
                    type: "button",
                    className: `manager-pulse-switcher-button${pulseMove?.id === move.id ? " is-active" : ""}`,
                    onClick: () => setActivePulseMoveId(move.id),
                  },
                  move.name,
                ),
              ),
            )
          : null,
        pulseMove
          ? h(
              "div",
              { className: "manager-pulse-grid" },
              h(
                "div",
                { className: "manager-pulse-main" },
                h("strong", { className: "manager-pulse-value" }, `${Math.max(0, 3 - pulseStageItems.filter((item) => item.done).length)}`),
                h("span", { className: "manager-pulse-label" }, "Stages waiting"),
                h("p", { className: "muted-copy" }, `${pulseMove.simulation?.truckCount || 0} trucks allocated, ETA ${pulseMove.eta || "--"}`),
                h(
                  "div",
                  { className: "manager-pulse-route" },
                  `${formatLocationLabel(pulseMove.startLabel, "From")} to ${formatLocationLabel(pulseMove.endLabel, "To")}`,
                ),
                h(
                  "div",
                  { className: "manager-pulse-meta-grid" },
                  h("div", { className: "manager-rig-stat" }, h("span", null, "Route"), h("strong", null, pulseMove.routeTime || "--")),
                  h("div", { className: "manager-rig-stat" }, h("span", null, "Loads"), h("strong", null, String(pulseMove.loadCount || 0))),
                  h("div", { className: "manager-rig-stat" }, h("span", null, "Progress"), h("strong", null, `${Math.round(pulseMove.completionPercentage || 0)}%`)),
                  h("div", { className: "manager-rig-stat" }, h("span", null, "Foreman"), h("strong", null, pulseMove.createdBy?.name || "Foreman")),
                ),
              ),
              h(
                "div",
                { className: "manager-pulse-stages" },
                pulseStageItems.map((item, index) =>
                  h(
                    "div",
                    { key: item.key, className: "manager-pulse-stage" },
                    h(
                      "div",
                      { className: "manager-pulse-stage-head" },
                      h("span", null, item.label),
                      h("strong", null, item.done ? "Done" : index === pulseStageItems.findIndex((stage) => !stage.done) ? "Current" : "Waiting"),
                    ),
                    h(ProgressBar, { value: item.done ? 100 : 12 }),
                  ),
                ),
              ),
            )
          : h("p", { className: "muted-copy" }, "No active rig move right now."),
      ),
      h(
        Card,
        { className: "dashboard-section-card manager-dashboard-panel", key: "fleet-timeline" },
        h(
          "div",
          { className: "section-heading" },
          h("div", null, h("h2", null, "Fleet Utilization Timeline"), h("p", { className: "muted-copy" }, "Where the fleet is being used right now across active rig moves.")),
        ),
        fleetTimelineItems.length
          ? h(
              "div",
              { className: "manager-fleet-timeline" },
              fleetTimelineItems.map((item) =>
                h(
                  "article",
                  { key: item.id, className: "manager-fleet-timeline-row" },
                  h("div", { className: "manager-fleet-timeline-dot" }),
                  h(
                    "div",
                    { className: "manager-fleet-timeline-main" },
                    h(
                      "div",
                      { className: "manager-fleet-timeline-head" },
                      h("strong", null, item.name),
                      h("span", { className: "manager-resource-status manager-resource-status-assigned" }, item.status),
                    ),
                    h("p", { className: "muted-copy" }, item.route),
                    h(
                      "div",
                      { className: "manager-fleet-timeline-stats" },
                      h("span", null, `${item.truckCount} trucks`),
                      h("span", null, `${item.utilization}% fleet use`),
                      h("span", null, `ETA ${item.eta}`),
                    ),
                    h(ProgressBar, { value: item.progress }),
                  ),
                ),
              ),
            )
          : h("p", { className: "muted-copy" }, "No fleet utilization to show right now."),
      ),
    ];
  }

  function renderTrucksSection() {
    return [
      h(MetricStrip, {
        key: "truck-strip",
        items: [
          { label: "Fleet units", value: String(trucks.length), meta: `${fleetAssigned} assigned now` },
          { label: "Available trucks", value: String(Math.max(fleetFree, 0)), meta: "Ready for dispatch" },
          { label: "Assigned trucks", value: String(fleetAssigned), meta: `${Math.max(fleetFree, 0)} available now` },
          { label: "Fleet utilization", value: `${utilizationPercent}%`, meta: "Based on active moves" },
        ],
      }),
      h(
        Card,
        { className: "dashboard-section-card manager-dashboard-panel", key: "truck-fleet" },
        h(
          "div",
          { className: "manager-resource-toolbar" },
          h("div", null, h("h2", null, "Truck Fleet")),
        ),
        h(
          "div",
          { className: "manager-truck-filterbar" },
          h("input", {
            className: "input",
            type: "text",
            value: truckFilter.query,
            placeholder: "Search truck, move, destination",
            onInput: (event) => setTruckFilter((current) => ({ ...current, query: event.target.value })),
          }),
          h(
            "select",
            {
              className: "input",
              value: truckFilter.status,
              onInput: (event) => setTruckFilter((current) => ({ ...current, status: event.target.value })),
            },
            h("option", { value: "all" }, "All status"),
            h("option", { value: "available" }, "Available"),
            h("option", { value: "assigned" }, "Assigned"),
          ),
          h(
            "select",
            {
              className: "input",
              value: truckFilter.type,
              onInput: (event) => setTruckFilter((current) => ({ ...current, type: event.target.value })),
            },
            h("option", { value: "all" }, "All types"),
            truckTypeOptions.map((type) =>
              h("option", { key: type, value: type }, type),
            ),
          ),
        ),
        filteredTruckAssignments.length
          ? h(
              "div",
              { className: "manager-truck-list" },
              filteredTruckAssignments.map((truck) =>
                h(
                  "article",
                  { key: truck.id, className: "manager-truck-row" },
                  h(
                    "div",
                    { className: "manager-truck-row-main" },
                    h("div", null, h("strong", null, truck.name), h("p", { className: "muted-copy" }, `${truck.type} • ${truck.linkedDriver?.name || "No driver linked"}`)),
                    h("span", { className: `manager-resource-status manager-resource-status-${truck.status.toLowerCase()}` }, truck.status),
                  ),
                  h(
                    "div",
                    { className: "manager-truck-row-grid" },
                    h("div", { className: "manager-rig-stat" }, h("span", null, "Move"), h("strong", null, truck.assignedMove || "Standby")),
                    h("div", { className: "manager-rig-stat" }, h("span", null, "Foreman"), h("strong", null, truck.assignedForeman || "No active foreman")),
                    h("div", { className: "manager-rig-stat" }, h("span", null, "Destination"), h("strong", null, truck.destinationLabel || "Ready yard")),
                    h("div", { className: "manager-rig-stat" }, h("span", null, "ETA"), h("strong", null, truck.assignmentEta || "--")),
                    h("div", { className: "manager-rig-stat" }, h("span", null, "Progress"), h("strong", null, `${truck.assignmentProgress || 0}%`)),
                    h("div", { className: "manager-rig-stat" }, h("span", null, "State"), h("strong", null, truck.status === "Assigned" ? "In route" : "Waiting")),
                  ),
                  h(
                    "div",
                    { className: "manager-truck-row-actions" },
                    truck.status === "Assigned" ? h(ProgressBar, { value: truck.assignmentProgress || 0 }) : null,
                    h(Button, {
                      type: "button",
                      variant: "ghost",
                      size: "sm",
                      disabled: truck.status === "Assigned",
                      onClick: () => handleRemoveTruck(truck),
                      children: "Remove",
                    }),
                  ),
                ),
              ),
            )
          : h("p", { className: "muted-copy" }, "No trucks match the current filters."),
      ),
    ];
  }

  function renderForemenSection() {
    return [
      h(MetricStrip, {
        key: "foreman-strip",
        items: [
          { label: "Foreman accounts", value: String(foremen.length), meta: `${activeForemen} active on moves` },
          { label: "Assigned rigs", value: String(foremen.filter((foreman) => foreman.assignedRig?.name).length), meta: "Named rig ownership" },
          { label: "Live moves", value: String(activeMoves.length), meta: "Across all foremen" },
          { label: "Tracked rigs", value: String(rigMapItems.length), meta: `${averageProgress}% avg completion` },
        ],
      }),
      h(
        Card,
        { className: "dashboard-section-card manager-dashboard-panel", key: "foreman-ops" },
          h(
            "div",
            { className: "manager-resource-toolbar" },
            h("div", null, h("h2", null, "Foreman Command"), h("p", { className: "muted-copy" }, "Add field leads, set their current rig, and track what each foreman is handling.")),
            h(
            "div",
              { className: "manager-resource-actions" },
              h(Button, {
                type: "button",
                variant: showForemanForm ? "ghost" : "secondary",
                onClick: () => {
                  if (showForemanForm) {
                    setEditingForemanId(null);
                    setForemanDraft({
                      name: "",
                      email: "",
                      password: "",
                      rigName: "",
                      startLabel: "",
                      latitude: "",
                      longitude: "",
                    });
                    setShowForemanForm(false);
                    return;
                  }
                  setShowForemanForm(true);
                },
                children: showForemanForm ? "Close Foreman" : "Add Foreman",
              }),
            ),
          ),
        showForemanForm
          ? h(
              "form",
              { className: "manager-resource-form", onSubmit: handleAddForeman },
              h(
                "label",
                { className: "manager-rig-stat" },
                h("span", null, "Foreman name"),
                h("input", {
                  className: "input",
                  type: "text",
                  value: foremanDraft.name,
                  onInput: (event) => setForemanDraft((current) => ({ ...current, name: event.target.value })),
                }),
              ),
              h(
                "label",
                { className: "manager-rig-stat" },
                h("span", null, "Email"),
                h("input", {
                  className: "input",
                  type: "email",
                  value: foremanDraft.email,
                  readOnly: Boolean(editingForemanId),
                  onInput: (event) => setForemanDraft((current) => ({ ...current, email: event.target.value })),
                }),
              ),
              editingForemanId
                ? null
                : h(
                    "label",
                    { className: "manager-rig-stat" },
                    h("span", null, "Password"),
                    h("input", {
                      className: "input",
                      type: "password",
                      value: foremanDraft.password,
                      onInput: (event) => setForemanDraft((current) => ({ ...current, password: event.target.value })),
                    }),
                  ),
              h(
                "label",
                { className: "manager-rig-stat" },
                h("span", null, "Assigned Rig"),
                h("input", {
                  className: "input",
                  type: "text",
                  value: foremanDraft.rigName,
                  onInput: (event) => setForemanDraft((current) => ({ ...current, rigName: event.target.value })),
                }),
              ),
              h(
                "label",
                { className: "manager-rig-stat" },
                h("span", null, "Current Rig Location"),
                h(
                  "div",
                  { className: "manager-resource-actions" },
                  h("input", {
                    className: "input",
                    type: "text",
                    value: foremanDraft.startLabel,
                    placeholder: "Click Select to open map",
                    readOnly: true,
                  }),
                  h(Button, {
                    type: "button",
                    variant: "ghost",
                    onClick: () => setIsForemanLocationPickerOpen(true),
                    children: foremanDraft.latitude && foremanDraft.longitude ? "Change" : "Select",
                  }),
                ),
              ),
              h(
                "label",
                { className: "manager-rig-stat" },
                h("span", null, "Latitude"),
                h("input", {
                  className: "input",
                  type: "number",
                  step: "any",
                  value: foremanDraft.latitude,
                  onInput: (event) => setForemanDraft((current) => ({ ...current, latitude: event.target.value })),
                }),
              ),
              h(
                "label",
                { className: "manager-rig-stat" },
                h("span", null, "Longitude"),
                h("input", {
                  className: "input",
                  type: "number",
                  step: "any",
                  value: foremanDraft.longitude,
                  onInput: (event) => setForemanDraft((current) => ({ ...current, longitude: event.target.value })),
                }),
              ),
              h(
                "div",
                { className: "manager-resource-form-actions" },
                h(Button, { type: "submit", children: editingForemanId ? "Save Foreman" : "Create Foreman" }),
              ),
            )
          : null,
        foremanSnapshots.length
          ? h(
              "div",
              { className: "manager-foreman-list" },
              foremanSnapshots.map(({ foreman, latestMove, status }) =>
                h(
                  "article",
                  { key: foreman.id, className: "manager-foreman-profile manager-resource-card manager-resource-card-strong" },
                  h(
                    "div",
                    { className: "manager-foreman-profile-head" },
                    h(
                      "div",
                      { className: "manager-foreman-profile-identity" },
                      h("span", { className: "manager-foreman-profile-avatar", "aria-hidden": "true" }, getInitials(foreman.name)),
                      h("div", null, h("strong", null, foreman.name), h("p", { className: "muted-copy" }, foreman.email || "--")),
                    ),
                  ),
                  h(
                    "div",
                    { className: "manager-foreman-profile-tags manager-resource-tags" },
                    h("span", { className: `manager-resource-status manager-resource-status-${status === "Executing" ? "assigned" : "available"}` }, status),
                    h("span", { className: "manager-resource-tag" }, foreman.assignedRig?.name || "Unassigned rig"),
                    h("span", { className: "manager-resource-tag manager-resource-tag-muted" }, latestMove?.name || "No live move"),
                  ),
                  h(
                    "div",
                    { className: "manager-foreman-profile-metrics manager-resource-metrics" },
                    h("div", { className: "manager-rig-stat" }, h("span", null, "Current site"), h("strong", null, formatLocationLabel(foreman.assignedRig?.startLabel, "Not set"))),
                    h("div", { className: "manager-rig-stat" }, h("span", null, "Move progress"), h("strong", null, latestMove ? `${Math.round(latestMove.completionPercentage || 0)}%` : "--")),
                    h("div", { className: "manager-rig-stat" }, h("span", null, "Destination"), h("strong", null, latestMove ? formatLocationLabel(latestMove.endLabel, "Destination") : "Awaiting plan")),
                    h("div", { className: "manager-rig-stat" }, h("span", null, "ETA"), h("strong", null, latestMove?.eta || "--")),
                  ),
                  latestMove ? h(ProgressBar, { value: Math.round(latestMove.completionPercentage || 0) }) : null,
                  h(
                    "div",
                    { className: "manager-resource-card-actions manager-foreman-profile-actions" },
                    latestMove
                      ? h(Button, {
                          type: "button",
                          variant: "ghost",
                          size: "sm",
                          onClick: () => onOpenMove?.(latestMove.id),
                          children: "Open Move",
                        })
                      : h("span", { className: "muted-copy" }, "Waiting for first rig move"),
                    h(Button, {
                      type: "button",
                      variant: "ghost",
                      size: "sm",
                      onClick: () => handleEditForeman(foreman),
                      children: "Edit",
                    }),
                    h(Button, {
                      type: "button",
                      variant: "ghost",
                      size: "sm",
                      onClick: () => handleRemoveForeman(foreman.id),
                      children: "Remove",
                    }),
                  ),
                ),
              ),
            )
          : h("p", { className: "muted-copy" }, "No foreman accounts yet."),
      ),
    ];
  }

  function renderReportsSection() {
    return [
      h(MetricStrip, {
        key: "reports-strip",
        items: [
          { label: "Active move reports", value: String(reportPlan.expectedPerDay), meta: "Expected each day across live moves" },
          { label: "Shift start reports", value: String(reportPlan.expectedShiftReports), meta: "Per 12h opening cycle" },
          { label: "Shift end reports", value: String(reportPlan.expectedShiftReports), meta: "Per 12h closing cycle" },
          { label: "Final closeout", value: String(reportPlan.finalReportsPending), meta: "One final report per move" },
        ],
      }),
      h(
        Card,
        { className: "dashboard-section-card manager-dashboard-panel", key: "reports-roadmap" },
        h(
          "div",
          { className: "section-heading" },
          h("div", null, h("h2", null, "Reports Pipeline"), h("p", { className: "muted-copy" }, "Prepared layout for the reporting system that will be implemented next.")),
          h("span", { className: "section-pill" }, "Planned"),
        ),
        h(
          "div",
          { className: "manager-report-pipeline" },
          h("article", { className: "manager-report-stage" }, h("span", { className: "manager-report-stage-kicker" }, "Step 01"), h("strong", null, "Shift Start Report"), h("p", { className: "muted-copy" }, "First report at the beginning of each 12h shift to capture rig state, team readiness, and blockers.")),
          h("article", { className: "manager-report-stage" }, h("span", { className: "manager-report-stage-kicker" }, "Step 02"), h("strong", null, "Shift End Report"), h("p", { className: "muted-copy" }, "Second report at the end of each 12h shift to capture moved loads, delays, and handoff notes.")),
          h("article", { className: "manager-report-stage" }, h("span", { className: "manager-report-stage-kicker" }, "Step 03"), h("strong", null, "Final Move Report"), h("p", { className: "muted-copy" }, "One final closeout report after the rig move is complete with final route, time, and completion evidence.")),
        ),
      ),
      h(
        Card,
        { className: "dashboard-section-card manager-dashboard-panel", key: "reports-preview" },
        h(
          "div",
          { className: "section-heading" },
          h("div", null, h("h2", null, "Expected Daily Flow"), h("p", { className: "muted-copy" }, "Reporting volume forecast based on current live moves.")),
          h("span", { className: "section-pill" }, `${reportPlan.activeMoves} live rigs`),
        ),
        h(
          "div",
          { className: "manager-report-preview-grid" },
          h("article", { className: "manager-insight-card" }, h("span", { className: "manager-insight-label" }, "Per active move"), h("strong", null, "4 daily + 1 final"), h("p", { className: "muted-copy" }, "Two reports every 12h shift during the move, then one closeout report.")),
          h("article", { className: "manager-insight-card" }, h("span", { className: "manager-insight-label" }, "Current day estimate"), h("strong", null, String(reportPlan.expectedPerDay)), h("p", { className: "muted-copy" }, "Projected total reports if all active moves remain open today.")),
          h("article", { className: "manager-insight-card" }, h("span", { className: "manager-insight-label" }, "Final reports pending"), h("strong", null, String(reportPlan.finalReportsPending)), h("p", { className: "muted-copy" }, "Final closeout reports expected after completion.")),
        ),
      ),
    ];
  }

  function renderPrimaryContent() {
    if (activeSection === "trucks") {
      return renderTrucksSection();
    }
    if (activeSection === "foremen") {
      return renderForemenSection();
    }
    if (activeSection === "reports") {
      return renderReportsSection();
    }
    return renderDashboardSection();
  }

  function renderSidebarContent() {
    if (activeSection === "trucks") {
      return [
        h(
          Card,
          { className: "dashboard-section-card manager-dashboard-panel", key: "truck-mix" },
          h("div", { className: "section-heading" }, h("h2", null, "Fleet Mix Chart")),
          fleetMixItems.length
            ? h(
                "div",
                { className: "manager-fleet-mix-chart" },
                h(
                  "svg",
                  { className: "manager-fleet-mix-line-chart", viewBox: "0 0 240 120", "aria-hidden": "true" },
                  h(
                    "defs",
                    null,
                    h(
                      "linearGradient",
                      { id: "fleetMixAreaGradient", x1: "0", y1: "0", x2: "0", y2: "1" },
                      h("stop", { offset: "0%", stopColor: "#d6ec67", stopOpacity: "0.18" }),
                      h("stop", { offset: "100%", stopColor: "#d6ec67", stopOpacity: "0.01" }),
                    ),
                  ),
                  h("path", { className: "manager-fleet-mix-grid-line", d: "M 18 18 L 222 18" }),
                  h("path", { className: "manager-fleet-mix-grid-line", d: "M 18 46 L 222 46" }),
                  h("path", { className: "manager-fleet-mix-grid-line", d: "M 18 74 L 222 74" }),
                  h("path", { className: "manager-fleet-mix-grid-line", d: "M 18 102 L 222 102" }),
                  h("path", { className: "manager-fleet-mix-area", d: buildFleetMixAreaPath(fleetMixItems) }),
                  h("path", { className: "manager-fleet-mix-line", d: buildFleetMixLinePath(fleetMixItems) }),
                  getFleetMixPoints(fleetMixItems).map((point, index) => {
                    const item = fleetMixItems[index];
                    return h(
                      "circle",
                      {
                        key: item.id,
                        className: `manager-fleet-mix-point${activeFleetMixItem?.id === item.id ? " is-active" : ""}`,
                        cx: point.x,
                        cy: point.y,
                        r: "2.5",
                        onMouseEnter: () => setHoveredFleetMixMoveId(item.id),
                        onFocus: () => setHoveredFleetMixMoveId(item.id),
                      },
                      h("title", null, `${item.label}: ${item.value} trucks${item.mix.length ? ` | ${item.mix.join(", ")}` : ""}`),
                    );
                  }),
                  h("text", { className: "manager-fleet-mix-axis-value", x: "228", y: "20" }, String(Math.max(...fleetMixItems.map((entry) => entry.value), 1))),
                  h("text", { className: "manager-fleet-mix-axis-value", x: "228", y: "48" }, String(Math.round(Math.max(...fleetMixItems.map((entry) => entry.value), 1) * 0.66))),
                  h("text", { className: "manager-fleet-mix-axis-value", x: "228", y: "76" }, String(Math.round(Math.max(...fleetMixItems.map((entry) => entry.value), 1) * 0.33))),
                  h("text", { className: "manager-fleet-mix-axis-value", x: "228", y: "104" }, "0"),
                ),
                h(
                  "div",
                  { className: "manager-fleet-mix-axis-labels" },
                  fleetMixItems.map((item) =>
                    h("span", { key: item.id, className: `manager-resource-mini-label${activeFleetMixItem?.id === item.id ? " is-active" : ""}` }, item.shortLabel),
                  ),
                ),
                activeFleetMixItem
                  ? h(
                      "div",
                      { className: "manager-fleet-mix-hovercard" },
                      h("span", { className: "manager-resource-mini-label" }, activeFleetMixItem.label),
                      h("strong", { className: "manager-resource-mini-value" }, `${activeFleetMixItem.value} trucks`),
                      h("p", { className: "muted-copy" }, activeFleetMixItem.mix.length ? activeFleetMixItem.mix.join(" • ") : "No truck mix configured."),
                    )
                  : null,
              )
            : h("p", { className: "muted-copy" }, "No active rig moves to chart right now."),
        ),
        h(
          Card,
          { className: "dashboard-section-card manager-dashboard-panel", key: "availability" },
          h("div", { className: "section-heading" }, h("h2", null, "Assignment Readiness"), h("span", { className: "section-pill" }, `${fleetFree} open`)),
          h(
            "div",
            { className: "manager-list-stack" },
            fleetAvailability.map((item) =>
              h(
                "div",
                { key: item.type, className: "manager-list-row" },
                h("div", null, h("strong", null, item.type), h("p", { className: "muted-copy" }, `${item.allocated} allocated`)),
                h("strong", null, `${item.available}/${item.count}`),
              ),
            ),
          ),
        ),
      ];
    }

    if (activeSection === "foremen") {
      return [
        h(
          Card,
          { className: "dashboard-section-card manager-dashboard-panel", key: "foreman-watch" },
          h("div", { className: "section-heading" }, h("h2", null, "Rig Watch"), h("span", { className: "section-pill" }, `${activeForemen} active`)),
          h(
            "div",
            { className: "manager-list-stack" },
            foremanSnapshots.slice(0, 5).map(({ foreman, latestMove, status }) =>
              h(
                "article",
                { key: foreman.id, className: "manager-list-row manager-list-row-card" },
                h("div", null, h("strong", null, foreman.name), h("p", { className: "muted-copy" }, latestMove?.name || "No current move")),
                h("span", { className: `manager-resource-status manager-resource-status-${status === "Executing" ? "assigned" : "available"}` }, status),
              ),
            ),
          ),
        ),
        h(
          Card,
          { className: "dashboard-section-card manager-dashboard-panel", key: "network-card" },
          h("div", { className: "section-heading" }, h("h2", null, "Network Map"), h("span", { className: "section-pill" }, `${liveRigs} live`)),
          h("p", { className: "muted-copy" }, "Use the network view to inspect where each foreman rig is, which route is active, and how far each move has progressed."),
        ),
      ];
    }

    if (activeSection === "reports") {
      return [
        h(
          Card,
          { className: "dashboard-section-card manager-dashboard-panel", key: "report-totals" },
          h("div", { className: "section-heading" }, h("h2", null, "Report Totals"), h("span", { className: "section-pill" }, "Forecast")),
          h(
            "div",
            { className: "manager-sidebar-stat-grid" },
            [
              { label: "Daily estimate", value: String(reportPlan.expectedPerDay), meta: "Across live moves" },
              { label: "Shift starts", value: String(reportPlan.expectedShiftReports), meta: "Beginning of shift" },
              { label: "Shift ends", value: String(reportPlan.expectedShiftReports), meta: "End of shift" },
              { label: "Final reports", value: String(reportPlan.finalReportsPending), meta: "Closeout pending" },
            ].map((item) =>
              h(
                "article",
                { key: item.label, className: "manager-resource-mini-card" },
                h("span", { className: "manager-resource-mini-label" }, item.label),
                h("strong", { className: "manager-resource-mini-value" }, item.value),
                h("span", { className: "manager-resource-mini-meta" }, item.meta),
              ),
            ),
          ),
        ),
        h(
          Card,
          { className: "dashboard-section-card manager-dashboard-panel", key: "report-notes" },
          h("div", { className: "section-heading" }, h("h2", null, "Implementation Notes"), h("span", { className: "section-pill" }, "Next")),
          h(
            "div",
            { className: "manager-note-list" },
            h("p", null, "Each active move should produce 2 reports per 12-hour shift: one at shift start and one at shift end."),
            h("p", null, "That produces 4 daily reports for every full day the rig move remains active."),
            h("p", null, "A final move report closes the workflow once the rig reaches the destination and the move is complete."),
          ),
        ),
      ];
    }

    return [
      h(
        Card,
        { className: "dashboard-section-card manager-dashboard-panel", key: "snapshot" },
        h("div", { className: "section-heading" }, h("h2", null, "Current Execution Rig Moves")),
        h(
          "div",
          { className: "manager-rig-progress-orbits" },
          activeMoves.length
            ? activeMoves.map((move) =>
                h(
                  "article",
                  { key: move.id, className: "manager-rig-progress-orbit" },
                  h(
                    "div",
                    {
                      className: "manager-rig-progress-ring",
                      style: { "--progress": `${Math.round(move.completionPercentage || 0)}%` },
                    },
                    h("strong", null, `${Math.round(move.completionPercentage || 0)}%`),
                  ),
                  h("span", { className: "manager-resource-mini-label" }, move.name),
                ),
              )
            : h("p", { className: "muted-copy" }, "No active rig move right now."),
        ),
      ),
      h(
        Card,
        { className: "dashboard-section-card manager-dashboard-panel", key: "field-summary" },
        h("div", { className: "section-heading" }, h("h2", null, "Field Leads"), h("span", { className: "section-pill" }, `${foremen.length} accounts`)),
        h(
          "div",
          { className: "manager-list-stack" },
          foremanSnapshots.slice(0, 4).map(({ foreman, latestMove, status }) =>
            h(
              "article",
              { key: foreman.id, className: "manager-list-row manager-list-row-card" },
              h("div", null, h("strong", null, foreman.name), h("p", { className: "muted-copy" }, latestMove?.name || foreman.assignedRig?.name || "No assigned rig")),
              h("span", { className: `manager-resource-status manager-resource-status-${status === "Executing" ? "assigned" : "available"}` }, status),
            ),
          ),
        ),
      ),
    ];
  }

  if (isMapOpen) {
    return h(
      AppLayout,
      {
        title: `${t("managerView", "Manager view")}, ${currentUser?.name || t("supervisor", "Supervisor")}`,
        subtitle: formatDate(currentDate),
        currentUser,
        onLogout,
        language,
        onToggleLanguage,
        fullBleed: true,
        hideHeader: true,
        className: "app-layout-scene-mode manager-viewall-layout",
      },
      h(
        "section",
        { className: "scene-only-shell manager-scene-shell" },
        viewAllMode === "3d"
          ? h(ManagerRigsScene3D, {
              rigs: rigMapItems,
              selectedRigId: selectedRig?.id || null,
              onSelectRig: setSelectedRigId,
              heightClass: "manager-map-fullscreen",
            })
          : h(ManagerRigsMap, {
              rigs: rigMapItems,
              selectedRigId: selectedRig?.id || null,
              onSelectRig: setSelectedRigId,
              heightClass: "manager-map-fullscreen",
            }),
        h(
          "div",
          { className: "scene-top-bar manager-scene-top-bar" },
          h(
            "div",
            { className: "scene-top-left-actions" },
            h(
              "button",
              {
                type: "button",
                className: "scene-back-button",
                onClick: () => setIsMapOpen(false),
                "aria-label": t("back", "Back"),
              },
              h("span", { "aria-hidden": "true" }, "<"),
            ),
            h(
              "button",
              {
                type: "button",
                className: "scene-back-button",
                onClick: () => setIsMapOpen(false),
                "aria-label": t("close", "Close"),
              },
              h("span", { "aria-hidden": "true" }, "x"),
            ),
            h("div", { className: "scene-compact-pill" }, t("viewAll", "View All")),
            h(
              "div",
              { className: "manager-view-mode-switch", role: "tablist", "aria-label": "View mode" },
              h(
                "button",
                {
                  type: "button",
                  className: `manager-view-mode-button${viewAllMode === "3d" ? " is-active" : ""}`,
                  onClick: () => setViewAllMode("3d"),
                },
                "3D Kingdom",
              ),
              h(
                "button",
                {
                  type: "button",
                  className: `manager-view-mode-button${viewAllMode === "map" ? " is-active" : ""}`,
                  onClick: () => setViewAllMode("map"),
                },
                "2D Map",
              ),
            ),
          ),
          h(
            "div",
            { className: "scene-top-title" },
            h("span", { className: "scene-panel-kicker" }, t("managerNetwork", "Manager Network")),
            h("strong", { className: "scene-top-title-text" }, t("allRigs", "All Rigs")),
            h("div", { className: "scene-stage-progress manager-scene-stage-progress" },
              h("div", { className: "scene-stage-item is-completed" }, h("span", { className: "scene-stage-label" }, t("planning", "Planning"))),
              h("div", { className: `scene-stage-item${liveRigs ? " is-active" : ""}` }, h("span", { className: "scene-stage-label" }, t("execution", "Execution"))),
              h("div", { className: `scene-stage-item${completedRigs ? " is-completed" : ""}` }, h("span", { className: "scene-stage-label" }, t("drilling", "Drilling"))),
            ),
          ),
        ),
        h(
          "aside",
          { className: "manager-scene-panel manager-scene-panel-left" },
          h("span", { className: "scene-panel-kicker" }, t("selectedRig", "Selected Rig")),
          h("strong", { className: "manager-scene-title" }, selectedRig?.name || t("noRigSelected", "No rig selected")),
          h("p", { className: "manager-scene-copy" }, selectedRig
            ? selectedRig.endPoint
              ? `${selectedRig.startLabel} to ${selectedRig.endLabel}`
              : selectedRig.startLabel
            : viewAllMode === "3d"
              ? t("noRigSelectedCopy3d", "Pick a rig on the Saudi terrain to inspect its transfer state.")
              : t("noRigSelectedCopy", "Pick a rig on the map to inspect its transfer state.")),
          h(
            "div",
            { className: "manager-scene-stat-list" },
            h("div", { className: "manager-scene-stat-row" }, h("span", null, t("status", "Status")), h("strong", null, selectedRig ? t(selectedRig.phase.toLowerCase(), selectedRig.phase) : "--")),
            h("div", { className: "manager-scene-stat-row" }, h("span", null, t("completion", "Completion")), h("strong", null, `${Math.round(selectedRig?.completionPercentage || 0)}%`)),
            h("div", { className: "manager-scene-stat-row" }, h("span", null, t("loads", "Loads")), h("strong", null, String(selectedRig?.loadCount || 0))),
            h("div", { className: "manager-scene-stat-row" }, h("span", null, t("route", "Route")), h("strong", null, selectedRig?.routeTime || "--")),
            h("div", { className: "manager-scene-stat-row" }, h("span", null, t("eta", "ETA")), h("strong", null, selectedRig?.eta || "--")),
          ),
          h(
            "div",
            { className: "manager-scene-callout" },
            h("span", { className: "scene-panel-kicker" }, t("liveTracking", "Live Tracking")),
            h("strong", null, selectedRig?.executionState === "active"
              ? t("transferInMotion", "Transfer in motion")
              : selectedRig?.endPoint
                ? t("routeReady", "Route ready")
                : t("rigOnSite", "Rig on site")),
            h("p", { className: "manager-scene-copy" }, selectedRig?.executionState === "active"
              ? t("transferInMotionCopy", "Showing old site, destination, route line, and live completion on the path.")
              : selectedRig?.endPoint
                ? t("routeReadyCopy", "This rig is not actively transferring right now.")
                : t("rigOnSiteCopy", "This rig is currently parked at its assigned location and has no active move.")),
          ),
        ),
        h(
          "div",
          { className: "scene-top-info-strip manager-scene-top-info-strip" },
          h(
            "div",
            { className: "scene-plan-kpis manager-scene-kpis" },
            h("div", { className: "scene-dashboard-stack-item" }, h("span", { className: "scene-dashboard-label" }, t("rigsLive", "Rigs Live")), h("strong", null, String(liveRigs))),
            h("div", { className: "scene-dashboard-stack-item" }, h("span", { className: "scene-dashboard-label" }, t("averageCompletion", "Average Completion")), h("strong", null, `${averageProgress}%`)),
            h("div", { className: "scene-dashboard-stack-item" }, h("span", { className: "scene-dashboard-label" }, t("driversReady", "Drivers Ready")), h("strong", null, String(Math.max(0, drivers.length - driversAssigned)))),
          ),
          h(
            "div",
            { className: "scene-plan-dashboard manager-scene-dashboard" },
            h("span", { className: "scene-panel-kicker" }, t("networkSummary", "Network Summary")),
            h("strong", { className: "scene-plan-summary-title" }, t("managerPlanOverview", "Rig Operations Overview")),
            h("div", { className: "scene-dashboard-pair" },
              h("div", { className: "scene-dashboard-pair-item" }, h("span", { className: "scene-dashboard-label" }, t("totalRigs", "Total Rigs")), h("strong", null, String(rigMapItems.length))),
              h("div", { className: "scene-dashboard-pair-item" }, h("span", { className: "scene-dashboard-label" }, t("inDrilling", "In Drilling")), h("strong", null, String(completedRigs))),
              h("div", { className: "scene-dashboard-pair-item" }, h("span", { className: "scene-dashboard-label" }, t("routesTracked", "Routes Tracked")), h("strong", null, String(rigMapItems.filter((item) => item.routeGeometry?.length > 1).length))),
              h("div", { className: "scene-dashboard-pair-item" }, h("span", { className: "scene-dashboard-label" }, t("loadTransfers", "Load Transfers")), h("strong", null, String(rigMapItems.reduce((sum, item) => sum + (item.loadCount || 0), 0)))),
            ),
          ),
        ),
      ),
    );
  }

  return h(
    AppLayout,
    {
      title: `${t("managerView", "Manager view")}, ${currentUser?.name || t("supervisor", "Supervisor")}`,
      subtitle: formatDate(currentDate),
      currentUser,
      onLogout,
      language,
      onToggleLanguage,
      fullBleed: true,
    },
    h(
      "div",
      { className: "manager-dashboard-shell" },
      dashboardError
        ? h(
            Card,
            { className: "dashboard-section-card manager-dashboard-panel" },
            h("div", { className: "section-heading" }, h("h2", null, "Data issue")),
            h("p", { className: "field-error" }, dashboardError),
            h("p", { className: "muted-copy" }, "The dashboard now depends on live Firestore data only. Create or repair the missing document instead of relying on repo defaults."),
          )
        : null,
      h(
        "div",
        { className: "manager-dashboard-hero manager-dashboard-hero-grid" },
        h(
          "div",
          { className: "manager-dashboard-hero-copy" },
          h("span", { className: "hero-badge" }, `${activeNavItem.label} Command Center`),
          h("p", { className: "manager-dashboard-hero-text" }, activeNavItem.description),
        ),
        h(
          "div",
          { className: "manager-dashboard-hero-actions" },
          activeSection === "trucks"
            ? h(Button, {
                type: "button",
                variant: "secondary",
                onClick: () => setIsTruckModalOpen(true),
                children: "Add Driver",
              })
            : activeSection === "dashboard"
              ? h(Button, {
                  type: "button",
                  variant: "secondary",
                  onClick: () => setIsMapOpen(true),
                  children: "Open Network",
                })
              : null,
          activeSection === "foremen"
            ? h(Button, {
                type: "button",
                variant: showForemanForm ? "ghost" : "secondary",
                onClick: () => setShowForemanForm((value) => !value),
                children: showForemanForm ? "Close Foreman" : "Add Foreman",
              })
            : null,
        ),
      ),
      h(
        "div",
        { className: "manager-dashboard-layout" },
        h(
          "aside",
          { className: "manager-dashboard-rail" },
          h(
            "div",
            { className: "manager-dashboard-nav" },
            navItems.map((item) =>
              h(
                "button",
                {
                  key: item.key,
                  type: "button",
                  className: `manager-dashboard-nav-button${activeSection === item.key ? " is-active" : ""}`,
                  onClick: () => {
                  if (item.key === "reports") {
                    navigateTo("/reports");
                    return;
                  }
                  setActiveSection(item.key);
                },
                  title: item.label,
                  "aria-label": item.label,
                },
                h("span", { className: `manager-dashboard-nav-icon-wrap${activeSection === item.key ? " is-active" : ""}` }, h(ManagerIcon, { name: item.icon })),
                h("span", { className: "manager-dashboard-nav-count" }, item.count),
              ),
            ),
          ),
        ),
        h(
          "section",
          { className: "manager-dashboard-primary" },
          renderPrimaryContent(),
        ),
        h(
          "aside",
          { className: "manager-dashboard-sidebar" },
          renderSidebarContent(),
        ),
      ),
    ),
    isForemanLocationPickerOpen
      ? h(
          Modal,
          {
            title: "Select current rig location",
            description: "Click the map to place the foreman's current rig location.",
            onClose: () => setIsForemanLocationPickerOpen(false),
            flushBody: true,
          },
          h(LeafletMap, {
            startPoint: null,
            endPoint:
              foremanDraft.latitude && foremanDraft.longitude
                ? {
                    lat: Number.parseFloat(foremanDraft.latitude),
                    lng: Number.parseFloat(foremanDraft.longitude),
                  }
                : null,
            pickerTarget: "end",
            onPickPoint: handleForemanMapPick,
            heightClass: "map-frame map-frame-modal",
          }),
        )
      : null,
    isTruckModalOpen
      ? h(
          Modal,
          {
            title: "Add Truck And Driver",
            description: "Create a managed truck together with its linked driver account.",
            onClose: () => setIsTruckModalOpen(false),
          },
          h(
            "form",
            { className: "manager-resource-form manager-resource-form-sidebar", onSubmit: handleAddTruck },
            h(
              "label",
              { className: "manager-rig-stat" },
              h("span", null, "Truck name"),
              h("input", {
                className: "input",
                type: "text",
                value: truckDraft.name,
                placeholder: "Auto-generate if empty",
                onInput: (event) => setTruckDraft((current) => ({ ...current, name: event.target.value })),
              }),
            ),
            h(
              "label",
              { className: "manager-rig-stat" },
              h("span", null, "Truck type"),
              h(
                "select",
                {
                  className: "input",
                  value: truckDraft.type,
                  onInput: (event) => setTruckDraft((current) => ({ ...current, type: event.target.value })),
                },
                truckTypeOptions.map((type) =>
                  h("option", { key: type, value: type }, type),
                ),
              ),
            ),
            h(
              "label",
              { className: "manager-rig-stat" },
              h("span", null, "Driver name"),
              h("input", {
                className: "input",
                type: "text",
                value: truckDraft.driverName,
                onInput: (event) => setTruckDraft((current) => ({ ...current, driverName: event.target.value })),
              }),
            ),
            h(
              "label",
              { className: "manager-rig-stat" },
              h("span", null, "Driver email"),
              h("input", {
                className: "input",
                type: "email",
                value: truckDraft.driverEmail,
                onInput: (event) => setTruckDraft((current) => ({ ...current, driverEmail: event.target.value })),
              }),
            ),
            h(
              "label",
              { className: "manager-rig-stat" },
              h("span", null, "Driver password"),
              h("input", {
                className: "input",
                type: "password",
                value: truckDraft.driverPassword,
                onInput: (event) => setTruckDraft((current) => ({ ...current, driverPassword: event.target.value })),
              }),
            ),
            h(
              "div",
              { className: "manager-resource-form-actions manager-resource-form-submit" },
              h(Button, { type: "submit", children: "Add Truck" }),
            ),
          ),
        )
      : null,
  );
}

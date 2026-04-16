import { React, h } from "../lib/react.js";
import { AppLayout } from "../layouts/AppLayout.js";
import { Button } from "../components/ui/Button.js";
import { Card, StatCard } from "../components/ui/Card.js";
import { Modal } from "../components/ui/Modal.js";
import { ProgressBar } from "../components/ui/ProgressBar.js";
import { LeafletMap } from "../components/map/LeafletMap.js";
import { ManagerRigsMap } from "../components/map/ManagerRigsMap.js";
import { ManagerRigsScene3D } from "../components/map/ManagerRigsScene3D.js";
import { formatCoordinate, formatDate, formatLocationLabel } from "../lib/format.js";
import { buildFleetAvailability } from "../features/resources/storage.js";
import { fetchLocationLabel } from "../features/rigMoves/api.js";
import { translate } from "../lib/language.js";

const { useMemo, useRef, useState } = React;

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

const DRIVER_TRUCK_TYPE_OPTIONS = ["Heavy Hauler", "Flat-bed", "Low-bed"];

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

function CollapsibleSection({ title, pill, children, defaultOpen = true }) {
  return h(
    Card,
    { className: "dashboard-section-card manager-collapsible-card" },
    h(
      "details",
      { className: "manager-section-toggle", open: defaultOpen },
      h(
        "summary",
        { className: "manager-section-summary" },
        h("div", null, h("h2", null, title)),
        pill ? h("span", { className: "section-pill" }, pill) : null,
      ),
      h("div", { className: "manager-section-body" }, children),
    ),
  );
}

function ForemanMoveList({ foreman, moves, onOpenMove }) {
  return h(
    Card,
    { className: "dashboard-section-card" },
    h(
      "div",
      { className: "section-heading" },
      h("div", null, h("h2", null, foreman.name), h("p", { className: "muted-copy" }, `${moves.length} rig ${moves.length === 1 ? "operation" : "operations"}`)),
      h("span", { className: "section-pill" }, "Read only"),
    ),
    h(
      "div",
      { className: "manager-rig-list" },
      moves.map((move) =>
        h(
          "article",
          { key: move.id, className: "manager-rig-card" },
          h(
            "div",
            { className: "manager-rig-head" },
            h(
              "div",
              null,
              h("strong", null, move.name),
              h("p", { className: "muted-copy" }, `${formatLocationLabel(move.startLabel, "Source")} to ${formatLocationLabel(move.endLabel, "Destination")}`),
            ),
            h("span", { className: "section-pill" }, getMoveStatus(move)),
          ),
          h(
            "div",
            { className: "manager-rig-stats" },
            h("div", { className: "manager-rig-stat" }, h("span", null, "Progress"), h("strong", null, `${Math.round(move.completionPercentage || 0)}%`)),
            h("div", { className: "manager-rig-stat" }, h("span", null, "Route"), h("strong", null, move.routeTime || "--")),
            h("div", { className: "manager-rig-stat" }, h("span", null, "ETA"), h("strong", null, move.eta || "--")),
            h("div", { className: "manager-rig-stat" }, h("span", null, "Loads"), h("strong", null, String(move.loadCount || 0))),
            h("div", { className: "manager-rig-stat" }, h("span", null, "Fleet"), h("strong", null, `${move.simulation?.truckCount || 0} trucks`)),
          ),
          h(ProgressBar, { value: Math.round(move.completionPercentage || 0) }),
          h(
            "div",
            { className: "manager-rig-footer" },
            h("span", { className: "muted-copy" }, `Updated ${formatDate(new Date(move.updatedAt))}`),
            h(Button, {
              type: "button",
              variant: "ghost",
              size: "sm",
              onClick: () => onOpenMove(move.id),
              children: "Inspect",
            }),
          ),
        ),
      ),
    ),
  );
}

export function ManagerDashboardPage({
  currentUser,
  currentDate,
  moves,
  foremen,
  managerResources,
  managerFleet,
  onOpenMove,
  onCreateDriver,
  onCreateForeman,
  onSaveResources,
  onLogout,
  language = "en",
  onToggleLanguage,
}) {
  const t = (key, fallback) => translate(language, key, fallback);
  const [showDriverForm, setShowDriverForm] = useState(false);
  const [showForemanForm, setShowForemanForm] = useState(false);
  const [isForemanLocationPickerOpen, setIsForemanLocationPickerOpen] = useState(false);
  const [isMapOpen, setIsMapOpen] = useState(false);
  const [viewAllMode, setViewAllMode] = useState("3d");
  const [selectedRigId, setSelectedRigId] = useState(null);
  const [driverDraft, setDriverDraft] = useState({
    name: "",
    email: "",
    password: "",
    truckType: "Heavy Hauler",
  });
  const [foremanDraft, setForemanDraft] = useState({
    name: "",
    email: "",
    password: "",
    rigName: "",
    startLabel: "",
    latitude: "",
    longitude: "",
  });
  const foremanLocationLookupRequestRef = useRef(0);

  const stats = getManagerStats(moves);
  const groupedForemen = foremen
    .map((foreman) => ({
      foreman,
      moves: moves.filter((move) => move.createdBy?.id === foreman.id),
    }))
    .filter((group) => group.moves.length);

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
  const fleetAssigned = trucks.filter((truck) => truck.status === "Assigned").length;
  const fleetFree = trucks.length - fleetAssigned;
  const driversAssigned = drivers.filter((driver) => driver.status === "Assigned").length;
  const taskSummary = getExecutionTaskSummary(moves);
  const activeForemen = foremen.filter((foreman) => moves.some((move) => move.createdBy?.id === foreman.id && move.executionState === "active")).length;

  const summaryCards = [
    { label: "Drilling Rigs", value: String(stats.drillingMoves), meta: "Already operating", tone: "green" },
    { label: "Moving Rigs", value: String(stats.activeMoves), meta: "Executing now", tone: "default" },
    { label: "Planning Rigs", value: String(stats.planningMoves), meta: "Still in planning", tone: "default" },
    { label: "Total Loads", value: String(stats.totalLoads), meta: "Across all moves", tone: "default" },
    { label: "Drivers Ready", value: String(Math.max(0, drivers.length - driversAssigned)), meta: `${drivers.length} driver accounts`, tone: "default" },
    { label: "Driver Capacity", value: String(drivers.length), meta: `${fleetAssigned} currently allocated`, tone: "default" },
    { label: "Active Drivers", value: String(driversAssigned), meta: "Linked to live tasks", tone: "default" },
    { label: "Foremen Active", value: String(activeForemen), meta: `${foremen.length} total foremen`, tone: "default" },
  ];

  const resourceCards = [
    { label: "Driver Capacity", value: String(drivers.length), meta: `${driversAssigned} assigned now` },
    { label: "Available Drivers", value: String(Math.max(0, drivers.length - driversAssigned)), meta: `${driversAssigned} assigned now` },
    { label: "Tasks Waiting", value: String((taskSummary.rigDown + taskSummary.move + taskSummary.rigUp) - taskSummary.completed), meta: "Driver app sync target" },
  ];
  const truckTypeOptions = [...new Set([...(managerFleet || []).map((truck) => truck.type), ...DRIVER_TRUCK_TYPE_OPTIONS])];
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

  async function saveResources(nextPartial) {
    const nextResources = {
      ...(managerResources || {}),
      ...nextPartial,
    };
    await onSaveResources?.(nextResources);
  }

  async function handleAddDriver(event) {
    event.preventDefault();
    const name = driverDraft.name.trim();
    const email = driverDraft.email.trim().toLowerCase();
    const password = driverDraft.password.trim();
    const truckType = driverDraft.truckType.trim();
    if (!name || !email || !password || !truckType) {
      return;
    }

    await onCreateDriver?.({
      name,
      email,
      password,
      truckType,
    });

      setDriverDraft({
        name: "",
        email: "",
        password: "",
        truckType,
      });
    setShowDriverForm(false);
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

    await onCreateForeman?.({
      name,
      email,
      password,
      assignedRig,
    });

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

  async function handleRemoveDriver(driverId) {
    await saveResources({
      drivers: (managerResources?.drivers || []).filter((driver) => driver.id !== driverId),
    });
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
              h("span", { "aria-hidden": "true" }, "←"),
            ),
            h(
              "button",
              {
                type: "button",
                className: "scene-back-button",
                onClick: () => setIsMapOpen(false),
                "aria-label": t("close", "Close"),
              },
              h("span", { "aria-hidden": "true" }, "×"),
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
      { className: "workspace-grid dashboard-grid manager-dashboard-stack" },
      h(
        "section",
        { className: "dashboard-column dashboard-column-wide manager-dashboard-main" },
        h(
          Card,
          { className: "dashboard-section-card" },
          h(
            "div",
            { className: "section-heading" },
            h("h2", null, t("managerOverview", "Manager Overview")),
            h(
              "div",
              { className: "manager-overview-actions" },
              h(Button, {
                type: "button",
                variant: "ghost",
                size: "sm",
                onClick: () => setIsMapOpen(true),
                children: t("viewAll", "View All"),
              }),
              h("span", { className: "section-pill" }, `${stats.totalMoves} ${t("rigOperations", "rig operations")}`),
            ),
          ),
          h("p", { className: "muted-copy section-spacing dashboard-existing-copy" }, t("managerOverviewCopy", "Live operations, ready trucks, and driver accounts in one view.")),
          h("div", { className: "manager-summary-grid" }, summaryCards.map((item) => h(StatCard, { key: item.label, ...item }))),
        ),
        h(
          CollapsibleSection,
          { title: t("resources", "Resources"), pill: `${fleetFree} ${t("trucksReady", "trucks ready")}`, defaultOpen: true },
          h(
            "div",
            { className: "manager-resource-toolbar" },
            h("p", { className: "muted-copy" }, t("resourcesCopy", "Create foreman and driver accounts. Drivers carry one truck type, and the planner uses that as the truck assigned to the driver.")),
            h(
              "div",
              { className: "manager-resource-actions" },
              h(Button, {
                type: "button",
                variant: showForemanForm ? "ghost" : "secondary",
                onClick: () => setShowForemanForm((value) => !value),
                children: showForemanForm ? t("closeForeman", "Close Foreman") : t("addForeman", "Add Foreman"),
              }),
              h(Button, {
                type: "button",
                variant: showDriverForm ? "ghost" : "secondary",
                onClick: () => setShowDriverForm((value) => !value),
                children: showDriverForm ? t("closeDriver", "Close Driver") : t("addDriver", "Add Driver"),
              }),
            ),
          ),
          h(
            "div",
            { className: "manager-resource-summary-grid" },
            resourceCards.map((item) =>
              h(
                "article",
                { key: item.label, className: "manager-resource-mini-card" },
                h("span", { className: "manager-resource-mini-label" }, item.label),
                h("strong", { className: "manager-resource-mini-value" }, item.value),
                h("span", { className: "manager-resource-mini-meta" }, item.meta),
              ),
            ),
          ),
          showDriverForm
            ? h(
                "form",
                { className: "manager-resource-form", onSubmit: handleAddDriver },
                h(
                  "label",
                  { className: "manager-rig-stat" },
                  h("span", null, t("driverName", "Driver name")),
                  h("input", {
                    className: "input",
                    type: "text",
                    value: driverDraft.name,
                    onInput: (event) => setDriverDraft((current) => ({ ...current, name: event.target.value })),
                  }),
                ),
                h(
                  "label",
                  { className: "manager-rig-stat" },
                  h("span", null, t("email", "Email")),
                  h("input", {
                    className: "input",
                    type: "email",
                    value: driverDraft.email,
                    onInput: (event) => setDriverDraft((current) => ({ ...current, email: event.target.value })),
                  }),
                ),
                h(
                  "label",
                  { className: "manager-rig-stat" },
                  h("span", null, t("password", "Password")),
                  h("input", {
                    className: "input",
                    type: "password",
                    value: driverDraft.password,
                    onInput: (event) => setDriverDraft((current) => ({ ...current, password: event.target.value })),
                  }),
                ),
                h(
                  "label",
                  { className: "manager-rig-stat" },
                  h("span", null, t("truckType", "Truck type")),
                  h(
                    "select",
                    {
                      className: "input",
                      value: driverDraft.truckType,
                      onInput: (event) =>
                        setDriverDraft((current) => ({
                          ...current,
                          truckType: event.target.value,
                          truckId: "",
                        })),
                    },
                    truckTypeOptions.map((type) =>
                      h("option", { key: type, value: type }, type),
                    ),
                  ),
                ),
                h(
                  "div",
                  { className: "manager-resource-form-actions" },
                  h(Button, { type: "submit", children: t("createDriver", "Create Driver") }),
                ),
              )
            : null,
          showForemanForm
            ? h(
                "form",
                { className: "manager-resource-form", onSubmit: handleAddForeman },
                h(
                  "label",
                  { className: "manager-rig-stat" },
                  h("span", null, t("foremanName", "Foreman name")),
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
                  h("span", null, t("email", "Email")),
                  h("input", {
                    className: "input",
                    type: "email",
                    value: foremanDraft.email,
                    onInput: (event) => setForemanDraft((current) => ({ ...current, email: event.target.value })),
                  }),
                ),
                h(
                  "label",
                  { className: "manager-rig-stat" },
                  h("span", null, t("password", "Password")),
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
                  h("span", null, t("assignedRig", "Assigned Rig")),
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
                  h("span", null, t("currentRigLocation", "Current Rig Location")),
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
                      children: foremanDraft.latitude && foremanDraft.longitude ? t("change", "Change") : t("select", "Select"),
                    }),
                  ),
                ),
                h(
                  "label",
                  { className: "manager-rig-stat" },
                  h("span", null, t("latitude", "Latitude")),
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
                  h("span", null, t("longitude", "Longitude")),
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
                  h(Button, { type: "submit", children: t("createForeman", "Create Foreman") }),
                ),
              )
            : null,
          h(
            "div",
            { className: "manager-resource-section" },
            h("div", { className: "section-heading" }, h("h3", null, t("foremen", "Foremen")), h("span", { className: "section-pill" }, `${foremen.length} ${t("accounts", "accounts")}`)),
            foremen.length
              ? h(
                  "div",
                  { className: "manager-resource-grid" },
                  foremen.map((foreman) =>
                    h(
                      "article",
                      { key: foreman.id, className: "manager-resource-card" },
                      h(
                        "div",
                        { className: "manager-resource-card-head" },
                        h("div", null, h("strong", null, foreman.name), h("p", { className: "muted-copy" }, foreman.email || "--")),
                        h("span", { className: "manager-resource-status manager-resource-status-available" }, t("active", "Active")),
                      ),
                      h(
                        "div",
                        { className: "manager-resource-tags" },
                        h("span", { className: "manager-resource-tag" }, foreman.assignedRig?.name || t("unassigned", "Unassigned")),
                        h("span", { className: "manager-resource-tag manager-resource-tag-muted" }, t("foreman", "Foreman")),
                      ),
                      h(
                        "div",
                        { className: "manager-resource-metrics" },
                        h("div", { className: "manager-rig-stat" }, h("span", null, t("moves", "Moves")), h("strong", null, String(moves.filter((move) => move.createdBy?.id === foreman.id).length))),
                        h("div", { className: "manager-rig-stat" }, h("span", null, t("assignedRig", "Assigned rig")), h("strong", null, foreman.assignedRig?.name || t("notSet", "Not set"))),
                      ),
                    ),
                  ),
                )
              : h("p", { className: "muted-copy" }, t("noForemanAccountsYet", "No foreman accounts yet.")),
          ),
          h(
            "div",
            { className: "manager-resource-section" },
            h("div", { className: "section-heading" }, h("h3", null, t("drivers", "Drivers")), h("span", { className: "section-pill" }, `${drivers.length} ${t("accounts", "accounts")}`)),
            drivers.length
              ? h(
                  "div",
                  { className: "manager-resource-grid" },
                  drivers.map((driver) =>
                    h(
                      "article",
                      { key: driver.id, className: "manager-resource-card" },
                      h(
                        "div",
                        { className: "manager-resource-card-head" },
                        h("div", null, h("strong", null, driver.name), h("p", { className: "muted-copy" }, driver.email)),
                        h("span", { className: `manager-resource-status manager-resource-status-${driver.status.toLowerCase()}` }, driver.status),
                      ),
                      h(
                        "div",
                        { className: "manager-resource-tags" },
                        h("span", { className: "manager-resource-tag" }, driver.truckType),
                        h("span", { className: "manager-resource-tag manager-resource-tag-muted" }, driver.linkedTruck?.name || `${driver.name} truck`),
                      ),
                      h(
                        "div",
                        { className: "manager-resource-metrics" },
                        h("div", { className: "manager-rig-stat" }, h("span", null, t("driverTruck", "Driver truck")), h("strong", null, driver.linkedTruck?.type || driver.truckType)),
                        h("div", { className: "manager-rig-stat" }, h("span", null, t("taskObject", "Task object")), h("strong", null, driver.status === "Assigned" ? t("liveTask", "Live task") : t("waiting", "Waiting"))),
                      ),
                      h(
                        "div",
                        { className: "manager-resource-card-actions" },
                        h(Button, {
                          type: "button",
                          variant: "ghost",
                          size: "sm",
                          onClick: () => handleRemoveDriver(driver.id),
                          children: t("remove", "Remove"),
                        }),
                      ),
                    ),
                  ),
                )
              : h("p", { className: "muted-copy" }, t("noDriverAccountsYet", "No driver accounts yet.")),
          ),
        ),
        h(
          CollapsibleSection,
          { title: t("moves", "Moves"), pill: `${stats.activeMoves} ${t("active", "active")}`, defaultOpen: true },
          groupedForemen.length
            ? groupedForemen.map((group) =>
                h(ForemanMoveList, {
                  key: group.foreman.id,
                  foreman: group.foreman,
                  moves: group.moves,
                  onOpenMove,
                }),
              )
            : h(
                Card,
                { className: "empty-state section-spacing" },
                h("h3", null, "No foreman rig operations yet"),
                h("p", { className: "muted-copy" }, "Once a foreman creates a rig move, it will appear here automatically."),
              ),
        ),
      ),
    ),
    isForemanLocationPickerOpen
      ? h(
          Modal,
          {
            title: t("selectCurrentRigLocation", "Select current rig location"),
            description: t("selectCurrentRigLocationCopy", "Click the map to place the foreman's current rig location."),
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
  );
}

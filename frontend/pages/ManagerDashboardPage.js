import { React, h } from "../lib/react.js";
import { AppLayout } from "../layouts/AppLayout.js";
import { Button } from "../components/ui/Button.js";
import { Card, StatCard } from "../components/ui/Card.js";
import { ProgressBar } from "../components/ui/ProgressBar.js";
import { formatDate, formatLocationLabel } from "../lib/format.js";
import { buildFleetAvailability } from "../features/resources/storage.js";

const { useMemo, useState } = React;

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
  onSaveResources,
  onLogout,
}) {
  const [showDriverForm, setShowDriverForm] = useState(false);
  const [driverDraft, setDriverDraft] = useState({
    name: "",
    email: "",
    password: "",
    truckType: "Heavy Hauler",
  });

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

  async function handleRemoveDriver(driverId) {
    await saveResources({
      drivers: (managerResources?.drivers || []).filter((driver) => driver.id !== driverId),
    });
  }

  return h(
    AppLayout,
    {
      title: `Manager view, ${currentUser?.name || "Supervisor"}`,
      subtitle: formatDate(currentDate),
      currentUser,
      onLogout,
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
          h("div", { className: "section-heading" }, h("h2", null, "Manager Overview"), h("span", { className: "section-pill" }, `${stats.totalMoves} rig operations`)),
          h("p", { className: "muted-copy section-spacing dashboard-existing-copy" }, "Live operations, ready trucks, and driver accounts in one view."),
          h("div", { className: "manager-summary-grid" }, summaryCards.map((item) => h(StatCard, { key: item.label, ...item }))),
        ),
        h(
          CollapsibleSection,
          { title: "Resources", pill: `${fleetFree} trucks ready`, defaultOpen: true },
          h(
            "div",
            { className: "manager-resource-toolbar" },
            h("p", { className: "muted-copy" }, "Create driver accounts only. Each driver carries one truck type, and the planner uses that as the truck assigned to the driver."),
            h(
              "div",
              { className: "manager-resource-actions" },
              h(Button, {
                type: "button",
                variant: showDriverForm ? "ghost" : "secondary",
                onClick: () => setShowDriverForm((value) => !value),
                children: showDriverForm ? "Close Driver" : "Add Driver",
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
                  h("span", null, "Driver name"),
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
                  h("span", null, "Email"),
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
                  h("span", null, "Password"),
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
                  h("span", null, "Truck type"),
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
                  h(Button, { type: "submit", children: "Create Driver" }),
                ),
              )
            : null,
          h(
            "div",
            { className: "manager-resource-section" },
            h("div", { className: "section-heading" }, h("h3", null, "Drivers"), h("span", { className: "section-pill" }, `${drivers.length} accounts`)),
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
                        h("div", { className: "manager-rig-stat" }, h("span", null, "Driver truck"), h("strong", null, driver.linkedTruck?.type || driver.truckType)),
                        h("div", { className: "manager-rig-stat" }, h("span", null, "Task object"), h("strong", null, driver.status === "Assigned" ? "Live task" : "Waiting")),
                      ),
                      h(
                        "div",
                        { className: "manager-resource-card-actions" },
                        h(Button, {
                          type: "button",
                          variant: "ghost",
                          size: "sm",
                          onClick: () => handleRemoveDriver(driver.id),
                          children: "Remove",
                        }),
                      ),
                    ),
                  ),
                )
              : h("p", { className: "muted-copy" }, "No driver accounts yet."),
          ),
        ),
        h(
          CollapsibleSection,
          { title: "Moves", pill: `${stats.activeMoves} active`, defaultOpen: true },
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
  );
}

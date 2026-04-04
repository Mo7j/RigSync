import { React, h } from "../lib/react.js";
import { AppLayout } from "../layouts/AppLayout.js";
import { Button } from "../components/ui/Button.js";
import { Card, StatCard } from "../components/ui/Card.js";
import { ProgressBar } from "../components/ui/ProgressBar.js";
import { formatDate, formatLocationLabel } from "../lib/format.js";
import { buildFleetAvailability } from "../features/resources/storage.js";

const { useEffect, useMemo, useState } = React;

function formatMoney(value) {
  const amount = Math.max(0, Number(value) || 0);
  return `$${amount.toFixed(amount % 1 === 0 ? 0 : 2)}/hr`;
}

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
  managerFleet,
  onOpenMove,
  onSaveFleet,
  onLogout,
}) {
  const [fleetDraft, setFleetDraft] = useState(managerFleet || []);
  const [isFleetDirty, setIsFleetDirty] = useState(false);

  useEffect(() => {
    if (!isFleetDirty) {
      setFleetDraft(managerFleet || []);
    }
  }, [managerFleet, isFleetDirty]);

  const stats = getManagerStats(moves);
  const groupedForemen = foremen
    .map((foreman) => ({
      foreman,
      moves: moves.filter((move) => move.createdBy?.id === foreman.id),
    }))
    .filter((group) => group.moves.length);
  const fleetAvailability = useMemo(
    () => buildFleetAvailability({ managerFleet: fleetDraft, moves }),
    [fleetDraft, moves],
  );
  const totalFleet = fleetDraft.reduce((sum, truck) => sum + Math.max(0, Number.parseInt(truck.count, 10) || 0), 0);
  const fleetAssigned = fleetAvailability.reduce((sum, truck) => sum + Math.max(0, Number.parseInt(truck.allocated, 10) || 0), 0);
  const fleetFree = fleetAvailability.reduce((sum, truck) => sum + Math.max(0, Number.parseInt(truck.available, 10) || 0), 0);
  const activeForemen = foremen.filter((foreman) => moves.some((move) => move.createdBy?.id === foreman.id && move.executionState === "active")).length;
  const summaryCards = [
    { label: "Drilling Rigs", value: String(stats.drillingMoves), meta: "Already operating", tone: "green" },
    { label: "Moving Rigs", value: String(stats.activeMoves), meta: "Executing now", tone: "default" },
    { label: "Planning Rigs", value: String(stats.planningMoves), meta: "Still in planning", tone: "default" },
    { label: "Total Loads", value: String(stats.totalLoads), meta: "Across all moves", tone: "default" },
    { label: "Fleet Total", value: String(totalFleet), meta: "All trucks in pool", tone: "default" },
    { label: "Fleet Assigned", value: String(fleetAssigned), meta: "Reserved on active moves", tone: "default" },
    { label: "Fleet Free", value: String(fleetFree), meta: "Ready to assign", tone: "default" },
    { label: "Foremen Active", value: String(activeForemen), meta: `${foremen.length} total foremen`, tone: "default" },
  ];

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
          h("p", { className: "muted-copy section-spacing dashboard-existing-copy" }, "Truck-focused view of live rig status and fleet availability."),
          h("div", { className: "manager-summary-grid" }, summaryCards.map((item) => h(StatCard, { key: item.label, ...item }))),
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
        h(
          CollapsibleSection,
          { title: "Fleet Resources", pill: `${fleetFree} free / ${fleetAssigned} assigned`, defaultOpen: true },
          h("p", { className: "muted-copy" }, "Control the truck pool your team can plan and execute against."),
          h(
            "div",
            { className: "manager-rig-list section-spacing" },
            fleetDraft.map((truck) => {
              const availability = fleetAvailability.find((item) => item.id === truck.id) || { allocated: 0, available: truck.count };

              return h(
                "div",
                { key: truck.id, className: "manager-rig-card" },
                h(
                  "div",
                  { className: "manager-rig-head" },
                  h("strong", null, truck.type),
                  h("span", { className: "section-pill" }, `${availability.available} free`),
                ),
                h(
                  "div",
                  { className: "manager-rig-stats manager-resource-stats" },
                  h("div", { className: "manager-rig-stat" }, h("span", null, "Total"), h("strong", null, String(truck.count))),
                  h("div", { className: "manager-rig-stat" }, h("span", null, "Assigned"), h("strong", null, String(availability.allocated || 0))),
                  h("div", { className: "manager-rig-stat" }, h("span", null, "Hourly Cost"), h("strong", null, formatMoney(truck.hourlyCost || 0))),
                ),
                h(
                  "div",
                  { className: "manager-resource-inputs" },
                  h(
                    "label",
                    { className: "manager-rig-stat" },
                    h("span", null, "Available to assign"),
                    h("input", {
                      className: "input",
                      type: "number",
                      min: "0",
                      value: truck.count,
                      onInput: (event) => {
                        setIsFleetDirty(true);
                        setFleetDraft((current) =>
                          current.map((item) =>
                            item.id === truck.id
                              ? { ...item, count: Math.max(0, Number.parseInt(event.target.value, 10) || 0) }
                              : item,
                          ),
                        );
                      },
                    }),
                  ),
                  h(
                    "label",
                    { className: "manager-rig-stat" },
                    h("span", null, "Hourly cost"),
                    h("input", {
                      className: "input",
                      type: "number",
                      min: "0",
                      step: "0.01",
                      value: truck.hourlyCost ?? 0,
                      onInput: (event) => {
                        setIsFleetDirty(true);
                        setFleetDraft((current) =>
                          current.map((item) =>
                            item.id === truck.id
                              ? { ...item, hourlyCost: Math.max(0, Number.parseFloat(event.target.value) || 0) }
                              : item,
                          ),
                        );
                      },
                    }),
                  ),
                ),
              );
            }),
          ),
          h(
            "div",
            { className: "auth-actions section-spacing" },
            h(Button, {
              type: "button",
              onClick: async () => {
                await onSaveFleet?.(fleetDraft);
                setIsFleetDirty(false);
              },
              children: "Save Fleet",
            }),
          ),
        ),
      ),
    ),
  );
}

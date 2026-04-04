import { React, h } from "../lib/react.js";
import { AppLayout } from "../layouts/AppLayout.js";
import { Button } from "../components/ui/Button.js";
import { Card, StatCard } from "../components/ui/Card.js";
import { ProgressBar } from "../components/ui/ProgressBar.js";
import { formatDate, formatLocationLabel, formatMinutes } from "../lib/format.js";

const { useEffect, useState } = React;

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
  const totalLoads = moves.reduce((sum, move) => sum + (move.loadCount || move.simulation?.bestPlan?.playback?.trips?.length || 0), 0);

  return {
    totalMoves,
    activeMoves,
    drillingMoves,
    totalLoads,
  };
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
            h("span", { className: "muted-copy" }, `Updated ${move.createdLabel || formatDate(new Date(move.updatedAt))}`),
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
  managerWorkers = 0,
  workerRoles = [],
  onOpenMove,
  onSaveFleet,
  onSaveWorkers,
  onLogout,
}) {
  const [fleetDraft, setFleetDraft] = useState(managerFleet || []);
  const [workerDraft, setWorkerDraft] = useState(managerWorkers || {});
  const [isFleetDirty, setIsFleetDirty] = useState(false);
  const [isWorkerDirty, setIsWorkerDirty] = useState(false);

  useEffect(() => {
    if (!isFleetDirty) {
      setFleetDraft(managerFleet || []);
    }
  }, [managerFleet, isFleetDirty]);

  useEffect(() => {
    if (!isWorkerDirty) {
      setWorkerDraft(managerWorkers || {});
    }
  }, [managerWorkers, isWorkerDirty]);

  const stats = getManagerStats(moves);
  const groupedForemen = foremen
    .map((foreman) => ({
      foreman,
      moves: moves.filter((move) => move.createdBy?.id === foreman.id),
    }))
    .filter((group) => group.moves.length);

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
      { className: "workspace-grid dashboard-grid" },
      h(
        "section",
        { className: "dashboard-column dashboard-column-wide" },
        h(
          Card,
          { className: "dashboard-section-card" },
          h("div", { className: "section-heading" }, h("h2", null, "Foreman Fleet Overview"), h("span", { className: "section-pill" }, `${foremen.length} foremen`)),
          h("p", { className: "muted-copy section-spacing dashboard-existing-copy" }, "You can inspect every rig operation under your team, but control remains with each foreman."),
          h(
            "div",
            { className: "rig-load-grid" },
            h(StatCard, { label: "Rig Operations", value: String(stats.totalMoves), meta: "All assigned foremen", tone: "default" }),
            h(StatCard, { label: "Active", value: String(stats.activeMoves), meta: "Currently in motion", tone: "default" }),
            h(StatCard, { label: "Drilling", value: String(stats.drillingMoves), meta: "Moved and operating", tone: "green" }),
            h(StatCard, { label: "Loads", value: String(stats.totalLoads), meta: "Across all rigs", tone: "default" }),
          ),
        ),
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
              { className: "empty-state" },
              h("h3", null, "No foreman rig operations yet"),
              h("p", { className: "muted-copy" }, "Once a foreman creates a rig move, it will appear here automatically as a read-only operation."),
            ),
      ),
      h(
        "aside",
        { className: "dashboard-column" },
        h(
          Card,
          { className: "dashboard-section-card" },
          h("div", { className: "section-heading" }, h("h2", null, "Resources")),
          h("p", { className: "muted-copy section-spacing" }, "Control the shared fleet and worker capacity your team can plan and execute against."),
          h(
            "div",
            { className: "section-heading section-spacing" },
            h("h3", null, "Fleet"),
            h("span", { className: "section-pill" }, "Manager control"),
          ),
          h("p", { className: "muted-copy" }, "Set the truck pool your foremen can assign by type."),
          h(
            "div",
            { className: "manager-rig-list section-spacing" },
            fleetDraft.map((truck) =>
              h(
                "div",
                { key: truck.id, className: "manager-rig-card" },
                h(
                  "div",
                  { className: "manager-rig-head" },
                  h("strong", null, truck.type),
                  h("span", { className: "section-pill" }, "Fleet role"),
                ),
                h(
                  "label",
                  { className: "manager-rig-stat" },
                  h("span", null, "Available to assign"),
                  h("input", {
                    className: "input",
                    type: "number",
                    min: "0",
                    value: truck.count,
                    onInput: (event) =>
                      {
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
                  { className: "manager-rig-stat section-spacing" },
                  h("span", null, "Hourly cost"),
                  h("input", {
                    className: "input",
                    type: "number",
                    min: "0",
                    step: "0.01",
                    value: truck.hourlyCost ?? 0,
                    onInput: (event) =>
                      {
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
            ),
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
          h(
            "div",
            { className: "section-heading section-spacing" },
            h("h3", null, "Workers"),
            h("span", { className: "section-pill" }, "Role capacity"),
          ),
          h("p", { className: "muted-copy" }, "Set the worker capacity the manager controls by role from the dataset."),
          ...(workerRoles.length ? workerRoles : Object.keys(workerDraft).map((roleId) => ({ id: roleId, label: roleId }))).map((role) =>
            h("div", { key: role.id, className: "manager-rig-card section-spacing" },
              h(
                "div",
                { className: "manager-rig-head" },
                h("strong", null, role.label),
                h("span", { className: "section-pill" }, "Worker role"),
              ),
              h(
                "label",
                { className: "manager-rig-stat" },
                h("span", null, "Available workers"),
                h("input", {
                  className: "input",
                  type: "number",
                  min: "0",
                  value: workerDraft[role.id]?.count ?? 0,
                  onInput: (event) =>
                    {
                      setIsWorkerDirty(true);
                      setWorkerDraft((current) => ({
                        ...current,
                        [role.id]: {
                          count: Math.max(0, Number.parseInt(event.target.value, 10) || 0),
                          hourlyCost: Math.max(0, Number.parseFloat(current[role.id]?.hourlyCost) || 0),
                        },
                      }));
                    },
                }),
              ),
              h(
                "label",
                { className: "manager-rig-stat section-spacing" },
                h("span", null, "Hourly cost"),
                h("input", {
                  className: "input",
                  type: "number",
                  min: "0",
                  step: "0.01",
                  value: workerDraft[role.id]?.hourlyCost ?? 0,
                  onInput: (event) =>
                    {
                      setIsWorkerDirty(true);
                      setWorkerDraft((current) => ({
                        ...current,
                        [role.id]: {
                          count: Math.max(0, Number.parseInt(current[role.id]?.count, 10) || 0),
                          hourlyCost: Math.max(0, Number.parseFloat(event.target.value) || 0),
                        },
                      }));
                    },
                }),
              ),
            ),
          ),
          h(
            "div",
            { className: "auth-actions" },
            h(Button, {
              type: "button",
              onClick: async () => {
                await onSaveWorkers?.(workerDraft);
                setIsWorkerDirty(false);
              },
              children: "Save Roles",
            }),
          ),
        ),
        h(
          Card,
          { className: "dashboard-section-card" },
          h("div", { className: "section-heading" }, h("h2", null, "Team Coverage")),
          h(
            "div",
            { className: "manager-team-list" },
            foremen.map((foreman) => {
              const foremanMoves = moves.filter((move) => move.createdBy?.id === foreman.id);
              const activeForemanMoves = foremanMoves.filter((move) => move?.executionState === "active").length;

              return h(
                "div",
                { key: foreman.id, className: "manager-team-row" },
                h(
                  "div",
                  null,
                  h("strong", null, foreman.name),
                  h("p", { className: "muted-copy" }, `${foremanMoves.length} assigned rig ${foremanMoves.length === 1 ? "move" : "moves"}`),
                ),
                h(
                  "div",
                  { className: "manager-team-meta" },
                  h("span", null, activeForemanMoves ? `${activeForemanMoves} active` : "Monitoring"),
                ),
              );
            }),
          ),
        ),
        h(
          Card,
          { className: "dashboard-section-card" },
          h("div", { className: "section-heading" }, h("h2", null, "Manager Notes")),
          h(
            "div",
            { className: "manager-note-list" },
            h("p", { className: "muted-copy" }, "Inspection mode hides execution controls, plan switching, fleet editing, and delete actions."),
            h("p", { className: "muted-copy" }, "Open any rig to review route, site progress, fleet state, and current completion without changing the plan."),
            h("p", { className: "muted-copy" }, `Average route time: ${moves.length ? formatMinutes(Math.round(moves.reduce((sum, move) => sum + (move.simulation?.routeMinutes || 0), 0) / moves.length)) : "--"}`),
          ),
        ),
      ),
    ),
  );
}

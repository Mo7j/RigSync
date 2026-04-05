import { h } from "../lib/react.js";
import { AppLayout } from "../layouts/AppLayout.js";
import { Button } from "../components/ui/Button.js";
import { Card, StatCard } from "../components/ui/Card.js";
import { formatDate, formatLocationLabel } from "../lib/format.js";

function getStageTitle(stage) {
  if (stage === "rigDown") {
    return "Rig Down";
  }
  if (stage === "rigMove") {
    return "Rig Move";
  }
  if (stage === "rigUp") {
    return "Rig Up";
  }
  return "Completed";
}

function getNextStage(stageStatus = {}) {
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

function getStatusLabel(status) {
  if (status === "completed") {
    return "Completed";
  }
  if (status === "active") {
    return "Live task";
  }
  return "Queued";
}

export function DriverDashboardPage({
  currentUser,
  currentDate,
  assignments,
  onCompleteStage,
  onLogout,
}) {
  const activeAssignments = (assignments || []).filter((assignment) => assignment.status !== "completed");
  const completedAssignments = (assignments || []).filter((assignment) => assignment.status === "completed");
  const orderedAssignments = [...activeAssignments].sort((left, right) => (left.sequence || 0) - (right.sequence || 0));
  const visibleAssignments = orderedAssignments.slice(0, 1);
  const queuedCount = Math.max(0, orderedAssignments.length - visibleAssignments.length);
  const nextStageCounts = {
    rigDown: activeAssignments.filter((assignment) => getNextStage(assignment.stageStatus) === "rigDown").length,
    rigMove: activeAssignments.filter((assignment) => getNextStage(assignment.stageStatus) === "rigMove").length,
    rigUp: activeAssignments.filter((assignment) => getNextStage(assignment.stageStatus) === "rigUp").length,
  };

  return h(
    AppLayout,
    {
      title: `${currentUser?.name || "Driver"} • Driver tasks`,
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
          h("div", { className: "section-heading" }, h("h2", null, "Driver Overview"), h("span", { className: "section-pill" }, `${activeAssignments.length} active tasks`)),
          h("p", { className: "muted-copy section-spacing" }, "Complete each assigned task in order: rig down, rig move, then rig up."),
          h(
            "div",
            { className: "manager-summary-grid" },
            h(StatCard, { label: "Rig Down", value: String(nextStageCounts.rigDown), meta: "Waiting on first stage", tone: "default" }),
            h(StatCard, { label: "Rig Move", value: String(nextStageCounts.rigMove), meta: "Ready to transport", tone: "default" }),
            h(StatCard, { label: "Rig Up", value: String(nextStageCounts.rigUp), meta: "Ready to finish", tone: "green" }),
            h(StatCard, { label: "Completed", value: String(completedAssignments.length), meta: "Closed driver tasks", tone: "default" }),
          ),
        ),
        h(
          Card,
          { className: "dashboard-section-card" },
          h("div", { className: "section-heading" }, h("h2", null, "Current Trip"), h("span", { className: "section-pill" }, currentUser?.truckType || "Driver truck")),
          queuedCount
            ? h("p", { className: "muted-copy section-spacing" }, `${queuedCount} more trip${queuedCount === 1 ? "" : "s"} queued after this one.`)
            : null,
          visibleAssignments.length
            ? h(
                "div",
                { className: "manager-rig-list" },
                visibleAssignments.map((assignment) => {
                  const nextStage = getNextStage(assignment.stageStatus);
                  return h(
                    "article",
                    { key: assignment.id, className: "manager-rig-card driver-task-card" },
                    h(
                      "div",
                      { className: "manager-rig-head" },
                      h(
                        "div",
                        null,
                        h("strong", null, assignment.tripLabel || assignment.moveName || "Assigned trip"),
                        h("p", { className: "muted-copy" }, `${assignment.loadCode || assignment.loadId ? `Load ${assignment.loadCode || `#${assignment.loadId}`}` : "Transfer load"} • Trip ${assignment.tripNumber}/${assignment.plannedTripCount}`),
                      ),
                      h("span", { className: "section-pill" }, assignment.status === "active" ? getStageTitle(nextStage) : getStatusLabel(assignment.status)),
                    ),
                    h(
                      "div",
                      { className: "manager-rig-stats" },
                      h("div", { className: "manager-rig-stat" }, h("span", null, "Truck type"), h("strong", null, assignment.truckType || currentUser?.truckType || "--")),
                      h("div", { className: "manager-rig-stat" }, h("span", null, "Driver"), h("strong", null, assignment.driverName || currentUser?.name || "--")),
                      h("div", { className: "manager-rig-stat" }, h("span", null, "Route"), h("strong", null, `${formatLocationLabel(assignment.startLabel, "Source")} to ${formatLocationLabel(assignment.endLabel, "Destination")}`)),
                      h("div", { className: "manager-rig-stat" }, h("span", null, "Rig Down"), h("strong", null, assignment.stageStatus?.rigDownCompleted ? "Done" : "Pending")),
                      h("div", { className: "manager-rig-stat" }, h("span", null, "Rig Move"), h("strong", null, assignment.stageStatus?.rigMoveCompleted ? "Done" : "Pending")),
                      h("div", { className: "manager-rig-stat" }, h("span", null, "Rig Up"), h("strong", null, assignment.stageStatus?.rigUpCompleted ? "Done" : "Pending")),
                    ),
                    h(
                      "div",
                      { className: "driver-task-actions" },
                      h(Button, {
                        type: "button",
                        variant: nextStage === "rigDown" ? "primary" : "ghost",
                        disabled: assignment.status !== "active" || nextStage !== "rigDown",
                        onClick: () => onCompleteStage?.({ assignmentId: assignment.id, stage: "rigDown" }),
                        children: "Rig Down Complete",
                      }),
                      h(Button, {
                        type: "button",
                        variant: nextStage === "rigMove" ? "primary" : "ghost",
                        disabled: assignment.status !== "active" || nextStage !== "rigMove",
                        onClick: () => onCompleteStage?.({ assignmentId: assignment.id, stage: "rigMove" }),
                        children: "Rig Move Complete",
                      }),
                      h(Button, {
                        type: "button",
                        variant: nextStage === "rigUp" ? "primary" : "ghost",
                        disabled: assignment.status !== "active" || nextStage !== "rigUp",
                        onClick: () => onCompleteStage?.({ assignmentId: assignment.id, stage: "rigUp" }),
                        children: "Rig Up Complete",
                      }),
                    ),
                  );
                }),
              )
            : h("p", { className: "muted-copy" }, "No assigned trips yet. Trips will appear after a foreman starts execution."),
        ),
      ),
    ),
  );
}

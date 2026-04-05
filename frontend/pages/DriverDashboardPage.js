import { React, h } from "../lib/react.js";
import { AppLayout } from "../layouts/AppLayout.js";
import { Button } from "../components/ui/Button.js";
import { Card, StatCard } from "../components/ui/Card.js";
import { formatDate, formatLocationLabel, formatMinutes } from "../lib/format.js";
import { translate } from "../lib/language.js";

const { useEffect, useState } = React;

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

function getElapsedMinutes(assignment, nowTs) {
  const executionStartedAt = assignment?.executionStartedAt || assignment?.assignedAt;
  if (!executionStartedAt) {
    return 0;
  }
  return Math.max(0, (nowTs - new Date(executionStartedAt).getTime()) / 60000);
}

function getStageDeadline(assignment, stage) {
  return Number.isFinite(Number(assignment?.stagePlan?.[stage]?.finishMinute))
    ? Number(assignment.stagePlan[stage].finishMinute)
    : null;
}

function getStageLateness(assignment, stage, nowTs) {
  const deadline = getStageDeadline(assignment, stage);
  if (deadline == null) {
    return 0;
  }
  return Math.max(0, Math.round(getElapsedMinutes(assignment, nowTs) - deadline));
}

function buildStageStatusLabel({ assignment, stage, nowTs, t }) {
  const completed = assignment?.stageStatus?.[`${stage}Completed`];
  if (completed) {
    const note = assignment?.stageDelayNotes?.[stage];
    if (note?.lateMinutes > 20) {
      return `${t("done", "Done")} • +${note.lateMinutes}m`;
    }
    return t("done", "Done");
  }

  const deadline = getStageDeadline(assignment, stage);
  if (deadline == null) {
    return t("pending", "Pending");
  }

  const remaining = Math.round(deadline - getElapsedMinutes(assignment, nowTs));
  if (remaining >= 0) {
    return `${formatMinutes(remaining)} ${t("left", "left")}`;
  }

  return `+${Math.abs(remaining)}m ${t("late", "late")}`;
}

function PhaseRow({ assignment, stage, isCurrent, nowTs, t }) {
  const deadline = getStageDeadline(assignment, stage);
  const note = assignment?.stageDelayNotes?.[stage];

  return h(
    "div",
    {
      className: `manager-rig-stat driver-phase-stat${isCurrent ? " driver-phase-stat-current" : ""}`,
    },
    h("span", null, t(stage, getStageTitle(stage))),
    h(
      "strong",
      null,
      buildStageStatusLabel({ assignment, stage, nowTs, t }),
    ),
    deadline != null
      ? h(
          "small",
          { className: "muted-copy" },
          `${t("eta", "ETA")} ${formatMinutes(Math.round(deadline))}`,
        )
      : null,
    note?.reason
      ? h(
          "small",
          { className: "muted-copy" },
          `${t("delayReason", "Delay reason")}: ${note.reason}`,
        )
      : null,
  );
}

export function DriverDashboardPage({
  currentUser,
  currentDate,
  assignments,
  onCompleteStage,
  onLogout,
  language = "en",
  onToggleLanguage,
}) {
  const t = (key, fallback) => translate(language, key, fallback);
  const [nowTs, setNowTs] = useState(Date.now());
  const [delayReasonDraft, setDelayReasonDraft] = useState("");
  const [delayError, setDelayError] = useState("");

  useEffect(() => {
    const timer = window.setInterval(() => {
      setNowTs(Date.now());
    }, 1000);
    return () => window.clearInterval(timer);
  }, []);

  const activeAssignments = (assignments || []).filter((assignment) => assignment.status !== "completed");
  const completedAssignments = (assignments || []).filter((assignment) => assignment.status === "completed");
  const orderedAssignments = [...activeAssignments].sort((left, right) => (left.sequence || 0) - (right.sequence || 0));
  const visibleAssignments = orderedAssignments.slice(0, 1);
  const queuedCount = Math.max(0, orderedAssignments.length - visibleAssignments.length);
  const currentAssignment = visibleAssignments[0] || null;
  const currentStage = currentAssignment ? getNextStage(currentAssignment.stageStatus) : "completed";
  const currentLateMinutes =
    currentAssignment && currentStage !== "completed"
      ? getStageLateness(currentAssignment, currentStage, nowTs)
      : 0;
  const needsDelayReason = currentLateMinutes > 20;
  const nextStageCounts = {
    rigDown: activeAssignments.filter((assignment) => getNextStage(assignment.stageStatus) === "rigDown").length,
    rigMove: activeAssignments.filter((assignment) => getNextStage(assignment.stageStatus) === "rigMove").length,
    rigUp: activeAssignments.filter((assignment) => getNextStage(assignment.stageStatus) === "rigUp").length,
  };

  async function handleStageComplete(stage) {
    if (!currentAssignment) {
      return;
    }

    if (needsDelayReason && !delayReasonDraft.trim()) {
      setDelayError(t("delayReasonRequired", "Enter a delay reason once the phase is more than 20 minutes late."));
      return;
    }

    setDelayError("");
    await onCompleteStage?.({
      assignmentId: currentAssignment.id,
      stage,
      delayReason: needsDelayReason ? delayReasonDraft.trim() : "",
    });
    setDelayReasonDraft("");
  }

  return h(
    AppLayout,
    {
      title: `${currentUser?.name || t("driver", "Driver")} • ${t("driverTasks", "Driver tasks")}`,
      subtitle: formatDate(currentDate),
      currentUser,
      onLogout,
      language,
      onToggleLanguage,
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
          h("div", { className: "section-heading" }, h("h2", null, t("driverOverview", "Driver Overview")), h("span", { className: "section-pill" }, `${activeAssignments.length} ${t("activeTasks", "active tasks")}`)),
          h("p", { className: "muted-copy section-spacing" }, t("completeAssignedTask", "Complete each assigned task in order: rig down, rig move, then rig up.")),
          h(
            "div",
            { className: "manager-summary-grid" },
            h(StatCard, { label: t("rigDown", "Rig Down"), value: String(nextStageCounts.rigDown), meta: t("waitingOnFirstStage", "Waiting on first stage"), tone: "default" }),
            h(StatCard, { label: t("rigMove", "Rig Move"), value: String(nextStageCounts.rigMove), meta: t("readyToTransport", "Ready to transport"), tone: "default" }),
            h(StatCard, { label: t("rigUp", "Rig Up"), value: String(nextStageCounts.rigUp), meta: t("readyToFinish", "Ready to finish"), tone: "green" }),
            h(StatCard, { label: t("completed", "Completed"), value: String(completedAssignments.length), meta: t("closedDriverTasks", "Closed driver tasks"), tone: "default" }),
          ),
        ),
        h(
          Card,
          { className: "dashboard-section-card" },
          h("div", { className: "section-heading" }, h("h2", null, t("currentTrip", "Current Trip")), h("span", { className: "section-pill" }, currentUser?.truckType || t("driverTruck", "Driver truck"))),
          queuedCount
            ? h("p", { className: "muted-copy section-spacing" }, `${queuedCount} ${t("moreTripsQueued", "more trips queued after this one")}`)
            : null,
          currentAssignment
            ? h(
                "div",
                { className: "manager-rig-list" },
                h(
                  "article",
                  { className: "manager-rig-card driver-task-card" },
                  h(
                    "div",
                    { className: "manager-rig-head" },
                    h(
                      "div",
                      null,
                      h("strong", null, currentAssignment.tripLabel || currentAssignment.moveName || t("assignedTrip", "Assigned trip")),
                      h("p", { className: "muted-copy" }, `${currentAssignment.loadCode || currentAssignment.loadId ? `Load ${currentAssignment.loadCode || `#${currentAssignment.loadId}`}` : t("transferLoad", "Transfer load")} • ${t("trip", "Trip")} ${currentAssignment.tripNumber}/${currentAssignment.plannedTripCount}`),
                    ),
                    h("span", { className: "section-pill" }, currentAssignment.status === "active" ? t(currentStage, getStageTitle(currentStage)) : t(currentAssignment.status, getStatusLabel(currentAssignment.status))),
                  ),
                  h(
                    "div",
                    { className: "manager-rig-stats" },
                    h("div", { className: "manager-rig-stat" }, h("span", null, t("truckType", "Truck type")), h("strong", null, currentAssignment.truckType || currentUser?.truckType || "--")),
                    h("div", { className: "manager-rig-stat" }, h("span", null, t("driver", "Driver")), h("strong", null, currentAssignment.driverName || currentUser?.name || "--")),
                    h("div", { className: "manager-rig-stat" }, h("span", null, t("route", "Route")), h("strong", null, `${formatLocationLabel(currentAssignment.startLabel, "Source")} to ${formatLocationLabel(currentAssignment.endLabel, "Destination")}`)),
                    h("div", { className: "manager-rig-stat" }, h("span", null, t("phaseEta", "Phase ETA")), h("strong", null, currentStage === "completed" ? t("completed", "Completed") : `${formatMinutes(Math.round(getStageDeadline(currentAssignment, currentStage) || 0))}`)),
                    h("div", { className: "manager-rig-stat" }, h("span", null, t("timeLeft", "Time Left")), h("strong", null, currentStage === "completed" ? t("done", "Done") : buildStageStatusLabel({ assignment: currentAssignment, stage: currentStage, nowTs, t }))),
                    h("div", { className: "manager-rig-stat" }, h("span", null, t("lateBy", "Late By")), h("strong", null, currentLateMinutes > 0 ? `${currentLateMinutes}m` : `0m`)),
                  ),
                  h(
                    "div",
                    { className: "manager-rig-stats driver-phase-grid" },
                    h(PhaseRow, { assignment: currentAssignment, stage: "rigDown", isCurrent: currentStage === "rigDown", nowTs, t }),
                    h(PhaseRow, { assignment: currentAssignment, stage: "rigMove", isCurrent: currentStage === "rigMove", nowTs, t }),
                    h(PhaseRow, { assignment: currentAssignment, stage: "rigUp", isCurrent: currentStage === "rigUp", nowTs, t }),
                  ),
                  needsDelayReason
                    ? h(
                        "div",
                        { className: "driver-delay-box" },
                        h("strong", null, t("delayReasonNeeded", "Delay reason required")),
                        h("p", { className: "muted-copy" }, `${t("delayReasonPrompt", "This phase is more than 20 minutes late. Enter the reason before completing it.")} (+${currentLateMinutes}m)`),
                        h("textarea", {
                          className: "input driver-delay-textarea",
                          value: delayReasonDraft,
                          placeholder: t("delayReasonPlaceholder", "Traffic, rig issue, weather, loading delay..."),
                          onInput: (event) => {
                            setDelayReasonDraft(event.target.value);
                            if (delayError) {
                              setDelayError("");
                            }
                          },
                        }),
                        delayError ? h("p", { className: "field-error" }, delayError) : null,
                      )
                    : null,
                  h(
                    "div",
                    { className: "driver-task-actions" },
                    h(Button, {
                      type: "button",
                      variant: currentStage === "rigDown" ? "primary" : "ghost",
                      disabled: currentAssignment.status !== "active" || currentStage !== "rigDown",
                      onClick: () => handleStageComplete("rigDown"),
                      children: t("rigDownComplete", "Rig Down Complete"),
                    }),
                    h(Button, {
                      type: "button",
                      variant: currentStage === "rigMove" ? "primary" : "ghost",
                      disabled: currentAssignment.status !== "active" || currentStage !== "rigMove",
                      onClick: () => handleStageComplete("rigMove"),
                      children: t("rigMoveComplete", "Rig Move Complete"),
                    }),
                    h(Button, {
                      type: "button",
                      variant: currentStage === "rigUp" ? "primary" : "ghost",
                      disabled: currentAssignment.status !== "active" || currentStage !== "rigUp",
                      onClick: () => handleStageComplete("rigUp"),
                      children: t("rigUpComplete", "Rig Up Complete"),
                    }),
                  ),
                ),
              )
            : h("p", { className: "muted-copy" }, t("noAssignedTrips", "No assigned trips yet. Trips will appear after a foreman starts execution.")),
        ),
      ),
    ),
  );
}

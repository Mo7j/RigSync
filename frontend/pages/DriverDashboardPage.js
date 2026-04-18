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

function getDriverMoveState(assignment = {}) {
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

function getDelayThresholdMinutes(assignment) {
  if (Number.isFinite(Number(assignment?.delayThresholdMinutes))) {
    return Math.max(0, Number(assignment.delayThresholdMinutes));
  }
  return 20;
}

function formatDelayAmount(minutes, assignment) {
  const safeMinutes = Math.max(0, Number(minutes) || 0);
  if (safeMinutes < 1 || assignment?.isDemoMove) {
    return `${Math.round(safeMinutes * 60)}s`;
  }
  return `${Math.round(safeMinutes)}m`;
}

function getStageLateness(assignment, stage, nowTs) {
  const deadline = getStageDeadline(assignment, stage);
  if (deadline == null) {
    return 0;
  }
  return Math.max(0, getElapsedMinutes(assignment, nowTs) - deadline);
}

function buildStageStatusLabel({ assignment, stage, nowTs, t }) {
  const completed = assignment?.stageStatus?.[`${stage}Completed`];
  const delayThresholdMinutes = getDelayThresholdMinutes(assignment);
  if (completed) {
    const note = assignment?.stageDelayNotes?.[stage];
    if (note?.lateMinutes > delayThresholdMinutes) {
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

  return `+${formatDelayAmount(Math.abs(deadline - getElapsedMinutes(assignment, nowTs)), assignment)} ${t("late", "late")}`;
}

function getStepTimerLines({
  assignment,
  stage = null,
  nowTs,
  t,
  state,
  fallbackStatus = null,
  completedStatus = null,
  etaLabel = null,
}) {
  const lines = [];
  const deadline = stage ? getStageDeadline(assignment, stage) : null;

  if (deadline != null) {
    lines.push(`${etaLabel || t("phaseEta", "Phase ETA")}: ${formatMinutes(Math.round(deadline))}`);
  }

  if (state === "done") {
    lines.push(`${t("timeLeft", "Time Left")}: ${completedStatus || t("done", "Done")}`);
    return lines;
  }

  if (stage && deadline != null) {
    lines.push(`${t("timeLeft", "Time Left")}: ${buildStageStatusLabel({ assignment, stage, nowTs, t })}`);
    return lines;
  }

  if (fallbackStatus) {
    lines.push(`${t("status", "Status")}: ${fallbackStatus}`);
  }

  return lines;
}

function buildPlannedReturnStep(assignment) {
  return {
    ...assignment,
    id: `${assignment.id}-return-preview`,
    taskType: "return",
    tripLabel: `Return to ${assignment.startLabel || "Source"}`,
    simpleLoadLabel: "Return Trip",
    startLabel: assignment.endLabel || assignment.startLabel || "",
    endLabel: assignment.startLabel || assignment.endLabel || "",
    loadId: null,
    loadCode: "",
    currentStage: "rigMove",
    status: "queued",
    moveStartedAt: null,
    outboundArrivedAt: assignment.outboundArrivedAt || null,
    returnMoveStartedAt: null,
    returnedToSourceAt: null,
    stageStatus: {
      rigDownCompleted: true,
      rigMoveCompleted: false,
      rigUpCompleted: true,
    },
    stageCompletedAt: {
      rigDown: assignment.stageCompletedAt?.rigDown || assignment.assignedAt || null,
      rigMove: null,
      rigUp: assignment.stageCompletedAt?.rigMove || assignment.assignedAt || null,
    },
    isPreviewReturn: true,
  };
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
  moves = [],
  onCompleteStage,
  onMoveAction,
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

  const moveById = new Map((moves || []).filter(Boolean).map((move) => [String(move.id), move]));
  const activeAssignments = (assignments || []).filter((assignment) => {
    if (!assignment?.moveId) {
      return false;
    }
    const move = moveById.get(String(assignment.moveId));
    return move?.executionState === "active";
  });
  const completedAssignments = (assignments || []).filter((assignment) => assignment.status === "completed");
  const activeMoveId = [...activeAssignments]
    .sort((left, right) => (left.sequence || 0) - (right.sequence || 0))
    [0]?.moveId || null;
  const orderedAssignments = activeMoveId
    ? activeAssignments
      .filter((assignment) => String(assignment.moveId) === String(activeMoveId))
      .sort((left, right) => (left.sequence || 0) - (right.sequence || 0))
    : [];
  const queuedCount = Math.max(0, orderedAssignments.filter((assignment) => assignment.status === "queued").length);
  const currentAssignment =
    orderedAssignments.find((assignment) => assignment.status === "active") ||
    orderedAssignments.find((assignment) => assignment.status === "foreman") ||
    orderedAssignments.find((assignment) => assignment.status === "queued") ||
    null;
  const currentMove = currentAssignment
    ? moveById.get(String(currentAssignment.moveId)) || null
    : null;
  const driverMoveState = getDriverMoveState(currentAssignment);
  const currentStage = currentAssignment
    ? ((currentAssignment.status === "active" && driverMoveState !== "returned")
        ? "rigMove"
        : getNextStage(currentAssignment.stageStatus))
    : "completed";
  const isReturnTask = currentAssignment?.taskType === "return";
  const currentLateMinutes =
    currentAssignment && currentStage !== "completed"
      ? getStageLateness(currentAssignment, currentStage, nowTs)
      : 0;
  const delayThresholdMinutes = currentAssignment ? getDelayThresholdMinutes(currentAssignment) : 20;
  const needsDelayReason = currentLateMinutes > delayThresholdMinutes;
  const nextStageCounts = {
    rigDown: activeAssignments.filter((assignment) => getNextStage(assignment.stageStatus) === "rigDown").length,
    rigMove: activeAssignments.filter((assignment) => getNextStage(assignment.stageStatus) === "rigMove").length,
    rigUp: activeAssignments.filter((assignment) => getNextStage(assignment.stageStatus) === "rigUp").length,
  };
  const sensorSummary = (() => {
    const executionProgress = currentMove?.executionProgress || {};
    const trackingMode = executionProgress?.trackingMode;
    if (trackingMode !== "demoUltrasonic") {
      return {
        enabled: false,
        progressPercent: null,
        progressLabel: "--",
        latestLabel: "--",
        readyToArrive: true,
      };
    }

    const latestCm = executionProgress?.ultrasonicLatestCm == null
      ? null
      : Math.max(0, Number(executionProgress.ultrasonicLatestCm) || 0);
    const startCm = Math.max(0, Number(executionProgress?.ultrasonicStartCm) || 45);
    const arrivalCm = Math.max(0, Number(executionProgress?.ultrasonicArrivalCm) || 8);
    const totalWindow = Math.max(startCm - Math.min(arrivalCm, startCm), 0.001);
    const outboundProgressPercent = latestCm == null
      ? null
      : Math.max(0, Math.min(100, Math.round(((startCm - latestCm) / totalWindow) * 100)));
    const isReturnTrip = currentAssignment?.taskType === "return" || driverMoveState === "movingReturn";
    const progressPercent = outboundProgressPercent == null
      ? null
      : isReturnTrip
        ? Math.max(0, Math.min(100, 100 - outboundProgressPercent))
        : outboundProgressPercent;
    const readyToArrive = progressPercent == null ? false : progressPercent >= 100;

    return {
      enabled: true,
      progressPercent,
      progressLabel: progressPercent == null ? "--" : `${progressPercent}%`,
      latestLabel: latestCm == null ? "--" : `${latestCm.toFixed(1)} cm`,
      readyToArrive,
    };
  })();
  const canConfirmSensorArrival = sensorSummary.readyToArrive;
  const rigDownCompleted = Boolean(currentAssignment?.stageStatus?.rigDownCompleted);
  const tripStarted = Boolean(currentAssignment?.moveStartedAt);
  const arrivalCompleted = isReturnTask
    ? Boolean(currentAssignment?.returnedToSourceAt)
    : Boolean(currentAssignment?.outboundArrivedAt);
  const closePhaseCompleted = isReturnTask
    ? Boolean(currentAssignment?.returnedToSourceAt)
    : Boolean(currentAssignment?.stageStatus?.rigUpCompleted);
  const returnAssignmentsByLoadId = new Map(
    orderedAssignments
      .filter((assignment) => assignment.taskType === "return" && assignment.returnForAssignmentId)
      .map((assignment) => [String(assignment.returnForAssignmentId), assignment]),
  );
  const timelineAssignments = orderedAssignments
    .filter((assignment) => assignment.taskType !== "return")
    .flatMap((assignment) => {
      const linkedReturnAssignment = returnAssignmentsByLoadId.get(String(assignment.id));
      return [
        assignment,
        linkedReturnAssignment || buildPlannedReturnStep(assignment),
      ];
    });
  const driverTimelineSteps = timelineAssignments.map((assignment, index) => {
    const stepMoveState = getDriverMoveState(assignment);
    const stepIsReturnTask = assignment?.taskType === "return";
    const isCurrentStep = currentAssignment && String(currentAssignment.id) === String(assignment.id);
    const hasReturnStarted = Boolean(assignment.returnMoveStartedAt || assignment.moveStartedAt);
    const hasReachedDestination = Boolean(assignment.outboundArrivedAt);
    const state = stepIsReturnTask
      ? (
          assignment.returnedToSourceAt
            ? "done"
            : isCurrentStep
              ? "current"
              : hasReachedDestination || assignment.status === "active"
                ? "current"
                : "locked"
        )
      : (
          hasReachedDestination || assignment.status === "completed" || assignment.status === "foreman"
            ? "done"
            : isCurrentStep
              ? "current"
              : "locked"
        );

    const bullets = [
      `${t("truckType", "Truck type")}: ${assignment.truckType || currentUser?.truckType || "--"}`,
      `${t("route", "Route")}: ${formatLocationLabel(assignment.startLabel, "Source")} to ${formatLocationLabel(assignment.endLabel, "Destination")}`,
      isCurrentStep
        ? (
            stepIsReturnTask && (stepMoveState === "movingOutbound" || stepMoveState === "movingReturn")
              ? t("driverReturnRunning", "Empty truck is returning to source. Confirm arrival only when it is really back at source.")
              : stepIsReturnTask && stepMoveState === "readyOutbound"
                ? t("driverReturnWaitingStart", "Empty truck is parked at destination. Start return when the driver leaves.")
                : stepMoveState === "readyOutbound"
                  ? t("driverMoveWaitingStart", "Truck is parked at source. Start the move when the driver leaves.")
                  : stepMoveState === "movingOutbound"
                    ? t("driverMoveOutbound", "Truck is on the outbound trip to the rig.")
                    : stepMoveState === "readyReturn"
                      ? t("driverMoveReadyReturn", "Truck arrived at the rig. Start the return as soon as the load is dropped.")
                      : stepMoveState === "movingReturn"
                        ? t("driverMoveReturning", "Truck is returning to source. Confirm arrival only when it is back at source.")
                        : t("driverMoveComplete", "Return trip completed.")
          )
        : stepIsReturnTask
          ? hasReachedDestination
            ? t("driverMoveReadyReturn", "Truck arrived at the rig. Start the return as soon as the load is dropped.")
            : t("futureStepsLocked", "Next steps stay locked until the current step is finished.")
        : assignment.status === "completed"
          ? t("done", "Done")
          : t("futureStepsLocked", "Next steps stay locked until the current step is finished."),
    ];

    if (isCurrentStep) {
      bullets.push(`${t("progress", "Progress")}: ${sensorSummary.progressLabel}`);
      bullets.push(`${t("sensor", "Sensor")}: ${sensorSummary.latestLabel}`);
    }

    let action = null;
    if (isCurrentStep && Boolean(assignment?.stageStatus?.rigDownCompleted) && stepMoveState === "readyOutbound") {
      action = {
        label: stepIsReturnTask ? t("startReturn", "Start Return") : t("startMoving", "Start Moving"),
        onClick: () => onMoveAction?.({
          assignmentId: assignment.id,
          action: stepIsReturnTask ? "startReturn" : "startMove",
        }),
      };
    } else if (isCurrentStep && (stepMoveState === "movingOutbound" || stepMoveState === "movingReturn")) {
      action = {
        label: stepIsReturnTask || stepMoveState === "movingReturn"
          ? t("arrivedSource", "Arrived at Source")
          : t("arrived", "Arrived"),
        disabled: !canConfirmSensorArrival,
        onClick: () => onMoveAction?.({
          assignmentId: assignment.id,
          action: "arrived",
        }),
      };
    }

    return {
      key: assignment.id,
      title: assignment.tripLabel || `${t("trip", "Trip")} ${index + 1}`,
      dateLabel: `STEP ${index + 1}`,
      state,
      bullets,
      timingLines: [
        `${t("planWindow", "Plan Window")}: ${formatMinutes(Math.round(assignment.plannedStartMinute || 0))} - ${formatMinutes(Math.round(assignment.plannedFinishMinute || 0))}`,
        ...getStepTimerLines({
          assignment,
          stage: stepIsReturnTask ? "rigMove" : assignment.status === "completed" ? "rigUp" : getNextStage(assignment.stageStatus),
          nowTs,
          t,
          state,
          fallbackStatus: state === "locked" ? t("locked", "Locked") : null,
          completedStatus: t("done", "Done"),
        }),
      ],
      action,
      showLockedArrivalHint: Boolean(action?.disabled),
      isReturnTask: stepIsReturnTask,
      moveState: stepMoveState,
    };
  });

  async function handleStageComplete(stage) {
    if (!currentAssignment) {
      return;
    }

    if (needsDelayReason && !delayReasonDraft.trim()) {
      setDelayError(
        currentAssignment?.isDemoMove
          ? t("delayReasonRequiredDemo", "Enter a delay reason once the phase is more than 20 seconds late.")
          : t("delayReasonRequired", "Enter a delay reason once the phase is more than 20 minutes late."),
      );
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
      { className: "workspace-grid dashboard-grid driver-dashboard-grid" },
      h(
        "section",
        { className: "dashboard-column dashboard-column-wide driver-dashboard-column" },
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
          h("div", { className: "section-heading" }, h("h2", null, t("currentTrip", "Assigned Plan")), h("span", { className: "section-pill" }, currentUser?.truckType || t("driverTruck", "Driver truck"))),
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
                      h("strong", null, currentMove?.name || currentAssignment.moveName || t("assignedTrip", "Assigned trip")),
                      h("p", { className: "muted-copy" }, `${currentAssignment.simpleLoadLabel || (currentAssignment.loadCode || currentAssignment.loadId ? `Load ${currentAssignment.loadCode || `#${currentAssignment.loadId}`}` : t("transferLoad", "Transfer load"))} • ${t("trip", "Trip")} ${currentAssignment.tripNumber}/${currentAssignment.plannedTripCount}`),
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
                    h("div", { className: "manager-rig-stat" }, h("span", null, t("lateBy", "Late By")), h("strong", null, currentLateMinutes > 0 ? formatDelayAmount(currentLateMinutes, currentAssignment) : `0s`)),
                  ),
                  h(
                    "div",
                    { className: "driver-step-timeline" },
                    driverTimelineSteps.map((step, index) =>
                      h(
                        "article",
                        {
                          key: step.key,
                          className: `driver-step-item driver-step-item-${index % 2 === 0 ? "left" : "right"} driver-step-item-${step.state}`,
                        },
                        h("div", { className: "driver-step-date" }, step.dateLabel),
                        h("div", { className: "driver-step-line" }, h("span", { className: "driver-step-node" })),
                        h(
                          "div",
                          { className: "driver-step-card-shell" },
                          h(
                            "div",
                            { className: `driver-step-card driver-step-card-${step.state}` },
                            h("div", { className: "driver-step-card-head" }, h("strong", null, step.title)),
                            step.timingLines?.length
                              ? h(
                                  "div",
                                  { className: "driver-step-timers" },
                                  step.timingLines.map((line, timerIndex) => h("p", { key: `${step.key}-timer-${timerIndex}`, className: "driver-step-timer-line muted-copy" }, line)),
                                )
                              : null,
                            h(
                              "ul",
                              { className: "driver-step-list" },
                              step.bullets.map((bullet, bulletIndex) => h("li", { key: `${step.key}-${bulletIndex}` }, bullet)),
                            ),
                            step.action
                              ? h(
                                  "div",
                                  { className: "driver-step-action" },
                                  h(Button, {
                                    type: "button",
                                    variant: step.state === "current" ? "primary" : "ghost",
                                    disabled: Boolean(step.action.disabled),
                                    onClick: step.action.onClick,
                                    children: step.action.label,
                                  }),
                                  step.showLockedArrivalHint
                                    ? h("p", { className: "muted-copy" }, step.isReturnTask || step.moveState === "movingReturn"
                                        ? t("arrivalLockedReturn", "Arrival stays locked until the live sensor reaches 100%.")
                                        : t("arrivalLockedOutbound", "Arrival stays locked until the live sensor reaches 100%."))
                                    : null,
                                )
                              : null,
                          ),
                        ),
                      ),
                    ),
                  ),
                  needsDelayReason
                    ? h(
                        "div",
                        { className: "driver-delay-box" },
                        h("strong", null, t("delayReasonNeeded", "Delay reason required")),
                        h(
                          "p",
                          { className: "muted-copy" },
                          currentAssignment?.isDemoMove
                            ? `${t("delayReasonPromptDemo", "This phase is more than 20 seconds late. Enter the reason before completing it.")} (+${formatDelayAmount(currentLateMinutes, currentAssignment)})`
                            : `${t("delayReasonPrompt", "This phase is more than 20 minutes late. Enter the reason before completing it.")} (+${formatDelayAmount(currentLateMinutes, currentAssignment)})`,
                        ),
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
                    h(
                      "p",
                      { className: "muted-copy" },
                      isReturnTask && driverMoveState === "readyOutbound"
                        ? t("driverReturnWaitingStart", "Empty truck is parked at destination. Start return when the driver leaves.")
                        : isReturnTask && (driverMoveState === "movingOutbound" || driverMoveState === "movingReturn")
                          ? t("driverReturnRunning", "Empty truck is returning to source. Confirm arrival only when it is really back at source.")
                          : driverMoveState === "readyOutbound"
                            ? t("driverMoveWaitingStart", "Truck is parked at source. Start the move when the driver leaves.")
                            : driverMoveState === "movingOutbound"
                              ? t("driverMoveOutbound", "Truck is on the outbound trip to the rig.")
                              : driverMoveState === "readyReturn"
                                ? t("driverMoveReadyReturn", "Truck arrived at the rig. Start the return as soon as the load is dropped.")
                                : driverMoveState === "movingReturn"
                                  ? t("driverMoveReturning", "Truck is returning to source. Confirm arrival only when it is back at source.")
                                  : t("driverMoveComplete", "Return trip completed."),
                    ),
                  ),
                ),
              )
            : h("p", { className: "muted-copy" }, t("noAssignedTrips", "No assigned trips yet. Trips will appear after a foreman starts execution.")),
        ),
      ),
    ),
  );
}

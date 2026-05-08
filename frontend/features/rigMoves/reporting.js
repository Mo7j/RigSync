import { formatDate, formatLocationLabel, formatMinutes } from "../../lib/format.js";

export const DAILY_REPORT_TYPE = "daily";
export const FINAL_REPORT_TYPE = "final";
export const FLAG_STATE_OPEN = "open";
export const FLAG_STATE_RESOLVED = "resolved";

const DEFAULT_PLANNING_START_TIME = "06:00";
const STAGE_ORDER = [
  { key: "rigDown", label: "Rig Down" },
  { key: "rigMove", label: "Move" },
  { key: "rigUp", label: "Rig Up" },
];

function toValidDate(value) {
  if (!value) {
    return null;
  }
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function getEarliestDate(values) {
  return values
    .map(toValidDate)
    .filter(Boolean)
    .sort((left, right) => left.getTime() - right.getTime())[0] || null;
}

function getLatestDate(values) {
  return values
    .map(toValidDate)
    .filter(Boolean)
    .sort((left, right) => right.getTime() - left.getTime())[0] || null;
}

function parsePlanningStartDate(move) {
  const planningStartDate = String(move?.planningStartDate || "").trim();
  const planningStartTime = String(move?.planningStartTime || DEFAULT_PLANNING_START_TIME).trim() || DEFAULT_PLANNING_START_TIME;
  if (planningStartDate) {
    const parsed = toValidDate(`${planningStartDate}T${planningStartTime}:00`);
    if (parsed) {
      return parsed;
    }
  }
  return toValidDate(move?.createdAt);
}

function getPlanTotalMinutes(move) {
  return Math.max(
    0,
    Number(move?.simulation?.bestPlan?.totalMinutes)
      || Number(move?.simulation?.bestScenario?.totalMinutes)
      || Number(move?.simulation?.totalMinutes)
      || 0,
  );
}

function getPlanRouteMinutes(move) {
  return Math.max(
    0,
    Number(move?.simulation?.bestPlan?.routeMinutes)
      || Number(move?.simulation?.bestScenario?.routeMinutes)
      || 0,
  );
}

function getAssignmentStageCompletionDate(assignment, stageKey) {
  if (stageKey === "rigMove") {
    return toValidDate(assignment?.outboundArrivedAt || assignment?.stageCompletedAt?.rigMove);
  }
  return toValidDate(assignment?.stageCompletedAt?.[stageKey]);
}

function getActualStartDate(move, taskAssignments) {
  return getEarliestDate([
    ...taskAssignments.flatMap((assignment) => [
      assignment?.executionStartedAt,
      assignment?.assignedAt,
      assignment?.stageCompletedAt?.rigDown,
      assignment?.stageCompletedAt?.rigMove,
      assignment?.stageCompletedAt?.rigUp,
    ]),
    move?.updatedAt,
    move?.createdAt,
  ]);
}

function getActualEndDate(move, taskAssignments, currentDate, isCompleted) {
  if (!isCompleted) {
    return toValidDate(currentDate) || new Date();
  }
  return getLatestDate([
    ...taskAssignments.flatMap((assignment) => [
      assignment?.returnedToSourceAt,
      assignment?.outboundArrivedAt,
      assignment?.stageCompletedAt?.rigDown,
      assignment?.stageCompletedAt?.rigMove,
      assignment?.stageCompletedAt?.rigUp,
      assignment?.updatedAt,
    ]),
    move?.updatedAt,
    currentDate,
  ]) || new Date();
}

function getMinuteDifference(startDate, endDate) {
  if (!startDate || !endDate) {
    return null;
  }
  const minutes = Math.round((endDate.getTime() - startDate.getTime()) / 60000);
  return Number.isFinite(minutes) ? Math.max(0, minutes) : null;
}

export function formatSafeDateTime(value, fallback = "--") {
  const date = toValidDate(value);
  if (!date) {
    return fallback;
  }
  return `${formatDate(date)} ${date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
}

function formatSignedMinuteLabel(totalMinutes = 0) {
  const roundedMinutes = Math.round(Number(totalMinutes) || 0);
  if (!roundedMinutes) {
    return "On plan";
  }
  const prefix = roundedMinutes > 0 ? "+" : "-";
  return `${prefix}${formatMinutes(Math.abs(roundedMinutes))}`;
}

function getMoveDisplayName(move) {
  const explicitName = String(move?.name || "").trim();
  if (explicitName) {
    return explicitName;
  }
  const start = formatLocationLabel(move?.startLabel, "Source");
  const end = formatLocationLabel(move?.endLabel, "Destination");
  return `${start} -> ${end}`;
}

function getMoveStatus(move, t = (key, fallback) => fallback) {
  if (move?.operatingState === "drilling") {
    return t("drilling", "Drilling");
  }
  if (move?.executionState === "completed") {
    return t("completed", "Completed");
  }
  if (move?.executionState === "active") {
    return t("executingNow", "Executing");
  }
  return t("planned", "Planning");
}

function getAssignmentDelayMinutes(assignment) {
  const notes = assignment?.stageDelayNotes || {};
  const noteMax = ["rigDown", "rigMove", "rigUp"].reduce((maxMinutes, key) => {
    const nextMinutes = Math.max(0, Number(notes?.[key]?.lateMinutes) || 0);
    return Math.max(maxMinutes, nextMinutes);
  }, 0);
  const flagMax = (assignment?.flags || []).reduce((maxMinutes, flag) => Math.max(maxMinutes, Math.max(0, Number(flag?.lateMinutes) || 0)), 0);
  return Math.max(noteMax, flagMax);
}

export function isSameCalendarDay(value, referenceDate = new Date()) {
  const date = toValidDate(value);
  const reference = toValidDate(referenceDate);
  if (!date || !reference) {
    return false;
  }
  return date.getFullYear() === reference.getFullYear()
    && date.getMonth() === reference.getMonth()
    && date.getDate() === reference.getDate();
}

export function getReportDateKey(value) {
  const date = toValidDate(value);
  if (!date) {
    return "";
  }
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

export function getQuarterHourBucketKey(value) {
  const date = toValidDate(value);
  if (!date) {
    return "";
  }
  const minuteBucket = Math.floor(date.getMinutes() / 15) * 15;
  return `${getReportDateKey(date)}-${String(date.getHours()).padStart(2, "0")}-${String(minuteBucket).padStart(2, "0")}`;
}

export function isQuarterHourBoundary(value) {
  const date = toValidDate(value);
  return Boolean(date) && date.getMinutes() % 15 === 0;
}

export function buildLiveFlagEntries(assignments = [], currentDate = new Date()) {
  const entries = [];

  (assignments || []).forEach((assignment) => {
    (assignment.flags || []).forEach((flag, index) => {
      const createdAt = flag.createdAt || assignment.updatedAt || assignment.assignedAt || null;
      const resolvedAt = flag.resolvedAt || null;
      const explicitMinutes = Math.max(0, Number(flag.lateMinutes) || 0);
      let delayMinutes = explicitMinutes;
      if (!delayMinutes && createdAt) {
        const createdMs = new Date(createdAt).getTime();
        const referenceMs = String(flag.status || FLAG_STATE_OPEN).trim().toLowerCase() === FLAG_STATE_RESOLVED
          ? new Date(resolvedAt || createdAt).getTime()
          : new Date(currentDate).getTime();
        if (Number.isFinite(createdMs) && Number.isFinite(referenceMs) && referenceMs > createdMs) {
          delayMinutes = Math.floor((referenceMs - createdMs) / 60000);
        }
      }
      entries.push({
        id: flag.id || `${assignment.id}-flag-${index + 1}`,
        moveId: assignment.moveId || null,
        moveName: assignment.moveName || assignment.moveId || "Rig move",
        driverName: assignment.driverName || assignment.driverId || "Driver",
        label: flag.label || flag.type || "Driver flag",
        reason: flag.reason || "No reason provided.",
        stage: assignment.currentStage || "move",
        destination: formatLocationLabel(assignment.endLabel, "Destination"),
        trip: assignment.tripLabel || assignment.loadCode || assignment.id || "Trip",
        createdAt,
        resolvedAt,
        delayMinutes: Math.max(delayMinutes, getAssignmentDelayMinutes(assignment)),
        state: String(flag.status || FLAG_STATE_OPEN).trim().toLowerCase() === FLAG_STATE_RESOLVED ? FLAG_STATE_RESOLVED : FLAG_STATE_OPEN,
      });
    });
  });

  return entries.sort((left, right) => new Date(right.createdAt || 0) - new Date(left.createdAt || 0));
}

function buildStagePerformance(taskAssignments, actualStartDate, actualElapsedMinutes, t) {
  return STAGE_ORDER.map((stage) => {
    const plannedFinishMinute = Math.max(
      ...taskAssignments
        .map((assignment) => Number(assignment?.stagePlan?.[stage.key]?.finishMinute))
        .filter((value) => Number.isFinite(value)),
      0,
    );
    const actualFinishMinute = Math.max(
      ...taskAssignments
        .map((assignment) => getMinuteDifference(actualStartDate, getAssignmentStageCompletionDate(assignment, stage.key)))
        .filter((value) => Number.isFinite(value)),
      -1,
    );
    const hasActualFinish = actualFinishMinute >= 0;
    const varianceMinutes = hasActualFinish && plannedFinishMinute > 0 ? actualFinishMinute - plannedFinishMinute : null;
    const isLateInFlight = !hasActualFinish && plannedFinishMinute > 0 && Number.isFinite(actualElapsedMinutes) && actualElapsedMinutes > plannedFinishMinute;
    const state = hasActualFinish
      ? varianceMinutes > 0 ? "delayed" : "complete"
      : isLateInFlight ? "at-risk" : "pending";
    let summary = "Planned milestone not available.";
    if (plannedFinishMinute > 0 && hasActualFinish) {
      summary = varianceMinutes > 0
        ? `${stage.label} finished ${formatMinutes(varianceMinutes)} behind plan.`
        : varianceMinutes < 0
          ? `${stage.label} finished ${formatMinutes(Math.abs(varianceMinutes))} ahead of plan.`
          : `${stage.label} finished on plan.`;
    } else if (plannedFinishMinute > 0 && isLateInFlight) {
      summary = `${stage.label} is open and has exceeded its planned finish by ${formatMinutes(actualElapsedMinutes - plannedFinishMinute)}.`;
    } else if (plannedFinishMinute > 0) {
      summary = `${stage.label} is still within its planned execution window.`;
    }

    return {
      key: stage.key,
      label: t(stage.key, stage.label),
      plannedFinishMinute,
      actualFinishMinute: hasActualFinish ? actualFinishMinute : null,
      varianceMinutes,
      state,
      summary,
    };
  });
}

function buildDelayHotspots(taskAssignments) {
  const hotspotMap = new Map();

  function upsertHotspot({ stage, reason, minutes, source }) {
    const normalizedReason = String(reason || "").trim() || "Unspecified delay";
    const normalizedStage = String(stage || "move").trim() || "move";
    const key = `${normalizedStage}::${normalizedReason}`;
    const existing = hotspotMap.get(key) || {
      id: key,
      stage: normalizedStage,
      reason: normalizedReason,
      minutes: 0,
      events: 0,
      source,
    };
    existing.minutes += Math.max(0, Number(minutes) || 0);
    existing.events += 1;
    hotspotMap.set(key, existing);
  }

  (taskAssignments || []).forEach((assignment) => {
    ["rigDown", "rigMove", "rigUp"].forEach((stageKey) => {
      const note = assignment?.stageDelayNotes?.[stageKey];
      if (note?.reason || note?.lateMinutes) {
        upsertHotspot({
          stage: stageKey,
          reason: note?.reason || `${stageKey} delay`,
          minutes: note?.lateMinutes,
          source: "stage-note",
        });
      }
    });

    (assignment?.flags || []).forEach((flag) => {
      if (flag?.reason || flag?.lateMinutes) {
        upsertHotspot({
          stage: assignment?.currentStage || "move",
          reason: flag?.reason || flag?.label || flag?.type || "Driver flag",
          minutes: flag?.lateMinutes,
          source: "flag",
        });
      }
    });
  });

  return [...hotspotMap.values()].sort((left, right) => (right.minutes - left.minutes) || (right.events - left.events));
}

function buildActualVsPlanSummary({ isCompleted, plannedTotalMinutes, actualElapsedMinutes, plannedProgress, progress, scheduleVarianceMinutes, progressVariance }) {
  if (!plannedTotalMinutes) {
    return "Planned duration is not available, so schedule variance cannot be measured yet.";
  }
  if (isCompleted) {
    if (!Number.isFinite(actualElapsedMinutes)) {
      return `Planned closeout duration is ${formatMinutes(plannedTotalMinutes)}. Actual closeout time has not been fully captured yet.`;
    }
    if (scheduleVarianceMinutes > 0) {
      return `Final execution closed ${formatMinutes(scheduleVarianceMinutes)} behind the planned duration of ${formatMinutes(plannedTotalMinutes)}.`;
    }
    if (scheduleVarianceMinutes < 0) {
      return `Final execution closed ${formatMinutes(Math.abs(scheduleVarianceMinutes))} ahead of the planned duration of ${formatMinutes(plannedTotalMinutes)}.`;
    }
    return `Final execution closed exactly on the planned duration of ${formatMinutes(plannedTotalMinutes)}.`;
  }
  return `Planned progress by this point is ${plannedProgress}%. Actual completion is ${progress}%, a variance of ${progressVariance > 0 ? "+" : ""}${progressVariance} pts against a ${formatMinutes(plannedTotalMinutes)} plan.`;
}

function buildDelaySummary(delayHotspots, totalDelayMinutes, totalDelayEvents, stagePerformance) {
  if (!delayHotspots.length || !totalDelayMinutes) {
    const atRiskStage = stagePerformance.find((stage) => stage.state === "at-risk");
    if (atRiskStage) {
      return `${atRiskStage.label} is running late against plan, but no formal delay cause has been recorded yet.`;
    }
    return "No material delay has been recorded for this move so far.";
  }
  const primary = delayHotspots[0];
  const secondary = delayHotspots.slice(1, 3).map((item) => `${item.reason} (${formatMinutes(item.minutes)})`).join(", ");
  return `Recorded delay exposure totals ${formatMinutes(totalDelayMinutes)} across ${totalDelayEvents} events. Primary driver is ${primary.reason} during ${primary.stage} (${formatMinutes(primary.minutes)}).${secondary ? ` Secondary drivers: ${secondary}.` : ""}`;
}

function getScheduleStatus({ isCompleted, scheduleVarianceMinutes, progressVariance, plannedTotalMinutes }) {
  if (!plannedTotalMinutes) {
    return "Plan Pending";
  }
  if (isCompleted) {
    if (scheduleVarianceMinutes > 0) {
      return "Closed Behind Plan";
    }
    if (scheduleVarianceMinutes < 0) {
      return "Closed Ahead of Plan";
    }
    return "Closed On Plan";
  }
  if (progressVariance <= -10) {
    return "Behind Plan";
  }
  if (progressVariance >= 10) {
    return "Ahead of Plan";
  }
  return "Near Plan";
}

export function buildMoveSummary(move, managerResources, currentDate = new Date(), t = (key, fallback) => fallback) {
  const taskAssignments = (managerResources?.taskAssignments || []).filter((assignment) => assignment.moveId === move.id);
  const completedTasks = taskAssignments.filter((assignment) => Boolean(assignment?.stageStatus?.rigUpCompleted || String(assignment?.status || "").trim() === "completed")).length;
  const totalTasks = taskAssignments.length;
  const completedToday = taskAssignments.filter((assignment) => isSameCalendarDay(assignment?.stageCompletedAt?.rigUp || assignment?.updatedAt, currentDate)).length;
  const completedStageTasks = taskAssignments.reduce((sum, assignment) => {
    const status = assignment?.stageStatus || {};
    return sum + (status.rigDownCompleted ? 1 : 0) + (status.rigMoveCompleted ? 1 : 0) + (status.rigUpCompleted ? 1 : 0);
  }, 0);
  const totalStageTasks = totalTasks * 3;
  const activeDrivers = [...new Set(taskAssignments
    .filter((assignment) => String(assignment?.status || "").trim() !== "completed")
    .map((assignment) => assignment?.driverName || assignment?.driverId || null)
    .filter(Boolean))];
  const flagEntries = buildLiveFlagEntries(taskAssignments, currentDate);
  const flagsToday = flagEntries.filter((entry) => isSameCalendarDay(entry.createdAt, currentDate));
  const delayMinutesToday = flagsToday.reduce((sum, entry) => sum + Math.max(0, Number(entry.delayMinutes) || 0), 0);
  const totalDelayMinutes = flagEntries.reduce((sum, entry) => sum + Math.max(0, Number(entry.delayMinutes) || 0), 0);
  const latestFlag = flagEntries[0] || null;
  const latestAssignmentUpdate = taskAssignments.reduce((latest, assignment) => {
    const timestamps = [
      assignment?.updatedAt,
      assignment?.stageCompletedAt?.rigDown,
      assignment?.stageCompletedAt?.rigMove,
      assignment?.stageCompletedAt?.rigUp,
    ].map((value) => new Date(value || 0).getTime()).filter((value) => Number.isFinite(value) && value > 0);
    return Math.max(latest, ...(timestamps.length ? timestamps : [0]));
  }, 0);
  const latestActivityMs = Math.max(new Date(move?.updatedAt || move?.createdAt || 0).getTime(), latestAssignmentUpdate, new Date(latestFlag?.createdAt || 0).getTime());
  const progressPercent = totalTasks ? Math.round((completedTasks / totalTasks) * 100) : Math.max(0, Number(move?.completionPercentage) || 0);
  const isCompleted = totalTasks > 0 ? completedTasks >= totalTasks : move?.executionState === "completed" || move?.operatingState === "drilling";
  const isActive = !isCompleted && (move?.executionState === "active" || taskAssignments.some((assignment) => String(assignment?.status || "").trim() !== "completed"));
  const plannedTotalMinutes = getPlanTotalMinutes(move);
  const plannedRouteMinutes = getPlanRouteMinutes(move);
  const planStartDate = parsePlanningStartDate(move);
  const actualStartDate = getActualStartDate(move, taskAssignments);
  const actualEndDate = getActualEndDate(move, taskAssignments, currentDate, isCompleted);
  const actualElapsedMinutes = getMinuteDifference(actualStartDate, actualEndDate);
  const plannedProgress = plannedTotalMinutes && Number.isFinite(actualElapsedMinutes)
    ? Math.min(100, Math.round((actualElapsedMinutes / Math.max(plannedTotalMinutes, 1)) * 100))
    : 0;
  const progressVariance = progressPercent - plannedProgress;
  const scheduleVarianceMinutes = plannedTotalMinutes && Number.isFinite(actualElapsedMinutes)
    ? actualElapsedMinutes - plannedTotalMinutes
    : null;
  const stagePerformance = buildStagePerformance(taskAssignments, actualStartDate, actualElapsedMinutes, t);
  const delayHotspots = buildDelayHotspots(taskAssignments);
  const delaySummary = buildDelaySummary(delayHotspots, totalDelayMinutes, flagEntries.length, stagePerformance);
  const actualVsPlanSummary = buildActualVsPlanSummary({
    isCompleted,
    plannedTotalMinutes,
    actualElapsedMinutes,
    plannedProgress,
    progress: progressPercent,
    scheduleVarianceMinutes,
    progressVariance,
  });
  const scheduleStatus = getScheduleStatus({
    isCompleted,
    scheduleVarianceMinutes,
    progressVariance,
    plannedTotalMinutes,
  });

  return {
    moveId: move.id,
    moveName: getMoveDisplayName(move),
    route: `${formatLocationLabel(move?.startLabel, t("source", "Source"))} -> ${formatLocationLabel(move?.endLabel, t("destination", "Destination"))}`,
    status: getMoveStatus(move, t),
    startLabel: move?.startLabel || null,
    endLabel: move?.endLabel || null,
    progress: progressPercent,
    plannedProgress,
    progressVariance,
    plannedTotalMinutes,
    plannedRouteMinutes,
    actualElapsedMinutes,
    scheduleVarianceMinutes,
    scheduleStatus,
    completedTasks,
    totalTasks,
    remainingTasks: Math.max(0, totalTasks - completedTasks),
    completedToday,
    completedStageTasks,
    totalStageTasks,
    activeDrivers,
    activeDriversCount: activeDrivers.length,
    delayEventCount: flagEntries.length,
    delayMinutesToday,
    totalDelayMinutes,
    latestReason: latestFlag?.reason || "No delay reason recorded.",
    latestUpdate: latestActivityMs > 0 ? new Date(latestActivityMs).toISOString() : null,
    latestEvents: flagEntries.slice(0, 6).map((entry) => ({
      id: entry.id,
      reason: entry.reason,
      driver: entry.driverName,
      stage: entry.stage,
      delayMinutes: entry.delayMinutes,
      time: entry.createdAt,
      trip: entry.trip,
      destination: entry.destination,
      state: entry.state,
    })),
    stageItems: [
      { key: "rigDown", label: t("rigDown", "Rig Down"), done: taskAssignments.every((assignment) => assignment?.stageStatus?.rigDownCompleted) && totalTasks > 0 },
      { key: "rigMove", label: t("move", "Move"), done: taskAssignments.every((assignment) => assignment?.stageStatus?.rigMoveCompleted) && totalTasks > 0 },
      { key: "rigUp", label: t("rigUp", "Rig Up"), done: taskAssignments.every((assignment) => assignment?.stageStatus?.rigUpCompleted) && totalTasks > 0 },
    ],
    stagePerformance,
    delayHotspots: delayHotspots.slice(0, 5),
    primaryDelayDriver: delayHotspots[0]?.reason || "No dominant delay driver recorded.",
    actualVsPlanSummary,
    delaySummary,
    isActive,
    isCompleted,
    planStartDate: planStartDate ? planStartDate.toISOString() : null,
    actualStartDate: actualStartDate ? actualStartDate.toISOString() : null,
    actualEndDate: actualEndDate ? actualEndDate.toISOString() : null,
  };
}

export function buildDailyReportRecord(summary, currentDate) {
  const reportDate = getReportDateKey(currentDate);
  return {
    id: `daily-${summary.moveId}-${reportDate}-${summary.slot}`,
    type: DAILY_REPORT_TYPE,
    slot: summary.slot,
    reportDate,
    moveId: summary.moveId,
    moveName: summary.moveName,
    route: summary.route,
    status: summary.status,
    progress: summary.progress,
    plannedProgress: summary.plannedProgress,
    progressVariance: summary.progressVariance,
    plannedTotalMinutes: summary.plannedTotalMinutes,
    plannedRouteMinutes: summary.plannedRouteMinutes,
    actualElapsedMinutes: summary.actualElapsedMinutes,
    scheduleVarianceMinutes: summary.scheduleVarianceMinutes,
    scheduleStatus: summary.scheduleStatus,
    completedTasks: summary.completedTasks,
    totalTasks: summary.totalTasks,
    remainingTasks: summary.remainingTasks,
    activeDrivers: summary.activeDriversCount,
    delayEventCount: summary.delayEventCount,
    delayMinutes: summary.delayMinutesToday,
    latestReason: summary.latestReason,
    latestUpdate: summary.latestUpdate,
    createdAt: new Date(currentDate).toISOString(),
    createdMinuteBucket: getQuarterHourBucketKey(currentDate),
    completedStageTasks: summary.completedStageTasks,
    latestEvents: summary.latestEvents,
    stageItems: summary.stageItems,
    stagePerformance: summary.stagePerformance,
    delayHotspots: summary.delayHotspots,
    primaryDelayDriver: summary.primaryDelayDriver,
    actualVsPlanSummary: summary.actualVsPlanSummary,
    delaySummary: summary.delaySummary,
    planStartDate: summary.planStartDate,
    actualStartDate: summary.actualStartDate,
    actualEndDate: summary.actualEndDate,
  };
}

export function buildFinalReportRecord(summary, currentDate) {
  return {
    id: `final-${summary.moveId}`,
    type: FINAL_REPORT_TYPE,
    slot: "Final",
    reportDate: getReportDateKey(currentDate),
    moveId: summary.moveId,
    moveName: summary.moveName,
    route: summary.route,
    status: "Completed",
    progress: 100,
    plannedProgress: 100,
    progressVariance: summary.progressVariance,
    plannedTotalMinutes: summary.plannedTotalMinutes,
    plannedRouteMinutes: summary.plannedRouteMinutes,
    actualElapsedMinutes: summary.actualElapsedMinutes,
    scheduleVarianceMinutes: summary.scheduleVarianceMinutes,
    scheduleStatus: summary.scheduleStatus,
    completedTasks: summary.completedTasks,
    totalTasks: summary.totalTasks,
    remainingTasks: 0,
    activeDrivers: summary.activeDriversCount,
    delayEventCount: summary.delayEventCount,
    delayMinutes: summary.totalDelayMinutes,
    latestReason: summary.latestReason,
    latestUpdate: summary.latestUpdate,
    createdAt: new Date(currentDate).toISOString(),
    createdMinuteBucket: getQuarterHourBucketKey(currentDate),
    completedStageTasks: summary.completedStageTasks,
    latestEvents: summary.latestEvents,
    stageItems: summary.stageItems,
    stagePerformance: summary.stagePerformance,
    delayHotspots: summary.delayHotspots,
    primaryDelayDriver: summary.primaryDelayDriver,
    actualVsPlanSummary: summary.actualVsPlanSummary,
    delaySummary: summary.delaySummary,
    planStartDate: summary.planStartDate,
    actualStartDate: summary.actualStartDate,
    actualEndDate: summary.actualEndDate,
  };
}

export function buildPrintMarkup(report, kind, generatedAt) {
  const title = kind === FINAL_REPORT_TYPE ? "Final Move Report" : `${report.slot || "Daily"} Daily Report`;
  const metrics = [
    ["Move", report.moveName || "--"],
    ["Route", report.route || "--"],
    ["Status", report.status || "--"],
    ["Generated At", formatSafeDateTime(report.createdAt || generatedAt)],
    ["Progress", `${report.progress || 0}%`],
    ["Planned Progress", `${report.plannedProgress || 0}%`],
    ["Progress Variance", `${report.progressVariance > 0 ? "+" : ""}${report.progressVariance || 0} pts`],
    ["Planned Duration", report.plannedTotalMinutes ? formatMinutes(report.plannedTotalMinutes) : "--"],
    ["Actual Elapsed", report.actualElapsedMinutes ? formatMinutes(report.actualElapsedMinutes) : "--"],
    ["Schedule Variance", report.scheduleVarianceMinutes == null ? "--" : formatSignedMinuteLabel(report.scheduleVarianceMinutes)],
    ["Delay Events", String(report.delayEventCount || 0)],
    ["Delay Minutes", `${report.delayMinutes || 0} min`],
  ];

  const latestEvents = Array.isArray(report.latestEvents) ? report.latestEvents : [];
  const stagePerformance = Array.isArray(report.stagePerformance) ? report.stagePerformance : [];
  const delayHotspots = Array.isArray(report.delayHotspots) ? report.delayHotspots : [];
  const eventsMarkup = latestEvents.length
    ? latestEvents.map((event) => `
      <tr>
        <td>${event.reason || "--"}</td>
        <td>${event.driver || "--"}</td>
        <td>${event.stage || "--"}</td>
        <td>${event.trip || "--"}</td>
        <td>${event.destination || "--"}</td>
        <td>${formatSafeDateTime(event.time)}</td>
        <td>${event.delayMinutes || 0} min</td>
      </tr>`).join("")
    : '<tr><td colspan="7">No activity captured for this report.</td></tr>';
  const stageMarkup = stagePerformance.length
    ? stagePerformance.map((stage) => `
      <tr>
        <td>${stage.label}</td>
        <td>${stage.plannedFinishMinute != null ? formatMinutes(stage.plannedFinishMinute) : "--"}</td>
        <td>${stage.actualFinishMinute != null ? formatMinutes(stage.actualFinishMinute) : "--"}</td>
        <td>${stage.varianceMinutes == null ? "--" : formatSignedMinuteLabel(stage.varianceMinutes)}</td>
        <td>${stage.summary}</td>
      </tr>`).join("")
    : '<tr><td colspan="5">No stage analysis available.</td></tr>';
  const hotspotMarkup = delayHotspots.length
    ? delayHotspots.map((item) => `
      <tr>
        <td>${item.stage}</td>
        <td>${item.reason}</td>
        <td>${item.events}</td>
        <td>${formatMinutes(item.minutes)}</td>
      </tr>`).join("")
    : '<tr><td colspan="4">No structured delay causes were recorded.</td></tr>';

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>${title}</title>
  <style>
    body { font-family: Arial, sans-serif; margin: 24px; color: #0f172a; }
    h1 { margin: 0 0 6px; font-size: 24px; }
    h2 { margin-top: 24px; }
    .sub { margin: 0 0 22px; color: #475569; }
    .grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; margin-bottom: 24px; }
    .tile { border: 1px solid #cbd5e1; border-radius: 12px; padding: 12px 14px; }
    .label { font-size: 12px; text-transform: uppercase; letter-spacing: .08em; color: #64748b; margin-bottom: 4px; }
    .value { font-size: 15px; font-weight: 700; }
    .narrative { border: 1px solid #cbd5e1; border-radius: 12px; padding: 14px; margin: 12px 0; background: #f8fafc; }
    table { width: 100%; border-collapse: collapse; margin-top: 12px; }
    th, td { border: 1px solid #cbd5e1; padding: 10px; text-align: left; font-size: 13px; vertical-align: top; }
    th { background: #e2e8f0; }
    .note { margin-top: 20px; font-size: 13px; color: #475569; }
    @media print { body { margin: 12mm; } }
  </style>
</head>
<body>
  <h1>${title}</h1>
  <p class="sub">RigSync operational report snapshot</p>
  <div class="grid">
    ${metrics.map(([label, value]) => `<div class="tile"><div class="label">${label}</div><div class="value">${value}</div></div>`).join("")}
  </div>
  <div class="narrative"><strong>Actual vs Plan:</strong> ${report.actualVsPlanSummary || "No schedule analysis available."}</div>
  <div class="narrative"><strong>Delay Analysis:</strong> ${report.delaySummary || "No delay analysis available."}</div>
  <h2>Stage Performance</h2>
  <table>
    <thead>
      <tr>
        <th>Stage</th>
        <th>Planned Finish</th>
        <th>Actual Finish</th>
        <th>Variance</th>
        <th>Assessment</th>
      </tr>
    </thead>
    <tbody>${stageMarkup}</tbody>
  </table>
  <h2>Delay Drivers</h2>
  <table>
    <thead>
      <tr>
        <th>Stage</th>
        <th>Driver</th>
        <th>Events</th>
        <th>Minutes</th>
      </tr>
    </thead>
    <tbody>${hotspotMarkup}</tbody>
  </table>
  <h2>Latest Activity</h2>
  <table>
    <thead>
      <tr>
        <th>Reason</th>
        <th>Driver</th>
        <th>Stage</th>
        <th>Trip</th>
        <th>Destination</th>
        <th>Time</th>
        <th>Delay</th>
      </tr>
    </thead>
    <tbody>${eventsMarkup}</tbody>
  </table>
  <p class="note">Use the browser print dialog and choose Save as PDF.</p>
</body>
</html>`;
}

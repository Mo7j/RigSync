import { React, h } from "../lib/react.js";
import { AppLayout } from "../layouts/AppLayout.js";
import { Button } from "../components/ui/Button.js";
import { Card, StatCard } from "../components/ui/Card.js";
import { ProgressBar } from "../components/ui/ProgressBar.js";
import { formatDate, formatLocationLabel } from "../lib/format.js";
import { translate } from "../lib/language.js";

const { useEffect, useMemo, useRef, useState } = React;
const DAILY_REPORT_TYPE = "daily";
const FINAL_REPORT_TYPE = "final";
const DAILY_REPORT_INTERVAL_MS = 15 * 60 * 1000;
const DAILY_REPORT_SLOTS = ["Morning", "Night"];
const FLAG_STATE_OPEN = "open";
const FLAG_STATE_RESOLVED = "resolved";

function isSameCalendarDay(value, referenceDate = new Date()) {
  if (!value) {
    return false;
  }
  const date = value instanceof Date ? value : new Date(value);
  const reference = referenceDate instanceof Date ? referenceDate : new Date(referenceDate);
  if (Number.isNaN(date.getTime()) || Number.isNaN(reference.getTime())) {
    return false;
  }
  return date.getFullYear() === reference.getFullYear()
    && date.getMonth() === reference.getMonth()
    && date.getDate() === reference.getDate();
}

function getReportDateKey(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "";
  }
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function getQuarterHourBucketKey(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "";
  }
  const minuteBucket = Math.floor(date.getMinutes() / 15) * 15;
  return `${getReportDateKey(date)}-${String(date.getHours()).padStart(2, "0")}-${String(minuteBucket).padStart(2, "0")}`;
}

function isQuarterHourBoundary(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    return false;
  }
  return date.getMinutes() % 15 === 0;
}

function formatSafeDateTime(value, fallback = "--") {
  if (!value) {
    return fallback;
  }
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    return fallback;
  }
  return `${formatDate(date)} ${date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
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

function buildLiveFlagEntries(assignments = [], currentDate = new Date()) {
  const entries = [];

  (assignments || []).forEach((assignment) => {
    (assignment.flags || []).forEach((flag, index) => {
      const createdAt = flag.createdAt || assignment.updatedAt || assignment.assignedAt || null;
      const resolvedAt = flag.resolvedAt || null;
      const explicitMinutes = Math.max(0, Number(flag.lateMinutes) || 0);
      let delayMinutes = explicitMinutes;
      if (!delayMinutes && createdAt) {
        const createdMs = new Date(createdAt).getTime();
        const referenceMs = String(flag.status || "open").trim().toLowerCase() === "resolved"
          ? new Date(resolvedAt || createdAt).getTime()
          : currentDate.getTime();
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
        state: String(flag.status || "open").trim().toLowerCase() === "resolved" ? "resolved" : "open",
      });
    });
  });

  return entries.sort((left, right) => new Date(right.createdAt || 0) - new Date(left.createdAt || 0));
}

function getMoveSummary(move, managerResources, currentDate = new Date(), t = (key, fallback) => fallback) {
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

  return {
    moveId: move.id,
    moveName: getMoveDisplayName(move),
    route: `${formatLocationLabel(move?.startLabel, t("source", "Source"))} -> ${formatLocationLabel(move?.endLabel, t("destination", "Destination"))}`,
    status: getMoveStatus(move, t),
    startLabel: move?.startLabel || null,
    endLabel: move?.endLabel || null,
    progress: progressPercent,
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
    isActive,
    isCompleted,
  };
}

function buildDailyReportRecord(summary, currentDate) {
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
  };
}

function buildPrintMarkup(report, kind, generatedAt) {
  const title = kind === FINAL_REPORT_TYPE ? "Final Move Report" : `${report.slot || "Daily"} Daily Report`;
  const metrics = [
    ["Move", report.moveName || "--"],
    ["Route", report.route || "--"],
    ["Status", report.status || "--"],
    ["Generated At", formatSafeDateTime(report.createdAt || generatedAt)],
    ["Progress", `${report.progress || 0}%`],
    ["Completed Tasks", `${report.completedTasks || 0}/${report.totalTasks || 0}`],
    ["Remaining Tasks", String(report.remainingTasks || 0)],
    ["Active Drivers", String(report.activeDrivers || 0)],
    ["Completed Stage Tasks", String(report.completedStageTasks || 0)],
    ["Delay Events", String(report.delayEventCount || 0)],
    ["Delay Minutes", `${report.delayMinutes || 0} min`],
    ["Latest Reason", report.latestReason || "No issue recorded."],
  ];

  const latestEvents = Array.isArray(report.latestEvents) ? report.latestEvents : [];
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
    : '<tr><td colspan="7">No activity captured for this report.</td></tr>' ;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>${title}</title>
  <style>
    body { font-family: Arial, sans-serif; margin: 24px; color: #0f172a; }
    h1 { margin: 0 0 6px; font-size: 24px; }
    .sub { margin: 0 0 22px; color: #475569; }
    .grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; margin-bottom: 24px; }
    .tile { border: 1px solid #cbd5e1; border-radius: 12px; padding: 12px 14px; }
    .label { font-size: 12px; text-transform: uppercase; letter-spacing: .08em; color: #64748b; margin-bottom: 4px; }
    .value { font-size: 15px; font-weight: 700; }
    table { width: 100%; border-collapse: collapse; margin-top: 12px; }
    th, td { border: 1px solid #cbd5e1; padding: 10px; text-align: left; font-size: 13px; }
    th { background: #e2e8f0; }
    .note { margin-top: 20px; font-size: 13px; color: #475569; }
    @media print { body { margin: 12mm; } }
  </style>
</head>
<body>
  <h1>${title}</h1>
  <p class="sub">RigSync local report snapshot</p>
  <div class="grid">
    ${metrics.map(([label, value]) => `<div class="tile"><div class="label">${label}</div><div class="value">${value}</div></div>`).join("")}
  </div>
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

function buildFinalReportRecord(summary, currentDate) {
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
  };
}

export function ReportsPage({
  currentUser,
  currentDate,
  moves,
  managerResources,
  onSaveResources,
  onBack,
  onLogout,
  language = "en",
  onToggleLanguage,
}) {
  const t = (key, fallback) => translate(language, key, fallback);
  const [activeTab, setActiveTab] = useState("daily");
  const [reportNow, setReportNow] = useState(() => new Date());
  const minuteGenerationRef = useRef("");
  const finalGenerationRef = useRef("");

  useEffect(() => {
    function syncNow() {
      setReportNow(new Date());
    }

    syncNow();
    const delayMs = 60000 - ((Date.now() % 60000) || 60000);
    const timeoutId = window.setTimeout(() => {
      syncNow();
      const intervalId = window.setInterval(syncNow, 60000);
      window.__rigsyncReportsMinuteInterval = intervalId;
    }, delayMs);

    return () => {
      window.clearTimeout(timeoutId);
      if (window.__rigsyncReportsMinuteInterval) {
        window.clearInterval(window.__rigsyncReportsMinuteInterval);
        window.__rigsyncReportsMinuteInterval = null;
      }
    };
  }, []);

  const reports = Array.isArray(managerResources?.reports) ? managerResources.reports : [];
  const allMoveSummaries = useMemo(
    () => (moves || []).map((move) => getMoveSummary(move, managerResources, reportNow, t)),
    [moves, managerResources, reportNow, language],
  );
  const activeMoveSummaries = useMemo(() => allMoveSummaries.filter((summary) => summary.isActive), [allMoveSummaries]);
  const completedMoveSummaries = useMemo(() => allMoveSummaries.filter((summary) => summary.isCompleted), [allMoveSummaries]);
  const dailyReports = useMemo(
    () => reports.filter((report) => String(report?.type || "").trim().toLowerCase() === DAILY_REPORT_TYPE).sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0)),
    [reports],
  );
  const finalReports = useMemo(
    () => reports.filter((report) => String(report?.type || "").trim().toLowerCase() === FINAL_REPORT_TYPE).sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0)),
    [reports],
  );
  const allTaskAssignments = useMemo(
    () => (Array.isArray(managerResources?.taskAssignments) ? managerResources.taskAssignments : []),
    [managerResources],
  );
  const allFlagEntries = useMemo(
    () => buildLiveFlagEntries(allTaskAssignments, reportNow),
    [allTaskAssignments, reportNow],
  );
  const latestDelayEvents = useMemo(
    () => allFlagEntries.slice(0, 8),
    [allFlagEntries],
  );
  const reportTotals = useMemo(() => ({
    activeRigsToday: activeMoveSummaries.length,
    tasksCompleted: allMoveSummaries.reduce((sum, summary) => sum + summary.completedToday, 0),
    generatedDailyReports: dailyReports.length,
    generatedFinalReports: finalReports.length,
    delayedRigs: allMoveSummaries.filter((summary) => summary.delayEventCount > 0 || summary.delayMinutesToday > 0).length,
    openFlags: allFlagEntries.filter((event) => event.state !== FLAG_STATE_RESOLVED).length,
    activeDrivers: allMoveSummaries.reduce((sum, summary) => sum + summary.activeDriversCount, 0),
    completedMoves: completedMoveSummaries.length,
  }), [activeMoveSummaries, allMoveSummaries, dailyReports, finalReports, allFlagEntries, completedMoveSummaries]);

  useEffect(() => {
    if (typeof onSaveResources !== "function" || !activeMoveSummaries.length) {
      return;
    }
    if (!isQuarterHourBoundary(reportNow)) {
      return;
    }
    const bucketKey = getQuarterHourBucketKey(reportNow);
    if (!bucketKey || minuteGenerationRef.current === bucketKey) {
      return;
    }

    const reportDate = getReportDateKey(reportNow);
    const nextReports = [];
    activeMoveSummaries.forEach((summary) => {
      const moveReportsToday = dailyReports
        .filter((report) => report.moveId === summary.moveId && report.reportDate === reportDate)
        .sort((left, right) => new Date(left.createdAt || 0) - new Date(right.createdAt || 0));
      if (moveReportsToday.length >= DAILY_REPORT_SLOTS.length) {
        return;
      }
      const latestReport = moveReportsToday[moveReportsToday.length - 1] || null;
      const latestReportMs = latestReport ? new Date(latestReport.createdAt || 0).getTime() : 0;
      const reportNowMs = reportNow.getTime();
      if (latestReportMs > 0 && Number.isFinite(latestReportMs) && reportNowMs - latestReportMs < DAILY_REPORT_INTERVAL_MS) {
        return;
      }
      const nextSlot = DAILY_REPORT_SLOTS[moveReportsToday.length];
      nextReports.push(buildDailyReportRecord({ ...summary, slot: nextSlot }, reportNow));
    });

    minuteGenerationRef.current = bucketKey;
    if (!nextReports.length) {
      return;
    }

    void onSaveResources({
      ...(managerResources || {}),
      reports: [...reports, ...nextReports],
    });
  }, [activeMoveSummaries, dailyReports, managerResources, onSaveResources, reportNow, reports]);

  useEffect(() => {
    if (typeof onSaveResources !== "function" || !completedMoveSummaries.length) {
      return;
    }

    const pendingFinals = completedMoveSummaries
      .filter((summary) => summary.totalTasks > 0)
      .filter((summary) => !finalReports.some((report) => report.moveId === summary.moveId))
      .map((summary) => buildFinalReportRecord(summary, reportNow));

    const finalKey = pendingFinals.map((report) => report.id).join("|");
    if (!finalKey || finalGenerationRef.current === finalKey) {
      return;
    }
    finalGenerationRef.current = finalKey;

    void onSaveResources({
      ...(managerResources || {}),
      reports: [...reports, ...pendingFinals],
    });
  }, [completedMoveSummaries, finalReports, managerResources, onSaveResources, reportNow, reports]);

  function handlePrintReport(report, kind) {
    const printWindow = window.open("", "_blank", "width=980,height=760");
    if (!printWindow) {
      window.alert("Please allow popups to print this report.");
      return;
    }
    const markup = buildPrintMarkup(report, kind, reportNow);
    printWindow.document.open();
    printWindow.document.write(markup);
    printWindow.document.close();
    printWindow.focus();
    window.setTimeout(() => {
      printWindow.print();
    }, 250);
  }

  function handleDeleteReport(reportId) {
    if (typeof onSaveResources !== "function") {
      return;
    }
    void onSaveResources({
      ...(managerResources || {}),
      reports: reports.filter((report) => report.id !== reportId),
    });
  }

  function handleUpdateFlag(flagId, mutateFlag) {
    if (typeof onSaveResources !== "function") {
      return;
    }
    const nextTaskAssignments = allTaskAssignments.map((assignment) => {
      const flags = Array.isArray(assignment.flags) ? assignment.flags : [];
      if (!flags.some((flag) => flag?.id === flagId)) {
        return assignment;
      }
      return {
        ...assignment,
        flags: mutateFlag(flags),
        updatedAt: new Date().toISOString(),
      };
    });
    void onSaveResources({
      ...(managerResources || {}),
      taskAssignments: nextTaskAssignments,
    });
  }

  function handleResolveFlag(flagId) {
    handleUpdateFlag(flagId, (flags) =>
      flags.map((flag) =>
        flag?.id === flagId
          ? {
              ...flag,
              status: FLAG_STATE_RESOLVED,
              resolvedAt: flag.resolvedAt || new Date().toISOString(),
            }
          : flag,
      ),
    );
  }

  function handleDeleteFlag(flagId) {
    handleUpdateFlag(flagId, (flags) => flags.filter((flag) => flag?.id !== flagId));
  }

  function renderPrintButton(report, kind) {
    return h(Button, {
      type: "button",
      variant: "ghost",
      size: "sm",
      onClick: () => handlePrintReport(report, kind),
      children: h(
        "span",
        { className: "report-print-icon", "aria-label": "Print report", title: "Print report" },
        h(
          "svg",
          { viewBox: "0 0 24 24", width: "16", height: "16", "aria-hidden": "true" },
          h("path", { fill: "currentColor", d: "M7 3h10v4H7V3zm10 8h2v6h-3v4H8v-4H5v-6h2v4h10v-4zm-3 8v-4H10v4h4zM6 9h12a3 3 0 0 1 3 3v5h-3v-2H6v2H3v-5a3 3 0 0 1 3-3z" })
        )
      ),
    });
  }

  function renderDeleteButton(onClick, label = "Delete") {
    return h(Button, {
      type: "button",
      variant: "ghost",
      size: "sm",
      onClick,
      children: label,
    });
  }

  function renderActiveTab() {
    return activeMoveSummaries.length
      ? h(
          "div",
          { className: "manager-resource-grid" },
          activeMoveSummaries.map((summary) =>
            h(
              "article",
              { key: summary.moveId, className: "manager-resource-card" },
              h(
                "div",
                { className: "manager-resource-card-head" },
                h("div", null, h("strong", null, summary.moveName), h("p", { className: "muted-copy" }, summary.route)),
                h("span", { className: "manager-resource-status manager-resource-status-active" }, summary.status),
              ),
              h(
                "div",
                { className: "manager-resource-metrics" },
                h("div", { className: "manager-rig-stat" }, h("span", null, t("progress", "Progress")), h("strong", null, `${summary.progress}%`)),
                h("div", { className: "manager-rig-stat" }, h("span", null, t("completedTasks", "Completed Tasks")), h("strong", null, `${summary.completedTasks}/${summary.totalTasks || 0}`)),
                h("div", { className: "manager-rig-stat" }, h("span", null, t("delayMinutesToday", "Delay Minutes Today")), h("strong", null, `${summary.delayMinutesToday} ${t("min", "min")}`)),
                h("div", { className: "manager-rig-stat" }, h("span", null, t("activeDrivers", "Active Drivers")), h("strong", null, String(summary.activeDriversCount))),
              ),
              h(ProgressBar, { value: summary.progress }),
            ),
          ),
        )
      : h("p", { className: "muted-copy" }, "No active rig moves right now.");
  }

  function renderDailyTab() {
    return dailyReports.length
      ? h(
          "div",
          { className: "manager-report-tab-stack" },
          dailyReports.map((report) =>
            h(
              Card,
              { key: report.id, className: "dashboard-section-card manager-dashboard-panel" },
              h(
                "div",
                { className: "manager-resource-card-head" },
                h("div", null, h("strong", null, report.moveName), h("p", { className: "muted-copy" }, report.route || "--")),
                h(
                  "div",
                  { className: "driver-task-actions" },
                  h("span", { className: "manager-resource-status manager-resource-status-active" }, report.slot || "Morning"),
                  renderPrintButton(report, DAILY_REPORT_TYPE),
                  renderDeleteButton(() => handleDeleteReport(report.id)),
                ),
              ),
              h(
                "div",
                { className: "manager-resource-metrics" },
                h("div", { className: "manager-rig-stat" }, h("span", null, "Created At"), h("strong", null, formatSafeDateTime(report.createdAt))),
                h("div", { className: "manager-rig-stat" }, h("span", null, t("progress", "Progress")), h("strong", null, `${report.progress || 0}%`)),
                h("div", { className: "manager-rig-stat" }, h("span", null, t("completedTasks", "Completed Tasks")), h("strong", null, `${report.completedTasks || 0}/${report.totalTasks || 0}`)),
                h("div", { className: "manager-rig-stat" }, h("span", null, "Remaining Tasks"), h("strong", null, String(report.remainingTasks || 0))),
                h("div", { className: "manager-rig-stat" }, h("span", null, t("delayMinutesToday", "Delay Minutes Today")), h("strong", null, `${report.delayMinutes || 0} ${t("min", "min")}`)),
                h("div", { className: "manager-rig-stat" }, h("span", null, t("activeDrivers", "Active Drivers")), h("strong", null, String(report.activeDrivers || 0))),
              ),
              h("p", { className: "muted-copy" }, report.latestReason || "No delay reason recorded."),
            ),
          ),
        )
      : h("p", { className: "muted-copy" }, "No saved daily reports yet. Reports are generated every 15 minutes for active rig moves, up to Morning and Night per day.");
  }

  function renderFinalTab() {
    return finalReports.length
      ? h(
          "div",
          { className: "manager-report-tab-stack" },
          finalReports.map((report) =>
            h(
              Card,
              { key: report.id, className: "dashboard-section-card manager-dashboard-panel" },
              h(
                "div",
                { className: "manager-resource-card-head" },
                h("div", null, h("strong", null, report.moveName), h("p", { className: "muted-copy" }, report.route || "--")),
                h(
                  "div",
                  { className: "driver-task-actions" },
                  h("span", { className: "manager-resource-status manager-resource-status-active" }, "Final"),
                  renderPrintButton(report, FINAL_REPORT_TYPE),
                  renderDeleteButton(() => handleDeleteReport(report.id)),
                ),
              ),
              h(
                "div",
                { className: "manager-resource-metrics" },
                h("div", { className: "manager-rig-stat" }, h("span", null, "Created At"), h("strong", null, formatSafeDateTime(report.createdAt))),
                h("div", { className: "manager-rig-stat" }, h("span", null, t("completion", "Completion")), h("strong", null, `${report.progress || 100}%`)),
                h("div", { className: "manager-rig-stat" }, h("span", null, t("completedTasks", "Completed Tasks")), h("strong", null, `${report.completedTasks || 0}/${report.totalTasks || 0}`)),
                h("div", { className: "manager-rig-stat" }, h("span", null, "Completed Stage Tasks"), h("strong", null, String(report.completedStageTasks || 0))),
                h("div", { className: "manager-rig-stat" }, h("span", null, "Delay Minutes"), h("strong", null, `${report.delayMinutes || 0} ${t("min", "min")}`)),
                h("div", { className: "manager-rig-stat" }, h("span", null, "Delay Events"), h("strong", null, String(report.delayEventCount || 0))),
              ),
              h("p", { className: "muted-copy" }, report.latestReason || "No delay reason recorded."),
            ),
          ),
        )
      : h("p", { className: "muted-copy" }, "No final reports yet. A final report is saved automatically when completed tasks reach total tasks.");
  }

  return h(
    AppLayout,
    {
      title: `Reports - ${currentUser?.name || t("managerView", "Manager view")}`,
      subtitle: formatDate(currentDate),
      currentUser,
      onLogout,
      language,
      onToggleLanguage,
      fullBleed: true,
    },
    h(
      "section",
      { className: "dashboard-shell manager-dashboard-shell" },
      h(
        "div",
        { className: "section-heading" },
        h("div", null, h("h2", null, "Reports Command Center"), h("p", { className: "muted-copy" }, "Daily and final move reporting using the local database flow.")),
        h(Button, { type: "button", variant: "ghost", onClick: onBack, children: t("back", "Back") }),
      ),
      h(
        "div",
        { className: "manager-summary-grid" },
        h(StatCard, { label: "Active rigs today", value: String(reportTotals.activeRigsToday), meta: "Rig moves contributing to live reporting", tone: "default" }),
        h(StatCard, { label: "Tasks completed", value: String(reportTotals.tasksCompleted), meta: "Finished assignment tasks across tracked moves", tone: "default" }),
        h(StatCard, { label: "Daily reports", value: String(reportTotals.generatedDailyReports), meta: "Morning and Night snapshots generated today", tone: "default" }),
        h(StatCard, { label: "Final reports", value: String(reportTotals.generatedFinalReports), meta: "Completed move closeout snapshots", tone: "default" }),
      ),
      h(
        "div",
        { className: "manager-dashboard-layout" },
        h(
          "aside",
          { className: "manager-dashboard-rail" },
          [
            { key: "active", label: "Active Rigs", count: String(activeMoveSummaries.length) },
            { key: "daily", label: "Daily Report", count: String(dailyReports.length) },
            { key: "final", label: "Final Report", count: String(finalReports.length) },
          ].map((item) =>
            h(
              "button",
              {
                key: item.key,
                type: "button",
                className: `manager-dashboard-nav-button${activeTab === item.key ? " is-active" : ""}`,
                onClick: () => setActiveTab(item.key),
                title: item.label,
                "aria-label": item.label,
              },
              h("span", { className: `manager-dashboard-nav-icon-wrap${activeTab === item.key ? " is-active" : ""}` }, item.label.slice(0, 1)),
              h("span", { className: "manager-dashboard-nav-count" }, item.count),
            ),
          ),
        ),
        h(
          "section",
          { className: "manager-dashboard-primary" },
          h(
            Card,
            { className: "dashboard-section-card manager-dashboard-panel" },
            h(
              "div",
              { className: "section-heading" },
              h(
                "div",
                null,
                h("h2", null, activeTab === "active" ? "Active Rigs" : activeTab === "daily" ? "Daily Report" : "Final Report"),
                h("p", { className: "muted-copy" }, activeTab === "active"
                  ? "Current active rig status from the local operation flow."
                  : activeTab === "daily"
                  ? "Saved Morning and Night daily snapshots generated automatically every 15 minutes for testing."
                    : "Final move closeout reports generated automatically when all tasks are completed."),
              ),
              activeTab === "daily"
                ? h("span", { className: "section-pill" }, `${dailyReports.length} reports`)
                : activeTab === "final"
                  ? h("span", { className: "section-pill" }, `${finalReports.length} final`)
                  : h("span", { className: "section-pill" }, `${activeMoveSummaries.length} active`),
            ),
            activeTab === "active"
              ? renderActiveTab()
              : activeTab === "daily"
                ? renderDailyTab()
                : renderFinalTab(),
          ),
        ),
        h(
          "aside",
          { className: "manager-dashboard-sidebar" },
          h(
            Card,
            { className: "dashboard-section-card manager-dashboard-panel" },
            h("div", { className: "section-heading" }, h("h2", null, "Report Totals")),
            h(
              "div",
              { className: "manager-report-preview-grid" },
              [
                { label: "Delayed rigs", value: String(reportTotals.delayedRigs), meta: "Moves with delay activity" },
                { label: "Open flags", value: String(reportTotals.openFlags), meta: "Unresolved reported issues" },
                { label: "Active drivers", value: String(reportTotals.activeDrivers), meta: "Across tracked moves" },
                { label: "Completed moves", value: String(reportTotals.completedMoves), meta: "Final reports available" },
              ].map((item) =>
                h(
                  "article",
                  { key: item.label, className: "manager-resource-mini-card" },
                  h("span", { className: "manager-resource-mini-label" }, item.label),
                  h("strong", { className: "manager-resource-mini-value" }, item.value),
                  h("p", { className: "muted-copy" }, item.meta),
                ),
              ),
            ),
          ),
          h(
            Card,
            { className: "dashboard-section-card manager-dashboard-panel" },
            h("div", { className: "section-heading" }, h("h2", null, "Flag List"), h("span", { className: "section-pill" }, `${latestDelayEvents.length} items`)),
            latestDelayEvents.length
              ? h(
                  "div",
                  { className: "manager-resource-grid" },
                  latestDelayEvents.map((event) =>
                    h(
                      "article",
                      { key: event.id, className: "manager-resource-card" },
                      h("div", { className: "manager-resource-card-head" }, h("div", null, h("strong", null, event.reason), h("p", { className: "muted-copy" }, event.moveName)), h("span", { className: `manager-resource-status ${event.state === FLAG_STATE_RESOLVED ? "manager-resource-status-active" : "manager-resource-status-busy"}` }, event.state === FLAG_STATE_RESOLVED ? "Resolved" : "Open")),
                      h("p", { className: "muted-copy" }, `${event.driverName || "Driver"} - ${event.stage || "move"}`),
                      h("div", { className: "manager-resource-metrics" },
                        h("div", { className: "manager-rig-stat" }, h("span", null, "Trip"), h("strong", null, event.trip || "--")),
                        h("div", { className: "manager-rig-stat" }, h("span", null, "Destination"), h("strong", null, event.destination || "--")),
                        h("div", { className: "manager-rig-stat" }, h("span", null, "Time"), h("strong", null, formatSafeDateTime(event.time))),
                        h("div", { className: "manager-rig-stat" }, h("span", null, "Delay"), h("strong", null, `${event.delayMinutes || 0} min`)),
                      ),
                      h("div", { className: "driver-task-actions" },
                        event.state !== FLAG_STATE_RESOLVED ? renderDeleteButton(() => handleResolveFlag(event.id), "Resolve") : null,
                        renderDeleteButton(() => handleDeleteFlag(event.id)),
                      ),
                    ),
                  ),
                )
              : h("p", { className: "muted-copy" }, "No flags captured yet."),
          ),
        ),
      ),
    ),
  );
}


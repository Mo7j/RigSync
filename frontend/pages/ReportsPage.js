import { React, h } from "../lib/react.js";
import { AppLayout } from "../layouts/AppLayout.js";
import { Button } from "../components/ui/Button.js";
import { Card, StatCard } from "../components/ui/Card.js";
import { ProgressBar } from "../components/ui/ProgressBar.js";
import { formatDate, formatMinutes } from "../lib/format.js";
import { translate } from "../lib/language.js";
import {
  DAILY_REPORT_TYPE,
  FINAL_REPORT_TYPE,
  FLAG_STATE_RESOLVED,
  buildDailyReportRecord,
  buildFinalReportRecord,
  buildLiveFlagEntries,
  buildMoveSummary,
  buildPrintMarkup,
  formatSafeDateTime,
  getQuarterHourBucketKey,
  getReportDateKey,
  isQuarterHourBoundary,
} from "../features/rigMoves/reporting.js";

const { useEffect, useMemo, useRef, useState } = React;
const DAILY_REPORT_INTERVAL_MS = 15 * 60 * 1000;
const DAILY_REPORT_SLOTS = ["Morning", "Night"];

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
    () => (moves || []).map((move) => buildMoveSummary(move, managerResources, reportNow, t)),
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

  function renderScheduleStats(item) {
    const hasActualElapsed = Number.isFinite(Number(item.actualElapsedMinutes));
    return h(
      "div",
      { className: "manager-resource-metrics" },
      h("div", { className: "manager-rig-stat" }, h("span", null, "Planned Duration"), h("strong", null, item.plannedTotalMinutes ? formatMinutes(item.plannedTotalMinutes) : "--")),
      h("div", { className: "manager-rig-stat" }, h("span", null, "Actual Elapsed"), h("strong", null, hasActualElapsed ? formatMinutes(item.actualElapsedMinutes) : "--")),
      h("div", { className: "manager-rig-stat" }, h("span", null, "Schedule Status"), h("strong", null, item.scheduleStatus || "--")),
      h("div", { className: "manager-rig-stat" }, h("span", null, "Schedule Variance"), h("strong", null, item.scheduleVarianceMinutes == null ? "--" : `${item.scheduleVarianceMinutes > 0 ? "+" : ""}${formatMinutes(Math.abs(item.scheduleVarianceMinutes))}`)),
      h("div", { className: "manager-rig-stat" }, h("span", null, "Planned Progress"), h("strong", null, `${item.plannedProgress || 0}%`)),
      h("div", { className: "manager-rig-stat" }, h("span", null, "Progress Variance"), h("strong", null, `${item.progressVariance > 0 ? "+" : ""}${item.progressVariance || 0} pts`)),
    );
  }

  function renderStagePerformance(stagePerformance = []) {
    return stagePerformance.length
      ? h(
          "div",
          { className: "manager-list-stack" },
          stagePerformance.map((stage) =>
            h(
              "article",
              { key: stage.key, className: "manager-list-row manager-list-row-card" },
              h("div", null, h("strong", null, stage.label), h("p", { className: "muted-copy" }, stage.summary)),
              h("strong", null, stage.varianceMinutes == null ? "--" : `${stage.varianceMinutes > 0 ? "+" : ""}${formatMinutes(Math.abs(stage.varianceMinutes))}`),
            ),
          ),
        )
      : h("p", { className: "muted-copy" }, "No stage performance recorded.");
  }

  function renderDelayHotspots(delayHotspots = []) {
    return delayHotspots.length
      ? h(
          "div",
          { className: "manager-list-stack" },
          delayHotspots.map((item) =>
            h(
              "article",
              { key: item.id, className: "manager-list-row manager-list-row-card" },
              h("div", null, h("strong", null, item.reason), h("p", { className: "muted-copy" }, `${item.stage} • ${item.events} events`)),
              h("strong", null, formatMinutes(item.minutes)),
            ),
          ),
        )
      : h("p", { className: "muted-copy" }, "No dominant delay drivers recorded.");
  }

  function renderActiveTab() {
    return activeMoveSummaries.length
      ? h(
          "div",
          { className: "manager-report-tab-stack" },
          activeMoveSummaries.map((summary) =>
            h(
              Card,
              { key: summary.moveId, className: "dashboard-section-card manager-dashboard-panel" },
              h(
                "div",
                { className: "manager-resource-card-head" },
                h("div", null, h("strong", null, summary.moveName), h("p", { className: "muted-copy" }, summary.route)),
                h("span", { className: "manager-resource-status manager-resource-status-active" }, summary.scheduleStatus || summary.status),
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
              renderScheduleStats(summary),
              h("p", { className: "muted-copy" }, summary.actualVsPlanSummary),
              h("p", { className: "muted-copy" }, summary.delaySummary),
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
              renderScheduleStats(report),
              h("p", { className: "muted-copy" }, report.actualVsPlanSummary || "No actual-vs-plan analysis available."),
              h("p", { className: "muted-copy" }, report.delaySummary || report.latestReason || "No delay reason recorded."),
              h("div", { className: "manager-report-preview-grid" },
                h("article", { className: "manager-insight-card" }, h("span", { className: "manager-insight-label" }, "Stage Performance"), renderStagePerformance(report.stagePerformance || [])),
                h("article", { className: "manager-insight-card" }, h("span", { className: "manager-insight-label" }, "Delay Drivers"), renderDelayHotspots(report.delayHotspots || [])),
              ),
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
              renderScheduleStats(report),
              h("p", { className: "muted-copy" }, report.actualVsPlanSummary || "No actual-vs-plan analysis available."),
              h("p", { className: "muted-copy" }, report.delaySummary || report.latestReason || "No delay reason recorded."),
              h("div", { className: "manager-report-preview-grid" },
                h("article", { className: "manager-insight-card" }, h("span", { className: "manager-insight-label" }, "Stage Performance"), renderStagePerformance(report.stagePerformance || [])),
                h("article", { className: "manager-insight-card" }, h("span", { className: "manager-insight-label" }, "Delay Drivers"), renderDelayHotspots(report.delayHotspots || [])),
              ),
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


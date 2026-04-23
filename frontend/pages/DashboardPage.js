import { React, h } from "../lib/react.js";
import { AppLayout } from "../layouts/AppLayout.js";
import { Button } from "../components/ui/Button.js";
import { Card, StatCard } from "../components/ui/Card.js";
import { Field, TextInput } from "../components/ui/Field.js";
import { Modal } from "../components/ui/Modal.js";
import { ProgressBar } from "../components/ui/ProgressBar.js";
import { LeafletMap } from "../components/map/LeafletMap.js";
import { formatCoordinate, formatDate, formatLocationLabel } from "../lib/format.js";
import { fetchLocationLabel } from "../features/rigMoves/api.js";

const { useRef, useState } = React;

function countActiveLoads(startupLoads = []) {
  return startupLoads.reduce((sum, item) => sum + (item.coveredCount || 0), 0);
}

function getRigStatus(activeMove) {
  if (activeMove?.operatingState === "drilling") {
    return "Drilling";
  }
  if (activeMove?.executionState === "active") {
    return "Moving";
  }
  if (activeMove?.executionState === "planning") {
    return "Planning move";
  }
  return "Drilling";
}

function formatProgressDuration(ms = 0) {
  const totalSeconds = Math.max(0, Math.round((Number(ms) || 0) / 1000));
  if (totalSeconds < 60) {
    return `${totalSeconds}s`;
  }

  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return seconds ? `${minutes}m ${seconds}s` : `${minutes}m`;
}

function ForemanNavIcon({ name }) {
  const baseProps = {
    className: "manager-nav-icon-svg",
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: "1.8",
    strokeLinecap: "round",
    strokeLinejoin: "round",
    "aria-hidden": "true",
  };

  if (name === "dashboard") {
    return h(
      "svg",
      baseProps,
      h("rect", { x: "3", y: "3", width: "7", height: "7", rx: "2" }),
      h("rect", { x: "14", y: "3", width: "7", height: "7", rx: "2" }),
      h("rect", { x: "3", y: "14", width: "7", height: "7", rx: "2" }),
      h("rect", { x: "14", y: "14", width: "7", height: "7", rx: "2" }),
    );
  }

  if (name === "loads") {
    return h(
      "svg",
      baseProps,
      h("path", { d: "M4 8.5 12 4l8 4.5v7L12 20l-8-4.5z" }),
      h("path", { d: "M12 4v16" }),
      h("path", { d: "M4 8.5 12 13l8-4.5" }),
    );
  }

  return h(
    "svg",
    baseProps,
    h("path", { d: "M7 4h10" }),
    h("path", { d: "M7 9h10" }),
    h("path", { d: "M7 14h10" }),
    h("path", { d: "M7 19h6" }),
    h("rect", { x: "4", y: "3", width: "16", height: "18", rx: "3" }),
  );
}

function MetricStrip({ items, className = "" }) {
  return h(
    "div",
    { className: `manager-metric-strip${className ? ` ${className}` : ""}` },
    items.map((item) =>
      h(
        "article",
        { key: item.label, className: "manager-metric-card" },
        h("span", { className: "manager-metric-label" }, item.label),
        h("strong", { className: "manager-metric-value" }, item.value),
        h("span", { className: "manager-metric-meta" }, item.meta),
      ),
    ),
  );
}

export function DashboardPage({
  moves,
  activeMove,
  rig,
  rigInventory,
  availableFleet,
  currentUser,
  currentDate,
  loadsReady,
  loadsError,
  createError,
  isCreatingMove,
  simulationProgress = { percent: 0, message: "" },
  onCreateMove,
  onSaveRigInventory,
  onOpenMove,
  onLogout,
  language = "en",
  onToggleLanguage,
}) {
  const [endPoint, setEndPoint] = useState(null);
  const [endLabel, setEndLabel] = useState("");
  const [fieldError, setFieldError] = useState("");
  const [isPickerOpen, setIsPickerOpen] = useState(false);
  const [isEditingLoads, setIsEditingLoads] = useState(false);
  const [activeSection, setActiveSection] = useState("dashboard");
  const endLookupRequestRef = useRef(0);

  async function resolveLocationLabelWithRetry(point) {
    const requestId = endLookupRequestRef.current + 1;
    endLookupRequestRef.current = requestId;
    const maxAttempts = 4;

    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      try {
        const resolvedLabel = await fetchLocationLabel(point);
        if (endLookupRequestRef.current !== requestId) {
          return;
        }
        if (resolvedLabel) {
          setEndLabel(resolvedLabel);
          return;
        }
      } catch {
        // Keep the coordinate fallback if lookup fails.
      }

      if (attempt < maxAttempts - 1) {
        await new Promise((resolve) => window.setTimeout(resolve, 1200 * (attempt + 1)));
      }
    }
  }

  async function handleMapPick({ point }) {
    setEndPoint(point);
    setEndLabel(formatCoordinate(point));
    setFieldError("");
    setIsPickerOpen(false);
    void resolveLocationLabelWithRetry(point);
  }

  async function handleSubmit(event) {
    event.preventDefault();

    if (!endPoint) {
      setFieldError("Select a destination location.");
      return;
    }

    await onCreateMove({
      name: `${rig?.name || "Rig"} move`,
      startPoint: rig?.currentPoint,
      endPoint,
      startLabel: rig?.currentLabel || formatCoordinate(rig?.currentPoint),
      endLabel: endLabel || formatCoordinate(endPoint),
    });
  }

  const drillingCompletion = Math.max(0, Math.min(100, Number(rig?.drillingCompletion) || 0));
  const reusableSummary = rigInventory?.reusableSummary || { totalUnits: 0, categoryCount: 0, criticalUnits: 0 };
  const startupSummary = rigInventory?.startupSummary || { totalUnits: 0, coveredUnits: 0, missingUnits: 0 };
  const canOpenActiveMove = Boolean(
    activeMove?.id && (moves || []).some((move) => move && String(move.id) === String(activeMove.id)),
  );
  const reusableNeededLoads = (rigInventory?.startupLoads || []).filter((item) => item.isReusable);
  const [inventoryDraft, setInventoryDraft] = useState(() =>
    Object.fromEntries(
      reusableNeededLoads.map((item) => [
        item.id,
        {
          onSite: item.onSiteCount || 0,
          transferable: item.transferableCount || 0,
        },
      ]),
    ),
  );
  const currentStatus = getRigStatus(activeMove);
  const progressPercent = Math.max(1, Number(simulationProgress?.percent) || 0);
  const progressStageLabel =
    simulationProgress?.totalStages > 0
      ? `${simulationProgress?.completedStages || 0}/${simulationProgress.totalStages} stages`
      : "Planning";
  const progressElapsedLabel = formatProgressDuration(simulationProgress?.elapsedMs || 0);
  const progressRemainingLabel =
    progressPercent >= 100 ? "0s" : formatProgressDuration(simulationProgress?.remainingMs || 0);
  const availableTruckCount = (availableFleet || []).reduce((sum, truck) => sum + (truck.available || 0), 0);
  const activeLoadCount = countActiveLoads(rigInventory?.startupLoads);
  const reportsSummary = {
    perDay: activeMove?.executionState === "active" ? 4 : 0,
    shiftReports: activeMove?.executionState === "active" ? 2 : 0,
    finalPending: activeMove ? 1 : 0,
  };
  const navItems = [
    {
      key: "dashboard",
      label: "Dashboard",
      icon: "dashboard",
      count: currentStatus,
      description: "Track the assigned rig, live move state, and drilling readiness.",
    },
    {
      key: "loads",
      label: "Extra Loads",
      icon: "loads",
      count: `${reusableNeededLoads.length}`,
      description: "Review reusable load coverage, update on-site counts, and keep transfer stock current.",
    },
    {
      key: "reports",
      label: "Reports",
      icon: "reports",
      count: activeMove?.executionState === "active" ? "Live" : "Planned",
      description: "See the reporting cadence expected for the current rig move workflow.",
    },
  ];
  const activeNavItem = navItems.find((item) => item.key === activeSection) || navItems[0];
  const dashboardSummaryItems = [
    { label: "Rig status", value: currentStatus, meta: rig?.currentWell || "Active well" },
    { label: "Drilling completion", value: `${drillingCompletion}%`, meta: "Current well progress" },
    { label: "Reusable stock", value: String(reusableSummary.totalUnits), meta: `${reusableSummary.categoryCount} load groups` },
    { label: "Startup loads ready", value: String(startupSummary.coveredUnits), meta: `${startupSummary.missingUnits} still missing` },
    { label: "Fleet available", value: String(availableTruckCount), meta: "Manager trucks free to assign" },
  ];
  const extraLoadSummaryItems = [
    { label: "Reusable loads", value: String(reusableNeededLoads.length), meta: "Load groups tracked" },
    { label: "On-site ready", value: String(activeLoadCount), meta: "Covered startup loads" },
    { label: "Critical loads", value: String(reusableSummary.criticalUnits), meta: "High-priority units" },
    { label: "Missing units", value: String(startupSummary.missingUnits), meta: "Need coverage" },
  ];
  const reportSummaryItems = [
    { label: "Daily reports", value: String(reportsSummary.perDay), meta: "Expected per active move day" },
    { label: "Shift reports", value: String(reportsSummary.shiftReports), meta: "Start and end of shift" },
    { label: "Final closeout", value: String(reportsSummary.finalPending), meta: "Expected after completion" },
    { label: "Move status", value: currentStatus, meta: activeMove?.name || "No active move" },
  ];
  const sanitizedMoves = [...(moves || [])]
    .filter(Boolean)
    .filter((move) =>
      Boolean(
        move?.id
        && (
          (move?.startLabel && move?.endLabel)
          || move?.routeTime
          || move?.eta
          || move?.createdAt
          || move?.updatedAt
          || move?.simulation?.truckCount
        ),
      ))
    .sort((left, right) => new Date(right.updatedAt || right.createdAt || 0) - new Date(left.updatedAt || left.createdAt || 0));
  const currentForemanMove = sanitizedMoves[0] || null;
  const moveTimelineItems = sanitizedMoves
    .map((move) => {
      const status = getRigStatus(move);
      return {
        id: move.id,
        name: move.name || "Rig move",
        route: `${formatLocationLabel(move.startLabel, "Source")} to ${formatLocationLabel(move.endLabel, "Destination")}`,
        status,
        progress: Math.round(move.completionPercentage || 0),
        meta: [
          move.routeTime || "Route pending",
          move.eta ? `ETA ${move.eta}` : "ETA pending",
          move.createdAt ? `Requested ${formatDate(new Date(move.createdAt))}` : "Requested recently",
        ],
      };
    });

  function syncInventoryDraft(nextInventory) {
    setInventoryDraft(
      Object.fromEntries(
        (nextInventory || []).map((item) => [
          item.id,
          {
            onSite: item.onSiteCount || 0,
            transferable: item.transferableCount || 0,
          },
        ]),
      ),
    );
  }

  React.useEffect(() => {
    syncInventoryDraft(reusableNeededLoads);
  }, [rig?.id, reusableNeededLoads.length, startupSummary.coveredUnits, startupSummary.missingUnits]);

  function handleSaveLoads() {
    onSaveRigInventory?.(rig?.id || `rig-${currentUser?.id || "home"}`, inventoryDraft);
    setIsEditingLoads(false);
  }

  function renderDashboardSection() {
    return [
      h(MetricStrip, { key: "dashboard-strip", items: dashboardSummaryItems, className: "manager-metric-strip-dashboard" }),
      h(
        Card,
        { className: "dashboard-section-card manager-dashboard-panel", key: "rig-overview" },
        h("div", { className: "section-heading" }, h("div", null, h("h2", null, "Rig Command"), h("p", { className: "muted-copy" }, `${formatLocationLabel(rig?.currentLabel, "Current site")} • ${rig?.field || "Assigned field"} • ${rig?.currentWell || "Current well"}`))),
        h(
          "div",
          { className: "manager-resource-metrics" },
          h("div", { className: "manager-rig-stat" }, h("span", null, "Current rig"), h("strong", null, rig?.name || "Assigned rig")),
          h("div", { className: "manager-rig-stat" }, h("span", null, "Daily target"), h("strong", null, String(rig?.dailyTargetHours || 0))),
          h("div", { className: "manager-rig-stat" }, h("span", null, "Current well"), h("strong", null, rig?.currentWell || "--")),
          h("div", { className: "manager-rig-stat" }, h("span", null, "Loads active"), h("strong", null, String(activeLoadCount))),
        ),
      ),
      h(
        Card,
        { className: "dashboard-section-card manager-dashboard-panel manager-dashboard-panel-emphasis", key: "move-timeline" },
        h(
          "div",
          { className: "section-heading" },
          h("div", null, h("h2", null, "Rig Move Timeline"), h("p", { className: "muted-copy" }, "See the current rig move and the previous requests in one timeline.")),
        ),
        moveTimelineItems.length
          ? h(
              "div",
              { className: "manager-fleet-timeline" },
              moveTimelineItems.map((move) =>
                h(
                  "article",
                  { key: move.id, className: "manager-fleet-timeline-row" },
                  h("div", { className: "manager-fleet-timeline-dot" }),
                  h(
                    "div",
                    { className: "manager-fleet-timeline-main" },
                    h(
                      "div",
                      { className: "manager-fleet-timeline-head" },
                      h("strong", null, move.name),
                      h("span", { className: `manager-resource-status manager-resource-status-${move.status === "Moving" || move.status === "Planning move" ? "assigned" : "available"}` }, move.status),
                    ),
                    h("p", { className: "muted-copy" }, move.route),
                    h(
                      "div",
                      { className: "manager-fleet-timeline-stats" },
                      move.meta.map((item) => h("span", { key: item }, item)),
                    ),
                    h(ProgressBar, { value: move.progress }),
                  ),
                ),
              ),
            )
          : h("p", { className: "muted-copy" }, "No rig move history yet."),
      ),
    ];
  }

  function renderLoadsSection() {
    return [
      h(MetricStrip, { key: "loads-strip", items: extraLoadSummaryItems }),
      h(
        Card,
        { className: "dashboard-section-card manager-dashboard-panel", key: "needed-loads" },
        h(
          "div",
          { className: "section-heading" },
          h("div", null, h("h2", null, "Needed Loads On Site"), h("p", { className: "muted-copy" }, "Only reusable needed loads can be adjusted here. Permanent rig loads stay read-only."))),
          h(
            "div",
            { className: "auth-actions" },
            isEditingLoads
              ? [
                  h(Button, {
                    key: "cancel-load-edit",
                    type: "button",
                    variant: "ghost",
                    onClick: () => {
                      syncInventoryDraft(reusableNeededLoads);
                      setIsEditingLoads(false);
                    },
                    children: "Cancel",
                  }),
                  h(Button, {
                    key: "save-load-edit",
                    type: "button",
                    onClick: handleSaveLoads,
                    children: "Save Loads",
                  }),
                ]
              : h(Button, { type: "button", variant: "ghost", onClick: () => setIsEditingLoads(true), children: "Edit Loads" }),
          ),
        ),
        reusableNeededLoads.length
          ? h(
              "div",
              { className: "manager-foreman-list" },
              reusableNeededLoads.map((item) => {
                const currentOnSiteCount = inventoryDraft[item.id]?.onSite ?? item.onSiteCount ?? 0;
                const currentTransferableCount = inventoryDraft[item.id]?.transferable ?? item.transferableCount ?? 0;

                return h(
                  "article",
                  { key: item.id, className: "manager-resource-card manager-resource-card-strong" },
                  h("div", { className: "manager-resource-card-head" }, h("div", null, h("strong", null, item.description), h("p", { className: "muted-copy" }, item.category)), h("span", { className: "section-pill" }, isEditingLoads ? "Editable" : `${currentOnSiteCount} on site`)),
                  h(
                    "div",
                    { className: "manager-resource-metrics" },
                    h("div", { className: "manager-rig-stat" }, h("span", null, "Truck"), h("strong", null, item.truckTypes.join(" / ") || "Planned")),
                    h("div", { className: "manager-rig-stat" }, h("span", null, "Needed"), h("strong", null, String(item.count))),
                    h(
                      "label",
                      { className: "manager-rig-stat" },
                      h("span", null, "Count On Site"),
                      isEditingLoads
                        ? h(TextInput, {
                            type: "number",
                            min: "0",
                            value: String(currentOnSiteCount),
                            onChange: (event) =>
                              setInventoryDraft((current) => ({
                                ...current,
                                [item.id]: {
                                  ...(current[item.id] || {}),
                                  onSite: Math.max(0, Number.parseInt(event.target.value, 10) || 0),
                                },
                              })),
                          })
                        : h("strong", null, String(currentOnSiteCount)),
                    ),
                    h(
                      "label",
                      { className: "manager-rig-stat" },
                      h("span", null, "Available To Transfer"),
                      isEditingLoads
                        ? h(TextInput, {
                            type: "number",
                            min: "0",
                            value: String(currentTransferableCount),
                            onChange: (event) =>
                              setInventoryDraft((current) => ({
                                ...current,
                                [item.id]: {
                                  ...(current[item.id] || {}),
                                  transferable: Math.max(0, Number.parseInt(event.target.value, 10) || 0),
                                },
                              })),
                          })
                        : h("strong", null, String(currentTransferableCount)),
                    ),
                  ),
                );
              }),
            )
          : h("p", { className: "muted-copy" }, "No reusable needed loads are configured for this rig."),
    ];
  }

  function renderReportsSection() {
    return [
      h(MetricStrip, { key: "report-strip", items: reportSummaryItems }),
      h(
        Card,
        { className: "dashboard-section-card manager-dashboard-panel", key: "report-cadence" },
        h("div", { className: "section-heading" }, h("div", null, h("h2", null, "Reporting Flow"), h("p", { className: "muted-copy" }, "Prepared manager-style reporting overview for the foreman workflow.")))),
        h(
          "div",
          { className: "manager-report-preview-grid" },
          h("article", { className: "manager-insight-card" }, h("span", { className: "manager-insight-label" }, "Shift start"), h("strong", null, String(reportsSummary.shiftReports ? 1 : 0)), h("p", { className: "muted-copy" }, "Capture crew readiness, site state, and blockers at the opening of shift.")),
          h("article", { className: "manager-insight-card" }, h("span", { className: "manager-insight-label" }, "Shift end"), h("strong", null, String(reportsSummary.shiftReports ? 1 : 0)), h("p", { className: "muted-copy" }, "Capture progress, moved loads, and handoff notes at close of shift.")),
          h("article", { className: "manager-insight-card" }, h("span", { className: "manager-insight-label" }, "Final closeout"), h("strong", null, String(reportsSummary.finalPending)), h("p", { className: "muted-copy" }, "Complete one final report once the rig move has finished.")),
        ),
    ];
  }

  function renderPrimaryContent() {
    if (activeSection === "loads") {
      return renderLoadsSection();
    }
    if (activeSection === "reports") {
      return renderReportsSection();
    }
    return renderDashboardSection();
  }

  function renderSidebarContent() {
    if (activeSection === "loads") {
      return [
        h(
          Card,
          { className: "dashboard-section-card manager-dashboard-panel", key: "load-overview" },
          h("div", { className: "section-heading" }, h("h2", null, "Load Coverage")),
          h(
            "div",
            { className: "manager-sidebar-stat-grid" },
            [
              { label: "Reusable stock", value: String(reusableSummary.totalUnits), meta: "Units on site" },
              { label: "Covered loads", value: String(startupSummary.coveredUnits), meta: "Ready now" },
              { label: "Missing loads", value: String(startupSummary.missingUnits), meta: "Need planning" },
              { label: "Critical", value: String(reusableSummary.criticalUnits), meta: "Priority units" },
            ].map((item) =>
              h(
                "article",
                { key: item.label, className: "manager-resource-mini-card" },
                h("span", { className: "manager-resource-mini-label" }, item.label),
                h("strong", { className: "manager-resource-mini-value" }, item.value),
                h("span", { className: "manager-resource-mini-meta" }, item.meta),
              ),
            ),
          ),
        ),
      ];
    }

    if (activeSection === "reports") {
      return [
        h(
          Card,
          { className: "dashboard-section-card manager-dashboard-panel", key: "report-note" },
          h("div", { className: "section-heading" }, h("h2", null, "Reporting Notes")),
          h(
            "div",
            { className: "manager-note-list" },
            h("p", null, "Each active move should generate a start-of-shift and end-of-shift report every 12 hours."),
            h("p", null, "When the move closes, one final report should capture completion evidence and the final transfer state."),
            h("p", null, "This section is currently a planning view and can be connected to actual report submission next."),
          ),
        ),
      ];
    }

    return [
      h(
        Card,
        { className: "dashboard-section-card manager-dashboard-panel", key: "request-move" },
        h("div", { className: "section-heading" }, h("h2", null, "Request Rig Move")),
        h("p", { className: "muted-copy section-spacing" }, "Start from the current drilling rig, select the destination, then continue into planning and execution."),
        currentForemanMove
          ? h(
              "div",
              { className: "manager-resource-section" },
              h(
                "div",
                { className: "manager-resource-metrics" },
                h("div", { className: "manager-rig-stat" }, h("span", null, "Move"), h("strong", null, currentForemanMove.name || "Current rig move")),
                h("div", { className: "manager-rig-stat" }, h("span", null, "Status"), h("strong", null, getRigStatus(currentForemanMove))),
                h("div", { className: "manager-rig-stat" }, h("span", null, "Completion"), h("strong", null, `${Math.round(currentForemanMove.completionPercentage || 0)}%`)),
                h("div", { className: "manager-rig-stat" }, h("span", null, "ETA"), h("strong", null, currentForemanMove.eta || "--")),
              ),
              h(Button, {
                type: "button",
                className: "dashboard-submit-button",
                onClick: () => onOpenMove(currentForemanMove.id),
                children: "Open Current Move",
              }),
            )
          : h(
              "form",
              { className: "create-form foreman-request-modal-form", onSubmit: handleSubmit },
              h(
                Field,
                { label: "Current Rig Location" },
                h(TextInput, {
                  type: "text",
                  value: rig?.currentLabel || formatCoordinate(rig?.currentPoint),
                  readOnly: true,
                }),
              ),
              h(
                Field,
                {
                  label: "Destination",
                  hint: endPoint ? formatCoordinate(endPoint) : "Choose the next drilling destination.",
                  error: fieldError,
                  action: h(Button, {
                    type: "button",
                    variant: "ghost",
                    className: "dashboard-field-button",
                    onClick: () => setIsPickerOpen(true),
                    children: endPoint ? "Change" : "Select",
                  }),
                },
                h(TextInput, {
                  type: "text",
                  value: endLabel,
                  placeholder: "Click Select to open map",
                  readOnly: true,
                }),
              ),
              createError ? h("p", { className: "field-error" }, createError) : null,
              loadsError ? h("p", { className: "field-error" }, loadsError) : null,
              isCreatingMove
                ? h(
                    "div",
                    {
                      className: "scene-plan-dashboard section-spacing",
                      style: { padding: "1rem", gap: "0.75rem" },
                    },
                    h(
                      "div",
                      { className: "scene-dashboard-inline scene-dashboard-kpi-item" },
                      h("span", { className: "scene-dashboard-label" }, "Planning Engine"),
                      h("strong", null, simulationProgress?.message || "Preparing simulation"),
                    ),
                    simulationProgress?.detail
                      ? h("p", { className: "muted-copy", style: { margin: 0 } }, simulationProgress.detail)
                      : null,
                    h(ProgressBar, { value: Math.max(1, Number(simulationProgress?.percent) || 0) }),
                    h(
                      "div",
                      { className: "scene-dashboard-pair" },
                      h(
                        "div",
                        { className: "scene-dashboard-inline scene-dashboard-pair-item" },
                        h("span", { className: "scene-dashboard-label" }, "Completed"),
                        h("strong", null, progressStageLabel),
                      ),
                      h(
                        "div",
                        { className: "scene-dashboard-inline scene-dashboard-pair-item" },
                        h("span", { className: "scene-dashboard-label" }, "Elapsed"),
                        h("strong", null, progressElapsedLabel),
                      ),
                    ),
                    h(
                      "div",
                      { className: "scene-dashboard-pair" },
                      h(
                        "div",
                        { className: "scene-dashboard-inline scene-dashboard-pair-item" },
                        h("span", { className: "scene-dashboard-label" }, "Progress"),
                        h("strong", null, `${progressPercent}%`),
                      ),
                      h(
                        "div",
                        { className: "scene-dashboard-inline scene-dashboard-pair-item" },
                        h("span", { className: "scene-dashboard-label" }, "Remaining"),
                        h("strong", null, progressRemainingLabel),
                      ),
                    ),
                  )
                : null,
              h(Button, {
                type: "submit",
                className: "dashboard-submit-button",
                isBusy: isCreatingMove,
                disabled: !loadsReady || !availableTruckCount,
                children: "Request Rig Move",
              }),
            ),
      ),
    ];
  }

  return h(
    AppLayout,
    {
      title: `${rig?.name || "Assigned Rig"} • ${currentUser?.name || "Foreman"}`,
      subtitle: formatDate(currentDate),
      currentUser,
      onLogout,
      language,
      onToggleLanguage,
      fullBleed: true,
    },
    h(
      "div",
      { className: "manager-dashboard-shell foreman-dashboard-shell" },
      h(
        "div",
        { className: "manager-dashboard-hero manager-dashboard-hero-grid" },
        h(
          "div",
          { className: "manager-dashboard-hero-copy" },
          h("span", { className: "hero-badge" }, `${activeNavItem.label} Command Center`),
          h("p", { className: "manager-dashboard-hero-text" }, activeNavItem.description),
        ),
      ),
      h(
        "div",
        { className: "manager-dashboard-layout" },
        h(
          "aside",
          { className: "manager-dashboard-rail" },
          h(
            "div",
            { className: "manager-dashboard-nav" },
            navItems.map((item) =>
              h(
                "button",
                {
                  key: item.key,
                  type: "button",
                  className: `manager-dashboard-nav-button${activeSection === item.key ? " is-active" : ""}`,
                  onClick: () => setActiveSection(item.key),
                  title: item.label,
                  "aria-label": item.label,
                },
                h("span", { className: `manager-dashboard-nav-icon-wrap${activeSection === item.key ? " is-active" : ""}` }, h(ForemanNavIcon, { name: item.icon })),
                h("span", { className: "manager-dashboard-nav-count" }, item.count),
              ),
            ),
          ),
        ),
        h(
          "main",
          { className: "manager-dashboard-primary" },
          renderPrimaryContent(),
        ),
        h(
          "aside",
          { className: "manager-dashboard-sidebar" },
          renderSidebarContent(),
        ),
      ),
    ),
    isPickerOpen
      ? h(
          Modal,
          {
            title: "Select destination",
            description: "Click the next drilling location to start the rig-move planning flow.",
            onClose: () => setIsPickerOpen(false),
            flushBody: true,
          },
          h(LeafletMap, {
            startPoint: rig?.currentPoint || null,
            endPoint,
            pickerTarget: "end",
            onPickPoint: handleMapPick,
            heightClass: "map-frame map-frame-modal",
          }),
        )
      : null,
  );
}

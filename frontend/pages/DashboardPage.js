import { React, h } from "../lib/react.js";
import { AppLayout } from "../layouts/AppLayout.js";
import { Button } from "../components/ui/Button.js";
import { Card, StatCard } from "../components/ui/Card.js";
import { Field, TextInput } from "../components/ui/Field.js";
import { Modal } from "../components/ui/Modal.js";
import { ProgressBar } from "../components/ui/ProgressBar.js";
import { LeafletMap } from "../components/map/LeafletMap.js";
import { formatCoordinate, formatDate, formatLocationLabel } from "../lib/format.js";
import { translate } from "../lib/language.js";
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
  const t = (key, fallback) => translate(language, key, fallback);
  const [endPoint, setEndPoint] = useState(null);
  const [endLabel, setEndLabel] = useState("");
  const [fieldError, setFieldError] = useState("");
  const [isPickerOpen, setIsPickerOpen] = useState(false);
  const [isEditingLoads, setIsEditingLoads] = useState(false);
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
      { className: "workspace-grid dashboard-grid" },
      h(
        "section",
        { className: "dashboard-column dashboard-column-wide" },
        h(
          Card,
          { className: "dashboard-section-card" },
          h("div", { className: "section-heading" }, h("h2", null, "Rig Drilling Overview"), h("span", { className: "section-pill" }, currentStatus)),
          h("p", { className: "muted-copy section-spacing dashboard-existing-copy" }, `${formatLocationLabel(rig?.currentLabel, "Current site")} • ${rig?.field || "Assigned field"} • ${rig?.currentWell || "Current well"}`),
          h(
            "div",
            { className: "rig-load-grid" },
            h(StatCard, { label: "Drilling Completion", value: `${drillingCompletion}%`, meta: "Current well progress", tone: "green" }),
            h(StatCard, { label: "Reusable Stock", value: String(reusableSummary.totalUnits), meta: `${reusableSummary.categoryCount} load groups on site`, tone: "default" }),
            h(StatCard, { label: "Startup Loads Ready", value: String(startupSummary.coveredUnits), meta: `${startupSummary.missingUnits} still missing`, tone: "default" }),
            h(StatCard, { label: "Fleet Available", value: String((availableFleet || []).reduce((sum, truck) => sum + (truck.available || 0), 0)), meta: "Manager trucks free to assign", tone: "default" }),
          ),
        ),
        h(
          Card,
          { className: "dashboard-section-card" },
          h(
            "div",
            { className: "section-heading" },
              h("h2", null, "Needed Loads On Site"),
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
                : h(Button, {
                    type: "button",
                    variant: "ghost",
                    onClick: () => setIsEditingLoads(true),
                    children: "Edit Loads",
                  }),
            ),
          ),
          h("p", { className: "muted-copy section-spacing" }, "Only reusable needed loads can be adjusted here. Permanent rig loads stay read-only."),
          reusableNeededLoads.length
            ? h(
                "div",
                { className: "manager-rig-list" },
                reusableNeededLoads.map((item) =>
                  (() => {
                    const currentOnSiteCount = inventoryDraft[item.id]?.onSite ?? item.onSiteCount ?? 0;
                    const currentTransferableCount = inventoryDraft[item.id]?.transferable ?? item.transferableCount ?? 0;

                    return h(
                      "article",
                      { key: item.id, className: "manager-rig-card" },
                      h(
                        "div",
                        { className: "manager-rig-head" },
                        h("div", null, h("strong", null, item.description), h("p", { className: "muted-copy" }, item.category)),
                        h("span", { className: "section-pill" }, isEditingLoads ? "Editable" : `${currentOnSiteCount} on site`),
                      ),
                      h(
                        "div",
                        { className: "manager-rig-stats" },
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
                  })(),
                ),
              )
            : h("p", { className: "muted-copy" }, "No reusable needed loads are configured for this rig."),
        ),
      ),
      h(
        "aside",
        { className: "dashboard-column" },
        activeMove && activeMove.operatingState !== "drilling"
          ? h(
              Card,
              { className: "dashboard-section-card" },
              h("div", { className: "section-heading" }, h("h2", null, "Current Rig Move"), h("span", { className: "section-pill" }, currentStatus)),
              h("p", { className: "muted-copy section-spacing" }, `${formatLocationLabel(activeMove.startLabel, "Source")} to ${formatLocationLabel(activeMove.endLabel, "Destination")}`),
              h(
                "div",
                { className: "rig-load-grid" },
                h(StatCard, { label: "Execution", value: currentStatus, meta: activeMove.routeTime || "--", tone: "default" }),
                h(StatCard, { label: "Completion", value: `${Math.round(activeMove.completionPercentage || 0)}%`, meta: activeMove.eta || "--", tone: "default" }),
              ),
              h(Button, {
                type: "button",
                className: "dashboard-submit-button",
                onClick: () => onOpenMove(activeMove.id),
                children: "Open Rig Move Workspace",
              }),
            )
          : h(
              Card,
              { className: "dashboard-section-card" },
              h("div", { className: "section-heading" }, h("h2", null, "Request Rig Move")),
              h("p", { className: "muted-copy section-spacing" }, "Start from the current drilling rig, select the destination, then continue into planning and execution."),
              h(
                "form",
                { className: "create-form", onSubmit: handleSubmit },
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
                  disabled: !loadsReady || !(availableFleet || []).some((truck) => truck.available > 0),
                  children: "Request Rig Move",
                }),
              ),
            ),
        h(
          Card,
          { className: "dashboard-section-card" },
          h("div", { className: "section-heading" }, h("h2", null, "Drilling KPIs")),
          h(
            "div",
            { className: "rig-load-grid" },
            h(StatCard, { label: "Current Well", value: rig?.currentWell || "--", meta: "Active drilling target", tone: "default" }),
            h(StatCard, { label: "Critical Loads", value: String(reusableSummary.criticalUnits), meta: "High-priority reusable units", tone: "default" }),
            h(StatCard, { label: "Loads Active", value: String(countActiveLoads(rigInventory?.startupLoads)), meta: "Startup loads covered on site", tone: "green" }),
            h(StatCard, { label: "Target Hrs/Day", value: String(rig?.dailyTargetHours || 0), meta: "Planned drilling cadence", tone: "default" }),
          ),
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

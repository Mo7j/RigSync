import { React, h } from "../lib/react.js";
import { AppLayout } from "../layouts/AppLayout.js";
import { Button } from "../components/ui/Button.js";
import { Card } from "../components/ui/Card.js";
import { Field, TextInput } from "../components/ui/Field.js";
import { ProgressBar } from "../components/ui/ProgressBar.js";
import { Modal } from "../components/ui/Modal.js";
import { LeafletMap } from "../components/map/LeafletMap.js";
import { formatCoordinate, formatDate, formatLocationLabel } from "../lib/format.js";
import { fetchLocationLabel } from "../features/rigMoves/api.js";

const { useRef, useState } = React;

function getSelectedLocationValue(point, label, fallbackLabel) {
  if (!point) {
    return "";
  }

  const resolvedLabel = formatLocationLabel(label, "");
  if (resolvedLabel) {
    return resolvedLabel;
  }

  return label || formatCoordinate(point) || fallbackLabel;
}

function MoveList({ moves, onOpenMove }) {
  if (!moves.length) {
    return h(
      Card,
      { className: "empty-state" },
      h("h3", null, "No rig moves yet"),
      h("p", { className: "muted-copy" }, "Create the first move to generate route simulation, ETA, and progress tracking."),
    );
  }

  return h(
    "div",
    { className: "move-list" },
    moves.map((move) =>
      h(
        "button",
        {
          key: move.id,
          type: "button",
          className: "move-row",
          onClick: () => onOpenMove(move.id),
        },
        h(
          "div",
          { className: "move-row-head" },
          h("strong", null, move.name),
          h("span", { className: "move-row-percentage" }, `${move.completionPercentage}%`),
        ),
        h("span", { className: "move-row-meta" }, `${move.routeTime} • ${move.routeKm} km`),
        h(ProgressBar, { value: move.completionPercentage }),
      ),
    ),
  );
}

export function DashboardPage({
  moves,
  currentUser,
  currentDate,
  loadsReady,
  loadsError,
  createError,
  isCreatingMove,
  onCreateMove,
  onOpenMove,
  onLogout,
}) {
  const [name, setName] = useState("");
  const [startPoint, setStartPoint] = useState(null);
  const [endPoint, setEndPoint] = useState(null);
  const [startLabel, setStartLabel] = useState("");
  const [endLabel, setEndLabel] = useState("");
  const [pickerTarget, setPickerTarget] = useState(null);
  const [fieldErrors, setFieldErrors] = useState({});
  const startLookupRequestRef = useRef(0);
  const endLookupRequestRef = useRef(0);

  async function resolveLocationLabelWithRetry(point, applyLabel, requestRef) {
    const requestId = requestRef.current + 1;
    requestRef.current = requestId;
    const maxAttempts = 4;

    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      try {
        const resolvedLabel = await fetchLocationLabel(point);
        if (requestRef.current !== requestId) {
          return;
        }
        if (resolvedLabel) {
          applyLabel(resolvedLabel);
          return;
        }
      } catch {
        // Retry a few times before keeping the coordinate fallback.
      }

      if (attempt < maxAttempts - 1) {
        await new Promise((resolve) => window.setTimeout(resolve, 1200 * (attempt + 1)));
      }
    }
  }

  function openPicker(target) {
    setPickerTarget(target);
  }

  async function handleMapPick({ target, point }) {
    if (target === "start") {
      setStartPoint(point);
      setStartLabel(formatCoordinate(point));
      setFieldErrors((current) => ({ ...current, start: undefined }));
      void resolveLocationLabelWithRetry(point, setStartLabel, startLookupRequestRef);
    } else {
      setEndPoint(point);
      setEndLabel(formatCoordinate(point));
      setFieldErrors((current) => ({ ...current, end: undefined }));
      void resolveLocationLabelWithRetry(point, setEndLabel, endLookupRequestRef);
    }
    setPickerTarget(null);
  }

  async function handleSubmit(event) {
    event.preventDefault();

    const nextErrors = {};
    if (!name.trim()) {
      nextErrors.name = "Move name is required.";
    }
    if (!startPoint) {
      nextErrors.start = "Select a start location.";
    }
    if (!endPoint) {
      nextErrors.end = "Select an end location.";
    }

    setFieldErrors(nextErrors);
    if (Object.keys(nextErrors).length) {
      return;
    }

    await onCreateMove({
      name: name.trim(),
      startPoint,
      endPoint,
      startLabel: startLabel || formatCoordinate(startPoint),
      endLabel: endLabel || formatCoordinate(endPoint),
    });
  }

  return h(
    AppLayout,
    {
      title: `Hi, ${currentUser?.name || "Operator"}`,
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
          h("div", { className: "section-heading" }, h("h2", null, "Existing Rig Moves"), h("span", { className: "section-pill" }, `${moves.length} total`)),
          h("p", { className: "muted-copy section-spacing dashboard-existing-copy" }, "Open any saved rig move to continue monitoring the simulation view."),
          h(MoveList, { moves, onOpenMove }),
        ),
      ),
      h(
        "aside",
        { className: "dashboard-column" },
        h(
          Card,
          { className: "dashboard-section-card" },
          h("div", { className: "section-heading" }, h("h2", null, "Create New Rig Move")),
          h(
            "form",
            { className: "create-form", onSubmit: handleSubmit },
            h(
              Field,
              { label: "Move Name", error: fieldErrors.name },
              h(TextInput, {
                type: "text",
                value: name,
                placeholder: "Eastern Province Transfer",
                onChange: (event) => setName(event.target.value),
              }),
            ),
            h(
              Field,
              {
                label: "Start Location",
                hint: startPoint ? formatCoordinate(startPoint) : "Select the source rig on the map.",
                error: fieldErrors.start,
                action: h(
                  Button,
                  {
                    type: "button",
                    variant: "ghost",
                    className: "dashboard-field-button",
                    onClick: () => openPicker("start"),
                    children: startPoint ? "Change" : "Select",
                  },
                ),
              },
              h(TextInput, {
                type: "text",
                value: getSelectedLocationValue(startPoint, startLabel, "Selected source rig"),
                placeholder: "Click Select to open map",
                readOnly: true,
              }),
            ),
            h(
              Field,
              {
                label: "End Location",
                hint: endPoint ? formatCoordinate(endPoint) : "Select the destination rig on the map.",
                error: fieldErrors.end,
                action: h(
                  Button,
                  {
                    type: "button",
                    variant: "ghost",
                    className: "dashboard-field-button",
                    onClick: () => openPicker("end"),
                    children: endPoint ? "Change" : "Select",
                  },
                ),
              },
              h(TextInput, {
                type: "text",
                value: getSelectedLocationValue(endPoint, endLabel, "Selected destination rig"),
                placeholder: "Click Select to open map",
                readOnly: true,
              }),
            ),
            createError ? h("p", { className: "field-error" }, createError) : null,
            loadsError ? h("p", { className: "field-error" }, loadsError) : null,
            h(Button, {
              type: "submit",
              className: "dashboard-submit-button",
              isBusy: isCreatingMove,
              disabled: !loadsReady,
              children: "Create and Simulate Move",
            }),
          ),
        ),
      ),
    ),
    pickerTarget
      ? h(
          Modal,
          {
            title: pickerTarget === "start" ? "Select start location" : "Select end location",
            description: "The map only appears while choosing a location. Click the exact rig position to continue.",
            onClose: () => setPickerTarget(null),
            flushBody: true,
          },
          h(LeafletMap, {
            startPoint,
            endPoint,
            pickerTarget,
            onPickPoint: handleMapPick,
            heightClass: "map-frame map-frame-modal",
          }),
        )
      : null,
  );
}

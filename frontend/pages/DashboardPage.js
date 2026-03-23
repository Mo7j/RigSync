import { React, h } from "../lib/react.js";
import { AppLayout } from "../layouts/AppLayout.js";
import { Button } from "../components/ui/Button.js";
import { Card, StatCard } from "../components/ui/Card.js";
import { Field, TextInput } from "../components/ui/Field.js";
import { ProgressBar } from "../components/ui/ProgressBar.js";
import { Modal } from "../components/ui/Modal.js";
import { LeafletMap } from "../components/map/LeafletMap.js";
import { formatCoordinate, formatDate } from "../lib/format.js";

const { useState } = React;

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
  const [pickerTarget, setPickerTarget] = useState(null);
  const [fieldErrors, setFieldErrors] = useState({});

  function openPicker(target) {
    setPickerTarget(target);
  }

  function handleMapPick({ target, point }) {
    if (target === "start") {
      setStartPoint(point);
    } else {
      setEndPoint(point);
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
          h("p", { className: "muted-copy section-spacing" }, "Open any saved rig move to continue monitoring the simulation view."),
          h(MoveList, { moves, onOpenMove }),
        ),
      ),
      h(
        "aside",
        { className: "dashboard-column" },
        h(
          Card,
          { className: "dashboard-section-card" },
          h("div", { className: "section-heading" }, h("h2", null, "Create New Rig Move"), h("span", { className: "section-pill" }, "Standard crew preset")),
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
                    size: "sm",
                    onClick: () => openPicker("start"),
                    children: startPoint ? "Change" : "Select",
                  },
                ),
              },
              h(TextInput, {
                type: "text",
                value: startPoint ? formatCoordinate(startPoint) : "",
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
                    size: "sm",
                    onClick: () => openPicker("end"),
                    children: endPoint ? "Change" : "Select",
                  },
                ),
              },
              h(TextInput, {
                type: "text",
                value: endPoint ? formatCoordinate(endPoint) : "",
                placeholder: "Click Select to open map",
                readOnly: true,
              }),
            ),
            createError ? h("p", { className: "field-error" }, createError) : null,
            loadsError ? h("p", { className: "field-error" }, loadsError) : null,
            h(Button, {
              type: "submit",
              isBusy: isCreatingMove,
              disabled: !loadsReady,
              children: "Create and Simulate Move",
            }),
          ),
        ),
        h(
          "div",
          { className: "dashboard-aside-stack" },
          h(StatCard, {
            label: "Routing readiness",
            value: loadsReady ? "Ready" : "Loading",
            meta: loadsReady ? "Dataset available" : "Waiting for backend loads",
            tone: loadsReady ? "green" : "default",
          }),
          h(StatCard, {
            label: "Settings",
            value: "6 workers / 4 trucks",
            meta: "Baseline scenario for new moves",
            tone: "default",
          }),
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

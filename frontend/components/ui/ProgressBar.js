import { h } from "../../lib/react.js";

export function ProgressBar({ value, tone = "green" }) {
  return h(
    "div",
    { className: "progress-track", "aria-hidden": "true" },
    h("div", {
      className: `progress-fill progress-fill-${tone}`,
      style: { width: `${Math.min(100, Math.max(0, value))}%` },
    }),
  );
}

import { h } from "../../lib/react.js";

const RIG_NODES = [
  { className: "hero-rig-node-alpha", label: "Rig A", x: 12, y: 24 },
  { className: "hero-rig-node-beta", label: "Rig B", x: 26, y: 62 },
  { className: "hero-rig-node-gamma", label: "Rig C", x: 46, y: 47 },
  { className: "hero-rig-node-delta", label: "Rig D", x: 66, y: 28 },
  { className: "hero-rig-node-epsilon", label: "Rig E", x: 84, y: 58 },
];

const FLOW_PATHS = [
  "M -20 210 C 160 180, 240 240, 382 234 S 626 140, 776 204 S 1038 344, 1242 278 S 1458 158, 1660 208",
  "M 48 646 C 224 596, 284 470, 438 438 S 724 520, 890 462 S 1176 314, 1378 366 S 1536 462, 1640 430",
  "M 146 792 C 272 706, 410 690, 554 596 S 830 382, 1010 430 S 1350 632, 1602 586",
  "M 0 468 C 150 432, 242 502, 356 456 S 566 320, 750 362 S 1042 572, 1260 540 S 1480 430, 1660 490",
  "M 80 108 C 300 130, 472 110, 640 154 S 980 282, 1202 236 S 1458 194, 1674 242",
  "M -60 868 C 154 806, 336 702, 530 640 S 918 500, 1130 562 S 1444 742, 1700 694",
];

export function HeroOperationsBackdrop() {
  return h(
    "div",
    { className: "hero-operations-backdrop" },
    h("div", { className: "hero-backdrop-aurora hero-backdrop-aurora-primary" }),
    h("div", { className: "hero-backdrop-aurora hero-backdrop-aurora-secondary" }),
    h("div", { className: "hero-backdrop-grid" }),
    h(
      "svg",
      {
        className: "hero-operations-svg",
        viewBox: "0 0 1600 900",
        fill: "none",
        preserveAspectRatio: "none",
        "aria-hidden": "true",
      },
      FLOW_PATHS.flatMap((path, index) => ([
        h("path", {
          key: `base-${index}`,
          d: path,
          className: "hero-flow-path hero-flow-path-base",
          pathLength: "100",
        }),
        h("path", {
          key: `glow-${index}`,
          d: path,
          className: "hero-flow-path hero-flow-path-glow",
          pathLength: "100",
        }),
      ])),
      FLOW_PATHS.flatMap((path, index) => ([
        h(
          "circle",
          { key: `dot-primary-${index}`, className: "hero-flow-dot hero-flow-dot-primary", r: "5" },
          h("animateMotion", {
            dur: `${11 + (index * 2)}s`,
            repeatCount: "indefinite",
            rotate: "auto",
            path,
          }),
        ),
        h(
          "circle",
          { key: `dot-secondary-${index}`, className: "hero-flow-dot hero-flow-dot-secondary", r: "3.5" },
          h("animateMotion", {
            dur: `${8 + index}s`,
            repeatCount: "indefinite",
            rotate: "auto",
            path,
          }),
        ),
      ])),
    ),
    h(
      "div",
      { className: "hero-platform-layer", "aria-hidden": "true" },
      RIG_NODES.map((node) =>
        h(
          "div",
          {
            key: node.label,
            className: `hero-platform-node ${node.className}`,
            style: { left: `${node.x}%`, top: `${node.y}%` },
          },
          h("span", { className: "hero-platform-core" }),
          h("span", { className: "hero-platform-ring hero-platform-ring-outer" }),
          h("span", { className: "hero-platform-ring hero-platform-ring-inner" }),
          h("span", { className: "hero-platform-label" }, node.label),
        ),
      ),
      h("div", { className: "hero-scan-column hero-scan-column-left" }),
      h("div", { className: "hero-scan-column hero-scan-column-right" }),
      h("div", { className: "hero-light-sweep hero-light-sweep-left" }),
      h("div", { className: "hero-light-sweep hero-light-sweep-right" }),
    ),
    h("div", { className: "hero-backdrop-vignette" }),
    h("div", { className: "hero-backdrop-noise" }),
  );
}

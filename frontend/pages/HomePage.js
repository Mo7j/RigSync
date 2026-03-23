import { h } from "../lib/react.js";
import { MarketingLayout } from "../layouts/MarketingLayout.js";
import { Button } from "../components/ui/Button.js";
import { Card, StatCard } from "../components/ui/Card.js";

const FEATURE_ITEMS = [
  {
    title: "Simulation & Forecasting",
    copy: "Turn route assumptions into scenario-based move plans with ETA, crew, and fleet impact visible before execution.",
  },
  {
    title: "Live Operations Tracking",
    copy: "See route geometry, truck motion, and stage progression in a single operational surface instead of scattered tools.",
  },
  {
    title: "Risk Detection & Alerting",
    copy: "Surface bottlenecks early with comparison logic, playback signals, and move progress that stays readable under pressure.",
  },
];

const FAQ_ITEMS = [
  {
    question: "What does RigSync optimize?",
    answer: "RigSync focuses on pre-move planning, simulation clarity, move execution visibility, and a more reliable handoff between planning and field operations.",
  },
  {
    question: "Do I need a map open all the time?",
    answer: "No. Map selection only appears when a location is being chosen, keeping the dashboard clean until the move needs geo context.",
  },
  {
    question: "Can the platform work when routing is unavailable?",
    answer: "Yes. The simulation falls back to a straight-line estimate when live routing is unavailable, so planning still works.",
  },
];

export function HomePage({
  moveCount,
  loadCount,
  isLoadingLoads,
  hasSession,
  onOpenLogin,
  onOpenDashboard,
}) {
  return h(
    MarketingLayout,
    {
      onPrimaryAction: hasSession ? onOpenDashboard : onOpenLogin,
      primaryLabel: hasSession ? "Open Dashboard" : "Ask Us",
    },
    h(
      "section",
      { id: "hero", className: "hero-section" },
      h("div", { className: "hero-orbit hero-orbit-left" }),
      h("div", { className: "hero-orbit hero-orbit-right" }),
      h(
        "div",
        { className: "hero-grid" },
        h(
          "div",
          { className: "hero-copy-block" },
          h("p", { className: "eyebrow" }, "Digital Twin Logistics"),
          h(
            "h1",
            { className: "hero-title" },
            "Plan, Simulate, and Execute Rig Moves with Precision",
          ),
          h(
            "p",
            { className: "hero-text" },
            "RigSync uses digital twin technology to optimize logistics, reduce delays, and eliminate operational risk across complex rig move programs.",
          ),
          h(
            "ul",
            { className: "hero-points" },
            FEATURE_ITEMS.map((item) =>
              h(
                "li",
                { key: item.title },
                h("span", { className: "hero-check" }, "✓"),
                h("span", null, item.title),
              ),
            ),
          ),
          h(
            "div",
            { className: "hero-actions" },
            h(Button, {
              type: "button",
              className: "hero-primary",
              onClick: hasSession ? onOpenDashboard : onOpenLogin,
              children: hasSession ? "Open Workspace" : "Digitize Now",
            }),
            h(
              "button",
              {
                type: "button",
                className: "play-button",
                onClick: () => document.getElementById("features")?.scrollIntoView({ behavior: "smooth" }),
              },
              "▶",
            ),
          ),
        ),
        h(
          "div",
          { className: "hero-side-panel" },
          h(
            Card,
            { className: "hero-side-card" },
            h("p", { className: "muted-copy" }, "Trusted across large-scale move programs"),
            h(
              "div",
              { className: "logo-cluster" },
              h("span", null, "SL"),
              h("span", null, "ADC"),
              h("span", null, "SA"),
              h("strong", null, "+25k"),
            ),
            h("p", { className: "hero-footnote" }, "World rig moves"),
          ),
          h(
            "div",
            { className: "hero-ring" },
            h("span", null, "Explore More"),
          ),
        ),
      ),
    ),
    h(
      "section",
      { id: "features", className: "marketing-section" },
      h("p", { className: "eyebrow" }, "Features"),
      h("h2", { className: "section-title" }, "Operations software designed for move clarity"),
      h(
        "div",
        { className: "feature-grid" },
        FEATURE_ITEMS.map((item, index) =>
          h(
            Card,
            { key: item.title, className: "feature-card" },
            h("span", { className: "feature-index" }, `0${index + 1}`),
            h("h3", null, item.title),
            h("p", { className: "muted-copy" }, item.copy),
          ),
        ),
      ),
    ),
    h(
      "section",
      { id: "about", className: "marketing-section marketing-section-accent" },
      h(
        "div",
        { className: "about-grid" },
        h(
          "div",
          null,
          h("p", { className: "eyebrow" }, "About Us"),
          h("h2", { className: "section-title" }, "Built for crews that need speed without losing control"),
          h(
            "p",
            { className: "muted-copy section-copy" },
            "RigSync keeps the dark, command-center visual language of the existing product while turning it into a scalable operational frontend. The experience is tuned for pre-move planning, confident dashboarding, and production-grade readability on desktop and tablet.",
          ),
        ),
        h(
          "div",
          { className: "about-stats" },
          h(StatCard, {
            label: "Rig moves tracked",
            value: moveCount ? `${moveCount}+` : "0",
            meta: "Saved operational runs",
            tone: "green",
          }),
          h(StatCard, {
            label: "Logical loads",
            value: isLoadingLoads ? "..." : String(loadCount),
            meta: "Available for planning",
            tone: "default",
          }),
          h(StatCard, {
            label: "Routing mode",
            value: "Live + fallback",
            meta: "Resilient by default",
            tone: "green",
          }),
        ),
      ),
    ),
    h(
      "section",
      { id: "faq", className: "marketing-section" },
      h("p", { className: "eyebrow" }, "FAQ"),
      h("h2", { className: "section-title" }, "Questions the operations team actually asks"),
      h(
        "div",
        { className: "faq-list" },
        FAQ_ITEMS.map((item) =>
          h(
            Card,
            { key: item.question, className: "faq-card" },
            h("h3", null, item.question),
            h("p", { className: "muted-copy" }, item.answer),
          ),
        ),
      ),
    ),
    h(
      "footer",
      { className: "marketing-footer" },
      h(
        "div",
        null,
        h("strong", { className: "footer-brand" }, "RigSync"),
        h("p", { className: "muted-copy" }, "Premium SaaS frontend for modern rig move operations."),
      ),
      h(
        Button,
        {
          type: "button",
          variant: "secondary",
          onClick: hasSession ? onOpenDashboard : onOpenLogin,
          children: hasSession ? "Go to Dashboard" : "Open Login",
        },
      ),
    ),
  );
}

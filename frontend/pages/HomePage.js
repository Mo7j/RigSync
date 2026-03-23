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
      primaryLabel: "Ask Us",
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
            "div",
            { className: "hero-side-card" },
            h(
              "div",
              { className: "hero-side-badge" },
              h("span", { className: "hero-side-badge-dot" }),
              h("span", null, "Live Command View"),
            ),
            h("p", { className: "eyebrow" }, "Operations Signal"),
            h("h3", { className: "hero-side-title" }, "Trusted across large-scale move programs"),
            h("p", { className: "muted-copy" }, "Digital planning, live route visibility, and safer execution for high-value rig transfers."),
            h(
              "div",
              { className: "logo-cluster" },
              h("span", null, "SL"),
              h("span", null, "ADC"),
              h("span", null, "SA"),
              h("strong", null, "+25k"),
            ),
            h("div", { className: "hero-side-divider" }),
            h(
              "dl",
              { className: "hero-side-metrics" },
              h("div", null, h("dt", null, "Planning confidence"), h("dd", null, "98%")),
              h("div", null, h("dt", null, "Ops visibility"), h("dd", null, "24/7")),
            ),
            h("p", { className: "hero-footnote" }, "World rig moves modeled and tracked through one command surface."),
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
      "section",
      { id: "rig-preview", className: "marketing-section model-preview-section" },
      h("p", { className: "eyebrow" }, "3D Preview"),
      h("h2", { className: "section-title" }, "Land rig embed preview on the home screen"),
      h(
        "p",
        { className: "muted-copy section-copy" },
        "A quick placement test for the Sketchfab model so the team can evaluate how a live 3D rig viewer feels at the end of the landing page.",
      ),
      h(
        "div",
        { className: "sketchfab-embed-wrapper model-preview-frame" },
        h("iframe", {
          title: "Land Rig",
          frameBorder: "0",
          allowFullScreen: true,
          allow: "autoplay; fullscreen; xr-spatial-tracking",
          loading: "lazy",
          src: "https://sketchfab.com/models/72d5781728dc49f59c3d62c38da574c5/embed?autospin=1&autostart=1&annotations_visible=0&transparent=1&ui_animations=0&ui_infos=0&ui_stop=0&ui_inspector=0&ui_watermark_link=0&ui_watermark=0&ui_hint=0&ui_ar=0&ui_help=0&ui_settings=0&ui_vr=0&ui_fullscreen=0&ui_annotations=0&ui_color=000000",
        }),
      ),
    ),
    h(
      "footer",
      { className: "marketing-footer" },
      h(
        "div",
        { className: "marketing-footer-inner" },
        h(
          "div",
          { className: "marketing-footer-grid" },
          h(
            "div",
            { className: "marketing-footer-brand" },
            h("strong", { className: "footer-brand" }, "RigSync"),
            h("p", { className: "muted-copy" }, "Premium SaaS frontend for modern rig move operations, from planning through execution."),
          ),
          h(
            "div",
            { className: "marketing-footer-column" },
            h("span", { className: "marketing-footer-heading" }, "Product"),
            h(
              "button",
              {
                type: "button",
                className: "footer-link",
                onClick: () => document.getElementById("features")?.scrollIntoView({ behavior: "smooth" }),
              },
              "Features",
            ),
            h(
              "button",
              {
                type: "button",
                className: "footer-link",
                onClick: hasSession ? onOpenDashboard : onOpenLogin,
              },
              hasSession ? "Dashboard" : "Login",
            ),
          ),
          h(
            "div",
            { className: "marketing-footer-column" },
            h("span", { className: "marketing-footer-heading" }, "Company"),
            h(
              "button",
              {
                type: "button",
                className: "footer-link",
                onClick: () => document.getElementById("about")?.scrollIntoView({ behavior: "smooth" }),
              },
              "About Us",
            ),
            h(
              "button",
              {
                type: "button",
                className: "footer-link",
                onClick: () => document.getElementById("faq")?.scrollIntoView({ behavior: "smooth" }),
              },
              "FAQ",
            ),
          ),
        ),
        h(
          "div",
          { className: "marketing-footer-bottom" },
          h("span", null, "© 2026 RigSync"),
          h("span", null, "Built for modern rig move operations"),
        ),
      ),
    ),
  );
}

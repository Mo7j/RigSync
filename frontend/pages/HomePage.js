import { React, h } from "../lib/react.js";
import { MarketingLayout } from "../layouts/MarketingLayout.js";
import { Button } from "../components/ui/Button.js";
import { Card, StatCard } from "../components/ui/Card.js";
import { HeroNetwork } from "../components/map/HeroNetwork.js";
import { translate } from "../lib/language.js";

const { useEffect } = React;

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
  language = "en",
  moveCount,
  loadCount,
  isLoadingLoads,
  hasSession,
  onOpenLogin,
  onOpenDashboard,
  onToggleLanguage,
}) {
  const t = (key, fallback) => translate(language, key, fallback);
  useEffect(() => {
    const scenes = Array.from(document.querySelectorAll(".marketing-scene"));
    if (!scenes.length) {
      return undefined;
    }

    const sceneTransforms = [
      { x: "0px", y: "0px", scale: "1.04" },
      { x: "220px", y: "-14px", scale: "0.92" },
      { x: "0px", y: "8px", scale: "1.02" },
      { x: "-220px", y: "18px", scale: "0.9" },
    ];

    function applySceneTransform(index) {
      const transform = sceneTransforms[index] || sceneTransforms[0];
      document.documentElement.style.setProperty("--home-cypher-x", transform.x);
      document.documentElement.style.setProperty("--home-cypher-y", transform.y);
      document.documentElement.style.setProperty("--home-cypher-scale", transform.scale);
    }

    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          entry.target.classList.toggle("is-visible", entry.isIntersecting);
          if (entry.isIntersecting) {
            const index = scenes.indexOf(entry.target);
            if (index >= 0) {
              document.documentElement.style.setProperty("--home-scene-index", String(index));
              applySceneTransform(index);
              window.dispatchEvent(new CustomEvent("home-scene-change", { detail: { index } }));
            }
          }
        });
      },
      {
        threshold: 0.34,
        rootMargin: "-8% 0px -8% 0px",
      },
    );

    scenes.forEach((scene, index) => {
      if (index === 0) {
        scene.classList.add("is-visible");
        document.documentElement.style.setProperty("--home-scene-index", "0");
        applySceneTransform(0);
        window.dispatchEvent(new CustomEvent("home-scene-change", { detail: { index: 0 } }));
      }
      observer.observe(scene);
    });

    return () => {
      observer.disconnect();
      document.documentElement.style.removeProperty("--home-cypher-x");
      document.documentElement.style.removeProperty("--home-cypher-y");
      document.documentElement.style.removeProperty("--home-cypher-scale");
    };
  }, []);

  useEffect(() => {
    const scenes = Array.from(document.querySelectorAll(".marketing-scene"));
    if (!scenes.length) {
      return undefined;
    }

    let isLocked = false;
    let lockTimeoutId = 0;
    let wheelDelta = 0;
    let wheelResetTimeoutId = 0;
    let lastSnapAt = 0;

    function getSceneTargetTop(scene, index) {
      if (index === 0) {
        return 0;
      }

      const rect = scene.getBoundingClientRect();
      const absoluteTop = window.scrollY + rect.top;
      const offset = Math.max((window.innerHeight - rect.height) / 2, 0);
      return Math.max(0, absoluteTop - offset);
    }

    function getActiveSceneIndex() {
      const viewportCenter = window.innerHeight / 2;
      let closestIndex = 0;
      let closestDistance = Number.POSITIVE_INFINITY;

      scenes.forEach((scene, index) => {
        const rect = scene.getBoundingClientRect();
        const sceneCenter = rect.top + (rect.height / 2);
        const distance = Math.abs(sceneCenter - viewportCenter);
        if (distance < closestDistance) {
          closestDistance = distance;
          closestIndex = index;
        }
      });

      return closestIndex;
    }

    function snapToScene(nextIndex) {
      const safeIndex = Math.max(0, Math.min(scenes.length - 1, nextIndex));
      const scene = scenes[safeIndex];
      if (!scene) {
        return;
      }

      isLocked = true;
      lastSnapAt = Date.now();
      wheelDelta = 0;
      window.scrollTo({
        top: getSceneTargetTop(scene, safeIndex),
        behavior: "smooth",
      });

      window.clearTimeout(lockTimeoutId);
      lockTimeoutId = window.setTimeout(() => {
        isLocked = false;
      }, 1050);
    }

    function handleWheel(event) {
      if (isLocked) {
        event.preventDefault();
        return;
      }

      if (Date.now() - lastSnapAt < 950) {
        event.preventDefault();
        return;
      }

      if (Math.abs(event.deltaY) < 4) {
        return;
      }

      event.preventDefault();
      wheelDelta += event.deltaY;

      window.clearTimeout(wheelResetTimeoutId);
      wheelResetTimeoutId = window.setTimeout(() => {
        wheelDelta = 0;
      }, 140);

      if (Math.abs(wheelDelta) < 70) {
        return;
      }

      const currentIndex = getActiveSceneIndex();
      const nextIndex = wheelDelta > 0 ? currentIndex + 1 : currentIndex - 1;
      if (nextIndex === currentIndex || nextIndex < 0 || nextIndex >= scenes.length) {
        wheelDelta = 0;
        return;
      }

      snapToScene(nextIndex);
    }

    function handleKeyDown(event) {
      if (isLocked) {
        return;
      }

      const currentIndex = getActiveSceneIndex();
      if (event.key === "ArrowDown" || event.key === "PageDown" || event.key === " ") {
        event.preventDefault();
        snapToScene(currentIndex + 1);
      } else if (event.key === "ArrowUp" || event.key === "PageUp") {
        event.preventDefault();
        snapToScene(currentIndex - 1);
      }
    }

    window.addEventListener("wheel", handleWheel, { passive: false });
    window.addEventListener("keydown", handleKeyDown);

    return () => {
      window.removeEventListener("wheel", handleWheel);
      window.removeEventListener("keydown", handleKeyDown);
      window.clearTimeout(lockTimeoutId);
      window.clearTimeout(wheelResetTimeoutId);
    };
  }, []);

  return h(
    MarketingLayout,
    {
      language,
      onToggleLanguage,
      className: "marketing-shell-home",
    },
    h(
      "div",
      { className: "home-story" },
      h(
        "div",
        { className: "home-scene-backdrop", "aria-hidden": "true" },
        h("div", { className: "hero-orbit hero-orbit-left" }),
        h("div", { className: "hero-orbit hero-orbit-right" }),
        h(HeroNetwork),
      ),
      h(
        "section",
        { id: "hero", className: "hero-section marketing-scene marketing-scene-hero" },
        h(
          "div",
          { className: "home-scene-panel home-hero-scene-panel" },
          h(
            "h1",
            { className: "hero-title" },
            t("heroTitle", "Operational Precision at Scale"),
          ),
          h(
            "p",
            { className: "hero-text" },
            t("heroText", "Plan and execute rig moves with simulation-driven logistics and full operational visibility."),
          ),
          h(
            "div",
            { className: "hero-actions" },
            h(Button, {
              type: "button",
              className: "hero-primary",
              onClick: hasSession ? onOpenDashboard : onOpenLogin,
              children: hasSession ? t("openWorkspace", "Open Workspace") : t("digitizeNow", "Digitize Now"),
            }),
          ),
        ),
      ),
      h(
        "section",
        { id: "features", className: "marketing-section marketing-scene marketing-scene-features" },
        h(
          "div",
          { className: "home-scene-panel home-scene-panel-left" },
          h("p", { className: "eyebrow" }, t("featuresTitle", "Features")),
          h("h2", { className: "section-title features-section-title" }, t("featuresHeadline", "Operations software designed for move clarity")),
          h(
            "div",
            { className: "feature-grid" },
            FEATURE_ITEMS.map((item, index) =>
              h(
                Card,
                { key: item.title, className: "feature-card home-scene-card" },
                h("span", { className: "feature-index" }, `0${index + 1}`),
                h("h3", null, item.title),
                h("p", { className: "muted-copy" }, item.copy),
              ),
            ),
          ),
        ),
      ),
      h(
        "section",
        { id: "about", className: "marketing-section marketing-scene marketing-section-accent marketing-scene-about" },
        h(
          "div",
          { className: "home-scene-panel home-about-scene-panel home-scene-panel-center" },
          h(
            "div",
            { className: "about-grid" },
            h(
              "div",
              null,
              h("p", { className: "eyebrow" }, t("aboutTitle", "About Us")),
              h("h2", { className: "section-title" }, t("aboutHeadline", "Built for crews that need speed without losing control")),
              h(
                "p",
                { className: "muted-copy section-copy" },
                t("aboutCopy", "RigSync keeps the dark, command-center visual language of the existing product while turning it into a scalable operational frontend. The experience is tuned for pre-move planning, confident dashboarding, and production-grade readability on desktop and tablet."),
              ),
            ),
            h(
              "div",
              { className: "about-stats" },
              h(StatCard, {
                label: "Rig moves tracked",
                label: t("rigMovesTracked", "Rig moves tracked"),
                value: moveCount ? `${moveCount}+` : "0",
                meta: t("savedOperationalRuns", "Saved operational runs"),
                tone: "green",
              }),
              h(StatCard, {
                label: t("logicalLoads", "Logical loads"),
                value: isLoadingLoads ? "..." : String(loadCount),
                meta: t("availableForPlanning", "Available for planning"),
                tone: "default",
              }),
              h(StatCard, {
                label: t("routingMode", "Routing mode"),
                value: t("liveFallback", "Live + fallback"),
                meta: t("resilientDefault", "Resilient by default"),
                tone: "green",
              }),
            ),
          ),
        ),
      ),
      h(
        "section",
        { id: "faq", className: "marketing-section marketing-scene marketing-scene-faq" },
        h(
          "div",
          { className: "home-scene-panel home-faq-scene-panel home-scene-panel-right" },
          h("p", { className: "eyebrow" }, "FAQ"),
          h("h2", { className: "home-faq-title" }, "FAQ"),
          h(
            "div",
            { className: "faq-list faq-list-compact" },
            FAQ_ITEMS.map((item) =>
              h(
                "details",
                { key: item.question, className: "faq-item-compact" },
                h(
                  "summary",
                  { className: "faq-summary-compact" },
                  h("span", { className: "faq-question-compact" }, item.question),
                  h("span", { className: "faq-arrow-compact", "aria-hidden": "true" }, ">"),
                ),
                h("p", { className: "muted-copy faq-answer-compact" }, item.answer),
              ),
            ),
          ),
        ),
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
            h("p", { className: "muted-copy" }, t("footerCopy", "Premium SaaS frontend for modern rig move operations, from planning through execution.")),
          ),
          h(
            "div",
            { className: "marketing-footer-column" },
            h("span", { className: "marketing-footer-heading" }, t("product", "Product")),
            h(
              "button",
              {
                type: "button",
                className: "footer-link",
                onClick: () => document.getElementById("features")?.scrollIntoView({ behavior: "smooth" }),
              },
              t("brandNavFeatures", "Features"),
            ),
            h(
              "button",
              {
                type: "button",
                className: "footer-link",
                onClick: hasSession ? onOpenDashboard : onOpenLogin,
              },
              hasSession ? t("dashboard", "Dashboard") : t("login", "Login"),
            ),
          ),
          h(
            "div",
            { className: "marketing-footer-column" },
            h("span", { className: "marketing-footer-heading" }, t("company", "Company")),
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

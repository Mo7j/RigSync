import { React, h } from "../lib/react.js";
import { MarketingLayout } from "../layouts/MarketingLayout.js";
import { Button } from "../components/ui/Button.js";
import { Card } from "../components/ui/Card.js";
import { HeroOperationsBackdrop } from "../components/map/HeroOperationsBackdrop.js";
import { translate } from "../lib/language.js";

const { useEffect, useMemo, useRef, useState } = React;

const FEATURE_ITEMS = [
  {
    icon: "NP",
    title: "Network-Based Rig Planning",
    copy: "See the company fleet as one connected operational network, choose the rig that needs to move, and plan in the context of all available rigs, routes, trucks, and field constraints.",
  },
  {
    icon: "TO",
    title: "Trade-Off Aware Optimization",
    copy: "Compare the best move plan for speed, cost, or utilization. RigSync surfaces the operational trade-offs clearly so the selected plan matches the situation on the ground.",
  },
  {
    icon: "DV",
    title: "Digital Twin Execution View",
    copy: "Move from planning into execution on the same operational twin. Follow route progress, move phases, active trucks, and site readiness without switching between disconnected tools.",
  },
  {
    icon: "FO",
    title: "Office-Level Fleet Oversight",
    copy: "Oversee all rigs, active moves, drivers, trucks, and field resources from one control surface designed for management visibility across the full company network.",
  },
  {
    icon: "RD",
    title: "Resource And Driver Control",
    copy: "Manage truck readiness, linked drivers, fleet availability, and operational assignments through one workspace that stays aligned with move execution.",
  },
  {
    icon: "AI",
    title: "AI Operational Assistant",
    copy: "Use the assistant to retrieve move status, inspect plan trade-offs, support senior review, and answer operational questions quickly with the right context already in the system.",
  },
];

const FAQ_ITEMS = [
  {
    question: "What is the difference between a digital twin and a simulation?",
    answer: "A simulation tests one possible move scenario. A digital twin is broader: it represents the live operational system itself, including rigs, trucks, drivers, routes, resources, and move status. In RigSync, simulation is one capability inside the digital twin.",
  },
  {
    question: "Why should I use RigSync instead of traditional planning tools?",
    answer: "Traditional move planning is usually fragmented across spreadsheets, calls, static plans, and separate tracking tools. RigSync brings planning, comparison, execution visibility, office oversight, and operational intelligence into one connected platform.",
  },
  {
    question: "How does RigSync help decisions during a move?",
    answer: "RigSync helps teams choose the plan that best fits current priorities, whether that means moving faster, reducing cost, or improving truck utilization. During execution it keeps managers, foremen, and field teams aligned on one operational picture.",
  },
];

function FeatureSymbol({ code }) {
  const commonProps = {
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: "1.8",
    strokeLinecap: "round",
    strokeLinejoin: "round",
    className: "feature-icon-svg",
    "aria-hidden": "true",
  };

  if (code === "NP") {
    return h(
      "svg",
      commonProps,
      h("circle", { cx: "5.5", cy: "12", r: "2.1" }),
      h("circle", { cx: "14.5", cy: "7", r: "2.1" }),
      h("circle", { cx: "18.5", cy: "16.5", r: "2.1" }),
      h("path", { d: "M7.6 11.4l4.8-3M7.6 12.6l8.7 3.1" }),
    );
  }

  if (code === "TO") {
    return h(
      "svg",
      commonProps,
      h("path", { d: "M12 4v16" }),
      h("path", { d: "M6 8h12" }),
      h("path", { d: "M7.8 8l-2.1 5h4.2z" }),
      h("path", { d: "M16.2 8l-2.1 5h4.2z" }),
      h("path", { d: "M9 18h6" }),
    );
  }

  if (code === "DV") {
    return h(
      "svg",
      commonProps,
      h("rect", { x: "4", y: "5", width: "7", height: "7", rx: "1.6" }),
      h("rect", { x: "13", y: "12", width: "7", height: "7", rx: "1.6" }),
      h("path", { d: "M11 8.5h2M13 15.5h-2M10.8 10.8l2.6 2.6" }),
    );
  }

  if (code === "FO") {
    return h(
      "svg",
      commonProps,
      h("path", { d: "M4 19h16" }),
      h("path", { d: "M7 19v-5M12 19V9M17 19v-8" }),
      h("path", { d: "M5.8 11.5l4.1-3 2.9 2.1 5-4.1" }),
      h("path", { d: "M16.4 6.5h2.4v2.4" }),
    );
  }

  if (code === "RD") {
    return h(
      "svg",
      commonProps,
      h("circle", { cx: "8.5", cy: "8", r: "2.3" }),
      h("path", { d: "M4.7 18c.9-2.4 2.7-3.7 5.1-3.7 2.1 0 3.8 1.1 4.8 3.1" }),
      h("path", { d: "M16.5 7h3M18 5.5v3" }),
      h("path", { d: "M16.5 11.5h3" }),
    );
  }

  return h(
    "svg",
    commonProps,
    h("path", { d: "M12 4.3l2.1 4.2 4.7.7-3.4 3.2.8 4.8-4.2-2.2-4.2 2.2.8-4.8-3.4-3.2 4.7-.7z" }),
  );
}

function useAnimatedCount(target, isActive, durationMs = 1400) {
  const [value, setValue] = useState(0);

  useEffect(() => {
    if (!isActive) {
      setValue(0);
      return undefined;
    }

    let frameId = 0;
    const startAt = performance.now();

    function tick(now) {
      const progress = Math.min(1, (now - startAt) / durationMs);
      const eased = 1 - Math.pow(1 - progress, 3);
      setValue(Math.round(target * eased));
      if (progress < 1) {
        frameId = window.requestAnimationFrame(tick);
      }
    }

    frameId = window.requestAnimationFrame(tick);
    return () => {
      window.cancelAnimationFrame(frameId);
    };
  }, [target, isActive, durationMs]);

  return value;
}

function AnimatedMetricCard({ label, target, suffix = "", prefix = "", meta, isActive, className = "" }) {
  const value = useAnimatedCount(target, isActive);
  return h(
    Card,
    { className: `feature-card home-scene-card metric-card${className ? ` ${className}` : ""}` },
    h("span", { className: "feature-index metric-card-kicker" }, label),
    h("strong", { className: "metric-card-value" }, `${prefix}${value}${suffix}`),
    h("p", { className: "metric-card-meta" }, meta),
  );
}

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
  const aboutSectionRef = useRef(null);
  const [isAboutVisible, setIsAboutVisible] = useState(false);
  const aboutMetrics = useMemo(
    () => [
      {
        label: "Connected Rigs",
        target: Math.max(18, Number(moveCount) || 0),
        meta: "Across the company network",
      },
      {
        label: "Move Scenarios",
        target: Math.max(64, (Number(moveCount) || 0) * 8),
        meta: "Speed, cost, and utilization trade-offs",
      },
      {
        label: "Tracked Resources",
        target: Math.max(240, Number(loadCount) || 0),
        meta: isLoadingLoads ? "Loading live operational totals" : "Drivers, trucks, loads, and readiness signals",
      },
      {
        label: "Execution Views",
        target: 4,
        meta: "Planning, move tracking, oversight, and AI assistance",
      },
    ],
    [moveCount, loadCount, isLoadingLoads],
  );

  useEffect(() => {
    const node = aboutSectionRef.current;
    if (!node) {
      return undefined;
    }

    const observer = new IntersectionObserver(
      ([entry]) => {
        setIsAboutVisible(Boolean(entry?.isIntersecting));
      },
      {
        threshold: 0.35,
      },
    );

    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const story = document.querySelector(".home-story");
    const hero = document.getElementById("hero");
    if (!story || !hero) {
      return undefined;
    }

    let frameId = 0;

    function commitMotion() {
      frameId = 0;
      const rect = hero.getBoundingClientRect();
      const heroSpan = Math.max(rect.height, window.innerHeight * 0.82);
      const progress = Math.max(0, Math.min(1.18, -rect.top / heroSpan));
      const scrollShift = Math.max(-140, Math.min(220, progress * 220));
      const lineDrift = Math.max(-90, Math.min(120, rect.top * -0.08));
      const glowDrift = Math.max(-140, Math.min(140, rect.top * -0.12));

      story.style.setProperty("--hero-scroll-progress", progress.toFixed(4));
      story.style.setProperty("--hero-scroll-shift", `${scrollShift.toFixed(1)}px`);
      story.style.setProperty("--hero-line-drift", `${lineDrift.toFixed(1)}px`);
      story.style.setProperty("--hero-glow-drift", `${glowDrift.toFixed(1)}px`);
    }

    function requestMotionCommit() {
      if (frameId) {
        return;
      }
      frameId = window.requestAnimationFrame(commitMotion);
    }

    function handlePointerMove(event) {
      const bounds = story.getBoundingClientRect();
      const relativeX = ((event.clientX - bounds.left) / Math.max(bounds.width, 1)) - 0.5;
      const relativeY = ((event.clientY - bounds.top) / Math.max(bounds.height, 1)) - 0.5;
      story.style.setProperty("--hero-pointer-x", relativeX.toFixed(4));
      story.style.setProperty("--hero-pointer-y", relativeY.toFixed(4));
    }

    function handlePointerLeave() {
      story.style.setProperty("--hero-pointer-x", "0");
      story.style.setProperty("--hero-pointer-y", "0");
    }

    requestMotionCommit();
    window.addEventListener("scroll", requestMotionCommit, { passive: true });
    window.addEventListener("resize", requestMotionCommit);
    story.addEventListener("pointermove", handlePointerMove);
    story.addEventListener("pointerleave", handlePointerLeave);

    return () => {
      window.removeEventListener("scroll", requestMotionCommit);
      window.removeEventListener("resize", requestMotionCommit);
      story.removeEventListener("pointermove", handlePointerMove);
      story.removeEventListener("pointerleave", handlePointerLeave);
      if (frameId) {
        window.cancelAnimationFrame(frameId);
      }
      story.style.removeProperty("--hero-scroll-progress");
      story.style.removeProperty("--hero-scroll-shift");
      story.style.removeProperty("--hero-line-drift");
      story.style.removeProperty("--hero-glow-drift");
      story.style.removeProperty("--hero-pointer-x");
      story.style.removeProperty("--hero-pointer-y");
    };
  }, []);

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
        h(HeroOperationsBackdrop),
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
            "Operational",
            h("br"),
            h("span", { className: "hero-title-accent" }, "Precision"),
            " At Scale",
          ),
          h(
            "p",
            { className: "hero-text hero-text-wide" },
            "Plan and execute rig moves through one connected operational network. RigSync links rigs, routes, trucks, and field decisions in a live visual system that moves with the page like an interactive control surface.",
          ),
          h(
            "div",
            { className: "hero-actions" },
            h(Button, {
              type: "button",
              className: "hero-primary",
              onClick: hasSession ? onOpenDashboard : onOpenLogin,
              children: t("openWorkspace", "Open Workspace"),
            }),
          ),
        ),
      ),
      h(
        "section",
        { id: "about", ref: aboutSectionRef, className: "marketing-section marketing-scene marketing-section-accent marketing-scene-about" },
        h(
          "div",
          { className: "home-scene-panel home-about-scene-panel home-scene-panel-center" },
          h(
            "div",
            { className: "about-stack" },
            h(
              "div",
              { className: "about-column about-column-main about-column-full" },
              h(
                "div",
                { className: "about-copy-block about-copy-block-full" },
                h("p", { className: "hero-badge" }, "About RigSync"),
                h("h2", { className: "section-title" }, "A Digital Twin Built For Real Rig Move Decisions"),
                h(
                  "p",
                  { className: "muted-copy section-copy" },
                  "RigSync gives drilling organizations a digital twin of their move operations. Instead of coordinating rig moves through disconnected spreadsheets, phone calls, and isolated tracking tools, teams can model rigs, trucks, drivers, routes, resources, and site readiness in one operational system. The result is faster planning, clearer trade-offs, stronger execution visibility, and better control from the office to the field.",
                ),
              ),
              h(
                "div",
                { className: "about-stats about-stats-left about-stats-full" },
                h(
                  "div",
                  { className: "about-stats-strip" },
                  h(
                    "div",
                    { className: "about-stats-strip-track" },
                    [...aboutMetrics, ...aboutMetrics].map((metric, index) =>
                      h(AnimatedMetricCard, {
                        key: `${metric.label}-${index}`,
                        label: metric.label,
                        target: metric.target,
                        isActive: isAboutVisible,
                        suffix: metric.label === "Connected Rigs" ? "+" : "",
                        meta: metric.meta,
                        className: "metric-card-strip",
                      }),
                    ),
                  ),
                ),
              ),
            ),
          ),
        ),
      ),
      h(
        "section",
        { id: "features", className: "marketing-section marketing-scene marketing-scene-features" },
        h(
          "div",
          { className: "home-scene-panel home-scene-panel-center" },
          h(
            "div",
            { className: "feature-showcase" },
            h(
              "div",
              { className: "feature-showcase-head" },
              h("p", { className: "hero-badge" }, "Features"),
              h("h2", { className: "section-title features-section-title" }, "From Move Planning To Fleet Oversight In One System"),
              h(
                "p",
                { className: "feature-showcase-lead-copy" },
                "RigSync combines planning, execution, fleet visibility, and field readiness in one operational system built for live rig move control.",
              ),
            ),
            h(
              "div",
              { className: "feature-showcase-grid" },
              FEATURE_ITEMS.slice(0, 5).map((item, index) =>
                h(
                  Card,
                  {
                    key: item.title,
                    className: `feature-showcase-card feature-showcase-card-${index + 1}`,
                  },
                  h(
                    "span",
                    { className: "feature-showcase-icon", "aria-hidden": "true" },
                    h(FeatureSymbol, { code: item.icon }),
                  ),
                  h(
                    "div",
                    { className: "feature-showcase-copy" },
                    h("strong", { className: "feature-showcase-title" }, item.title),
                    h("p", { className: "feature-showcase-text" }, item.copy),
                  ),
                ),
              ),
            ),
          ),
        ),
      ),
      h(
        "section",
        { id: "faq", className: "marketing-section marketing-scene marketing-scene-faq" },
        h(
          "div",
          { className: "home-scene-panel home-faq-scene-panel home-scene-panel-center" },
          h("p", { className: "eyebrow" }, "FAQ"),
          h("h2", { className: "home-faq-title" }, "Digital Twin Questions That Matter"),
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
            h("p", { className: "muted-copy" }, "A digital twin platform for network-wide rig move planning, execution oversight, and operational intelligence."),
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
              "About RigSync",
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
          h("span", null, "Built for digital twin rig move operations"),
        ),
      ),
    ),
  );
}

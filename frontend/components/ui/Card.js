import { h } from "../../lib/react.js";

export function Card({ children, className = "", ...props }) {
  return h("section", {
    ...props,
    className: `card${className ? ` ${className}` : ""}`,
    children,
  });
}

export function StatCard({ label, value, meta, tone = "default" }) {
  return h(
    "article",
    { className: `stat-card stat-card-${tone}` },
    h("span", { className: "stat-card-label" }, label),
    h("strong", { className: "stat-card-value" }, value),
    meta ? h("p", { className: "stat-card-meta" }, meta) : null,
  );
}

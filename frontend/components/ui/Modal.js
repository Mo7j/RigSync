import { React, h } from "../../lib/react.js";

const { useEffect } = React;

export function Modal({ title, description, children, onClose, flushBody = false, eyebrow = "Location Selector", className = "" }) {
  useEffect(() => {
    const handleEscape = (event) => {
      if (event.key === "Escape") {
        onClose();
      }
    };

    window.addEventListener("keydown", handleEscape);
    return () => window.removeEventListener("keydown", handleEscape);
  }, [onClose]);

  return h(
    "div",
    {
      className: "modal-backdrop",
      onClick: onClose,
    },
    h(
      "div",
      {
        className: `modal-shell${flushBody ? " modal-shell-flush" : ""}${className ? ` ${className}` : ""}`,
        onClick: (event) => event.stopPropagation(),
      },
      h(
        "div",
        { className: "modal-header" },
        h(
          "div",
          null,
          h("p", { className: "eyebrow" }, eyebrow),
          h("h3", null, title),
          description ? h("p", { className: "muted-copy" }, description) : null,
        ),
        h(
          "button",
          {
            type: "button",
            className: "icon-button",
            onClick: onClose,
            "aria-label": "Close modal",
          },
          "×",
        ),
      ),
      children,
    ),
  );
}

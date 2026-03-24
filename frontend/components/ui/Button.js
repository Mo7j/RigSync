import { h } from "../../lib/react.js";

export function Button({
  children,
  variant = "primary",
  size = "md",
  className = "",
  isBusy = false,
  ...props
}) {
  const variantClass = `button button-${variant} button-${size}${isBusy ? " is-busy" : ""}${className ? ` ${className}` : ""}`;

  return h(
    "button",
    {
      ...props,
      className: variantClass,
      disabled: props.disabled || isBusy,
    },
    h(
      "span",
      { className: "button-content" },
      h(
        "span",
        { className: `button-label${isBusy ? " button-label-busy" : ""}` },
        children,
      ),
      isBusy ? h("span", { className: "button-spinner", "aria-hidden": true }) : null,
    ),
  );
}

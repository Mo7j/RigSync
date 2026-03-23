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
    isBusy ? "Loading..." : children,
  );
}

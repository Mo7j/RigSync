import { h } from "../../lib/react.js";

export function Field({ label, hint, error, action, children }) {
  return h(
    "label",
    { className: "field" },
    h(
      "span",
      { className: "field-header" },
      h("span", { className: "field-label" }, label),
      action ? h("span", { className: "field-action" }, action) : null,
    ),
    children,
    hint ? h("small", { className: "field-hint" }, hint) : null,
    error ? h("small", { className: "field-error" }, error) : null,
  );
}

export function TextInput(props) {
  return h("input", {
    ...props,
    className: `input${props.className ? ` ${props.className}` : ""}`,
  });
}

export function SelectInput({ children, ...props }) {
  return h(
    "select",
    {
      ...props,
      className: `input${props.className ? ` ${props.className}` : ""}`,
    },
    children,
  );
}

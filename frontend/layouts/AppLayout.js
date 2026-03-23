import { h } from "../lib/react.js";
import { Button } from "../components/ui/Button.js";

function SettingsGlyph() {
  return h(
    "svg",
    {
      viewBox: "0 0 24 24",
      className: "settings-glyph",
      "aria-hidden": "true",
    },
    h("path", {
      d: "M12 8.75A3.25 3.25 0 1 0 12 15.25A3.25 3.25 0 1 0 12 8.75Z M4.92 13.22L3 12l1.92-1.22.44-2.24 2.19-.62.87-2.11L10.75 6 12 4l1.25 2 2.33-.19.87 2.11 2.19.62.44 2.24L21 12l-1.92 1.22-.44 2.24-2.19.62-.87 2.11L13.25 18 12 20l-1.25-2-2.33.19-.87-2.11-2.19-.62-.44-2.24Z",
      fill: "currentColor",
    }),
  );
}

export function AppLayout({
  title,
  subtitle,
  currentUser,
  onLogout,
  onBack,
  fullBleed = false,
  children,
}) {
  return h(
    "main",
    { className: "app-shell" },
    h("div", { className: "app-grid" }),
    h(
      "section",
      { className: `app-frame${fullBleed ? " app-frame-bleed" : ""}` },
      h(
        "header",
        { className: "app-header" },
        h(
          "div",
          { className: "app-brand-cluster" },
          onBack
            ? h(
                Button,
                {
                  type: "button",
                  variant: "ghost",
                  size: "sm",
                  className: "back-button",
                  onClick: onBack,
                  children: "Back",
                },
              )
            : null,
          h(
            "div",
            null,
            h("p", { className: "eyebrow" }, "RigSync Workspace"),
            h("h1", { className: "app-title" }, title),
            subtitle ? h("p", { className: "muted-copy" }, subtitle) : null,
          ),
        ),
        h(
          "div",
          { className: "app-header-actions" },
          h(
            "div",
            { className: "user-badge" },
            h("span", { className: "user-badge-dot" }),
            h(
              "div",
              null,
              h("strong", null, currentUser?.name || "Operations"),
              h("span", null, currentUser?.role || "Control room"),
            ),
          ),
          h(
            "button",
            {
              type: "button",
              className: "icon-button settings-button",
              "aria-label": "Settings",
            },
            h(SettingsGlyph),
          ),
          h(Button, {
            type: "button",
            variant: "ghost",
            size: "sm",
            onClick: onLogout,
            children: "Logout",
          }),
        ),
      ),
      children,
    ),
  );
}

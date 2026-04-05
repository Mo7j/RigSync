import { h } from "../lib/react.js";
import { Button } from "../components/ui/Button.js";
import { translate } from "../lib/language.js";

function scrollToSection(sectionId) {
  const section = document.getElementById(sectionId);
  if (section) {
    section.scrollIntoView({ behavior: "smooth", block: "start" });
  }
}

export function MarketingLayout({ language = "en", onToggleLanguage, children, className = "" }) {
  return h(
    "div",
    { className: `marketing-shell${className ? ` ${className}` : ""}` },
    h(
      "header",
      { className: "marketing-header" },
      h(
        "button",
        {
          type: "button",
          className: "brand-mark",
          onClick: () => scrollToSection("hero"),
        },
        h("span", { className: "brand-rig" }, "Rig"),
        h("span", { className: "brand-sync" }, "Sync"),
      ),
      h(
        "nav",
        { className: "marketing-nav" },
        ["features", "about", "faq"].map((item) =>
          h(
            "button",
            {
              key: item,
              type: "button",
              className: "nav-link",
              onClick: () => scrollToSection(item),
            },
            item === "faq"
              ? translate(language, "brandNavFaq", "FAQ")
              : item === "about"
                ? translate(language, "brandNavAbout", "About Us")
                : translate(language, "brandNavFeatures", "Features"),
          ),
        ),
      ),
      h(Button, {
        type: "button",
        variant: "ghost",
        size: "sm",
        className: "marketing-cta",
        onClick: onToggleLanguage,
        children: translate(language, "langToggle", "AR"),
      }),
    ),
    children,
  );
}

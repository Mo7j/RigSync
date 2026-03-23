import { React } from "./react.js";

const { useEffect, useState } = React;

function parseHashRoute() {
  const hash = window.location.hash.replace(/^#/, "") || "/home";
  const cleanPath = hash.startsWith("/") ? hash : `/${hash}`;
  const parts = cleanPath.split("/").filter(Boolean);

  if (parts[0] === "login") {
    return { page: "login" };
  }

  if (parts[0] === "dashboard") {
    return { page: "dashboard" };
  }

  if (parts[0] === "move" && parts[1]) {
    return { page: "move", moveId: parts[1] };
  }

  return { page: "home" };
}

export function navigateTo(path) {
  const normalized = path.startsWith("/") ? path : `/${path}`;
  window.location.hash = normalized;
}

export function useHashRoute() {
  const [route, setRoute] = useState(parseHashRoute);

  useEffect(() => {
    const updateRoute = () => setRoute(parseHashRoute());

    window.addEventListener("hashchange", updateRoute);
    updateRoute();

    return () => {
      window.removeEventListener("hashchange", updateRoute);
    };
  }, []);

  return route;
}

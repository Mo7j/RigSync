import { React, h } from "../../lib/react.js";
import { DEFAULT_CENTER, fetchRouteData, fallbackRouteData, getTruckPosition, getTruckStatus } from "../../features/rigMoves/simulation.js";

const { useEffect, useMemo, useRef, useState } = React;

function createTruckIcon(truckId) {
  const svg = `
    <svg width="54" height="54" viewBox="0 0 42 42" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path d="M11 23.5C11 20.4624 13.4624 18 16.5 18H23.5C26.5376 18 29 20.4624 29 23.5V27H11V23.5Z" fill="#E8F7C4"/>
      <path d="M29 20H32.2C33.0233 20 33.7933 20.4021 34.2627 21.076L36.2 23.8571C36.7194 24.6027 37 25.4897 37 26.3983V27H29V20Z" fill="#C6FF00"/>
      <circle cx="16.5" cy="28.5" r="2.5" fill="#111013"/>
      <circle cx="30.5" cy="28.5" r="2.5" fill="#111013"/>
      <circle cx="31.5" cy="11" r="7" fill="#0f1216"/>
      <text x="31.5" y="13.5" text-anchor="middle" font-family="Space Grotesk, sans-serif" font-size="8" font-weight="700" fill="#f5f7fb">${truckId}</text>
    </svg>`;

  return window.L.divIcon({
    className: "truck-marker-icon",
    html: `<div class="truck-marker-body">${svg}</div>`,
    iconSize: [54, 54],
    iconAnchor: [27, 27],
  });
}

function createSourceIcon() {
  const svg = `
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
      <circle cx="12" cy="12" r="6.5" fill="#ffd84a"/>
      <circle cx="12" cy="12" r="9" stroke="rgba(255,216,74,0.28)" stroke-width="1.5"/>
    </svg>`;

  return window.L.divIcon({
    className: "endpoint-marker-icon endpoint-marker-icon-source",
    html: svg,
    iconSize: [24, 24],
    iconAnchor: [12, 12],
  });
}

function createDestinationIcon() {
  const svg = `
    <svg width="26" height="34" viewBox="0 0 26 34" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path fill-rule="evenodd" clip-rule="evenodd" d="M13 1.5C7.20101 1.5 2.5 6.20101 2.5 12C2.5 19.5331 9.36044 25.0578 12.0505 31.0114C12.4012 31.7878 13.5988 31.7878 13.9495 31.0114C16.6396 25.0578 23.5 19.5331 23.5 12C23.5 6.20101 18.799 1.5 13 1.5ZM13 15.5C14.933 15.5 16.5 13.933 16.5 12C16.5 10.067 14.933 8.5 13 8.5C11.067 8.5 9.5 10.067 9.5 12C9.5 13.933 11.067 15.5 13 15.5Z" fill="#ffd84a"/>
    </svg>`;

  return window.L.divIcon({
    className: "endpoint-marker-icon endpoint-marker-icon-destination",
    html: svg,
    iconSize: [26, 34],
    iconAnchor: [13, 31],
  });
}

function createSupportSourceIcon() {
  const svg = `
    <svg width="26" height="26" viewBox="0 0 26 26" fill="none" xmlns="http://www.w3.org/2000/svg">
      <circle cx="13" cy="13" r="8" fill="#8bc7ff"/>
      <circle cx="13" cy="13" r="11" stroke="rgba(139,199,255,0.28)" stroke-width="1.5"/>
      <path d="M9.5 13H16.5M13 9.5V16.5" stroke="#0f1216" stroke-width="1.8" stroke-linecap="round"/>
    </svg>`;

  return window.L.divIcon({
    className: "endpoint-marker-icon endpoint-marker-icon-support",
    html: svg,
    iconSize: [26, 26],
    iconAnchor: [13, 13],
  });
}

function buildTooltipHtml(title, items) {
  if (!items.length) {
    return `<div class="rig-tooltip"><strong>${title}</strong><p>No loads at this stage.</p></div>`;
  }

  const rows = items
    .slice(0, 6)
    .map((trip) => `<li><span>#${trip.loadId}</span><em>${trip.description}</em></li>`)
    .join("");

  return `<div class="rig-tooltip"><strong>${title}</strong><ul>${rows}</ul></div>`;
}

function createSceneTooltipOptions(extra = {}) {
  return {
    className: "scene-map-tooltip",
    direction: "auto",
    offset: [0, -12],
    opacity: 0.96,
    ...extra,
  };
}

function clampTooltipToViewport(tooltip) {
  const element = tooltip?.getElement?.();
  if (!element) {
    return;
  }

  element.style.marginLeft = "0px";
  element.style.marginTop = "0px";

  const padding = 12;
  const rect = element.getBoundingClientRect();
  const overflowLeft = padding - rect.left;
  const overflowRight = rect.right - (window.innerWidth - padding);
  const overflowTop = padding - rect.top;
  const overflowBottom = rect.bottom - (window.innerHeight - padding);

  const shiftX = overflowLeft > 0 ? overflowLeft : overflowRight > 0 ? -overflowRight : 0;
  const shiftY = overflowTop > 0 ? overflowTop : overflowBottom > 0 ? -overflowBottom : 0;

  if (shiftX || shiftY) {
    element.style.marginLeft = `${shiftX}px`;
    element.style.marginTop = `${shiftY}px`;
  }
}

function bindClampedTooltip(layer, content, options) {
  if (!layer) {
    return;
  }

  if (layer.__sceneTooltipHandlers) {
    layer.off("tooltipopen", layer.__sceneTooltipHandlers.open);
    layer.off("tooltipclose", layer.__sceneTooltipHandlers.close);
  }

  layer.bindTooltip(content, options);

  const handleOpen = (event) => {
    const tooltip = event.tooltip || layer.getTooltip?.();
    if (!tooltip) {
      return;
    }

    window.requestAnimationFrame(() => clampTooltipToViewport(tooltip));
  };

  const handleClose = (event) => {
    const element = event.tooltip?.getElement?.();
    if (!element) {
      return;
    }

    element.style.marginLeft = "0px";
    element.style.marginTop = "0px";
  };

  layer.__sceneTooltipHandlers = { open: handleOpen, close: handleClose };
  layer.on("tooltipopen", handleOpen);
  layer.on("tooltipclose", handleClose);
}

function shouldShowTruckMarker(status) {
  return status?.startsWith("In transit") || status?.startsWith("Heading to pickup") || status === "Returning";
}

function focusMapOnPoint(map, point, zoom = 12) {
  if (!map || !point) {
    return;
  }

  map.flyTo([point.lat, point.lng], zoom, {
    animate: true,
    duration: 0.45,
    easeLinearity: 0.25,
  });
}

function resetMapToIdleFocus(map, startPoint, endPoint, simulation) {
  if (!map) {
    return;
  }

  if (simulation?.routeGeometry?.length) {
    const bounds = window.L.latLngBounds(simulation.routeGeometry);
    map.flyToBounds(bounds, {
      padding: [50, 50],
      animate: true,
      duration: 0.5,
    });
    return;
  }

  const bounds = [];
  if (startPoint) {
    bounds.push([startPoint.lat, startPoint.lng]);
  }
  if (endPoint) {
    bounds.push([endPoint.lat, endPoint.lng]);
  }

  if (bounds.length > 1) {
    map.flyToBounds(bounds, {
      padding: [50, 50],
      animate: true,
      duration: 0.5,
    });
  } else if (startPoint || endPoint) {
    const point = startPoint || endPoint;
    map.flyTo([point.lat, point.lng], 8, {
      animate: true,
      duration: 0.45,
    });
  }
}

export function LeafletMap({
  startPoint,
  endPoint,
  simulation,
  currentMinute = 0,
  supportRoutes = [],
  pickerTarget = null,
  onPickPoint,
  onRigFocusChange = null,
  onTruckFocusChange = null,
  onFocusChange = null,
  heightClass = "map-frame",
}) {
  const [locationRequestState, setLocationRequestState] = useState("idle");
  const [locationRequestError, setLocationRequestError] = useState("");
  const [supportRouteGeometryMap, setSupportRouteGeometryMap] = useState({});
  const mapElementRef = useRef(null);
  const mapRef = useRef(null);
  const markersRef = useRef({ start: null, end: null });
  const routeLineRef = useRef(null);
  const supportRouteLinesRef = useRef([]);
  const supportMarkersRef = useRef(new Map());
  const truckMarkersRef = useRef(new Map());
  const routeKeyRef = useRef("");
  const pointBoundsKeyRef = useRef("");
  const supportRouteCacheRef = useRef(new Map());
  const supportRouteRequestKey = useMemo(
    () =>
      JSON.stringify({
        endPoint: endPoint ? [endPoint.lat, endPoint.lng] : null,
        supportRoutes: (supportRoutes || []).map((route) => ({
          key: route?.key || "",
          sourcePoint: route?.sourcePoint ? [route.sourcePoint.lat, route.sourcePoint.lng] : null,
        })),
      }),
    [supportRoutes, endPoint],
  );

  useEffect(() => {
    if (!mapElementRef.current || mapRef.current || !window.L) {
      return undefined;
    }

    const map = window.L.map(mapElementRef.current, {
      zoomControl: false,
      doubleClickZoom: false,
      zoomAnimation: true,
      fadeAnimation: true,
      markerZoomAnimation: true,
      zoomSnap: 1,
      zoomDelta: 1,
      wheelPxPerZoomLevel: 120,
    }).setView(DEFAULT_CENTER, 6);
    window.L.tileLayer("https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png", {
      maxZoom: 19,
      subdomains: "abcd",
      keepBuffer: 4,
      attribution: "&copy; OpenStreetMap contributors &copy; CARTO",
    }).addTo(map);

    mapRef.current = map;
    window.requestAnimationFrame(() => {
      map.invalidateSize(false);
    });

    return () => {
      map.remove();
      mapRef.current = null;
    };
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !pickerTarget || typeof onPickPoint !== "function") {
      return undefined;
    }

    const handleClick = (event) => {
      onPickPoint({
        target: pickerTarget,
        point: { lat: event.latlng.lat, lng: event.latlng.lng },
      });
    };

    map.on("click", handleClick);
    return () => map.off("click", handleClick);
  }, [pickerTarget, onPickPoint]);

  useEffect(() => {
    if (!pickerTarget) {
      setLocationRequestState("idle");
      setLocationRequestError("");
    }
  }, [pickerTarget]);

  useEffect(() => {
    let cancelled = false;

    async function loadSupportRoutes() {
      if (!endPoint || !(supportRoutes || []).length) {
        setSupportRouteGeometryMap({});
        return;
      }

      const supportedRoutes = supportRoutes.filter((route) => route?.sourcePoint && route?.key);
      const nextMap = {};

      supportedRoutes.forEach((route) => {
        if (route?.geometry?.length > 2) {
          nextMap[route.key] = route.geometry;
          return;
        }

        const cacheKey = `${route.sourcePoint.lat},${route.sourcePoint.lng}->${endPoint.lat},${endPoint.lng}`;
        const cachedGeometry = supportRouteCacheRef.current.get(cacheKey);
        if (cachedGeometry?.length > 2) {
          nextMap[route.key] = cachedGeometry;
          return;
        }

        nextMap[route.key] = fallbackRouteData(route.sourcePoint, endPoint).geometry;
      });

      if (!cancelled) {
        setSupportRouteGeometryMap(nextMap);
      }

      const uncachedRoutes = supportedRoutes.filter((route) => {
        if (route?.geometry?.length > 2) {
          return false;
        }

        const cacheKey = `${route.sourcePoint.lat},${route.sourcePoint.lng}->${endPoint.lat},${endPoint.lng}`;
        return !(supportRouteCacheRef.current.get(cacheKey)?.length > 2);
      });

      if (uncachedRoutes.length) {
        const results = await Promise.all(
          uncachedRoutes.map(async (route) => {
            const cacheKey = `${route.sourcePoint.lat},${route.sourcePoint.lng}->${endPoint.lat},${endPoint.lng}`;

            try {
              const routeData = await fetchRouteData(route.sourcePoint, endPoint);
              if (routeData?.geometry?.length > 2) {
                return { key: route.key, cacheKey, geometry: routeData.geometry };
              }
            } catch {
              // Fall back below.
            }

            return {
              key: route.key,
              cacheKey,
              geometry: fallbackRouteData(route.sourcePoint, endPoint).geometry,
            };
          }),
        );

        results.forEach((result) => {
          nextMap[result.key] = result.geometry;
          if (result.geometry?.length > 2) {
            supportRouteCacheRef.current.set(result.cacheKey, result.geometry);
          }
        });
      }

      if (!cancelled) {
        setSupportRouteGeometryMap(nextMap);
      }
    }

    loadSupportRoutes();

    return () => {
      cancelled = true;
    };
  }, [supportRouteRequestKey]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || pickerTarget) {
      return undefined;
    }

    const handleDoubleClick = () => {
      resetMapToIdleFocus(map, startPoint, endPoint, simulation);
      onRigFocusChange?.(null);
      onTruckFocusChange?.(null);
      onFocusChange?.(null);
    };

    map.on("dblclick", handleDoubleClick);
    return () => map.off("dblclick", handleDoubleClick);
  }, [pickerTarget, startPoint, endPoint, simulation, onRigFocusChange, onTruckFocusChange]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !window.L) {
      return;
    }

    const sourceTrips =
      simulation?.bestPlan?.playback?.trips?.filter((trip) => currentMinute < trip.arrivalAtDestination) || [];
    const destinationTrips =
      simulation?.bestPlan?.playback?.trips?.filter((trip) => currentMinute >= trip.arrivalAtDestination) || [];

    if (startPoint) {
      if (!markersRef.current.start) {
        markersRef.current.start = window.L.marker([startPoint.lat, startPoint.lng], {
          icon: createSourceIcon(),
        }).addTo(map);
        markersRef.current.start.on("click", () => {
          focusMapOnPoint(map, startPoint, 13);
          onRigFocusChange?.("source");
          onFocusChange?.({ kind: "rig", side: "source" });
        });
      } else {
        markersRef.current.start.setLatLng([startPoint.lat, startPoint.lng]);
      }

      bindClampedTooltip(markersRef.current.start, buildTooltipHtml("Loads at source", sourceTrips), createSceneTooltipOptions());
    } else if (markersRef.current.start) {
      markersRef.current.start.remove();
      markersRef.current.start = null;
    }

    if (endPoint) {
      if (!markersRef.current.end) {
        markersRef.current.end = window.L.marker([endPoint.lat, endPoint.lng], {
          icon: createDestinationIcon(),
        }).addTo(map);
        markersRef.current.end.on("click", () => {
          focusMapOnPoint(map, endPoint, 13);
          onRigFocusChange?.("destination");
          onFocusChange?.({ kind: "rig", side: "destination" });
        });
      } else {
        markersRef.current.end.setLatLng([endPoint.lat, endPoint.lng]);
      }

      bindClampedTooltip(markersRef.current.end, buildTooltipHtml("Loads at destination", destinationTrips), createSceneTooltipOptions());
    } else if (markersRef.current.end) {
      markersRef.current.end.remove();
      markersRef.current.end = null;
    }
  }, [startPoint, endPoint, simulation, currentMinute, onRigFocusChange, onTruckFocusChange]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !window.L) {
      return;
    }

    supportRouteLinesRef.current.forEach((line) => line.remove());
    supportRouteLinesRef.current = [];

    const activeSupportKeys = new Set();

    (supportRoutes || []).forEach((route) => {
      if (!route?.sourcePoint || !endPoint) {
        return;
      }

      activeSupportKeys.add(route.key);

      const existingMarker = supportMarkersRef.current.get(route.key);
      if (existingMarker) {
        existingMarker.setLatLng([route.sourcePoint.lat, route.sourcePoint.lng]);
        bindClampedTooltip(
          existingMarker,
          `<div class="rig-tooltip"><strong>${route.sourceLabel}</strong><p>${route.quantity}x ${route.loadLabel}</p></div>`,
          createSceneTooltipOptions(),
        );
      } else {
        const marker = window.L.marker([route.sourcePoint.lat, route.sourcePoint.lng], {
          icon: createSupportSourceIcon(),
        }).addTo(map);
        bindClampedTooltip(
          marker,
          `<div class="rig-tooltip"><strong>${route.sourceLabel}</strong><p>${route.quantity}x ${route.loadLabel}</p></div>`,
          createSceneTooltipOptions(),
        );
        supportMarkersRef.current.set(route.key, marker);
      }

      const geometry =
        supportRouteGeometryMap[route.key] || [
          [route.sourcePoint.lat, route.sourcePoint.lng],
          [endPoint.lat, endPoint.lng],
        ];

      const line = window.L.polyline(
        geometry,
        {
          color: "#8bc7ff",
          weight: 2,
          opacity: 0.75,
          dashArray: "10 10",
          lineCap: "round",
          lineJoin: "round",
        },
      ).addTo(map);

      supportRouteLinesRef.current.push(line);
    });

    supportMarkersRef.current.forEach((marker, key) => {
      if (!activeSupportKeys.has(key)) {
        marker.remove();
        supportMarkersRef.current.delete(key);
      }
    });
  }, [supportRoutes, endPoint, supportRouteGeometryMap]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !window.L) {
      return;
    }

    const bounds = [];
    if (startPoint) {
      bounds.push([startPoint.lat, startPoint.lng]);
    }
    if (endPoint) {
      bounds.push([endPoint.lat, endPoint.lng]);
    }

    if (bounds.length) {
      const nextBoundsKey = bounds.map((point) => point.join(",")).join("|");
      if (pointBoundsKeyRef.current !== nextBoundsKey) {
        pointBoundsKeyRef.current = nextBoundsKey;
        map.fitBounds(bounds, { padding: [50, 50], maxZoom: bounds.length === 1 ? 8 : 6, animate: false });
      }
    } else {
      pointBoundsKeyRef.current = "";
    }
  }, [startPoint, endPoint]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !window.L) {
      return;
    }

    if (routeLineRef.current) {
      routeLineRef.current.remove();
      routeLineRef.current = null;
    }

    if (!simulation?.routeGeometry?.length) {
      routeKeyRef.current = "";
      return;
    }

    const nextRouteKey = JSON.stringify(simulation.routeGeometry);

    routeLineRef.current = window.L.polyline(simulation.routeGeometry, {
      color: "#c6ff00",
      weight: 3,
      opacity: 0.9,
      lineCap: "round",
      lineJoin: "round",
      smoothFactor: 0.8,
    }).addTo(map);

    if (routeKeyRef.current !== nextRouteKey) {
      routeKeyRef.current = nextRouteKey;
      map.fitBounds(routeLineRef.current.getBounds(), { padding: [50, 50], animate: false });
    }
  }, [simulation]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !window.L) {
      return;
    }

    if (!simulation?.bestPlan?.playback?.trips?.length || !simulation?.routeGeometry?.length) {
      truckMarkersRef.current.forEach((marker) => marker.remove());
      truckMarkersRef.current.clear();
      return;
    }

    const activeTruckIds = new Set();

    for (let truckId = 1; truckId <= simulation.truckCount; truckId += 1) {
      const status = getTruckStatus(simulation.bestPlan.playback, currentMinute, truckId);
      if (!shouldShowTruckMarker(status)) {
        const hiddenMarker = truckMarkersRef.current.get(truckId);
        if (hiddenMarker) {
          hiddenMarker.remove();
          truckMarkersRef.current.delete(truckId);
        }
        continue;
      }

      const position = getTruckPosition(simulation.bestPlan.playback, simulation.routeGeometry, currentMinute, truckId);
      if (!position) {
        continue;
      }

      activeTruckIds.add(truckId);
      const existingMarker = truckMarkersRef.current.get(truckId);

      if (existingMarker) {
        existingMarker.setLatLng([position.lat, position.lng]);
        bindClampedTooltip(existingMarker, `Truck ${truckId}: ${status}`, createSceneTooltipOptions({ offset: [0, -8] }));
      } else {
        const marker = window.L.marker([position.lat, position.lng], {
          icon: createTruckIcon(truckId),
        }).addTo(map);
        marker.on("click", () => {
          const currentPosition = marker.getLatLng();
          focusMapOnPoint(map, { lat: currentPosition.lat, lng: currentPosition.lng }, 14);
          onTruckFocusChange?.(truckId);
          onFocusChange?.({ kind: "truck", truckId });
        });

        bindClampedTooltip(marker, `Truck ${truckId}: ${status}`, createSceneTooltipOptions({ offset: [0, -8] }));

        truckMarkersRef.current.set(truckId, marker);
      }
    }

    truckMarkersRef.current.forEach((marker, truckId) => {
      if (!activeTruckIds.has(truckId)) {
        marker.remove();
        truckMarkersRef.current.delete(truckId);
      }
    });
  }, [simulation, currentMinute, onRigFocusChange, onTruckFocusChange]);

  function handleUseMyLocation(event) {
    event.stopPropagation();

    if (!pickerTarget || typeof onPickPoint !== "function") {
      return;
    }

    if (!navigator.geolocation) {
      setLocationRequestState("error");
      setLocationRequestError("Location access is not available in this browser.");
      return;
    }

    setLocationRequestState("loading");
    setLocationRequestError("");

    navigator.geolocation.getCurrentPosition(
      (position) => {
        const point = {
          lat: position.coords.latitude,
          lng: position.coords.longitude,
        };

        setLocationRequestState("idle");
        setLocationRequestError("");
        focusMapOnPoint(mapRef.current, point, 13);
        onPickPoint({ target: pickerTarget, point });
      },
      (error) => {
        setLocationRequestState("error");
        if (error?.code === error.PERMISSION_DENIED) {
          setLocationRequestError("Location permission was denied.");
          return;
        }
        if (error?.code === error.POSITION_UNAVAILABLE) {
          setLocationRequestError("Current location is unavailable.");
          return;
        }
        if (error?.code === error.TIMEOUT) {
          setLocationRequestError("Location request timed out.");
          return;
        }
        setLocationRequestError("Unable to get your current location.");
      },
      {
        enableHighAccuracy: true,
        timeout: 10000,
        maximumAge: 0,
      },
    );
  }

  return h(
    "div",
    { className: heightClass },
    h("div", { ref: mapElementRef, className: "real-map" }),
    pickerTarget
      ? h(
          "button",
          {
            type: "button",
            className: `map-picker-hint${locationRequestState === "loading" ? " is-loading" : ""}`,
            onClick: handleUseMyLocation,
          },
          h("strong", { className: "map-picker-hint-title" }, locationRequestState === "loading" ? "Locating..." : "My location"),
          h(
            "span",
            { className: "map-picker-hint-copy" },
            locationRequestError || "Use your current location for this point.",
          ),
        )
      : null,
  );
}

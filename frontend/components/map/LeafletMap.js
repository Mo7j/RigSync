import { React, h } from "../../lib/react.js";
import { DEFAULT_CENTER, getTruckPosition, getTruckStatus } from "../../features/rigMoves/simulation.js";

const { useEffect, useRef } = React;

function createTruckIcon(truckId) {
  const svg = `
    <svg width="42" height="42" viewBox="0 0 42 42" fill="none" xmlns="http://www.w3.org/2000/svg">
      <circle cx="21" cy="21" r="20" fill="rgba(198,255,0,0.14)" stroke="#c6ff00" />
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
    iconSize: [42, 42],
    iconAnchor: [21, 21],
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

export function LeafletMap({
  startPoint,
  endPoint,
  simulation,
  currentMinute = 0,
  pickerTarget = null,
  onPickPoint,
  heightClass = "map-frame",
}) {
  const mapElementRef = useRef(null);
  const mapRef = useRef(null);
  const markersRef = useRef({ start: null, end: null });
  const routeLineRef = useRef(null);
  const truckMarkersRef = useRef([]);

  useEffect(() => {
    if (!mapElementRef.current || mapRef.current || !window.L) {
      return undefined;
    }

    const map = window.L.map(mapElementRef.current, { zoomControl: false }).setView(DEFAULT_CENTER, 6);
    window.L.tileLayer("https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png", {
      maxZoom: 19,
      subdomains: "abcd",
      attribution: "&copy; OpenStreetMap contributors &copy; CARTO",
    }).addTo(map);

    mapRef.current = map;

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
    const map = mapRef.current;
    if (!map || !window.L) {
      return;
    }

    const { start, end } = markersRef.current;
    if (start) {
      start.remove();
    }
    if (end) {
      end.remove();
    }

    const sourceTrips = simulation?.bestPlan?.playback?.trips?.filter((trip) => currentMinute < trip.arrivalAtDestination) || [];
    const destinationTrips = simulation?.bestPlan?.playback?.trips?.filter((trip) => currentMinute >= trip.arrivalAtDestination) || [];

    markersRef.current.start = startPoint
      ? window.L.marker([startPoint.lat, startPoint.lng]).addTo(map).bindTooltip(
          buildTooltipHtml("Loads at source", sourceTrips),
          { direction: "top", offset: [0, -12], opacity: 0.96 },
        )
      : null;
    markersRef.current.end = endPoint
      ? window.L.marker([endPoint.lat, endPoint.lng]).addTo(map).bindTooltip(
          buildTooltipHtml("Loads at destination", destinationTrips),
          { direction: "top", offset: [0, -12], opacity: 0.96 },
        )
      : null;

    const bounds = [];
    if (startPoint) {
      bounds.push([startPoint.lat, startPoint.lng]);
    }
    if (endPoint) {
      bounds.push([endPoint.lat, endPoint.lng]);
    }
    if (bounds.length) {
      map.fitBounds(bounds, { padding: [50, 50], maxZoom: bounds.length === 1 ? 8 : 6 });
    }
  }, [startPoint, endPoint, simulation, currentMinute]);

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
      return;
    }

    routeLineRef.current = window.L.polyline(simulation.routeGeometry, {
      color: "#c6ff00",
      weight: 4,
      opacity: 0.9,
    }).addTo(map);

    map.fitBounds(routeLineRef.current.getBounds(), { padding: [50, 50] });
  }, [simulation]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !window.L) {
      return;
    }

    truckMarkersRef.current.forEach((marker) => marker.remove());
    truckMarkersRef.current = [];

    if (!simulation?.bestPlan?.playback?.trips?.length || !simulation?.routeGeometry?.length) {
      return;
    }

    for (let truckId = 1; truckId <= simulation.truckCount; truckId += 1) {
      const position = getTruckPosition(simulation.bestPlan.playback, simulation.routeGeometry, currentMinute, truckId);
      if (!position) {
        continue;
      }

      const marker = window.L.marker([position.lat, position.lng], {
        icon: createTruckIcon(truckId),
      })
        .addTo(map)
        .bindTooltip(`Truck ${truckId}: ${getTruckStatus(simulation.bestPlan.playback, currentMinute, truckId)}`);

      truckMarkersRef.current.push(marker);
    }
  }, [simulation, currentMinute]);

  return h(
    "div",
    { className: heightClass },
    h("div", { ref: mapElementRef, className: "real-map" }),
    pickerTarget
      ? h(
          "div",
          { className: "map-picker-hint" },
          `Click anywhere on the map to set the ${pickerTarget === "start" ? "start" : "end"} location.`,
        )
      : null,
  );
}

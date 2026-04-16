import { React, h } from "../../lib/react.js";
import { SAUDI_BORDER_POINTS } from "./saudiShape.js";

const { useEffect, useMemo, useRef } = React;

const DEFAULT_CENTER = [24.7136, 46.6753];

function buildRigIcon({ tone = "idle", label = "R" }) {
  const palette =
    tone === "active"
      ? { fill: "#ffd84a", stroke: "rgba(255,216,74,0.28)", text: "#111013" }
      : tone === "destination"
        ? { fill: "#8bc7ff", stroke: "rgba(139,199,255,0.28)", text: "#111013" }
        : { fill: "#c6ff00", stroke: "rgba(198,255,0,0.25)", text: "#111013" };

  const svg = `
    <svg width="34" height="34" viewBox="0 0 34 34" fill="none" xmlns="http://www.w3.org/2000/svg">
      <circle cx="17" cy="17" r="11" fill="${palette.fill}"/>
      <circle cx="17" cy="17" r="15" stroke="${palette.stroke}" stroke-width="1.5"/>
      <text x="17" y="20.5" text-anchor="middle" font-family="Space Grotesk, sans-serif" font-size="10" font-weight="700" fill="${palette.text}">${label}</text>
    </svg>`;

  return window.L.divIcon({
    className: "manager-map-marker-icon",
    html: svg,
    iconSize: [34, 34],
    iconAnchor: [17, 17],
  });
}

function buildTransferIcon(progressPercent = 0) {
  const safePercent = Math.max(0, Math.min(100, Math.round(progressPercent)));
  const svg = `
    <svg width="44" height="44" viewBox="0 0 44 44" fill="none" xmlns="http://www.w3.org/2000/svg">
      <circle cx="22" cy="22" r="16" fill="#111013" stroke="rgba(255,216,74,0.22)" stroke-width="2"/>
      <circle cx="22" cy="22" r="10" fill="#ffd84a"/>
      <text x="22" y="25.5" text-anchor="middle" font-family="Space Grotesk, sans-serif" font-size="9" font-weight="700" fill="#111013">${safePercent}%</text>
    </svg>`;

  return window.L.divIcon({
    className: "manager-map-marker-icon manager-map-marker-icon-transfer",
    html: svg,
    iconSize: [44, 44],
    iconAnchor: [22, 22],
  });
}

function bindTooltip(layer, html) {
  layer.bindTooltip(html, {
    className: "scene-map-tooltip manager-map-tooltip",
    direction: "top",
    offset: [0, -10],
    opacity: 0.96,
  });
}

function buildSegments(points) {
  const segments = [];
  let total = 0;
  for (let index = 1; index < points.length; index += 1) {
    const start = points[index - 1];
    const end = points[index];
    const dx = end[1] - start[1];
    const dy = end[0] - start[0];
    const length = Math.sqrt((dx * dx) + (dy * dy));
    segments.push({ start, end, length });
    total += length;
  }
  return { segments, total };
}

function interpolateRoutePoint(routeGeometry, progressPercent) {
  const points = (routeGeometry || []).filter((point) => Array.isArray(point) && point.length >= 2);
  if (!points.length) {
    return null;
  }
  if (points.length === 1) {
    return { lat: points[0][0], lng: points[0][1] };
  }

  const { segments, total } = buildSegments(points);
  if (!total) {
    return { lat: points[0][0], lng: points[0][1] };
  }

  const target = total * Math.max(0, Math.min(1, (Number(progressPercent) || 0) / 100));
  let traversed = 0;

  for (const segment of segments) {
    if (traversed + segment.length >= target) {
      const ratio = segment.length ? (target - traversed) / segment.length : 0;
      return {
        lat: segment.start[0] + ((segment.end[0] - segment.start[0]) * ratio),
        lng: segment.start[1] + ((segment.end[1] - segment.start[1]) * ratio),
      };
    }
    traversed += segment.length;
  }

  const last = points[points.length - 1];
  return { lat: last[0], lng: last[1] };
}

export function ManagerRigsMap({
  rigs = [],
  heightClass = "map-frame map-frame-modal",
  selectedRigId = null,
  onSelectRig,
}) {
  const mapElementRef = useRef(null);
  const mapRef = useRef(null);
  const layersRef = useRef([]);

  const mapItems = useMemo(
    () =>
      (rigs || []).map((rig, index) => {
        const routeGeometry = rig.routeGeometry || [];
        const transferPoint = rig.executionState === "active"
          ? interpolateRoutePoint(routeGeometry, rig.completionPercentage || 0)
          : null;
        return {
          ...rig,
          index: index + 1,
          transferPoint,
        };
      }),
    [rigs],
  );

  useEffect(() => {
    if (!mapElementRef.current || mapRef.current || !window.L) {
      return undefined;
    }

    const map = window.L.map(mapElementRef.current, {
      zoomControl: true,
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
    window.requestAnimationFrame(() => map.invalidateSize(false));

    return () => {
      map.remove();
      mapRef.current = null;
    };
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !window.L) {
      return;
    }

    layersRef.current.forEach((layer) => layer.remove());
    layersRef.current = [];

    const bounds = [];

    const saudiHighlight = window.L.polygon(SAUDI_BORDER_POINTS, {
      color: "#ffd84a",
      weight: 2,
      opacity: 0.92,
      fillColor: "#ffd84a",
      fillOpacity: 0.12,
      lineJoin: "round",
      smoothFactor: 1.4,
      interactive: false,
    }).addTo(map);
    layersRef.current.push(saudiHighlight);

    const saudiGlow = window.L.polygon(SAUDI_BORDER_POINTS, {
      color: "#ffe48f",
      weight: 10,
      opacity: 0.12,
      fillOpacity: 0,
      lineJoin: "round",
      smoothFactor: 1.4,
      interactive: false,
    }).addTo(map);
    layersRef.current.push(saudiGlow);

    mapItems.forEach((rig) => {
      const indexLabel = String(rig.index);
      const isSelected = selectedRigId === rig.id;
      const lineColor = rig.executionState === "active"
        ? "#ffd84a"
        : isSelected
          ? "#c6ff00"
          : "#8bc7ff";
      const lineWeight = rig.executionState === "active"
        ? 4
        : isSelected
          ? 3
          : 2;

      if (rig.routeGeometry?.length > 1) {
        const routeLine = window.L.polyline(rig.routeGeometry, {
          color: lineColor,
          weight: lineWeight,
          opacity: 0.85,
          dashArray: rig.executionState === "active" ? null : "8 8",
          lineCap: "round",
          lineJoin: "round",
        }).addTo(map);
        if (typeof onSelectRig === "function") {
          routeLine.on("click", () => onSelectRig(rig.id));
        }
        layersRef.current.push(routeLine);
        rig.routeGeometry.forEach((point) => bounds.push(point));
      }

      if (rig.startPoint) {
        const startMarker = window.L.marker([rig.startPoint.lat, rig.startPoint.lng], {
          icon: buildRigIcon({ tone: "idle", label: indexLabel }),
        }).addTo(map);
        bindTooltip(
          startMarker,
          `<div class="rig-tooltip"><strong>${rig.name}</strong><p>Old site</p><p>${rig.startLabel || ""}</p></div>`,
        );
        if (typeof onSelectRig === "function") {
          startMarker.on("click", () => onSelectRig(rig.id));
        }
        layersRef.current.push(startMarker);
        bounds.push([rig.startPoint.lat, rig.startPoint.lng]);
      }

      if (rig.endPoint) {
        const endMarker = window.L.marker([rig.endPoint.lat, rig.endPoint.lng], {
          icon: buildRigIcon({ tone: "destination", label: indexLabel }),
        }).addTo(map);
        bindTooltip(
          endMarker,
          `<div class="rig-tooltip"><strong>${rig.name}</strong><p>New site</p><p>${rig.endLabel || ""}</p></div>`,
        );
        if (typeof onSelectRig === "function") {
          endMarker.on("click", () => onSelectRig(rig.id));
        }
        layersRef.current.push(endMarker);
        bounds.push([rig.endPoint.lat, rig.endPoint.lng]);
      }

      if (rig.transferPoint) {
        const transferMarker = window.L.marker([rig.transferPoint.lat, rig.transferPoint.lng], {
          icon: buildTransferIcon(rig.completionPercentage || 0),
        }).addTo(map);
        bindTooltip(
          transferMarker,
          `<div class="rig-tooltip"><strong>${rig.name}</strong><p>Transferring</p><p>${Math.round(rig.completionPercentage || 0)}% complete</p></div>`,
        );
        if (typeof onSelectRig === "function") {
          transferMarker.on("click", () => onSelectRig(rig.id));
        }
        layersRef.current.push(transferMarker);
        bounds.push([rig.transferPoint.lat, rig.transferPoint.lng]);
      }
    });

    if (bounds.length) {
      map.fitBounds(bounds, {
        padding: [56, 56],
        maxZoom: bounds.length === 1 ? 9 : 7,
        animate: false,
      });
    } else {
      map.setView(DEFAULT_CENTER, 6, { animate: false });
    }
  }, [mapItems, onSelectRig, selectedRigId]);

  return h(
    "div",
    { className: heightClass },
    h("div", { ref: mapElementRef, className: "real-map" }),
  );
}

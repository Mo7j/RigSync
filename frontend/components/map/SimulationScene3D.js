import { React, h } from "../../lib/react.js";
import * as THREE from "https://esm.sh/three@0.179.1";
import { OrbitControls } from "https://esm.sh/three@0.179.1/examples/jsm/controls/OrbitControls.js";
import { GLTFLoader } from "https://esm.sh/three@0.179.1/examples/jsm/loaders/GLTFLoader.js";
import { getTruckStatus, haversineKilometers } from "../../features/rigMoves/simulation.js";

const { useEffect, useRef } = React;
const assetLoader = new GLTFLoader();
const assetTemplateCache = new Map();

const MODEL_PATHS = {
  truck: "/assets/models/heavy_truck.glb",
  rig: "/assets/models/1.glb",
};

export function preloadSimulationSceneAssets() {
  return Promise.all([
    loadModelTemplate("truck"),
    loadModelTemplate("rig"),
  ]);
}

function cloneModelWithUniqueMaterials(template) {
  const clone = template.clone(true);
  clone.traverse((child) => {
    if (!child.isMesh) {
      return;
    }

    if (Array.isArray(child.material)) {
      child.material = child.material.map((material) => material.clone());
    } else if (child.material) {
      child.material = child.material.clone();
    }

    child.castShadow = true;
    child.receiveShadow = true;
  });
  return clone;
}

function hashString(value) {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = ((hash << 5) - hash) + value.charCodeAt(index);
    hash |= 0;
  }
  return Math.abs(hash);
}

function tintModel(root, color) {
  const tint = new THREE.Color(color);
  root.traverse((child) => {
    if (!child.isMesh || !child.material) {
      return;
    }

    const partSeed = hashString(`${child.name || "mesh"}-${child.uuid}`).toString();
    const toneOffset = (hashString(partSeed) % 7) / 100;
    const shadeBase = 0.24 + toneOffset;
    const detailTone = new THREE.Color().setRGB(shadeBase, shadeBase + 0.015, shadeBase + 0.03);
    const accentMix = 0.05 + ((hashString(`${partSeed}-accent`) % 4) / 100);
    const materials = Array.isArray(child.material) ? child.material : [child.material];
    materials.forEach((material) => {
      if (material.color) {
        material.color.lerp(detailTone, 0.88);
        material.color.lerp(tint, accentMix);
      }
      if ("metalness" in material) {
        const metalnessOffset = (hashString(`${partSeed}-metal`) % 14) / 100;
        material.metalness = Math.min(Math.max((material.metalness ?? 0.24) * 0.72, 0.12), 0.22 + metalnessOffset);
      }
      if ("roughness" in material) {
        const roughnessOffset = (hashString(`${partSeed}-rough`) % 10) / 100;
        material.roughness = Math.min(Math.max((material.roughness ?? 0.76) * 0.92, 0.48), 0.82 + roughnessOffset);
      }
      if ("emissive" in material && material.emissive) {
        material.emissive.copy(tint).multiplyScalar(0.03 + accentMix);
        material.emissiveIntensity = 0.02;
      }
    });
  });
}

function addAccentLines(root, color, opacity = 0.72) {
  root.traverse((child) => {
    if (!child.isMesh || !child.geometry) {
      return;
    }

    const edgeLines = new THREE.LineSegments(
      new THREE.EdgesGeometry(child.geometry, 38),
      new THREE.LineBasicMaterial({
        color,
        transparent: true,
        opacity,
      }),
    );
    edgeLines.renderOrder = 2;
    edgeLines.userData = { accentLines: true };
    child.add(edgeLines);
  });
}

function captureHighlightMaterials(root) {
  const materials = [];
  root.traverse((child) => {
    if ((!child.isMesh && !child.isLineSegments) || !child.material) {
      return;
    }

    const materialList = Array.isArray(child.material) ? child.material : [child.material];
    materials.push({
      mesh: child,
      isLine: Boolean(child.isLineSegments),
      materials: materialList.map((material) => ({
        color: material.color ? material.color.clone() : null,
        emissive: "emissive" in material && material.emissive ? material.emissive.clone() : null,
        emissiveIntensity: material.emissiveIntensity || 0,
        opacity: material.opacity ?? 1,
      })),
    });
  });
  return materials;
}

function applyHighlightState(capturedMaterials, color, strength = 0) {
  const targetColor = new THREE.Color(color);
  capturedMaterials.forEach(({ mesh, materials, isLine }) => {
    const materialList = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    materialList.forEach((material, index) => {
      const original = materials[index];
      if (material.color && original?.color) {
        material.color.copy(original.color).lerp(targetColor, isLine ? Math.min(0.7, strength * 0.58) : Math.min(0.42, strength * 0.5));
      }
      if ("emissive" in material && material.emissive && original?.emissive) {
        material.emissive.copy(original.emissive).lerp(targetColor, Math.min(0.48, strength * 0.5));
        material.emissiveIntensity = original.emissiveIntensity + (strength * 0.18);
      }
      if ("opacity" in material && material.transparent && original) {
        material.opacity = isLine
          ? Math.max(original.opacity, 0.48 + (strength * 0.18))
          : Math.max(original.opacity, 0.9 + (strength * 0.04));
      }
      if (isLine) {
        material.transparent = true;
      }
    });
  });
}

function collectStatusMeshes(root) {
  const meshes = [];
  root.traverse((child) => {
    if (child.isMesh && child.material) {
      meshes.push(child);
    }
  });
  return meshes.sort((left, right) => {
    const leftPos = left.getWorldPosition(new THREE.Vector3());
    const rightPos = right.getWorldPosition(new THREE.Vector3());
    return leftPos.x - rightPos.x;
  });
}

function captureMeshMaterials(meshes) {
  return meshes.map((mesh) => {
    const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    return {
      mesh,
      materials: materials.map((material) => ({
        color: material.color ? material.color.clone() : null,
        emissive: "emissive" in material && material.emissive ? material.emissive.clone() : null,
        emissiveIntensity: material.emissiveIntensity || 0,
      })),
    };
  });
}

function applyStatusPalette(capturedMaterials, progressRatio, palette) {
  const clampedProgress = Math.max(0, Math.min(1, progressRatio));

  function getGradientColor(stops, amount) {
    if (!stops?.length) {
      return new THREE.Color(palette.active.color);
    }
    if (stops.length === 1) {
      return new THREE.Color(stops[0]);
    }

    const clampedAmount = Math.max(0, Math.min(1, amount));
    const scaled = clampedAmount * (stops.length - 1);
    const index = Math.min(stops.length - 2, Math.floor(scaled));
    const localRatio = scaled - index;
    return new THREE.Color(stops[index]).lerp(new THREE.Color(stops[index + 1]), localRatio);
  }

  const activeBandColor = getGradientColor(palette.gradientStops, clampedProgress);
  const activeBandEmissive = getGradientColor(palette.emissiveStops || palette.gradientStops, clampedProgress);
  const targetColor = new THREE.Color(palette.idle.color).lerp(activeBandColor, clampedProgress);
  const targetEmissive = new THREE.Color(palette.idle.emissive).lerp(activeBandEmissive, clampedProgress);
  const colorMix = palette.idle.mix + ((palette.active.mix - palette.idle.mix) * clampedProgress);
  const emissiveMix = palette.idle.emissiveMix + ((palette.active.emissiveMix - palette.idle.emissiveMix) * clampedProgress);
  const emissiveIntensity =
    palette.idle.emissiveIntensity +
    ((palette.active.emissiveIntensity - palette.idle.emissiveIntensity) * clampedProgress);

  capturedMaterials.forEach(({ mesh, materials }) => {
    const materialList = Array.isArray(mesh.material) ? mesh.material : [mesh.material];

    materialList.forEach((material, materialIndex) => {
      const original = materials[materialIndex];
      if (material.color && original?.color) {
        const visibleMix = 0.5 + (colorMix * 0.9);
        material.color.copy(original.color).lerp(targetColor, visibleMix);
      }
      if ("emissive" in material && material.emissive && original?.emissive) {
        const visibleEmissiveMix = 0.34 + (emissiveMix * 0.96);
        material.emissive.copy(original.emissive).lerp(targetEmissive, visibleEmissiveMix);
        material.emissiveIntensity = Math.max(original.emissiveIntensity, emissiveIntensity * 1.9);
      }
    });

    mesh.children.forEach((child) => {
      if (!child.isLineSegments || !child.material?.color) {
        return;
      }

      child.material.color.copy(targetColor);
      child.material.opacity = 0.42 + (clampedProgress * 0.78);
      child.material.transparent = true;
    });
  });
}

function findAncestorWithUserData(object, key) {
  let current = object;
  while (current) {
    if (current.userData && current.userData[key] !== undefined) {
      return current;
    }
    current = current.parent || null;
  }
  return null;
}

function centerAndScaleModel(root, { targetWidth = 24, targetHeight = 12, lift = 0 } = {}) {
  const bounds = new THREE.Box3().setFromObject(root);
  const size = new THREE.Vector3();
  const center = new THREE.Vector3();
  bounds.getSize(size);
  bounds.getCenter(center);

  const scaleX = targetWidth / Math.max(size.x, 1);
  const scaleY = targetHeight / Math.max(size.y, 1);
  const scaleZ = targetWidth / Math.max(size.z, 1);
  const scale = Math.min(scaleX, scaleY, scaleZ);

  root.scale.multiplyScalar(scale);

  const nextBounds = new THREE.Box3().setFromObject(root);
  const nextCenter = new THREE.Vector3();
  const nextSize = new THREE.Vector3();
  nextBounds.getCenter(nextCenter);
  nextBounds.getSize(nextSize);

  root.position.x -= nextCenter.x;
  root.position.z -= nextCenter.z;
  root.position.y -= nextBounds.min.y - lift;

  return root;
}

function loadModelTemplate(key) {
  if (assetTemplateCache.has(key)) {
    return assetTemplateCache.get(key);
  }

  const promise = new Promise((resolve, reject) => {
    assetLoader.load(
      MODEL_PATHS[key],
      (gltf) => resolve(gltf.scene),
      undefined,
      reject,
    );
  });

  assetTemplateCache.set(key, promise);
  return promise;
}

function buildRouteMetrics(points) {
  const validPoints = points.filter(Boolean);

  if (validPoints.length < 2) {
    return {
      totalKm: 0,
      cumulativeKm: validPoints.map(() => 0),
    };
  }

  let runningDistance = 0;
  const cumulativeKm = [0];

  for (let index = 1; index < validPoints.length; index += 1) {
    runningDistance += haversineKilometers(validPoints[index - 1], validPoints[index]);
    cumulativeKm.push(runningDistance);
  }

  return {
    totalKm: runningDistance,
    cumulativeKm,
  };
}

function buildProjection(points) {
  const validPoints = points.filter(Boolean);

  if (!validPoints.length) {
    return {
      project: () => new THREE.Vector3(0, 0, 0),
      extent: 1,
      routeMetrics: { totalKm: 0, cumulativeKm: [] },
    };
  }

  const origin = validPoints.reduce(
    (accumulator, point) => ({
      lat: accumulator.lat + point.lat,
      lng: accumulator.lng + point.lng,
    }),
    { lat: 0, lng: 0 },
  );

  origin.lat /= validPoints.length;
  origin.lng /= validPoints.length;

  const metersPerLng = 111320 * Math.cos((origin.lat * Math.PI) / 180);
  const rawPoints = validPoints.map((point) => ({
    x: (point.lng - origin.lng) * metersPerLng,
    z: (point.lat - origin.lat) * 110540,
  }));

  const bounds = rawPoints.reduce(
    (accumulator, point) => ({
      minX: Math.min(accumulator.minX, point.x),
      maxX: Math.max(accumulator.maxX, point.x),
      minZ: Math.min(accumulator.minZ, point.z),
      maxZ: Math.max(accumulator.maxZ, point.z),
    }),
    { minX: Infinity, maxX: -Infinity, minZ: Infinity, maxZ: -Infinity },
  );

  const width = Math.max(bounds.maxX - bounds.minX, 1);
  const depth = Math.max(bounds.maxZ - bounds.minZ, 1);
  const extent = Math.max(width, depth, 1);

  const targetSpan = 138;
  const targetDepth = 42;
  const scaleX = targetSpan / width;
  const scaleZ = targetDepth / depth;
  const routeMetrics = buildRouteMetrics(validPoints);

  return {
    extent: targetSpan,
    routeMetrics,
    project(point, y = 0) {
      const x = ((point.lng - origin.lng) * metersPerLng) * scaleX;
      const z = ((point.lat - origin.lat) * 110540) * scaleZ;
      return new THREE.Vector3(x, y, z);
    },
  };
}

function interpolateWorldPosition(startWorld, endWorld, ratio, y = 0) {
  const clampedRatio = Math.max(0, Math.min(1, ratio));
  return new THREE.Vector3(
    startWorld.x + ((endWorld.x - startWorld.x) * clampedRatio),
    y,
    startWorld.z + ((endWorld.z - startWorld.z) * clampedRatio),
  );
}

function createTruckFallbackMesh(accentColor) {
  const truck = new THREE.Group();

  const chassis = new THREE.Mesh(
    new THREE.BoxGeometry(7.2, 2.1, 3.4),
    new THREE.MeshStandardMaterial({
      color: 0x3a4048,
      metalness: 0.46,
      roughness: 0.48,
    }),
  );
  chassis.position.y = 2.2;
  truck.add(chassis);

  const cab = new THREE.Mesh(
    new THREE.BoxGeometry(2.6, 2.4, 3.2),
    new THREE.MeshStandardMaterial({
      color: 0x4b525c,
      metalness: 0.42,
      roughness: 0.44,
    }),
  );
  cab.position.set(2.1, 3.3, 0);
  truck.add(cab);

  const bed = new THREE.Mesh(
    new THREE.BoxGeometry(3.6, 0.7, 2.9),
    new THREE.MeshStandardMaterial({
      color: 0x232931,
      metalness: 0.28,
      roughness: 0.78,
    }),
  );
  bed.position.set(-1.4, 3.1, 0);
  truck.add(bed);

  const beacon = new THREE.Mesh(
    new THREE.CylinderGeometry(0.18, 0.18, 0.4, 18),
    new THREE.MeshStandardMaterial({
      color: accentColor,
      emissive: accentColor,
      emissiveIntensity: 0.16,
      metalness: 0.24,
      roughness: 0.72,
    }),
  );
  beacon.rotation.z = Math.PI / 2;
  beacon.position.set(0.8, 4.5, 0);
  truck.add(beacon);

  const wheelGeometry = new THREE.CylinderGeometry(0.82, 0.82, 0.7, 18);
  const wheelMaterial = new THREE.MeshStandardMaterial({
    color: 0x111317,
    metalness: 0.18,
    roughness: 0.92,
  });

  [
    [2.4, 1.15, 1.7],
    [2.4, 1.15, -1.7],
    [-1.5, 1.15, 1.7],
    [-1.5, 1.15, -1.7],
  ].forEach(([x, y, z]) => {
    const wheel = new THREE.Mesh(wheelGeometry, wheelMaterial);
    wheel.rotation.z = Math.PI / 2;
    wheel.position.set(x, y, z);
    truck.add(wheel);
  });

  return truck;
}

function createPadFallback(position, color, labelOffsetX) {
  const group = new THREE.Group();
  group.position.copy(position);

  const base = new THREE.Mesh(
    new THREE.BoxGeometry(30, 2.4, 22),
    new THREE.MeshStandardMaterial({
      color: 0x11161d,
      metalness: 0.38,
      roughness: 0.76,
    }),
  );
  base.position.y = 1.2;
  group.add(base);

  const inner = new THREE.Mesh(
    new THREE.BoxGeometry(20, 0.6, 13),
    new THREE.MeshStandardMaterial({
      color: 0x1b2530,
      emissive: color,
      emissiveIntensity: 0.12,
      metalness: 0.35,
      roughness: 0.55,
    }),
  );
  inner.position.y = 2.8;
  group.add(inner);

  const ring = new THREE.Mesh(
    new THREE.TorusGeometry(8.8, 0.38, 14, 48),
    new THREE.MeshStandardMaterial({
      color,
      emissive: color,
      emissiveIntensity: 1.1,
      metalness: 0.2,
      roughness: 0.35,
    }),
  );
  ring.rotation.x = Math.PI / 2;
  ring.position.y = 3.2;
  ring.userData = { pulse: true };
  group.add(ring);

  const marker = new THREE.Mesh(
    new THREE.CylinderGeometry(1.4, 1.4, 8, 24),
    new THREE.MeshStandardMaterial({
      color: 0xeef4fb,
      emissive: color,
      emissiveIntensity: 0.18,
      metalness: 0.5,
      roughness: 0.28,
    }),
  );
  marker.position.set(labelOffsetX, 6.5, 0);
  group.add(marker);

  return group;
}

function createRouteObjects(points) {
  if (points.length < 2) {
    return { objects: [] };
  }

  const routeSegments = new THREE.Group();
  const routeMaterial = new THREE.MeshStandardMaterial({
    color: 0x6f7782,
    emissive: 0x2f353d,
    emissiveIntensity: 0.16,
    metalness: 0.18,
    roughness: 0.56,
    transparent: true,
    opacity: 0.94,
  });

  for (let index = 0; index < points.length - 1; index += 1) {
    const start = points[index];
    const end = points[index + 1];
    const segmentVector = new THREE.Vector3().subVectors(end, start);
    const segmentLength = Math.max(segmentVector.length(), 0.001);
    const segment = new THREE.Mesh(
      new THREE.BoxGeometry(7.2, 0.95, segmentLength + 0.8),
      routeMaterial,
    );
    segment.position.copy(start).lerp(end, 0.5);
    segment.position.y = 0.72;
    segment.lookAt(end.x, segment.position.y, end.z);
    routeSegments.add(segment);
  }

  const routeLine = new THREE.Line(
    new THREE.BufferGeometry().setFromPoints(points),
    new THREE.LineBasicMaterial({
      color: 0xb0b7c0,
      transparent: true,
      opacity: 0.52,
    }),
  );
  routeLine.position.y = 1.16;

  return { objects: [routeSegments, routeLine] };
}

function createFloor(extent) {
  const group = new THREE.Group();
  const size = Math.max(340, extent * 0.32);

  const base = new THREE.Mesh(
    new THREE.PlaneGeometry(size, size),
    new THREE.MeshStandardMaterial({
      color: 0x21252a,
      metalness: 0.12,
      roughness: 0.96,
    }),
  );
  base.rotation.x = -Math.PI / 2;
  group.add(base);

  const innerPlate = new THREE.Mesh(
    new THREE.PlaneGeometry(size * 0.9, size * 0.9),
    new THREE.MeshStandardMaterial({
      color: 0x2b3036,
      metalness: 0.16,
      roughness: 0.88,
    }),
  );
  innerPlate.rotation.x = -Math.PI / 2;
  innerPlate.position.y = 0.04;
  group.add(innerPlate);

  const panelField = new THREE.Mesh(
    new THREE.PlaneGeometry(size * 0.86, size * 0.86, 14, 14),
    new THREE.MeshStandardMaterial({
      color: 0x30353c,
      metalness: 0.18,
      roughness: 0.84,
      wireframe: true,
      transparent: true,
      opacity: 0.1,
    }),
  );
  panelField.rotation.x = -Math.PI / 2;
  panelField.position.y = 0.06;
  group.add(panelField);

  const grid = new THREE.GridHelper(size, 12, 0x4b535c, 0x343a42);
  grid.position.y = 0.08;
  grid.material.transparent = true;
  grid.material.opacity = 0.24;
  group.add(grid);

  const diagonalGrid = new THREE.GridHelper(size * 0.82, 8, 0x3f464f, 0x2d3339);
  diagonalGrid.rotation.y = Math.PI / 4;
  diagonalGrid.position.y = 0.1;
  diagonalGrid.material.transparent = true;
  diagonalGrid.material.opacity = 0.12;
  group.add(diagonalGrid);

  return group;
}

export function SimulationScene3D({
  startPoint,
  endPoint,
  simulation,
  currentMinute = 0,
  heightClass = "map-frame",
  showOverlay = true,
  onReadyStateChange = null,
  onRigFocusChange = null,
}) {
  const hostRef = useRef(null);
  const overlayRef = useRef(null);
  const tooltipRef = useRef(null);
  const currentMinuteRef = useRef(currentMinute);
  const simulationRef = useRef(simulation);
  const assetsReadyRef = useRef(false);
  const truckHeadingRef = useRef(new Map());
  const rigVisualStateRef = useRef({
    source: null,
    destination: null,
  });
  const playbackStatsRef = useRef({
    totalTrips: 0,
    shiftedCount: 0,
    riggedCount: 0,
    movingCount: 0,
  });
  const focusedRigSideRef = useRef(null);
  const cameraTransitioningRef = useRef(false);
  const hoveredObjectRef = useRef(null);

  function setOverlayState(state) {
    const overlay = overlayRef.current;
    if (!overlay) {
      return;
    }

    overlay.dataset.state = state;
    const label = overlay.querySelector("[data-scene-status]");
    if (label) {
      label.textContent =
        state === "loading" ? "Loading rig and truck assets" : "Route playback with live truck motion";
    }
  }

  function setTooltipState(content = null, position = null) {
    const tooltip = tooltipRef.current;
    if (!tooltip) {
      return;
    }

    if (!content || !position) {
      tooltip.dataset.visible = "false";
      return;
    }

    tooltip.dataset.visible = "true";
    tooltip.style.left = `${position.x}px`;
    tooltip.style.top = `${position.y}px`;
    tooltip.querySelector("[data-tooltip-title]").textContent = content.title;
    tooltip.querySelector("[data-tooltip-line='state']").textContent = content.state;
    tooltip.querySelector("[data-tooltip-line='assigned']").textContent = content.assigned;
    tooltip.querySelector("[data-tooltip-line='progress']").textContent = content.progress;
    tooltip.querySelector("[data-tooltip-line='moving']").textContent = content.moving;
  }

  function buildComponentTooltip(componentInfo) {
    const { totalTrips, shiftedCount, riggedCount, movingCount } = playbackStatsRef.current;
    const totalComponents = Math.max(componentInfo.totalComponents || 1, 1);
    const startLoadIndex = Math.floor((componentInfo.index * totalTrips) / totalComponents);
    const endLoadIndex = Math.floor(((componentInfo.index + 1) * totalTrips) / totalComponents);
    const assignedLoads = Math.max(endLoadIndex - startLoadIndex, totalTrips > 0 ? 1 : 0);
    const completedCount = componentInfo.side === "source" ? shiftedCount : riggedCount;
    const completedWithin = Math.max(0, Math.min(assignedLoads, completedCount - startLoadIndex));
    const progress = assignedLoads > 0 ? Math.round((completedWithin / assignedLoads) * 100) : 0;
    const stateLabel =
      componentInfo.side === "source"
        ? progress >= 100
          ? "Shifted out"
          : progress > 0
            ? "Shifting"
            : "Waiting"
        : progress >= 100
          ? "Rigged up"
          : progress > 0
            ? "Rigging up"
            : "Pending";

    return {
      title: componentInfo.name,
      state: `State: ${stateLabel}`,
      assigned: `Assigned loads: ${completedWithin}/${assignedLoads || 0}`,
      progress: `Progress: ${progress}%`,
      moving: `Loads moving now: ${movingCount}`,
    };
  }

  function buildRigTooltip(rigInfo) {
    const { totalTrips, shiftedCount, riggedCount, movingCount } = playbackStatsRef.current;
    const completedCount = rigInfo.side === "source" ? shiftedCount : riggedCount;
    const progress = totalTrips > 0 ? Math.round((completedCount / totalTrips) * 100) : 0;
    const stateLabel =
      rigInfo.side === "source"
        ? progress >= 100
          ? "All loads shifted"
          : progress > 0
            ? "Shift in progress"
            : "Waiting"
        : progress >= 100
          ? "Rig up complete"
          : progress > 0
            ? "Rig up in progress"
            : "Pending";

    return {
      title: rigInfo.name,
      state: `State: ${stateLabel}`,
      assigned: `Completed loads: ${completedCount}/${totalTrips}`,
      progress: `Progress: ${progress}%`,
      moving: `Loads moving now: ${movingCount}`,
    };
  }

  function buildTruckTooltip(truckInfo) {
    const distanceKm = Number.isFinite(truckInfo.distanceKm) ? truckInfo.distanceKm : 0;
    const routeDistanceKm = Number.isFinite(truckInfo.routeDistanceKm) ? truckInfo.routeDistanceKm : 0;
    const progress = routeDistanceKm > 0 ? Math.round((distanceKm / routeDistanceKm) * 100) : 0;
    const loadLabel = truckInfo.loadId ? `Load: #${truckInfo.loadId}` : "Load: Waiting";

    return {
      title: `Truck ${truckInfo.truckId}`,
      state: `State: ${truckInfo.status || "Waiting"}`,
      assigned: loadLabel,
      progress: `Route progress: ${progress}%`,
      moving: `Distance: ${distanceKm.toFixed(1)} / ${routeDistanceKm.toFixed(1)} km`,
    };
  }

  useEffect(() => {
    if (!assetsReadyRef.current) {
      currentMinuteRef.current = 0;
      return;
    }

    currentMinuteRef.current = currentMinute;
  }, [currentMinute]);

  useEffect(() => {
    simulationRef.current = simulation;
  }, [simulation]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) {
      return undefined;
    }
    let disposed = false;
    onReadyStateChange?.(false);
    assetsReadyRef.current = false;
    currentMinuteRef.current = 0;
    truckHeadingRef.current = new Map();
    focusedRigSideRef.current = null;
    cameraTransitioningRef.current = false;
    hoveredObjectRef.current = null;
    rigVisualStateRef.current = {
      source: null,
      destination: null,
    };
    setOverlayState("loading");

    const routeGeometry = simulation?.routeGeometry || [];
    const routePoints = routeGeometry.map(([lat, lng]) => ({ lat, lng }));
    const straightRoutePoints =
      startPoint && endPoint
        ? [startPoint, endPoint]
        : routePoints.length >= 2
          ? [routePoints[0], routePoints[routePoints.length - 1]]
          : routePoints;
    const geoPoints = [
      ...(startPoint ? [startPoint] : []),
      ...straightRoutePoints,
      ...(endPoint ? [endPoint] : []),
    ];
    const projection = buildProjection(geoPoints);
    const measuredRouteMetrics = buildRouteMetrics(routePoints.length >= 2 ? routePoints : straightRoutePoints);
    const projectedRoute = straightRoutePoints.map((point) => projection.project(point, 1.2));
    const straightStartWorld = projectedRoute[0] || new THREE.Vector3(0, 1.2, 0);
    const straightEndWorld = projectedRoute[projectedRoute.length - 1] || new THREE.Vector3(0, 1.2, 0);

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x1e2126);
    scene.fog = new THREE.FogExp2(0x25292f, 0.0018);

    const camera = new THREE.PerspectiveCamera(44, 1, 0.1, 1200);
    const cameraDistance = Math.max(120, Math.min(220, projection.extent * 0.12));
    camera.position.set(cameraDistance, cameraDistance * 0.72, cameraDistance * 0.95);
    const defaultCameraPosition = camera.position.clone();
    const defaultTarget = new THREE.Vector3(0, 10, 0);
    const zoomState = {
      currentTarget: defaultTarget.clone(),
      desiredTarget: defaultTarget.clone(),
      currentPosition: camera.position.clone(),
      desiredPosition: camera.position.clone(),
    };
    const raycaster = new THREE.Raycaster();
    const pointer = new THREE.Vector2();

    const renderer = new THREE.WebGLRenderer({
      antialias: false,
      alpha: true,
      powerPreference: "high-performance",
    });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.25));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 0.98;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    host.innerHTML = "";
    host.appendChild(renderer.domElement);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.enablePan = true;
    controls.target.copy(defaultTarget);
    controls.minDistance = 16;
    controls.maxDistance = cameraDistance * 1.45;
    controls.maxPolarAngle = Math.PI * 0.44;
    controls.minPolarAngle = Math.PI * 0.24;

    scene.add(createFloor(projection.extent));

    const ambientLight = new THREE.AmbientLight(0xe2e5e9, 0.72);
    scene.add(ambientLight);

    const keyLight = new THREE.DirectionalLight(0xf2f3f5, 1.08);
    keyLight.position.set(78, 124, 44);
    keyLight.castShadow = true;
    keyLight.shadow.mapSize.width = 1024;
    keyLight.shadow.mapSize.height = 1024;
    keyLight.shadow.camera.near = 10;
    keyLight.shadow.camera.far = 320;
    keyLight.shadow.camera.left = -120;
    keyLight.shadow.camera.right = 120;
    keyLight.shadow.camera.top = 120;
    keyLight.shadow.camera.bottom = -120;
    keyLight.shadow.bias = -0.0008;
    keyLight.shadow.normalBias = 0.02;
    scene.add(keyLight);

    const rimLight = new THREE.DirectionalLight(0x9ba3af, 0.92);
    rimLight.position.set(-42, 28, -56);
    scene.add(rimLight);

    const lowFill = new THREE.PointLight(0x7e8792, 6, 220, 1.9);
    lowFill.position.set(0, 14, 8);
    scene.add(lowFill);

    const leftGlow = new THREE.PointLight(0x656d77, 8, 168, 1.7);
    leftGlow.position.set(-42, 16, 12);
    scene.add(leftGlow);

    const rightGlow = new THREE.PointLight(0x747d88, 7, 132, 1.8);
    rightGlow.position.set(46, 14, -10);
    scene.add(rightGlow);

    const backGlow = new THREE.PointLight(0x5d666f, 6, 180, 2);
    backGlow.position.set(0, 22, -48);
    scene.add(backGlow);

    const groundShadow = new THREE.Mesh(
      new THREE.CircleGeometry(78, 48),
        new THREE.MeshBasicMaterial({
          color: 0x161a1f,
          transparent: true,
          opacity: 0.22,
        }),
      );
    groundShadow.rotation.x = -Math.PI / 2;
    groundShadow.position.y = 0.12;
    scene.add(groundShadow);

    const routeGroup = new THREE.Group();
    const routeObjects = createRouteObjects(projectedRoute);
    routeObjects.objects.forEach((object) => routeGroup.add(object));
    scene.add(routeGroup);

    const truckAccent = 0x4d5560;
    const padAssetsGroup = new THREE.Group();
    scene.add(padAssetsGroup);

    const trucksGroup = new THREE.Group();
    scene.add(trucksGroup);

    const truckMeshes = new Map();
    const pulseTargets = [];
    const rigPickTargets = [];
    const truckPickTargets = [];
    const highlightTargets = new Map();

    function registerPulseTargets(root) {
      root.traverse((child) => {
        if (child.userData?.pulse) {
          pulseTargets.push(child);
        }
      });
    }

    function createTruckInstance(truckId) {
      const truckMesh = createTruckFallbackMesh(truckAccent);
      truckMesh.visible = false;
      truckMesh.userData = { truckId, status: "" };
      return truckMesh;
    }

    async function buildAssets() {
      let truckTemplate = null;
      let rigTemplate = null;

      try {
        [truckTemplate, rigTemplate] = await Promise.all([
          loadModelTemplate("truck"),
          loadModelTemplate("rig"),
        ]);
      } catch (error) {
        console.warn("3D assets failed to load, using fallback geometry instead.", error);
      }

      if (disposed) {
        return;
      }

      if (startPoint) {
        const startAsset = rigTemplate
          ? centerAndScaleModel(cloneModelWithUniqueMaterials(rigTemplate), { targetWidth: 49, targetHeight: 27, lift: 0 })
          : createPadFallback(projection.project(startPoint, 0), 0x1de9d5, -6);
        if (rigTemplate) {
          tintModel(startAsset, 0x6b7280);
          addAccentLines(startAsset, 0x9ca3af, 0.42);
          startAsset.rotation.y = Math.PI * 0.18;
          startAsset.position.copy(projection.project(startPoint, 1.6));
          const statusMeshes = collectStatusMeshes(startAsset);
          statusMeshes.forEach((mesh, index) => {
            mesh.userData.rigComponent = {
              side: "source",
              index,
              totalComponents: statusMeshes.length,
              name: mesh.name?.trim() || `Source Module ${index + 1}`,
            };
            mesh.userData.highlightKey = `rig-source-component-${index}`;
            highlightTargets.set(mesh.userData.highlightKey, {
              root: mesh,
              capturedMaterials: captureHighlightMaterials(mesh),
              color: 0xe5e7eb,
              kind: "rig-component",
              baseScale: mesh.scale.clone(),
            });
          });
          startAsset.userData.rigInfo = {
            side: "source",
            name: "Source Rig",
          };
          rigVisualStateRef.current.source = {
            meshes: statusMeshes,
            capturedMaterials: captureMeshMaterials(statusMeshes),
          };
        }
        startAsset.userData.highlightKey = "rig-source";
        startAsset.userData = { ...startAsset.userData, clickableRig: true };
        highlightTargets.set("rig-source", {
          root: startAsset,
          capturedMaterials: captureHighlightMaterials(startAsset),
          color: 0x9ca3af,
          kind: "rig",
          baseScale: startAsset.scale.clone(),
        });
        rigPickTargets.push(startAsset);
        padAssetsGroup.add(startAsset);
        registerPulseTargets(startAsset);
      }

      if (endPoint) {
        const endAsset = rigTemplate
          ? centerAndScaleModel(cloneModelWithUniqueMaterials(rigTemplate), { targetWidth: 63, targetHeight: 36, lift: 0 })
          : createPadFallback(projection.project(endPoint, 0), 0xc6ff00, 6);
        if (rigTemplate) {
          tintModel(endAsset, 0x6b7280);
          addAccentLines(endAsset, 0x9ca3af, 0.42);
          endAsset.rotation.y = -Math.PI * 0.12;
          endAsset.position.copy(projection.project(endPoint, 1.6));
          const statusMeshes = collectStatusMeshes(endAsset);
          statusMeshes.forEach((mesh, index) => {
            mesh.userData.rigComponent = {
              side: "destination",
              index,
              totalComponents: statusMeshes.length,
              name: mesh.name?.trim() || `Destination Module ${index + 1}`,
            };
            mesh.userData.highlightKey = `rig-destination-component-${index}`;
            highlightTargets.set(mesh.userData.highlightKey, {
              root: mesh,
              capturedMaterials: captureHighlightMaterials(mesh),
              color: 0xe5e7eb,
              kind: "rig-component",
              baseScale: mesh.scale.clone(),
            });
          });
          endAsset.userData.rigInfo = {
            side: "destination",
            name: "Destination Rig",
          };
          rigVisualStateRef.current.destination = {
            meshes: statusMeshes,
            capturedMaterials: captureMeshMaterials(statusMeshes),
          };
        }
        endAsset.userData.highlightKey = "rig-destination";
        endAsset.userData = { ...endAsset.userData, clickableRig: true };
        highlightTargets.set("rig-destination", {
          root: endAsset,
          capturedMaterials: captureHighlightMaterials(endAsset),
          color: 0x9ca3af,
          kind: "rig",
          baseScale: endAsset.scale.clone(),
        });
        rigPickTargets.push(endAsset);
        padAssetsGroup.add(endAsset);
        registerPulseTargets(endAsset);
      }

      for (let truckId = 1; truckId <= (simulation?.truckCount || 0); truckId += 1) {
        const truckMesh = truckTemplate
          ? cloneModelWithUniqueMaterials(truckTemplate)
          : createTruckInstance(truckId);
        if (truckTemplate) {
          tintModel(truckMesh, truckAccent);
          centerAndScaleModel(truckMesh, { targetWidth: 16.2, targetHeight: 9.2, lift: 0 });
        }
        truckMesh.visible = false;
        truckMesh.userData = { truckId, status: "", highlightKey: `truck-${truckId}` };
        trucksGroup.add(truckMesh);
        truckMeshes.set(truckId, truckMesh);
        truckPickTargets.push(truckMesh);
        highlightTargets.set(`truck-${truckId}`, {
          root: truckMesh,
          capturedMaterials: captureHighlightMaterials(truckMesh),
          color: 0xfbbf24,
          kind: "truck",
          baseScale: truckMesh.scale.clone(),
        });
      }

      assetsReadyRef.current = true;
      currentMinuteRef.current = simulationRef.current ? currentMinute : 0;
      setOverlayState("ready");
      onReadyStateChange?.(true);
    }

    buildAssets();

    const resizeObserver = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) {
        return;
      }

      const width = Math.max(Math.floor(entry.contentRect.width), 1);
      const height = Math.max(Math.floor(entry.contentRect.height), 1);
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
      renderer.setSize(width, height, false);
    });
    resizeObserver.observe(host);

    function focusOnRig(targetObject) {
      const bounds = new THREE.Box3().setFromObject(targetObject);
      const center = bounds.getCenter(new THREE.Vector3());
      const size = bounds.getSize(new THREE.Vector3());
      const focusDistance = Math.max(size.x, size.y, size.z, 18);
      const direction = new THREE.Vector3(0.95, 0.62, 0.88).normalize();

      zoomState.desiredTarget.copy(center);
      zoomState.desiredTarget.y = Math.max(center.y, 6);
      zoomState.desiredPosition.copy(center).add(direction.multiplyScalar(focusDistance * 1.8));
      focusedRigSideRef.current = targetObject.userData?.rigInfo?.side || null;
      onRigFocusChange?.(focusedRigSideRef.current);
      cameraTransitioningRef.current = true;
    }

    function resetFocus() {
      zoomState.desiredTarget.copy(defaultTarget);
      zoomState.desiredPosition.copy(defaultCameraPosition);
      focusedRigSideRef.current = null;
      onRigFocusChange?.(null);
      cameraTransitioningRef.current = true;
    }

    function handlePointerDown(event) {
      if (event.button !== 0) {
        return;
      }

      const rect = renderer.domElement.getBoundingClientRect();
      pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
      pointer.y = -(((event.clientY - rect.top) / rect.height) * 2 - 1);
      raycaster.setFromCamera(pointer, camera);
      const intersections = raycaster.intersectObjects(rigPickTargets, true);

      if (!intersections.length) {
        return;
      }

      const hit = intersections[0].object;
      const rigRoot = rigPickTargets.find((candidate) => candidate === hit || candidate.children.includes(hit) || candidate.getObjectById(hit.id));
      if (rigRoot) {
        focusOnRig(rigRoot);
      }
    }

    function handlePointerMove(event) {
      const rect = renderer.domElement.getBoundingClientRect();
      pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
      pointer.y = -(((event.clientY - rect.top) / rect.height) * 2 - 1);
      raycaster.setFromCamera(pointer, camera);
      const truckIntersections = raycaster.intersectObjects(truckPickTargets, true);
      const truckHit = truckIntersections.find((entry) => findAncestorWithUserData(entry.object, "truckId"));

      if (truckHit) {
        const truckRoot = findAncestorWithUserData(truckHit.object, "truckId");
        hoveredObjectRef.current = truckRoot?.userData?.highlightKey || null;
        renderer.domElement.style.cursor = "pointer";
        setTooltipState(buildTruckTooltip(truckRoot.userData), {
          x: event.clientX + 18,
          y: event.clientY + 18,
        });
        return;
      }

      const intersections = raycaster.intersectObjects(rigPickTargets, true);
      const hit = intersections.find((entry) => findAncestorWithUserData(entry.object, "rigComponent"));

      if (!hit) {
        hoveredObjectRef.current = null;
        renderer.domElement.style.cursor = "grab";
        setTooltipState();
        return;
      }

      renderer.domElement.style.cursor = "pointer";
      const componentObject = findAncestorWithUserData(hit.object, "rigComponent");
      const componentInfo = componentObject?.userData?.rigComponent;
      const rigRoot = rigPickTargets.find((candidate) => candidate.getObjectById(componentObject.id));
      const showComponentDetail = focusedRigSideRef.current && focusedRigSideRef.current === componentInfo.side;
      hoveredObjectRef.current = showComponentDetail
        ? componentObject.userData?.highlightKey || null
        : rigRoot?.userData?.highlightKey || null;
      const tooltipContent =
        showComponentDetail
          ? buildComponentTooltip(componentInfo)
          : buildRigTooltip(rigRoot?.userData?.rigInfo || { side: componentInfo.side, name: "Rig" });

      setTooltipState(tooltipContent, {
        x: event.clientX + 18,
        y: event.clientY + 18,
      });
    }

    function handlePointerLeave() {
      hoveredObjectRef.current = null;
      renderer.domElement.style.cursor = "grab";
      setTooltipState();
    }

    renderer.domElement.addEventListener("pointerdown", handlePointerDown);
    renderer.domElement.addEventListener("pointermove", handlePointerMove);
    renderer.domElement.addEventListener("pointerleave", handlePointerLeave);
    renderer.domElement.addEventListener("dblclick", resetFocus);
    renderer.domElement.style.cursor = "grab";

    let animationFrameId = 0;

    function updateTrucks(elapsedSeconds) {
      const nextSimulation = simulationRef.current;
      const playback = nextSimulation?.bestPlan?.playback;
      const minute = currentMinuteRef.current;
      const routeDistanceKm = Math.max(measuredRouteMetrics.totalKm, 0.001);
      const totalTrips = Math.max(playback?.trips?.length || 0, 1);

      if (!assetsReadyRef.current) {
        truckMeshes.forEach((mesh) => {
          mesh.visible = false;
        });
        return;
      }

      if (!playback?.trips?.length) {
        truckMeshes.forEach((mesh) => {
          mesh.visible = false;
        });
        return;
      }

      const sourceState = rigVisualStateRef.current.source;
      const shiftedCount = playback.trips.filter((trip) => minute >= trip.rigDownFinish).length;
      const riggedCount = playback.trips.filter((trip) => minute >= trip.rigUpFinish).length;
      const movingCount = playback.trips.filter(
        (trip) => minute >= trip.rigDownFinish && minute < trip.arrivalAtDestination,
      ).length;
      playbackStatsRef.current = {
        totalTrips,
        shiftedCount,
        riggedCount,
        movingCount,
      };

      if (sourceState?.capturedMaterials?.length) {
        applyStatusPalette(sourceState.capturedMaterials, shiftedCount / totalTrips, {
          active: {
            color: 0x22c55e,
            emissive: 0x34d399,
            mix: 0.94,
            emissiveMix: 0.62,
            emissiveIntensity: 0.38,
          },
          idle: {
            color: 0x272f39,
            emissive: 0x0b1015,
            mix: 0.18,
            emissiveMix: 0.06,
            emissiveIntensity: 0.06,
          },
          gradientStops: [0xef4444, 0xf59e0b, 0x22c55e],
          emissiveStops: [0xb91c1c, 0xea580c, 0x10b981],
        });
      }

      const destinationState = rigVisualStateRef.current.destination;
      if (destinationState?.capturedMaterials?.length) {
        applyStatusPalette(destinationState.capturedMaterials, riggedCount / totalTrips, {
          active: {
            color: 0x22c55e,
            emissive: 0x34d399,
            mix: 0.94,
            emissiveMix: 0.62,
            emissiveIntensity: 0.38,
          },
          idle: {
            color: 0x272f39,
            emissive: 0x0b1015,
            mix: 0.18,
            emissiveMix: 0.06,
            emissiveIntensity: 0.06,
          },
          gradientStops: [0xef4444, 0xf59e0b, 0x22c55e],
          emissiveStops: [0xb91c1c, 0xea580c, 0x10b981],
        });
      }

      truckMeshes.forEach((mesh, truckId) => {
        const truckTrips = playback?.trips?.filter((trip) => trip.truckId === truckId) || [];
        if (!truckTrips.length) {
          mesh.visible = false;
          return;
        }

        const activeTrip = truckTrips.find((trip) => {
          const tripEnd = trip.returnToSource ?? trip.arrivalAtDestination;
          return minute >= trip.loadStart && minute <= tripEnd;
        });
        const deliveredTrip = [...truckTrips].reverse().find((trip) => minute > trip.arrivalAtDestination);

        let currentWorld = straightStartWorld;
        let nextWorld = straightStartWorld;
        let distanceKm = 0;

        if (!activeTrip) {
          if (deliveredTrip && !deliveredTrip.returnToSource) {
            currentWorld = straightEndWorld;
            nextWorld = straightEndWorld;
            distanceKm = routeDistanceKm;
          }
        } else if (minute < activeTrip.rigDownFinish) {
          currentWorld = straightStartWorld;
          nextWorld = straightStartWorld;
          distanceKm = 0;
        } else if (minute < activeTrip.arrivalAtDestination) {
          const tripDuration = Math.max(activeTrip.arrivalAtDestination - activeTrip.rigDownFinish, 1);
          const outboundRatio = (minute - activeTrip.rigDownFinish) / tripDuration;
          const forwardMinute = Math.min(minute + 0.6, activeTrip.arrivalAtDestination);
          const nextOutboundRatio = (forwardMinute - activeTrip.rigDownFinish) / tripDuration;

          currentWorld = interpolateWorldPosition(straightStartWorld, straightEndWorld, outboundRatio, 3.3);
          nextWorld = interpolateWorldPosition(straightStartWorld, straightEndWorld, nextOutboundRatio, 3.3);
          distanceKm = routeDistanceKm * Math.max(0, Math.min(1, outboundRatio));
        } else if (minute < activeTrip.rigUpFinish) {
          currentWorld = straightEndWorld;
          nextWorld = straightEndWorld;
          distanceKm = routeDistanceKm;
        } else if (activeTrip.returnToSource && minute < activeTrip.returnToSource) {
          const tripDuration = Math.max(activeTrip.returnToSource - activeTrip.rigUpFinish, 1);
          const inboundRatio = (minute - activeTrip.rigUpFinish) / tripDuration;
          const forwardMinute = Math.min(minute + 0.6, activeTrip.returnToSource);
          const nextInboundRatio = (forwardMinute - activeTrip.rigUpFinish) / tripDuration;

          currentWorld = interpolateWorldPosition(straightEndWorld, straightStartWorld, inboundRatio, 3.3);
          nextWorld = interpolateWorldPosition(straightEndWorld, straightStartWorld, nextInboundRatio, 3.3);
          distanceKm = routeDistanceKm * Math.max(0, 1 - Math.min(1, inboundRatio));
        } else {
          currentWorld = straightEndWorld;
          nextWorld = straightEndWorld;
          distanceKm = routeDistanceKm;
        }

        const deltaX = nextWorld.x - currentWorld.x;
        const deltaZ = nextWorld.z - currentWorld.z;
        const movementMagnitude = Math.hypot(deltaX, deltaZ);
        const lastHeading = truckHeadingRef.current.get(truckId) ?? 0;
        const heading =
          movementMagnitude > 0.02
            ? Math.atan2(deltaX, deltaZ)
            : lastHeading;
        const bob = Math.sin(elapsedSeconds * 2.4 + truckId * 0.6) * 0.08;

        mesh.visible = true;
        mesh.position.copy(currentWorld);
        mesh.position.y += bob;
        mesh.rotation.y = heading;
        truckHeadingRef.current.set(truckId, heading);
        mesh.userData.status = getTruckStatus(playback, minute, truckId);
        mesh.userData.loadId = activeTrip?.loadId ?? deliveredTrip?.loadId ?? null;
        mesh.userData.distanceKm = distanceKm;
        mesh.userData.routeDistanceKm = measuredRouteMetrics.totalKm;
      });
    }

    function animate(now) {
      const elapsedSeconds = now / 1000;
      animationFrameId = window.requestAnimationFrame(animate);

      pulseTargets.forEach((target, index) => {
        const pulseAmount = target.userData?.pulseAmount ?? 0.018;
        const phaseOffset = target.userData?.phaseOffset ?? index * 0.7;
        const pulse = 1 + Math.sin(elapsedSeconds * 1.2 + phaseOffset) * pulseAmount;
        target.scale.setScalar(pulse);
      });

      lowFill.intensity = 10 + (Math.sin(elapsedSeconds * 0.9) * 1.2);
      leftGlow.intensity = 17 + (Math.sin(elapsedSeconds * 0.75) * 1.8);
      rightGlow.intensity = 11 + (Math.cos(elapsedSeconds * 0.68) * 1.2);
      backGlow.intensity = 9 + (Math.sin(elapsedSeconds * 0.52 + 0.8) * 0.9);

      if (cameraTransitioningRef.current) {
        zoomState.currentTarget.lerp(zoomState.desiredTarget, 0.08);
        zoomState.currentPosition.lerp(zoomState.desiredPosition, 0.08);
        controls.target.copy(zoomState.currentTarget);
        camera.position.copy(zoomState.currentPosition);

        const targetDelta = zoomState.currentTarget.distanceTo(zoomState.desiredTarget);
        const positionDelta = zoomState.currentPosition.distanceTo(zoomState.desiredPosition);
        if (targetDelta < 0.12 && positionDelta < 0.18) {
          zoomState.currentTarget.copy(zoomState.desiredTarget);
          zoomState.currentPosition.copy(zoomState.desiredPosition);
          controls.target.copy(zoomState.desiredTarget);
          camera.position.copy(zoomState.desiredPosition);
          cameraTransitioningRef.current = false;
        }
      } else {
        zoomState.currentTarget.copy(controls.target);
        zoomState.desiredTarget.copy(controls.target);
        zoomState.currentPosition.copy(camera.position);
        zoomState.desiredPosition.copy(camera.position);
      }

      updateTrucks(elapsedSeconds);
      highlightTargets.forEach((target, key) => {
        const isActive = hoveredObjectRef.current === key;
        const highlightStrength = isActive ? 0.44 + ((Math.sin(elapsedSeconds * 5.8) + 1) * 0.14) : 0;
        applyHighlightState(target.capturedMaterials, target.color, highlightStrength);
        if (target.kind === "rig-component") {
          const scaleMultiplier = isActive ? 1 + (Math.sin(elapsedSeconds * 5.8) * 0.008) : 1;
          target.root.scale.copy(target.baseScale).multiplyScalar(scaleMultiplier);
        } else {
          target.root.scale.copy(target.baseScale);
        }
      });
      controls.update();
      renderer.render(scene, camera);
    }

    animationFrameId = window.requestAnimationFrame(animate);

    return () => {
      disposed = true;
      onReadyStateChange?.(false);
      onRigFocusChange?.(null);
      assetsReadyRef.current = false;
      window.cancelAnimationFrame(animationFrameId);
      resizeObserver.disconnect();
      renderer.domElement.removeEventListener("pointerdown", handlePointerDown);
      renderer.domElement.removeEventListener("pointermove", handlePointerMove);
      renderer.domElement.removeEventListener("pointerleave", handlePointerLeave);
      renderer.domElement.removeEventListener("dblclick", resetFocus);
      controls.dispose();
      renderer.dispose();
      scene.traverse((object) => {
        if (object.geometry) {
          object.geometry.dispose();
        }

        if (Array.isArray(object.material)) {
          object.material.forEach((material) => material.dispose());
        } else if (object.material) {
          object.material.dispose();
        }
      });
      host.innerHTML = "";
    };
  }, [startPoint, endPoint, simulation]);

  return h(
    "div",
    { className: `${heightClass} scene-3d-shell` },
    h("div", { ref: hostRef, className: "scene-3d-canvas" }),
    h(
      "div",
      { ref: tooltipRef, className: "scene-3d-tooltip", "data-visible": "false" },
      h("strong", { className: "scene-3d-tooltip-title", "data-tooltip-title": true }, ""),
      h("span", { className: "scene-3d-tooltip-line", "data-tooltip-line": "state" }, ""),
      h("span", { className: "scene-3d-tooltip-line", "data-tooltip-line": "assigned" }, ""),
      h("span", { className: "scene-3d-tooltip-line", "data-tooltip-line": "progress" }, ""),
      h("span", { className: "scene-3d-tooltip-line", "data-tooltip-line": "moving" }, ""),
    ),
    showOverlay
      ? h(
          "div",
          { ref: overlayRef, className: "scene-3d-overlay", "data-state": "loading" },
          h("span", { className: "scene-3d-badge" }, "3D Simulation"),
          h("span", { className: "scene-3d-copy", "data-scene-status": true }, "Loading rig and truck assets"),
        )
      : null,
  );
}

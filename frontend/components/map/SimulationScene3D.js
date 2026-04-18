import { React, h } from "../../lib/react.js";
import * as THREE from "https://esm.sh/three@0.179.1";
import { OrbitControls } from "https://esm.sh/three@0.179.1/examples/jsm/controls/OrbitControls.js";
import { GLTFLoader } from "https://esm.sh/three@0.179.1/examples/jsm/loaders/GLTFLoader.js";
import { getTruckDelayState, getTruckRoadHoldState, getTruckStatus, haversineKilometers } from "../../features/rigMoves/simulation.js";

const { useEffect, useRef } = React;
const assetLoader = new GLTFLoader();
const assetTemplateCache = new Map();
let platformEdgeFadeTexture = null;

const MODEL_PATHS = {
  flatbedTruck: "/assets/models/FlatBed.glb",
  lowbedTruck: "/assets/models/LowBed.glb",
  heavyHaulerTruck: "/assets/models/HeavyHauler.glb",
  rig: "/assets/models/fRig.glb",
  terrain: "/assets/models/mountain.glb",
  lamp: "/assets/models/lamp.glb",
  siteLamp: "/assets/models/siteLamp.glb",
};

export function preloadSimulationSceneAssets() {
  return Promise.all([
    loadModelTemplate("flatbedTruck"),
    loadModelTemplate("lowbedTruck"),
    loadModelTemplate("heavyHaulerTruck"),
    loadModelTemplate("rig"),
    loadModelTemplate("terrain"),
    loadModelTemplate("lamp"),
    loadModelTemplate("siteLamp"),
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

function getPlatformEdgeFadeTexture() {
  if (platformEdgeFadeTexture) {
    return platformEdgeFadeTexture;
  }

  const size = 256;
  const inset = size * 0.18;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const context = canvas.getContext("2d");

  if (!context) {
    return null;
  }

  context.clearRect(0, 0, size, size);
  const gradient = context.createRadialGradient(
    size / 2,
    size / 2,
    size * 0.16,
    size / 2,
    size / 2,
    size * 0.62,
  );
  gradient.addColorStop(0, "rgba(255,255,255,0)");
  gradient.addColorStop(0.62, "rgba(255,255,255,0.06)");
  gradient.addColorStop(0.82, "rgba(255,255,255,0.55)");
  gradient.addColorStop(1, "rgba(255,255,255,1)");
  context.fillStyle = gradient;
  context.fillRect(0, 0, size, size);

  context.globalCompositeOperation = "destination-out";
  context.fillStyle = "rgba(0,0,0,1)";
  context.fillRect(inset, inset, size - (inset * 2), size - (inset * 2));

  platformEdgeFadeTexture = new THREE.CanvasTexture(canvas);
  platformEdgeFadeTexture.needsUpdate = true;
  return platformEdgeFadeTexture;
}

function normalizeTruckType(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, "");
}

function getTruckModelKey(type) {
  const normalized = normalizeTruckType(type);
  if (normalized.includes("flatbed")) {
    return "flatbedTruck";
  }
  if (normalized.includes("lowbed")) {
    return "lowbedTruck";
  }
  if (normalized.includes("heavyhauler") || normalized.includes("heavyhaul")) {
    return "heavyHaulerTruck";
  }
  return "lowbedTruck";
}

function buildTruckTypeAssignments(truckSetup, truckCount) {
  const expanded = (truckSetup || [])
    .flatMap((item) => {
      const count = Math.max(0, Number.parseInt(item?.count, 10) || 0);
      return Array.from({ length: count }, () => item?.type || "LowBed");
    })
    .slice(0, truckCount);

  while (expanded.length < truckCount) {
    expanded.push("LowBed");
  }

  return expanded;
}

function getConfiguredTruckCount(simulation, playback) {
  const configuredCount = (simulation?.truckSetup || []).reduce(
    (sum, item) => sum + Math.max(0, Number.parseInt(item?.count, 10) || 0),
    0,
  );
  if (configuredCount > 0) {
    return configuredCount;
  }

  const scenarioTruckCount = Number.parseInt(simulation?.truckCount, 10) || 0;
  if (scenarioTruckCount > 0) {
    return scenarioTruckCount;
  }

  const playbackCount = Math.max(
    0,
    ...(playback?.trips?.map((trip) => Number.parseInt(trip?.truckId, 10) || 0) || []),
  );
  return playbackCount;
}

function setTruckVariantVisible(truckRoot, truckType) {
  const variantKey = getTruckModelKey(truckType);
  const variants = truckRoot.userData?.truckVariants || {};
  let didShowVariant = false;

  Object.entries(variants).forEach(([key, variant]) => {
    if (!variant) {
      return;
    }
    const isVisible = key === variantKey;
    variant.visible = isVisible;
    didShowVariant ||= isVisible;
  });

  if (!didShowVariant && variants.fallback) {
    variants.fallback.visible = true;
  }

  truckRoot.userData.truckType = truckType;
  truckRoot.userData.activeTruckVariantKey = didShowVariant ? variantKey : "fallback";
}

function getTruckVariantDimensions(variantKey) {
  if (variantKey === "heavyHaulerTruck") {
    return { targetWidth: 17.2, targetHeight: 8.3 };
  }
  if (variantKey === "lowbedTruck") {
    return { targetWidth: 15.9, targetHeight: 8.1 };
  }
  return { targetWidth: 12.2, targetHeight: 7.2 };
}

function getTruckVariantWidthStretch(variantKey) {
  if (variantKey === "heavyHaulerTruck") {
    return 1.28;
  }
  if (variantKey === "lowbedTruck") {
    return 1.3;
  }
  return 1;
}

function getTruckVariantRoadOffset(truckType) {
  const variantKey = getTruckModelKey(truckType);
  if (variantKey === "heavyHaulerTruck") {
    return 5;
  }
  if (variantKey === "lowbedTruck") {
    return 5;
  }
  return 4;
}

function formatSceneMinuteLabel(minutes, fallback = "--") {
  if (!Number.isFinite(Number(minutes))) {
    return fallback;
  }

  const totalSeconds = Math.max(0, Math.round(Number(minutes) * 60));
  const wholeMinutes = Math.floor(totalSeconds / 60);
  const remainingSeconds = totalSeconds % 60;
  return `${wholeMinutes} min ${remainingSeconds} sec`;
}

function formatSceneDelayLabel(minutes, fallback = "On time") {
  if (!Number.isFinite(Number(minutes))) {
    return fallback;
  }

  const safeMinutes = Math.max(0, Number(minutes));
  if (safeMinutes <= 0) {
    return fallback;
  }

  const totalSeconds = Math.round(safeMinutes * 60);
  if (safeMinutes < 1) {
    return `${totalSeconds} sec`;
  }

  const wholeMinutes = Math.floor(totalSeconds / 60);
  const remainingSeconds = totalSeconds % 60;
  return remainingSeconds > 0 ? `${wholeMinutes} min ${remainingSeconds} sec` : `${wholeMinutes} min`;
}

function tintModel(root, color) {
  const tint = new THREE.Color(color);
  root.traverse((child) => {
    if (!child.isMesh || !child.material) {
      return;
    }

    const partSeed = hashString(`${child.name || "mesh"}-${child.uuid}`).toString();
    const toneOffset = (hashString(partSeed) % 11) / 100;
    const shadowTone = tint.clone().lerp(new THREE.Color(0x050608), 0.3 + toneOffset);
    const midShadowTone = tint.clone().lerp(new THREE.Color(0x1f252c), 0.18 + toneOffset);
    const steelTone = tint.clone().lerp(new THREE.Color(0x66707a), 0.1 + ((hashString(`${partSeed}-steel`) % 5) / 100));
    const coolLiftTone = tint.clone().lerp(new THREE.Color(0x7e8994), 0.14 + ((hashString(`${partSeed}-cool`) % 6) / 100));
    const warmDustTone = tint.clone().lerp(new THREE.Color(0x6b6359), 0.08 + ((hashString(`${partSeed}-dust`) % 4) / 100));
    const shadowMix = 0.16 + ((hashString(`${partSeed}-shadow`) % 8) / 100);
    const midShadowMix = 0.1 + ((hashString(`${partSeed}-mid`) % 6) / 100);
    const steelMix = 0.07 + ((hashString(`${partSeed}-accent`) % 5) / 100);
    const coolLiftMix = 0.05 + ((hashString(`${partSeed}-highlight`) % 4) / 100);
    const warmDustMix = 0.03 + ((hashString(`${partSeed}-dustmix`) % 3) / 100);
    const materials = Array.isArray(child.material) ? child.material : [child.material];
    materials.forEach((material) => {
      if (material.color) {
        material.color.copy(tint);
        material.color.lerp(shadowTone, shadowMix);
        material.color.lerp(midShadowTone, midShadowMix);
        material.color.lerp(steelTone, steelMix);
        material.color.lerp(coolLiftTone, coolLiftMix);
        material.color.lerp(warmDustTone, warmDustMix);
      }
      if ("metalness" in material) {
        const metalnessOffset = (hashString(`${partSeed}-metal`) % 14) / 100;
        material.metalness = Math.min(Math.max((material.metalness ?? 0.24) * 0.82, 0.14), 0.26 + metalnessOffset);
      }
      if ("roughness" in material) {
        const roughnessOffset = (hashString(`${partSeed}-rough`) % 10) / 100;
        material.roughness = Math.min(Math.max((material.roughness ?? 0.76) * 0.9, 0.42), 0.78 + roughnessOffset);
      }
      if ("emissive" in material && material.emissive) {
        material.emissive.copy(shadowTone).lerp(steelTone, 0.35).multiplyScalar(0.026);
        material.emissiveIntensity = 0.026;
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

function addTruckDelayOverlayMeshes(root) {
  const overlays = [];
  const sourceMeshes = [];
  root.traverse((child) => {
    if (child.isMesh && child.geometry && !child.userData?.isDelayOverlay) {
      sourceMeshes.push(child);
    }
  });

  sourceMeshes.forEach((child) => {
    const overlayMesh = new THREE.Mesh(
      child.geometry,
      new THREE.MeshBasicMaterial({
        color: 0xff2a2a,
        transparent: true,
        opacity: 0.52,
        depthWrite: false,
        polygonOffset: true,
        polygonOffsetFactor: -2,
        polygonOffsetUnits: -2,
        side: THREE.DoubleSide,
      }),
    );
    overlayMesh.userData.isDelayOverlay = true;
    overlayMesh.visible = false;
    overlayMesh.renderOrder = 8;
    overlayMesh.position.set(0, 0, 0);
    overlayMesh.rotation.set(0, 0, 0);
    overlayMesh.scale.setScalar(1.003);
    child.add(overlayMesh);
    overlays.push(overlayMesh);
  });
  root.userData.delayOverlays = overlays;
}

function applyTerrainVertexColors(mesh, baseColor, topShadow, topHighlight) {
  if (!mesh.geometry?.attributes?.position) {
    mesh.material = new THREE.MeshBasicMaterial({ color: baseColor });
    return;
  }

  const geometry = mesh.geometry.clone();
  const position = geometry.attributes.position;
  geometry.computeVertexNormals();
  const normals = geometry.attributes.normal;
  const colorValues = new Float32Array(position.count * 3);
  geometry.computeBoundingBox();
  const minY = geometry.boundingBox?.min.y ?? 0;
  const maxY = geometry.boundingBox?.max.y ?? 1;
  const height = Math.max(maxY - minY, 0.001);

  for (let index = 0; index < position.count; index += 1) {
    const y = position.getY(index);
    const heightRatio = Math.max(0, Math.min(1, (y - minY) / height));
    const normalY = normals ? normals.getY(index) : 1;
    const slopeStrength = 1 - Math.max(0, Math.min(1, normalY));
    const topBlend = Math.max(0, (heightRatio - 0.1) / 0.9);
    const layeredColor = baseColor.clone();

    layeredColor.lerp(topShadow, topBlend * (0.84 + (slopeStrength * 0.62)));
    layeredColor.lerp(topHighlight, topBlend * 0.28 * Math.max(0.15, 1 - (slopeStrength * 0.9)));

    colorValues[(index * 3)] = layeredColor.r;
    colorValues[(index * 3) + 1] = layeredColor.g;
    colorValues[(index * 3) + 2] = layeredColor.b;
  }

  geometry.setAttribute("color", new THREE.BufferAttribute(colorValues, 3));
  mesh.geometry = geometry;
  mesh.material = new THREE.MeshBasicMaterial({ vertexColors: true });
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

function applyHighlightState(capturedMaterials, color, strength = 0, options = {}) {
  const targetColor = new THREE.Color(color);
  const hoverBaseColor = new THREE.Color(options.hoverBaseColor ?? 0x6a6553);
  const maxLineMix = options.maxLineMix ?? 0.7;
  const maxSurfaceMix = options.maxSurfaceMix ?? 0.42;
  const lineMixScale = options.lineMixScale ?? 0.58;
  const surfaceMixScale = options.surfaceMixScale ?? 0.5;
  const emissiveMixScale = options.emissiveMixScale ?? 0.5;
  const baseMixScale = options.baseMixScale ?? 0.28;
  capturedMaterials.forEach(({ mesh, materials, isLine }) => {
    const materialList = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    materialList.forEach((material, index) => {
      const original = materials[index];
      if (material.color && original?.color) {
        material.color.copy(original.color);
        if (!isLine) {
          material.color.lerp(hoverBaseColor, Math.min(0.24, strength * baseMixScale));
        }
        material.color.lerp(
          targetColor,
          isLine
            ? Math.min(maxLineMix, strength * lineMixScale)
            : Math.min(maxSurfaceMix, strength * surfaceMixScale),
        );
      }
      if ("emissive" in material && material.emissive && original?.emissive) {
        material.emissive.copy(original.emissive).lerp(targetColor, Math.min(0.48, strength * emissiveMixScale));
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

function applyRigComponentHoverState(capturedMaterials, color, strength = 0) {
  applyHighlightState(capturedMaterials, color, strength, {
    maxLineMix: 0.7,
    maxSurfaceMix: 0.42,
    lineMixScale: 0.58,
    surfaceMixScale: 0.5,
    emissiveMixScale: 0.42,
    baseMixScale: 0.28,
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

function getTruckFollowOffset(heading, distance, lift) {
  return new THREE.Vector3(
    -Math.sin(heading) * distance,
    lift,
    -Math.cos(heading) * distance,
  );
}

function getTruckFocusTargetWorld(truckRoot) {
  const variantKey = truckRoot?.userData?.activeTruckVariantKey || "fallback";
  const variantRoot = truckRoot?.userData?.truckVariants?.[variantKey] || truckRoot;
  const bounds = new THREE.Box3().setFromObject(variantRoot);
  return bounds.getCenter(new THREE.Vector3());
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

function buildStylizedRoutePoints(points, routeMetrics) {
  if (!points?.length) {
    return [];
  }

  if (points.length < 3) {
    return points.map((point) => point.clone());
  }

  const start = points[0].clone();
  const end = points[points.length - 1].clone();
  const axis = new THREE.Vector3().subVectors(end, start);
  const totalLength = Math.max(axis.length(), 0.001);
  axis.normalize();
  const side = new THREE.Vector3(-axis.z, 0, axis.x).normalize();

  return points.map((_, index) => {
    const routeProgress = index / Math.max(points.length - 1, 1);
    const idealPoint = start.clone().lerp(end, routeProgress);
    const centerArc = Math.sin(routeProgress * Math.PI) * 18;
    return idealPoint.add(side.clone().multiplyScalar(centerArc));
  });
}

function buildWorldPathMetrics(points) {
  if (!points?.length) {
    return {
      points: [],
      segmentLengths: [],
      totalLength: 0,
    };
  }

  const segmentLengths = [];
  let totalLength = 0;

  for (let index = 1; index < points.length; index += 1) {
    const segmentLength = points[index].distanceTo(points[index - 1]);
    segmentLengths.push(segmentLength);
    totalLength += segmentLength;
  }

  return {
    points,
    segmentLengths,
    totalLength,
  };
}

function interpolateWorldPath(pathMetrics, ratio, y = 0) {
  const points = pathMetrics?.points || [];

  if (!points.length) {
    return new THREE.Vector3(0, y, 0);
  }

  if (points.length === 1) {
    return points[0].clone().setY(y);
  }

  const clampedRatio = Math.max(0, Math.min(1, ratio));
  const segmentLengths = pathMetrics.segmentLengths || [];
  const totalLength = pathMetrics.totalLength || 0;

  if (totalLength <= 0.0001) {
    return points[0].clone().setY(y);
  }

  const targetLength = totalLength * clampedRatio;
  let traversed = 0;

  for (let index = 0; index < segmentLengths.length; index += 1) {
    const segmentLength = segmentLengths[index];
    if (traversed + segmentLength >= targetLength) {
      const localRatio = (targetLength - traversed) / Math.max(segmentLength, 0.0001);
      return points[index].clone().lerp(points[index + 1], localRatio).setY(y);
    }
    traversed += segmentLength;
  }

  return points[points.length - 1].clone().setY(y);
}

function getRoadLampEndClearance(totalLength = 0) {
  return Math.min(Math.max(24, totalLength * 0.17), totalLength * 0.28);
}

function interpolateWorldPathWithEndpointOffset(pathMetrics, ratio, endpointOffset = 0, y = 0) {
  const totalLength = pathMetrics?.totalLength || 0;
  if (totalLength <= 0.0001) {
    return interpolateWorldPath(pathMetrics, ratio, y);
  }

  // Keep a small lead-in for the truck body, but let 100% reach the real end of the lane.
  const startOffset = Math.max(0, endpointOffset);
  const endOffset = 0;
  const usableLength = Math.max(totalLength - startOffset - endOffset, 0.0001);
  const adjustedRatio = (startOffset + (usableLength * Math.max(0, Math.min(1, ratio)))) / totalLength;
  return interpolateWorldPath(pathMetrics, adjustedRatio, y);
}

function remapRouteToFixedAnchors(points, startAnchor, endAnchor) {
  if (!points?.length) {
    return [];
  }

  if (points.length === 1) {
    return [startAnchor.clone()];
  }

  const sourceStart = points[0].clone();
  const sourceEnd = points[points.length - 1].clone();
  const sourceAxis = new THREE.Vector3().subVectors(sourceEnd, sourceStart);
  const targetAxis = new THREE.Vector3().subVectors(endAnchor, startAnchor);
  const sourceLength = Math.max(sourceAxis.length(), 0.001);
  const targetLength = Math.max(targetAxis.length(), 0.001);
  sourceAxis.normalize();
  targetAxis.normalize();
  const sourceSide = new THREE.Vector3(-sourceAxis.z, 0, sourceAxis.x).normalize();
  const targetSide = new THREE.Vector3(-targetAxis.z, 0, targetAxis.x).normalize();

  const cumulative = [0];
  let totalLength = 0;
  for (let index = 1; index < points.length; index += 1) {
    totalLength += points[index].distanceTo(points[index - 1]);
    cumulative.push(totalLength);
  }
  totalLength = Math.max(totalLength, 0.001);

  return points.map((point, index) => {
    const progress = cumulative[index] / totalLength;
    const sourceBase = sourceStart.clone().lerp(sourceEnd, progress);
    const sourceOffset = new THREE.Vector3().subVectors(point, sourceBase);
    const lateralOffset = sourceSide.dot(sourceOffset) * 0.28;
    const verticalOffset = point.y - sourceBase.y;
    const targetBase = startAnchor.clone().lerp(endAnchor, progress);
    return targetBase
      .add(targetSide.clone().multiplyScalar(lateralOffset))
      .setY(targetBase.y + verticalOffset);
  });
}

function clamp01(value) {
  return Math.max(0, Math.min(1, value));
}

function smoothstep(edge0, edge1, value) {
  const t = clamp01((value - edge0) / Math.max(edge1 - edge0, 0.0001));
  return t * t * (3 - (2 * t));
}

function getCenterIslandProfile(ratio) {
  const t = clamp01(ratio);
  const gateIn = smoothstep(0.1, 0.28, t);
  const gateOut = 1 - smoothstep(0.72, 0.9, t);
  const centerWeight = Math.sin(t * Math.PI) ** 1.35;
  return gateIn * gateOut * centerWeight;
}

function buildSplitRoadPath(points, sideAxis, sideSign, baseOffset = 12.5, centerBulge = 14.5) {
  if (!points?.length) {
    return [];
  }

  const metrics = buildWorldPathMetrics(points);
  const totalLength = Math.max(metrics.totalLength, 0.001);
  let traversed = 0;

  return points.map((point, index) => {
    if (index > 0) {
      traversed += metrics.segmentLengths[index - 1] || 0;
    }
    const ratio = traversed / totalLength;
    const separation = baseOffset + (getCenterIslandProfile(ratio) * centerBulge);
    return point.clone().add(sideAxis.clone().multiplyScalar(sideSign * separation));
  });
}

function offsetCurvePointsLocally(points, offsetDistance) {
  if (!points?.length) {
    return [];
  }

  const metrics = buildWorldPathMetrics(points);
  const totalLength = Math.max(metrics.totalLength, 0.001);
  let traversed = 0;

  return points.map((point, index) => {
    if (index > 0) {
      traversed += metrics.segmentLengths[index - 1] || 0;
    }
    const ratio = traversed / totalLength;
    const taperIn = smoothstep(0.12, 0.26, ratio);
    const taperOut = 1 - smoothstep(0.74, 0.88, ratio);
    const taperedOffset = offsetDistance * taperIn * taperOut;
    const previous = points[Math.max(0, index - 1)];
    const next = points[Math.min(points.length - 1, index + 1)];
    const tangent = next.clone().sub(previous).setY(0);
    if (tangent.lengthSq() < 0.0001) {
      tangent.set(1, 0, 0);
    } else {
      tangent.normalize();
    }
    const side = new THREE.Vector3(-tangent.z, 0, tangent.x).multiplyScalar(taperedOffset);
    return point.clone().add(side);
  });
}

function connectLaneToAnchors(points, startAnchor, endAnchor) {
  if (!points?.length) {
    return [startAnchor.clone(), endAnchor.clone()];
  }

  const firstPoint = points[0].clone();
  const lastPoint = points[points.length - 1].clone();
  return [
    startAnchor.clone(),
    startAnchor.clone().lerp(firstPoint, 0.55),
    ...points.map((point) => point.clone()),
    lastPoint.clone().lerp(endAnchor, 0.55),
    endAnchor.clone(),
  ];
}

function getContinuousAngle(nextAngle, previousAngle = 0) {
  let adjusted = nextAngle;
  while ((adjusted - previousAngle) > Math.PI) {
    adjusted -= Math.PI * 2;
  }
  while ((adjusted - previousAngle) < -Math.PI) {
    adjusted += Math.PI * 2;
  }
  return adjusted;
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

function createStatusLabelSprite(label, backgroundColor = "#ef4444") {
  const canvas = document.createElement("canvas");
  canvas.width = 256;
  canvas.height = 96;
  const context = canvas.getContext("2d");
  if (!context) {
    return null;
  }

  context.clearRect(0, 0, canvas.width, canvas.height);
  context.fillStyle = backgroundColor;
  context.strokeStyle = "rgba(255, 235, 235, 0.95)";
  context.lineWidth = 4;

  const radius = 22;
  const x = 10;
  const y = 10;
  const width = canvas.width - 20;
  const height = canvas.height - 20;
  context.beginPath();
  context.moveTo(x + radius, y);
  context.lineTo(x + width - radius, y);
  context.quadraticCurveTo(x + width, y, x + width, y + radius);
  context.lineTo(x + width, y + height - radius);
  context.quadraticCurveTo(x + width, y + height, x + width - radius, y + height);
  context.lineTo(x + radius, y + height);
  context.quadraticCurveTo(x, y + height, x, y + height - radius);
  context.lineTo(x, y + radius);
  context.quadraticCurveTo(x, y, x + radius, y);
  context.closePath();
  context.fill();
  context.stroke();

  context.fillStyle = "#fff7f7";
  context.font = "700 30px Space Grotesk, sans-serif";
  context.textAlign = "center";
  context.textBaseline = "middle";
  context.fillText(label, canvas.width / 2, canvas.height / 2 + 2);

  const texture = new THREE.CanvasTexture(canvas);
  texture.needsUpdate = true;
  const material = new THREE.SpriteMaterial({
    map: texture,
    transparent: true,
    depthWrite: false,
  });
  const sprite = new THREE.Sprite(material);
  sprite.scale.set(8.8, 3.2, 1);
  return sprite;
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

function createRouteObjects(routeDefinitions) {
  if (!routeDefinitions?.length) {
    return { objects: [], routes: [] };
  }

  const routeRoot = new THREE.Group();
  const routeEntries = [];
  const routeMaterial = new THREE.MeshStandardMaterial({
    color: 0x31383f,
    emissive: 0x07090b,
    emissiveIntensity: 0.03,
    metalness: 0.12,
    roughness: 0.78,
    transparent: true,
    opacity: 0.94,
  });
  const shoulderMaterial = new THREE.MeshStandardMaterial({
    color: 0x252b31,
    transparent: true,
    opacity: 0.42,
    metalness: 0.06,
    roughness: 0.92,
  });

  function addFlatRoad(startPoint, endPoint, key, width = 10.8, shoulderWidth = 12.6) {
    const roadGroup = new THREE.Group();
    const roadSurfaceMaterial = routeMaterial.clone();
    const roadShoulderMaterial = shoulderMaterial.clone();
    const direction = new THREE.Vector3().subVectors(endPoint, startPoint).setY(0);
    const length = Math.max(direction.length(), 0.001);
    direction.normalize();
    const heading = Math.atan2(direction.x, direction.z);
    const center = startPoint.clone().lerp(endPoint, 0.5).setY(0.22);

    const routeSurface = new THREE.Mesh(
      new THREE.BoxGeometry(width, 0.18, length),
      roadSurfaceMaterial,
    );
    routeSurface.position.copy(center);
    routeSurface.rotation.y = heading;
    roadGroup.add(routeSurface);

    const routeShoulder = new THREE.Mesh(
      new THREE.BoxGeometry(shoulderWidth, 0.08, length),
      roadShoulderMaterial,
    );
    routeShoulder.position.copy(center.clone().setY(0.08));
    routeShoulder.rotation.y = heading;
    roadGroup.add(routeShoulder);
    routeRoot.add(roadGroup);
    routeEntries.push({ key, root: roadGroup, points: [startPoint.clone(), endPoint.clone()] });
  }

  routeDefinitions.forEach(({ key, start, end, width, shoulderWidth }) => {
    addFlatRoad(start, end, key, width, shoulderWidth);
  });

  return { objects: [routeRoot], routes: routeEntries };
}

function createRigBoard(position, routeDirection, radius = 18) {
  const boardHeight = 1.2;
  const boardRotation = Math.atan2(routeDirection.x || 0, routeDirection.z || 1) + Math.PI;
  const boardWidth = radius * 4.6;
  const boardDepth = radius * 2.9;
  const shoulderWidth = boardWidth * 1.12;
  const shoulderDepth = boardDepth * 1.08;
  const board = new THREE.Mesh(
    new THREE.BoxGeometry(boardWidth, boardHeight, boardDepth),
    new THREE.MeshStandardMaterial({
      color: 0x32373d,
      emissive: 0x06080b,
      emissiveIntensity: 0.025,
      metalness: 0.08,
      roughness: 0.88,
    }),
  );
  board.position.copy(position);
  board.position.y = boardHeight / 2;
  board.rotation.y = boardRotation;
  board.receiveShadow = true;

  const shoulder = new THREE.Mesh(
    new THREE.BoxGeometry(shoulderWidth, 0.16, shoulderDepth),
    new THREE.MeshStandardMaterial({
      color: 0x1b1f24,
      emissive: 0x050608,
      emissiveIntensity: 0.02,
      metalness: 0.04,
      roughness: 0.96,
    }),
  );
  shoulder.position.copy(position);
  shoulder.position.y = 0.08;
  shoulder.rotation.y = boardRotation;
  shoulder.receiveShadow = true;

  return [shoulder, board];
}

function getRigBoardRotation(routeDirection) {
  return Math.atan2(routeDirection.x || 0, routeDirection.z || 1) + Math.PI;
}

function getRigBoardParkingWorld(position, routeDirection, radius, truckId) {
  const boardRotation = getRigBoardRotation(routeDirection);
  const boardWidth = radius * 3.6;
  const boardDepth = radius * 2.45;
  const slotIndex = Math.max(0, truckId - 1);
  const laneDepth = boardDepth * 0.975;
  const rowSpacing = 7.8;
  const rows = Math.max(1, Math.floor(laneDepth / rowSpacing));
  const rowIndex = slotIndex % rows;
  const columnIndex = Math.floor(slotIndex / rows);
  const localX = Math.min(boardWidth * 0.42, (boardWidth * 0.17) + (columnIndex * 19));
  const rowDistanceFromCenter = Math.ceil(rowIndex / 2);
  const rowSideDirection = rowIndex === 0 ? 0 : (rowIndex % 2 === 1 ? 1 : -1);
  const localZ = rowSideDirection * rowDistanceFromCenter * rowSpacing;
  const worldOffset = new THREE.Vector3(localX, 2.35, localZ)
    .applyAxisAngle(new THREE.Vector3(0, 1, 0), boardRotation);

  return {
    position: position.clone().add(worldOffset),
    heading: boardRotation - (Math.PI / 2),
  };
}

function getRigBoardRigWorld(position, routeDirection, radius, height = 1.6) {
  const boardRotation = getRigBoardRotation(routeDirection);
  const boardWidth = radius * 4.6;
  const worldOffset = new THREE.Vector3(-(boardWidth * 0.1), height, 0)
    .applyAxisAngle(new THREE.Vector3(0, 1, 0), boardRotation);
  return position.clone().add(worldOffset);
}

function addRigCornerLamps(parent, position, routeDirection, radius, siteLampTemplate, rigTargetWorld, modelYawOffset = 0) {
  if (!parent || !siteLampTemplate) {
    return;
  }

  const boardRotation = getRigBoardRotation(routeDirection);
  const boardWidth = radius * 3.6;
  const boardDepth = radius * 2.45;
  const lampHeight = 2.6;
  const cornerOffsets = [
    { offset: new THREE.Vector3(boardWidth * 0.40, lampHeight, boardDepth * 0.36), yawOffset: modelYawOffset },
  ];

  cornerOffsets.forEach(({ offset: cornerOffset, yawOffset }) => {
    const lamp = centerAndScaleModel(
      cloneModelWithUniqueMaterials(siteLampTemplate),
      { targetWidth: 16, targetHeight: 42, lift: 0 },
    );
    tintModel(lamp, 0x6a7178);
    const lampRoot = new THREE.Group();
    const worldPosition = cornerOffset
      .clone()
      .applyAxisAngle(new THREE.Vector3(0, 1, 0), boardRotation)
      .add(position);
    lampRoot.position.copy(worldPosition);
    const localRigTarget = rigTargetWorld.clone().sub(worldPosition);
    lamp.rotation.y = Math.atan2(localRigTarget.x, localRigTarget.z) + yawOffset + THREE.MathUtils.degToRad(-100);
    lampRoot.add(lamp);

    const lampLight = new THREE.SpotLight(0xffe5b5, 150, 140, 0.8, 0.85, 1.02);
    lampLight.position.set(0, 46, 0);
    lampLight.castShadow = false;

    const lampTarget = new THREE.Object3D();
    lampTarget.position.set(localRigTarget.x, 0.4, localRigTarget.z);
    lampRoot.add(lampTarget);
    lampLight.target = lampTarget;

    lampRoot.add(lampLight);
    parent.add(lampRoot);
  });
}

function addMedianLamps(parent, curvePoints, lampTemplate, lampCount = 4) {
  if (!parent || !lampTemplate || !curvePoints || curvePoints.length < 2) {
    return;
  }

  const pathMetrics = buildWorldPathMetrics(curvePoints);
  const totalLength = pathMetrics.totalLength || 0;
  if (totalLength <= 1 || lampCount <= 0) {
    return;
  }

  const endClearance = getRoadLampEndClearance(totalLength);
  const usableLength = Math.max(totalLength - (endClearance * 2), 1);
  for (let lampIndex = 0; lampIndex < lampCount; lampIndex += 1) {
    const ratioAlongUsable = lampCount === 1 ? 0.5 : (lampIndex / (lampCount - 1));
    const distance = endClearance + (usableLength * ratioAlongUsable);
    const ratio = distance / totalLength;
    const nextRatio = Math.min(1, (distance + 1.2) / totalLength);
    const currentPoint = interpolateWorldPath(pathMetrics, ratio, 0);
    const nextPoint = interpolateWorldPath(pathMetrics, nextRatio, 0);
    const heading = Math.atan2(nextPoint.x - currentPoint.x, nextPoint.z - currentPoint.z);
    const lamp = centerAndScaleModel(
      cloneModelWithUniqueMaterials(lampTemplate),
      { targetWidth: 3.2, targetHeight: 15, lift: 0 },
    );
    lamp.position.copy(currentPoint);
    lamp.position.y = 0.18;
    lamp.rotation.y = heading + (Math.PI / 2);

    const lampGlow = new THREE.SpotLight(0xffe0a8, 8.5, 10, 1, 0.8, 0.5);
    lampGlow.position.set(0, 2.5, 0);
    lampGlow.castShadow = false;
    const lampTarget = new THREE.Object3D();
    lampTarget.position.set(0, 0.2, 0);
    lamp.add(lampTarget);
    lampGlow.target = lampTarget;
    lamp.add(lampGlow);

    parent.add(lamp);
  }
}

function getLocationLabel(label, fallback) {
  if (!label || typeof label !== "string") {
    return fallback;
  }

  const primary = label.split(",")[0]?.trim();
  return primary || label.trim() || fallback;
}

function createFloor(extent) {
  const group = new THREE.Group();
  const size = Math.max(340, extent * 0.32);

  const base = new THREE.Mesh(
    new THREE.PlaneGeometry(size * 0.94, size * 0.94),
    new THREE.MeshBasicMaterial({
      color: 0x252a30,
    }),
  );
  base.rotation.x = -Math.PI / 2;
  group.add(base);

  const innerPlate = new THREE.Mesh(
    new THREE.PlaneGeometry(size * 0.9, size * 0.9),
    new THREE.MeshBasicMaterial({
      color: 0x252a30,
      transparent: true,
      opacity: 0.92,
    }),
  );
  innerPlate.rotation.x = -Math.PI / 2;
  innerPlate.position.y = 0.04;
  group.add(innerPlate);

  const edgeFadeTexture = getPlatformEdgeFadeTexture();
  if (edgeFadeTexture) {
    const edgeFade = new THREE.Mesh(
      new THREE.PlaneGeometry(size * 1.12, size * 1.12),
      new THREE.MeshBasicMaterial({
        color: 0x252a30,
        alphaMap: edgeFadeTexture,
        transparent: true,
        opacity: 0.9,
        depthWrite: false,
      }),
    );
    edgeFade.rotation.x = -Math.PI / 2;
    edgeFade.position.y = 0.01;
    group.add(edgeFade);
  }

  return group;
}

export function SimulationScene3D({
  startPoint,
  endPoint,
  startLabel = "",
  endLabel = "",
  simulation,
  currentMinute = 0,
  delayMinute = 0,
  executionAssignments = [],
  activeTripAlert = null,
  sceneFocusResetKey = 0,
  heightClass = "map-frame",
  showOverlay = true,
  onReadyStateChange = null,
  onRigFocusChange = null,
  onTruckFocusChange = null,
  onFocusChange = null,
}) {
  const startPointKey = startPoint
    ? `${Number(startPoint.lat || 0).toFixed(6)},${Number(startPoint.lng || 0).toFixed(6)}`
    : "none";
  const endPointKey = endPoint
    ? `${Number(endPoint.lat || 0).toFixed(6)},${Number(endPoint.lng || 0).toFixed(6)}`
    : "none";
  const routeGeometryKey = (simulation?.routeGeometry || [])
    .map((point) => `${Number(point?.[0] || 0).toFixed(6)},${Number(point?.[1] || 0).toFixed(6)}`)
    .join("|");
  const hostRef = useRef(null);
  const overlayRef = useRef(null);
  const tooltipRef = useRef(null);
  const currentMinuteRef = useRef(currentMinute);
  const delayMinuteRef = useRef(delayMinute);
  const activeTripAlertRef = useRef(activeTripAlert);
  const sceneFocusResetKeyRef = useRef(sceneFocusResetKey);
  const handledSceneFocusResetKeyRef = useRef(sceneFocusResetKey);
  const simulationRef = useRef(simulation);
  const executionAssignmentsRef = useRef(executionAssignments);
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
  const focusedTruckIdRef = useRef(null);
  const focusedTruckOffsetRef = useRef(null);
  const focusedTruckLastTargetRef = useRef(null);
  const focusedTruckFollowConfigRef = useRef(null);
  const hoveredRigComponentRef = useRef(null);
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
    tooltip.querySelector("[data-tooltip-title]").textContent = content.title;
    ["state", "assigned", "delay", "arrival", "progress", "moving"].forEach((lineKey) => {
      const lineNode = tooltip.querySelector(`[data-tooltip-line='${lineKey}']`);
      if (!lineNode) {
        return;
      }

      const lineValue = content[lineKey] || "";
      lineNode.textContent = lineValue;
      lineNode.style.display = lineValue ? "block" : "none";
    });

    const padding = 16;
    const tooltipRect = tooltip.getBoundingClientRect();
    const maxLeft = Math.max(padding, window.innerWidth - tooltipRect.width - padding);
    const maxTop = Math.max(padding, window.innerHeight - tooltipRect.height - padding);
    const clampedLeft = Math.min(Math.max(position.x, padding), maxLeft);
    const clampedTop = Math.min(Math.max(position.y, padding), maxTop);

    tooltip.style.left = `${clampedLeft}px`;
    tooltip.style.top = `${clampedTop}px`;
  }

  function setRigComponentDirectHover(nextMesh, strength = 0.58) {
    const previousMesh = hoveredRigComponentRef.current;
    if (previousMesh && previousMesh !== nextMesh) {
      const previousMaterials = Array.isArray(previousMesh.material) ? previousMesh.material : [previousMesh.material];
      const previousOriginals = previousMesh.userData?.hoverOriginalMaterials || [];
      previousMaterials.forEach((material, index) => {
        const original = previousOriginals[index];
        if (!original) {
          return;
        }
        if (material.color && original.color) {
          material.color.copy(original.color);
        }
        if ("emissive" in material && material.emissive && original.emissive) {
          material.emissive.copy(original.emissive);
          material.emissiveIntensity = original.emissiveIntensity;
        }
      });
      hoveredRigComponentRef.current = null;
    }

    if (!nextMesh) {
      return;
    }

    if (!nextMesh.userData.hoverOriginalMaterials) {
      const materials = Array.isArray(nextMesh.material) ? nextMesh.material : [nextMesh.material];
      nextMesh.userData.hoverOriginalMaterials = materials.map((material) => ({
        color: material.color ? material.color.clone() : null,
        emissive: "emissive" in material && material.emissive ? material.emissive.clone() : null,
        emissiveIntensity: material.emissiveIntensity || 0,
      }));
    }

    const nextMaterials = Array.isArray(nextMesh.material) ? nextMesh.material : [nextMesh.material];
    const targetColor = new THREE.Color(0xfbbf24);
    const hoverBaseColor = new THREE.Color(0x6a6553);
    nextMaterials.forEach((material, index) => {
      const original = nextMesh.userData.hoverOriginalMaterials?.[index];
      if (material.color) {
        material.color.copy(original?.color || material.color);
        material.color.lerp(hoverBaseColor, Math.min(0.24, strength * 0.28));
        material.color.lerp(targetColor, Math.min(0.42, strength * 0.5));
      }
      if ("emissive" in material && material.emissive) {
        const sourceEmissive = original?.emissive || material.emissive;
        material.emissive.lerpColors(sourceEmissive, targetColor, Math.min(0.48, strength * 0.5));
        material.emissiveIntensity = (original?.emissiveIntensity || 0) + (strength * 0.18);
      }
    });
    hoveredRigComponentRef.current = nextMesh;
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
    const stateLabel = truckInfo.isDelayed
      ? `${truckInfo.status || "Waiting"} • Delayed`
      : (truckInfo.status || "Waiting");

    return {
      title: `Truck ${truckInfo.truckId}`,
      state: `State: ${stateLabel}`,
      assigned: loadLabel,
      delay: `Delay: ${formatSceneDelayLabel(truckInfo.lateMinutes, "On time")}`,
      arrival: `Planned arrival: ${formatSceneMinuteLabel(truckInfo.plannedArrivalMinute)}`,
      progress: `Route progress: ${progress}%`,
      moving: `Distance: ${distanceKm.toFixed(1)} / ${routeDistanceKm.toFixed(1)} km`,
    };
  }

function buildRouteTooltip(routeInfo) {
  const distanceKm = Number.isFinite(routeInfo.distanceKm) ? routeInfo.distanceKm : 0;
  const routeLabel = routeInfo.routeLabel || "Move Route";
  const stateLabel = routeInfo.stateLabel || "Source to destination";
  const pathLabel = routeInfo.pathLabel || "Active haul corridor";
  return {
    title: routeLabel,
    state: `State: ${stateLabel}`,
    assigned: `Distance: ${distanceKm.toFixed(1)} km`,
    progress: `Path: ${pathLabel}`,
    moving: `Connection: ${routeInfo.startName || "Source"} to ${routeInfo.endName || "Destination"}`,
  };
}

  function buildBoardTooltip(boardInfo) {
    const point = boardInfo.point || {};
    return {
      title: boardInfo.locationName || `${boardInfo.side === "source" ? "Source" : "Destination"} Location`,
      state: `State: ${boardInfo.side === "source" ? "Source location" : "Destination location"}`,
      assigned: `Site: ${boardInfo.fullLabel || boardInfo.locationName || "Unknown location"}`,
      progress: `Coordinates: ${Number(point.lat || 0).toFixed(4)}, ${Number(point.lng || 0).toFixed(4)}`,
      moving: `Role: ${boardInfo.side === "source" ? "Origin rig pad" : "Destination rig pad"}`,
    };
  }

  useEffect(() => {
    sceneFocusResetKeyRef.current = sceneFocusResetKey;
  }, [sceneFocusResetKey]);

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
    executionAssignmentsRef.current = executionAssignments;
  }, [executionAssignments]);

  useEffect(() => {
    delayMinuteRef.current = delayMinute;
  }, [delayMinute]);

  useEffect(() => {
    activeTripAlertRef.current = activeTripAlert;
  }, [activeTripAlert]);

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
    focusedTruckIdRef.current = null;
    focusedTruckOffsetRef.current = null;
    focusedTruckLastTargetRef.current = null;
    focusedTruckFollowConfigRef.current = null;
    hoveredRigComponentRef.current = null;
    cameraTransitioningRef.current = false;
    hoveredObjectRef.current = null;
    rigVisualStateRef.current = {
      source: null,
      destination: null,
    };
    setOverlayState("loading");

    const routeGeometry = simulation?.routeGeometry || [];
    const routePoints = routeGeometry.map(([lat, lng]) => ({ lat, lng }));
    const activeRoutePoints =
      routePoints.length >= 2
        ? routePoints
        : startPoint && endPoint
          ? [startPoint, endPoint]
          : routePoints;
    const geoPoints = [
      ...(startPoint ? [startPoint] : []),
      ...activeRoutePoints,
      ...(endPoint ? [endPoint] : []),
    ];
    const projection = buildProjection(geoPoints);
    const measuredRouteMetrics = buildRouteMetrics(activeRoutePoints);
    const fixedStartWorld = new THREE.Vector3(98, 1.2, 16);
    const fixedEndWorld = new THREE.Vector3(-86, 1.2, -6);
    const straightStartWorld = fixedStartWorld.clone();
    const straightEndWorld = fixedEndWorld.clone();
    const platformSize = Math.max(340, projection.extent * 0.32);
    const platformEdgeOffset = platformSize * 0.38;
    const routeDirectionWorld = new THREE.Vector3(
      straightEndWorld.x - straightStartWorld.x,
      0,
      straightEndWorld.z - straightStartWorld.z,
    );
    if (routeDirectionWorld.lengthSq() < 0.0001) {
      routeDirectionWorld.set(1, 0, 0);
    } else {
      routeDirectionWorld.normalize();
    }
    const roadStartWorld = straightStartWorld.clone();
    const roadEndWorld = straightEndWorld.clone();
    const projectedRoute = [roadStartWorld, roadEndWorld];
    const projectedRouteMetrics = buildWorldPathMetrics(projectedRoute);
    const reversedProjectedRoute = [...projectedRoute].reverse();
    const reversedProjectedRouteMetrics = buildWorldPathMetrics(reversedProjectedRoute);
    const routeSideWorld = new THREE.Vector3(-routeDirectionWorld.z, 0, routeDirectionWorld.x).normalize();
    const roadCenterOffset = 27;
    const laneHalfGap = 3.2;
    const roadTravelHeight = 0.255;
    const outboundRoadSourceAnchor = roadStartWorld.clone().add(routeSideWorld.clone().multiplyScalar(roadCenterOffset));
    const outboundRoadDestinationAnchor = roadEndWorld.clone().add(routeSideWorld.clone().multiplyScalar(roadCenterOffset));
    const inboundRoadSourceAnchor = roadStartWorld.clone().add(routeSideWorld.clone().multiplyScalar(-roadCenterOffset));
    const inboundRoadDestinationAnchor = roadEndWorld.clone().add(routeSideWorld.clone().multiplyScalar(-roadCenterOffset));
    const outboundLanePointsA = [
      outboundRoadSourceAnchor.clone().add(routeSideWorld.clone().multiplyScalar(-laneHalfGap)),
      outboundRoadDestinationAnchor.clone().add(routeSideWorld.clone().multiplyScalar(-laneHalfGap)),
    ];
    const outboundLanePointsB = [
      outboundRoadSourceAnchor.clone().add(routeSideWorld.clone().multiplyScalar(laneHalfGap)),
      outboundRoadDestinationAnchor.clone().add(routeSideWorld.clone().multiplyScalar(laneHalfGap)),
    ];
    const inboundLanePointsA = [
      inboundRoadDestinationAnchor.clone().add(routeSideWorld.clone().multiplyScalar(-laneHalfGap)),
      inboundRoadSourceAnchor.clone().add(routeSideWorld.clone().multiplyScalar(-laneHalfGap)),
    ];
    const inboundLanePointsB = [
      inboundRoadDestinationAnchor.clone().add(routeSideWorld.clone().multiplyScalar(laneHalfGap)),
      inboundRoadSourceAnchor.clone().add(routeSideWorld.clone().multiplyScalar(laneHalfGap)),
    ];
    const outboundLaneMetricsA = buildWorldPathMetrics(outboundLanePointsA);
    const outboundLaneMetricsB = buildWorldPathMetrics(outboundLanePointsB);
    const inboundLaneMetricsA = buildWorldPathMetrics(inboundLanePointsA);
    const inboundLaneMetricsB = buildWorldPathMetrics(inboundLanePointsB);
    const playbackTrips = simulation?.bestPlan?.playback?.trips || [];

    function getTripLaneKey(trip) {
      return trip
        ? `${trip.loadId ?? "load"}::${trip.truckId ?? "truck"}::${trip.loadStart ?? "start"}::${trip.rigUpFinish ?? "rigup"}`
        : null;
    }

    function buildLaneAssignmentMap(trips, timeField) {
      const assignments = new Map();
      let useFirstLane = false;

      [...trips]
        .sort((a, b) => {
          if ((a?.[timeField] ?? 0) !== (b?.[timeField] ?? 0)) {
            return (a?.[timeField] ?? 0) - (b?.[timeField] ?? 0);
          }
          if ((a?.loadStart ?? 0) !== (b?.loadStart ?? 0)) {
            return (a?.loadStart ?? 0) - (b?.loadStart ?? 0);
          }
          if ((a?.rigUpFinish ?? 0) !== (b?.rigUpFinish ?? 0)) {
            return (a?.rigUpFinish ?? 0) - (b?.rigUpFinish ?? 0);
          }
          if ((a?.truckId ?? 0) !== (b?.truckId ?? 0)) {
            return (a?.truckId ?? 0) - (b?.truckId ?? 0);
          }
          return (a?.loadId ?? 0) - (b?.loadId ?? 0);
        })
        .forEach((trip) => {
          useFirstLane = !useFirstLane;
          assignments.set(getTripLaneKey(trip), useFirstLane);
        });

      return assignments;
    }

    const outboundLaneOrderByTrip = buildLaneAssignmentMap(playbackTrips, "loadStart");
    const inboundLaneOrderByTrip = buildLaneAssignmentMap(
      playbackTrips.filter((trip) => trip.returnToSource != null),
      "rigUpFinish",
    );

    function getTravelLaneMetrics(truckId, direction, trip = null) {
      const slotIndex = Math.max(0, truckId - 1);
      const tripLaneKey = getTripLaneKey(trip);
      const useFirstLane = trip
        ? (direction === "outbound"
          ? (outboundLaneOrderByTrip.get(tripLaneKey) ?? (slotIndex % 2 === 0))
          : (inboundLaneOrderByTrip.get(tripLaneKey) ?? (slotIndex % 2 === 0)))
        : slotIndex % 2 === 0;
      if (direction === "outbound") {
        return useFirstLane ? outboundLaneMetricsA : outboundLaneMetricsB;
      }
      return useFirstLane ? inboundLaneMetricsA : inboundLaneMetricsB;
    }

    function getLaneHeading(pathMetrics, fromStart = true) {
      const points = pathMetrics?.points || [];
      if (points.length < 2) {
        return Math.atan2(routeDirectionWorld.x, routeDirectionWorld.z);
      }
      const current = fromStart ? points[0] : points[points.length - 1];
      const neighbor = fromStart ? points[1] : points[points.length - 2];
      const tangent = fromStart
        ? neighbor.clone().sub(current)
        : current.clone().sub(neighbor);
      return Math.atan2(tangent.x, tangent.z);
    }

    function getLaneParkingWorld(truckId, direction, trip = null) {
      const pathMetrics = getTravelLaneMetrics(truckId, direction, trip);
      const points = pathMetrics?.points || [];
      if (points.length < 2) {
        const fallbackHeading = Math.atan2(routeDirectionWorld.x, routeDirectionWorld.z);
        const fallbackBase = direction === "outbound" ? roadStartWorld : roadEndWorld;
        const fallbackMove = new THREE.Vector3(Math.sin(fallbackHeading), 0, Math.cos(fallbackHeading)).multiplyScalar(-30);
        return {
          position: fallbackBase.clone().add(fallbackMove),
          heading: fallbackHeading,
        };
      }

      const lanePoint = points[0];
      const laneHeading = getLaneHeading(pathMetrics, true);
      return {
        position: lanePoint.clone(),
        heading: laneHeading,
      };
    }

    const scene = new THREE.Scene();
    scene.background = null;
    scene.fog = new THREE.FogExp2(0x25292f, 0.0018);

    const camera = new THREE.PerspectiveCamera(44, 1, 0.1, 1200);
    const layoutSpan = fixedStartWorld.distanceTo(fixedEndWorld);
    const cameraDistance = Math.max(162, Math.min(248, layoutSpan * 1.12));
    camera.position.set(cameraDistance * 0.32, cameraDistance * 0.4, cameraDistance * 1.02);
    const defaultCameraPosition = camera.position.clone();
    const defaultTarget = new THREE.Vector3(-8, 5.4, -1);
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
    controls.maxDistance = cameraDistance * 1.55;
    controls.maxPolarAngle = Math.PI * 0.4;
    controls.minPolarAngle = Math.PI * 0.2;
    const handleControlsStart = () => {
      cameraTransitioningRef.current = false;
      if (focusedTruckIdRef.current != null || focusedRigSideRef.current != null) {
        focusedRigSideRef.current = null;
        focusedTruckIdRef.current = null;
        focusedTruckOffsetRef.current = null;
        focusedTruckLastTargetRef.current = null;
        focusedTruckFollowConfigRef.current = null;
        onRigFocusChange?.(null);
        onTruckFocusChange?.(null);
        onFocusChange?.(null);
      }
      zoomState.currentTarget.copy(controls.target);
      zoomState.desiredTarget.copy(controls.target);
      zoomState.currentPosition.copy(camera.position);
      zoomState.desiredPosition.copy(camera.position);
    };
    controls.addEventListener("start", handleControlsStart);
    const handleControlsChange = () => {
      if (
        focusedTruckIdRef.current != null &&
        !cameraTransitioningRef.current &&
        !focusedTruckFollowConfigRef.current
      ) {
        focusedTruckOffsetRef.current = camera.position.clone().sub(controls.target);
      }
    };
    controls.addEventListener("change", handleControlsChange);

    const floorGroup = createFloor(projection.extent);
    const sceneSpin = -Math.PI * 0.05;
    floorGroup.rotation.y = sceneSpin;
    scene.add(floorGroup);

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

    const routeGroup = new THREE.Group();
    routeGroup.rotation.y = sceneSpin;
    const routeObjects = createRouteObjects([
      {
        key: "outbound",
        start: outboundRoadSourceAnchor,
        end: outboundRoadDestinationAnchor,
        width: 10.8,
        shoulderWidth: 12.6,
      },
      {
        key: "inbound",
        start: inboundRoadSourceAnchor,
        end: inboundRoadDestinationAnchor,
        width: 10.8,
        shoulderWidth: 12.6,
      },
    ]);
    routeObjects.objects.forEach((object) => routeGroup.add(object));
    scene.add(routeGroup);
    const truckPoolCount = Math.max(24, simulation?.truckCount || 0, (simulation?.truckSetup?.length || 1) * 8);

    const truckAccent = 0x647587;
    const padAssetsGroup = new THREE.Group();
    padAssetsGroup.rotation.y = sceneSpin;
    scene.add(padAssetsGroup);

    const trucksGroup = new THREE.Group();
    trucksGroup.rotation.y = sceneSpin;
    scene.add(trucksGroup);

    const truckMeshes = new Map();
    const pulseTargets = [];
    const rigPickTargets = [];
    const truckPickTargets = [];
    const boardPickTargets = [];
    const routePickTargets = [];
    const highlightTargets = new Map();

    routeObjects.routes.forEach(({ key, root }) => {
      const isOutbound = key === "outbound";
      const highlightKey = `move-route-${key}`;
      root.userData = {
        ...root.userData,
        routeInfo: {
          distanceKm: measuredRouteMetrics.totalKm,
          startName: getLocationLabel(startLabel, "Source"),
          endName: getLocationLabel(endLabel, "Destination"),
          routeLabel: isOutbound ? "Outbound Road" : "Inbound Road",
          stateLabel: isOutbound ? "Source to destination" : "Destination to source",
          pathLabel: isOutbound ? "Loaded haul lane" : "Return haul lane",
        },
        highlightKey,
      };
      routePickTargets.push(root);
      highlightTargets.set(highlightKey, {
        root,
        capturedMaterials: captureHighlightMaterials(root),
        color: 0xfbbf24,
        kind: "route",
        intensityFactor: 0.52,
        highlightOptions: {
          maxSurfaceMix: 0.24,
          surfaceMixScale: 0.3,
          emissiveMixScale: 0.22,
        },
        baseScale: root.scale.clone(),
      });
    });

    function registerPulseTargets(root) {
      root.traverse((child) => {
        if (child.userData?.pulse) {
          pulseTargets.push(child);
        }
      });
    }

    function addTruckRoadLight(truckRoot) {
      const lightRoot = new THREE.Group();
      lightRoot.visible = false;

      const roadLight = new THREE.SpotLight(0xffe7b8, 20, 34, 0.62, 0.88, 1.1);
      roadLight.position.set(0, 3.2, 4.2);
      roadLight.castShadow = false;

      const lightTarget = new THREE.Object3D();
      lightTarget.position.set(0, 0.2, 18);
      lightRoot.add(lightTarget);
      roadLight.target = lightTarget;

      lightRoot.add(roadLight);
      truckRoot.add(lightRoot);
      return lightRoot;
    }

    function addTruckDelayLight(truckRoot) {
      const delayLight = new THREE.PointLight(0xff6464, 0, 16, 2.2);
      delayLight.position.set(0, 5.8, 0);
      delayLight.visible = false;
      truckRoot.add(delayLight);
      return delayLight;
    }

    function createTruckInstance(truckId) {
      const truckRoot = new THREE.Group();
      const fallbackMesh = createTruckFallbackMesh(truckAccent);
      addTruckDelayOverlayMeshes(fallbackMesh);
      truckRoot.add(fallbackMesh);
      const roadLight = addTruckRoadLight(truckRoot);
      const delayLight = addTruckDelayLight(truckRoot);
      truckRoot.visible = false;
      truckRoot.userData = {
        truckId,
        status: "",
        roadLight,
        delayLight,
        truckVariants: {
          fallback: fallbackMesh,
        },
        activeTruckVariantKey: "fallback",
      };
      return truckRoot;
    }

    function setTruckDelayVisualState(truckRoot, isDelayed, pulseStrength = 0) {
      if (!truckRoot) {
        return;
      }

      truckRoot.traverse((child) => {
        if (!child.isMesh || !child.material || child.userData?.isDelayOverlay) {
          return;
        }

        if (child.userData.delayOriginalMaterial) {
          child.material = child.userData.delayOriginalMaterial;
        }
      });

      const delayLight = truckRoot.userData?.delayLight;
      if (delayLight) {
        delayLight.visible = isDelayed;
        delayLight.intensity = isDelayed ? (5.2 + (pulseStrength * 3.2)) : 0;
      }

      const variants = truckRoot.userData?.truckVariants || {};
      Object.values(variants).forEach((variantRoot) => {
        const overlays = variantRoot?.userData?.delayOverlays || [];
        overlays.forEach((overlayMesh) => {
          overlayMesh.visible = false;
        });
      });

    }

    async function buildAssets() {
      const truckTemplates = {};
      let rigTemplate = null;
      let terrainTemplate = null;
      let lampTemplate = null;
      let siteLampTemplate = null;

      try {
        const [flatbedTruckTemplate, lowbedTruckTemplate, heavyHaulerTruckTemplate, nextRigTemplate, nextTerrainTemplate, nextLampTemplate, nextSiteLampTemplate] = await Promise.all([
          loadModelTemplate("flatbedTruck"),
          loadModelTemplate("lowbedTruck"),
          loadModelTemplate("heavyHaulerTruck"),
          loadModelTemplate("rig"),
          loadModelTemplate("terrain"),
          loadModelTemplate("lamp"),
          loadModelTemplate("siteLamp"),
        ]);
        truckTemplates.flatbedTruck = flatbedTruckTemplate;
        truckTemplates.lowbedTruck = lowbedTruckTemplate;
        truckTemplates.heavyHaulerTruck = heavyHaulerTruckTemplate;
        rigTemplate = nextRigTemplate;
        terrainTemplate = nextTerrainTemplate;
        lampTemplate = nextLampTemplate;
        siteLampTemplate = nextSiteLampTemplate;
      } catch (error) {
        console.warn("3D assets failed to load, using fallback geometry instead.", error);
      }

      if (disposed) {
        return;
      }

      if (terrainTemplate) {
        const terrainInset = platformSize * 0.31;
        const terrainPresets = [
          { x: -terrainInset * 0.75, z: -terrainInset * 1.05, width: 175, height: 46, rotation: Math.PI * 0.5 },
          { x: terrainInset * 0.86, z: -terrainInset, width: 128, height: 29, rotation: -Math.PI * 0.5 },
          { x: terrainInset * 0.18, z: terrainInset, width: 124, height: 27, rotation: Math.PI * 0.5 },
          { x: 0, z: 4, width: 60, height: 16, rotation: Math.PI * 0.465 },
        ];

        terrainPresets.forEach(({ x, z, width, height, rotation }) => {
          const terrainAsset = centerAndScaleModel(
            cloneModelWithUniqueMaterials(terrainTemplate),
            {
              targetWidth: width,
              targetHeight: height,
              lift: 0,
            },
          );
          const terrainBounds = new THREE.Box3().setFromObject(terrainAsset);
          const terrainMinY = terrainBounds.min.y;
          const terrainHeight = Math.max(terrainBounds.max.y - terrainMinY, 0.001);
          const terrainBaseColor = new THREE.Color(0x252a30);
          const terrainTopShadow = new THREE.Color(0x14181c);
          const terrainTopHighlight = new THREE.Color(0x323941);
          terrainAsset.traverse((child) => {
            if (!child.isMesh || !child.material) {
              return;
            }

            child.castShadow = false;
            child.receiveShadow = false;
            applyTerrainVertexColors(child, terrainBaseColor, terrainTopShadow, terrainTopHighlight);
          });
          terrainAsset.position.set(x, 0.18, z);
          terrainAsset.rotation.y = rotation;
          floorGroup.add(terrainAsset);
        });
      } else {
        const centerIsland = new THREE.Mesh(
          new THREE.ConeGeometry(14, 14, 12),
          new THREE.MeshStandardMaterial({
            color: 0x2b3138,
            metalness: 0.04,
            roughness: 0.96,
          }),
        );
        centerIsland.position.set(0, 7, -2);
        floorGroup.add(centerIsland);
      }

      if (lampTemplate) {
        routeObjects.routes.forEach(({ points }) => {
          addMedianLamps(routeGroup, points, lampTemplate, 6);
        });
      }

      if (startPoint) {
        const startBoardParts = createRigBoard(straightStartWorld.clone().setY(0), routeDirectionWorld, 24);
        const startBoardGroup = new THREE.Group();
        startBoardGroup.userData = {
          boardInfo: {
            side: "source",
            locationName: getLocationLabel(startLabel, "Source"),
            fullLabel: startLabel,
            point: startPoint,
          },
          highlightKey: "rig-board-source",
        };
        startBoardParts.forEach((part) => {
          startBoardGroup.add(part);
        });
        boardPickTargets.push(startBoardGroup);
        highlightTargets.set("rig-board-source", {
          root: startBoardGroup,
          capturedMaterials: captureHighlightMaterials(startBoardGroup),
          color: 0xfbbf24,
          kind: "board",
          intensityFactor: 0.46,
          highlightOptions: {
            maxSurfaceMix: 0.34,
            surfaceMixScale: 0.42,
            emissiveMixScale: 0.38,
          },
          baseScale: startBoardGroup.scale.clone(),
        });
        padAssetsGroup.add(startBoardGroup);
        if (siteLampTemplate) {
          addRigCornerLamps(
            padAssetsGroup,
            straightStartWorld.clone().setY(0),
            routeDirectionWorld,
            24,
            siteLampTemplate,
            getRigBoardRigWorld(straightStartWorld.clone().setY(0), routeDirectionWorld, 24, 4.8),
          );
        }
        const startAsset = rigTemplate
          ? centerAndScaleModel(cloneModelWithUniqueMaterials(rigTemplate), { targetWidth: 148, targetHeight: 82, lift: 0 })
          : createPadFallback(straightStartWorld.clone().setY(0), 0x1de9d5, -6);
        if (rigTemplate) {
          tintModel(startAsset, 0x596069);
          startAsset.rotation.y = Math.PI * 0.18;
          startAsset.position.copy(getRigBoardRigWorld(straightStartWorld.clone().setY(0), routeDirectionWorld, 24, 2.1));
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
              color: 0xfbbf24,
              kind: "rig-component",
              intensityFactor: 0.58,
              highlightOptions: {
                maxSurfaceMix: 0.42,
                surfaceMixScale: 0.5,
                emissiveMixScale: 0.5,
              },
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
          color: 0xfbbf24,
          kind: "rig",
          intensityFactor: 0.58,
          baseScale: startAsset.scale.clone(),
        });
        rigPickTargets.push(startAsset);
        padAssetsGroup.add(startAsset);
        registerPulseTargets(startAsset);
      }

      if (endPoint) {
        const endBoardParts = createRigBoard(straightEndWorld.clone().setY(0), routeDirectionWorld.clone().multiplyScalar(-1), 28);
        const endBoardGroup = new THREE.Group();
        endBoardGroup.userData = {
          boardInfo: {
            side: "destination",
            locationName: getLocationLabel(endLabel, "Destination"),
            fullLabel: endLabel,
            point: endPoint,
          },
          highlightKey: "rig-board-destination",
        };
        endBoardParts.forEach((part) => {
          endBoardGroup.add(part);
        });
        boardPickTargets.push(endBoardGroup);
        highlightTargets.set("rig-board-destination", {
          root: endBoardGroup,
          capturedMaterials: captureHighlightMaterials(endBoardGroup),
          color: 0xfbbf24,
          kind: "board",
          intensityFactor: 0.46,
          highlightOptions: {
            maxSurfaceMix: 0.34,
            surfaceMixScale: 0.42,
            emissiveMixScale: 0.38,
          },
          baseScale: endBoardGroup.scale.clone(),
        });
        padAssetsGroup.add(endBoardGroup);
        if (siteLampTemplate) {
          addRigCornerLamps(
            padAssetsGroup,
            straightEndWorld.clone().setY(0),
            routeDirectionWorld.clone().multiplyScalar(-1),
            28,
            siteLampTemplate,
            getRigBoardRigWorld(straightEndWorld.clone().setY(0), routeDirectionWorld.clone().multiplyScalar(-1), 28, 5.1),
            Math.PI,
          );
        }
        const endAsset = rigTemplate
          ? centerAndScaleModel(cloneModelWithUniqueMaterials(rigTemplate), { targetWidth: 188, targetHeight: 106, lift: 0 })
          : createPadFallback(straightEndWorld.clone().setY(0), 0xc6ff00, 6);
        if (rigTemplate) {
          tintModel(endAsset, 0x596069);
          endAsset.rotation.y = -Math.PI * 0.12;
          endAsset.position.copy(getRigBoardRigWorld(straightEndWorld.clone().setY(0), routeDirectionWorld.clone().multiplyScalar(-1), 28, 2.3));
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
              color: 0xfbbf24,
              kind: "rig-component",
              intensityFactor: 0.58,
              highlightOptions: {
                maxSurfaceMix: 0.42,
                surfaceMixScale: 0.5,
                emissiveMixScale: 0.5,
              },
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
          color: 0xfbbf24,
          kind: "rig",
          intensityFactor: 0.58,
          baseScale: endAsset.scale.clone(),
        });
        rigPickTargets.push(endAsset);
        padAssetsGroup.add(endAsset);
        registerPulseTargets(endAsset);
      }

      const initialTruckTypeAssignments = buildTruckTypeAssignments(simulationRef.current?.truckSetup, simulationRef.current?.truckCount || 0);
      for (let truckId = 1; truckId <= truckPoolCount; truckId += 1) {
        const truckRoot = createTruckInstance(truckId);
        const truckVariants = {};

        ["flatbedTruck", "lowbedTruck", "heavyHaulerTruck"].forEach((variantKey) => {
          const variantTemplate = truckTemplates[variantKey];
          if (!variantTemplate) {
            return;
          }

          const variantMesh = cloneModelWithUniqueMaterials(variantTemplate);
          tintModel(variantMesh, truckAccent);
          centerAndScaleModel(variantMesh, {
            ...getTruckVariantDimensions(variantKey),
            lift: 0,
          });
          variantMesh.scale.x *= getTruckVariantWidthStretch(variantKey);
          addTruckDelayOverlayMeshes(variantMesh);
          variantMesh.visible = false;
          truckRoot.add(variantMesh);
          truckVariants[variantKey] = variantMesh;
        });

        truckRoot.visible = false;
        truckRoot.userData = {
          ...truckRoot.userData,
          truckId,
          status: "",
          highlightKey: `truck-${truckId}`,
          truckVariants: {
            ...truckVariants,
            fallback: truckRoot.userData.truckVariants?.fallback || null,
          },
        };
        setTruckVariantVisible(truckRoot, initialTruckTypeAssignments[truckId - 1] || "LowBed");
        trucksGroup.add(truckRoot);
        truckMeshes.set(truckId, truckRoot);
        truckPickTargets.push(truckRoot);
        highlightTargets.set(`truck-${truckId}`, {
          root: truckRoot,
          capturedMaterials: captureHighlightMaterials(truckRoot),
          color: 0xfbbf24,
          delayedColor: 0xff4d4f,
          kind: "truck",
          intensityFactor: 1,
          baseScale: truckRoot.scale.clone(),
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
      const direction = new THREE.Vector3(0.98, 0.38, 0.94).normalize();

      zoomState.desiredTarget.copy(center);
      zoomState.desiredTarget.y = Math.max(center.y, 4.6);
      zoomState.desiredPosition.copy(center).add(direction.multiplyScalar(focusDistance * 1.8));
      focusedRigSideRef.current = targetObject.userData?.rigInfo?.side || null;
      focusedTruckIdRef.current = null;
      focusedTruckOffsetRef.current = null;
      focusedTruckFollowConfigRef.current = null;
      onRigFocusChange?.(focusedRigSideRef.current);
      onFocusChange?.({ kind: "rig", side: focusedRigSideRef.current });
      cameraTransitioningRef.current = true;
    }

    function focusOnTruck(targetObject) {
      const truckId = targetObject.userData?.truckId ?? null;
      const variantKey = targetObject.userData?.activeTruckVariantKey || "fallback";
      const { targetWidth, targetHeight } = getTruckVariantDimensions(variantKey);
      const heading = truckHeadingRef.current.get(truckId) ?? targetObject.rotation.y ?? 0;
      const followDistance = Math.max(targetWidth * 1.7, 24);
      const followLift = Math.max(targetHeight * 1.3, 10.5);
      const followOffset = getTruckFollowOffset(heading, followDistance, followLift);
      const focusTarget = getTruckFocusTargetWorld(targetObject);

      zoomState.desiredTarget.copy(focusTarget);
      zoomState.desiredPosition.copy(zoomState.desiredTarget).add(followOffset);
      focusedRigSideRef.current = null;
      focusedTruckIdRef.current = truckId;
      focusedTruckOffsetRef.current = followOffset.clone();
      focusedTruckLastTargetRef.current = focusTarget.clone();
      focusedTruckFollowConfigRef.current = {
        distance: followDistance,
        lift: followLift,
      };
      onTruckFocusChange?.(truckId);
      onFocusChange?.({ kind: "truck", truckId });
      cameraTransitioningRef.current = true;
    }

    function resetFocus() {
      zoomState.desiredTarget.copy(defaultTarget);
      zoomState.desiredPosition.copy(defaultCameraPosition);
      focusedRigSideRef.current = null;
      focusedTruckIdRef.current = null;
      focusedTruckOffsetRef.current = null;
      focusedTruckLastTargetRef.current = null;
      focusedTruckFollowConfigRef.current = null;
      onRigFocusChange?.(null);
      onTruckFocusChange?.(null);
      onFocusChange?.(null);
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
      const truckIntersections = raycaster.intersectObjects(truckPickTargets, true);
      const truckHit = truckIntersections.find((entry) => findAncestorWithUserData(entry.object, "truckId"));

      if (truckHit) {
        const truckRoot = findAncestorWithUserData(truckHit.object, "truckId");
        if (truckRoot) {
          focusOnTruck(truckRoot);
          return;
        }
      }

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
        setRigComponentDirectHover(null);
        const truckRoot = findAncestorWithUserData(truckHit.object, "truckId");
        hoveredObjectRef.current = truckRoot?.userData?.highlightKey || null;
        renderer.domElement.style.cursor = "pointer";
        setTooltipState(buildTruckTooltip(truckRoot.userData), {
          x: event.clientX + 18,
          y: event.clientY + 18,
        });
        return;
      }

      const boardIntersections = raycaster.intersectObjects(boardPickTargets, true);
      const boardHit = boardIntersections.find((entry) => findAncestorWithUserData(entry.object, "boardInfo"));
      const routeIntersections = raycaster.intersectObjects(routePickTargets, true);
      const routeHit = routeIntersections.find((entry) => findAncestorWithUserData(entry.object, "routeInfo"));
      const intersections = raycaster.intersectObjects(rigPickTargets, true);
      const hit = intersections.find((entry) => findAncestorWithUserData(entry.object, "rigComponent"));

      if (!hit) {
        if (boardHit) {
          setRigComponentDirectHover(null);
          const boardRoot = findAncestorWithUserData(boardHit.object, "boardInfo");
          hoveredObjectRef.current = boardRoot?.userData?.highlightKey || null;
          renderer.domElement.style.cursor = "pointer";
          setTooltipState(buildBoardTooltip(boardRoot?.userData?.boardInfo || {}), {
            x: event.clientX + 18,
            y: event.clientY + 18,
          });
          return;
        }
        if (routeHit) {
          setRigComponentDirectHover(null);
          const routeRoot = findAncestorWithUserData(routeHit.object, "routeInfo");
          hoveredObjectRef.current = routeRoot?.userData?.highlightKey || null;
          renderer.domElement.style.cursor = "pointer";
          setTooltipState(buildRouteTooltip(routeRoot?.userData?.routeInfo || {}), {
            x: event.clientX + 18,
            y: event.clientY + 18,
          });
          return;
        }
        setRigComponentDirectHover(null);
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

      setRigComponentDirectHover(showComponentDetail ? componentObject : null);

      setTooltipState(tooltipContent, {
        x: event.clientX + 18,
        y: event.clientY + 18,
      });
    }

    function handlePointerLeave() {
      setRigComponentDirectHover(null);
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
      const activeTruckCount = getConfiguredTruckCount(nextSimulation, playback);
      const truckTypeAssignments = buildTruckTypeAssignments(nextSimulation?.truckSetup, activeTruckCount);
      const totalTrips = Math.max(playback?.trips?.length || 0, 1);

      if (!assetsReadyRef.current) {
        truckMeshes.forEach((mesh) => {
          mesh.visible = false;
          mesh.position.set(0, -1000, 0);
        });
        return;
      }

      if (!playback?.trips?.length) {
        truckMeshes.forEach((mesh) => {
          mesh.visible = false;
          mesh.position.set(0, -1000, 0);
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
            color: 0x3a4047,
            emissive: 0x1a1f24,
            mix: 0.82,
            emissiveMix: 0.18,
            emissiveIntensity: 0.08,
          },
          idle: {
            color: 0x23282e,
            emissive: 0x080b0e,
            mix: 0.14,
            emissiveMix: 0.04,
            emissiveIntensity: 0.03,
          },
          gradientStops: [0x23282e, 0x2b3138, 0x3a4047],
          emissiveStops: [0x080b0e, 0x11161b, 0x1a1f24],
        });
      }

      const destinationState = rigVisualStateRef.current.destination;
      if (destinationState?.capturedMaterials?.length) {
        applyStatusPalette(destinationState.capturedMaterials, riggedCount / totalTrips, {
          active: {
            color: 0x3a4047,
            emissive: 0x1a1f24,
            mix: 0.82,
            emissiveMix: 0.18,
            emissiveIntensity: 0.08,
          },
          idle: {
            color: 0x23282e,
            emissive: 0x080b0e,
            mix: 0.14,
            emissiveMix: 0.04,
            emissiveIntensity: 0.03,
          },
          gradientStops: [0x23282e, 0x2b3138, 0x3a4047],
          emissiveStops: [0x080b0e, 0x11161b, 0x1a1f24],
        });
      }

      truckMeshes.forEach((mesh, truckId) => {
        if (truckId > activeTruckCount) {
          mesh.visible = false;
          mesh.position.set(0, -1000, 0);
          return;
        }

        const assignedTruckType = truckTypeAssignments[truckId - 1] || "LowBed";
        const truckBodyOffset = getTruckVariantRoadOffset(assignedTruckType);
        if (mesh.userData?.truckType !== assignedTruckType) {
          setTruckVariantVisible(mesh, assignedTruckType);
        }

        const truckTrips = playback?.trips?.filter((trip) => trip.truckId === truckId) || [];
        if (!truckTrips.length) {
          mesh.visible = false;
          mesh.position.set(0, -1000, 0);
          return;
        }

        const getTripEndMinute = (trip) => trip?.returnToSource ?? trip?.returnStart ?? trip?.arrivalAtDestination;
        const activeTrip = truckTrips.find((trip) => {
          const tripEnd = getTripEndMinute(trip);
          const tripStart = trip.dispatchStart ?? trip.moveStart ?? trip.loadStart ?? 0;
          return minute >= tripStart && minute <= tripEnd;
        });
        const nextTrip = truckTrips.find((trip) => minute < (trip.dispatchStart ?? trip.moveStart ?? trip.loadStart ?? 0)) || null;
        const completedTrip = [...truckTrips].reverse().find((trip) => {
          const tripEnd = getTripEndMinute(trip);
          return minute > tripEnd;
        }) || null;
        const sourceSiteParking = getRigBoardParkingWorld(
          straightStartWorld.clone().setY(0),
          routeDirectionWorld,
          24,
          truckId,
        );
        const destinationSiteParking = getRigBoardParkingWorld(
          straightEndWorld.clone().setY(0),
          routeDirectionWorld.clone().multiplyScalar(-1),
          28,
          truckId,
        );
        const sourceLaneParking = getLaneParkingWorld(truckId, "outbound", activeTrip);
        const destinationLaneParking = getLaneParkingWorld(truckId, "inbound", activeTrip);

        let currentWorld = roadStartWorld;
        let nextWorld = roadStartWorld;
        let distanceKm = 0;
        const tripStartMinute = activeTrip?.moveStart ?? activeTrip?.pickupLoadFinish ?? activeTrip?.rigDownFinish ?? 0;
        const returnStartMinute = activeTrip?.returnStart ?? activeTrip?.rigUpFinish ?? activeTrip?.arrivalAtDestination ?? 0;
        const activeTripHasReturnToSource = Number.isFinite(Number(activeTrip?.returnToSource));
        const roadHoldState = getTruckRoadHoldState(playback, minute, truckId, executionAssignmentsRef.current);
        const delayState = getTruckDelayState(playback, delayMinuteRef.current, truckId, executionAssignmentsRef.current);
        const holdingAtDestinationOnRoad = roadHoldState.holdOutbound;
        const holdingAtSourceOnRoad = roadHoldState.holdReturn;
        const returnStartedConfirmed = roadHoldState.returnStartedConfirmed;
        const hasCompletedReturnToSource = Boolean(
          roadHoldState.returnArrivalConfirmed ||
          (activeTrip && Number.isFinite(Number(activeTrip?.returnToSource)) && minute >= Number(activeTrip.returnToSource) && !holdingAtSourceOnRoad),
        );
        const parkedAtDestination =
          !holdingAtDestinationOnRoad &&
          roadHoldState.outboundArrivalConfirmed &&
          !hasCompletedReturnToSource &&
          (
            (activeTrip && minute >= activeTrip.arrivalAtDestination && minute < returnStartMinute) ||
            (!activeTrip && Boolean(completedTrip))
          );
        const parkedAtSource =
          (!holdingAtSourceOnRoad && hasCompletedReturnToSource) ||
          (!activeTrip && (!completedTrip || !roadHoldState.outboundArrivalConfirmed || roadHoldState.returnArrivalConfirmed)) ||
          (activeTrip && minute < activeTrip.rigDownFinish) ||
          (activeTrip && minute < tripStartMinute);

        if (!activeTrip) {
          if (parkedAtDestination) {
            currentWorld = destinationSiteParking.position.clone();
            nextWorld = currentWorld;
            distanceKm = routeDistanceKm;
          } else if (holdingAtSourceOnRoad) {
            const inboundLaneMetrics = getTravelLaneMetrics(truckId, "inbound", completedTrip);
            currentWorld = interpolateWorldPathWithEndpointOffset(inboundLaneMetrics, 1, truckBodyOffset, roadTravelHeight);
            nextWorld = currentWorld;
            distanceKm = 0;
          } else if (parkedAtSource) {
            currentWorld = sourceSiteParking.position.clone();
            nextWorld = currentWorld;
            distanceKm = 0;
          }
        } else if (parkedAtSource) {
          currentWorld = sourceSiteParking.position.clone();
          nextWorld = currentWorld;
          distanceKm = 0;
        } else if (minute < activeTrip.arrivalAtDestination) {
          const tripDuration = Math.max(activeTrip.arrivalAtDestination - tripStartMinute, 1);
          const outboundRatio = Math.max(0, Math.min(1, (minute - tripStartMinute) / tripDuration));
          const forwardMinute = Math.min(minute + 0.6, activeTrip.arrivalAtDestination);
          const nextOutboundRatio = Math.max(0, Math.min(1, (forwardMinute - tripStartMinute) / tripDuration));
          const outboundLaneMetrics = getTravelLaneMetrics(truckId, "outbound", activeTrip);
          currentWorld = interpolateWorldPathWithEndpointOffset(outboundLaneMetrics, outboundRatio, truckBodyOffset, roadTravelHeight);
          nextWorld = interpolateWorldPathWithEndpointOffset(outboundLaneMetrics, nextOutboundRatio, truckBodyOffset, roadTravelHeight);
          distanceKm = routeDistanceKm * Math.max(0, Math.min(1, outboundRatio));
        } else if (holdingAtDestinationOnRoad) {
          const outboundLaneMetrics = getTravelLaneMetrics(truckId, "outbound", activeTrip);
          currentWorld = interpolateWorldPathWithEndpointOffset(outboundLaneMetrics, 1, truckBodyOffset, roadTravelHeight);
          nextWorld = currentWorld;
          distanceKm = routeDistanceKm;
        } else if (!returnStartedConfirmed || minute < returnStartMinute) {
          currentWorld = destinationSiteParking.position.clone();
          nextWorld = currentWorld;
          distanceKm = routeDistanceKm;
        } else if (returnStartedConfirmed && activeTripHasReturnToSource && minute < Number(activeTrip.returnToSource)) {
          const tripDuration = Math.max(Number(activeTrip.returnToSource) - returnStartMinute, 1);
          const inboundRatio = (minute - returnStartMinute) / tripDuration;
          const forwardMinute = Math.min(minute + 0.6, Number(activeTrip.returnToSource));
          const nextInboundRatio = (forwardMinute - returnStartMinute) / tripDuration;
          const inboundLaneMetrics = getTravelLaneMetrics(truckId, "inbound", activeTrip);
          currentWorld = interpolateWorldPathWithEndpointOffset(inboundLaneMetrics, inboundRatio, truckBodyOffset, roadTravelHeight);
          nextWorld = interpolateWorldPathWithEndpointOffset(inboundLaneMetrics, nextInboundRatio, truckBodyOffset, roadTravelHeight);
          distanceKm = routeDistanceKm * Math.max(0, 1 - Math.min(1, inboundRatio));
        } else if (holdingAtSourceOnRoad) {
          const inboundLaneMetrics = getTravelLaneMetrics(truckId, "inbound", activeTrip);
          currentWorld = interpolateWorldPathWithEndpointOffset(inboundLaneMetrics, 1, truckBodyOffset, roadTravelHeight);
          nextWorld = currentWorld;
          distanceKm = 0;
        } else {
          currentWorld = parkedAtDestination
            ? destinationSiteParking.position.clone()
            : sourceSiteParking.position.clone();
          nextWorld = currentWorld;
          distanceKm = parkedAtDestination ? routeDistanceKm : 0;
        }

        const deltaX = nextWorld.x - currentWorld.x;
        const deltaZ = nextWorld.z - currentWorld.z;
        const movementMagnitude = Math.hypot(deltaX, deltaZ);
        const lastHeading = truckHeadingRef.current.get(truckId) ?? 0;
        const movingHeading = movementMagnitude > 0.02 ? Math.atan2(deltaX, deltaZ) : lastHeading;
        const isParked =
          parkedAtDestination ||
          parkedAtSource ||
          (activeTrip && returnStartedConfirmed && !activeTripHasReturnToSource && minute >= returnStartMinute);
        let heading = lastHeading;
        if (isParked) {
          heading = getContinuousAngle(
            parkedAtDestination
              ? destinationSiteParking.heading
              : sourceSiteParking.heading,
            lastHeading,
          );
        } else if (activeTrip && minute < activeTrip.arrivalAtDestination) {
          const tripDuration = Math.max(activeTrip.arrivalAtDestination - tripStartMinute, 1);
          const outboundRatio = Math.max(0, Math.min(1, (minute - tripStartMinute) / tripDuration));
          heading = outboundRatio < 0
            ? getContinuousAngle(sourceSiteParking.heading, lastHeading)
            : getContinuousAngle(movingHeading, lastHeading);
        } else if (returnStartedConfirmed && activeTripHasReturnToSource && minute < Number(activeTrip.returnToSource)) {
          const tripDuration = Math.max(Number(activeTrip.returnToSource) - returnStartMinute, 1);
          const inboundRatio = Math.max(0, Math.min(1, (minute - returnStartMinute) / tripDuration));
          heading = inboundRatio < 0
            ? getContinuousAngle(destinationSiteParking.heading, lastHeading)
            : getContinuousAngle(movingHeading, lastHeading);
        } else {
          heading = getContinuousAngle(movingHeading, lastHeading);
        }
        mesh.visible = true;
        mesh.position.copy(currentWorld);
        mesh.rotation.y = heading;
        const activeAlert = activeTripAlertRef.current;
        const visibleLoadId = activeTrip?.loadId ?? completedTrip?.loadId ?? null;
        const alertMatchesTruck = Boolean(
          activeAlert && (
            (activeAlert?.assignmentId && String(activeAlert.assignmentId) === String(delayState.assignment?.id || "")) ||
            (activeAlert?.sourceAssignmentId && String(activeAlert.sourceAssignmentId) === String(delayState.assignment?.id || "")) ||
            (activeAlert?.linkedAssignmentId && String(activeAlert.linkedAssignmentId) === String(delayState.assignment?.id || "")) ||
            (activeAlert?.loadId != null && String(activeAlert.loadId) === String(visibleLoadId ?? ""))
          ),
        );
        const alertDrivenDelayed = Boolean(
          alertMatchesTruck && activeAlert?.tone === "red",
        );
        setTruckDelayVisualState(mesh, alertDrivenDelayed);
        const roadLight = mesh.userData?.roadLight;
        if (roadLight) {
          roadLight.visible = !isParked;
        }
        truckHeadingRef.current.set(truckId, heading);
        mesh.userData.status = holdingAtDestinationOnRoad
          ? "Awaiting arrival confirmation"
          : holdingAtSourceOnRoad
            ? "Awaiting source arrival confirmation"
            : getTruckStatus(playback, minute, truckId);
        mesh.userData.isDelayed = alertDrivenDelayed;
        mesh.userData.lateMinutes = alertMatchesTruck
          ? activeAlert?.lateMinutes ?? delayState.lateMinutes
          : delayState.lateMinutes;
        mesh.userData.plannedArrivalMinute =
          (alertMatchesTruck
            ? activeAlert?.plannedFinishMinute
            : null) ??
          delayState.assignment?.stagePlan?.rigMove?.finishMinute ??
          activeTrip?.arrivalAtDestination ??
          completedTrip?.arrivalAtDestination ??
          null;
        mesh.userData.loadId = activeTrip?.loadId ?? completedTrip?.loadId ?? null;
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

      if (sceneFocusResetKeyRef.current !== handledSceneFocusResetKeyRef.current) {
        handledSceneFocusResetKeyRef.current = sceneFocusResetKeyRef.current;
        if ((currentMinuteRef.current || 0) <= 0.25) {
          resetFocus();
        }
      }

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
      const playback = simulationRef.current?.bestPlan?.playback;
      if (focusedTruckIdRef.current != null) {
        const focusedTruck = truckMeshes.get(focusedTruckIdRef.current);
        if (focusedTruck?.visible) {
          const nextTarget = getTruckFocusTargetWorld(focusedTruck);
          const previousTarget = focusedTruckLastTargetRef.current;

          if (!previousTarget) {
            focusedTruckLastTargetRef.current = nextTarget.clone();
          } else if (!cameraTransitioningRef.current) {
            const followConfig = focusedTruckFollowConfigRef.current;
            const heading = truckHeadingRef.current.get(focusedTruckIdRef.current) ?? focusedTruck.rotation.y ?? 0;
            const desiredOffset = followConfig
              ? getTruckFollowOffset(heading, followConfig.distance, followConfig.lift)
              : (focusedTruckOffsetRef.current || camera.position.clone().sub(controls.target));
            controls.target.lerp(nextTarget, 0.18);
            camera.position.lerp(nextTarget.clone().add(desiredOffset), 0.18);
            focusedTruckOffsetRef.current = camera.position.clone().sub(controls.target);
            zoomState.currentTarget.copy(controls.target);
            zoomState.desiredTarget.copy(controls.target);
            zoomState.currentPosition.copy(camera.position);
            zoomState.desiredPosition.copy(camera.position);
            focusedTruckLastTargetRef.current.copy(nextTarget);
          } else {
            focusedTruckLastTargetRef.current = nextTarget.clone();
          }
        }
      }
      highlightTargets.forEach((target, key) => {
        const isActive = hoveredObjectRef.current === key;
        const highlightStrength = isActive
          ? (0.44 + ((Math.sin(elapsedSeconds * 5.8) + 1) * 0.14)) * (target.intensityFactor ?? 1)
          : 0;
        const truckIsDelayed = target.kind === "truck" && Boolean(target.root?.userData?.isDelayed);
        const delayedTruckStrength = truckIsDelayed
          ? 0.34 + ((Math.sin(elapsedSeconds * 5.8) + 1) * 0.1)
          : 0;
        const effectiveStrength = Math.max(highlightStrength, delayedTruckStrength);
        const highlightColor = target.kind === "truck" && target.root?.userData?.isDelayed
          ? (target.delayedColor || target.color)
          : target.color;
        const highlightOptions = truckIsDelayed
          ? {
              ...target.highlightOptions,
              hoverBaseColor: 0x301010,
              maxLineMix: 0.68,
              maxSurfaceMix: 0.6,
              lineMixScale: 0.72,
              surfaceMixScale: 0.74,
              emissiveMixScale: 0.62,
              baseMixScale: 0.24,
            }
          : target.highlightOptions;
        if (target.kind === "rig-component" && isActive) {
          applyRigComponentHoverState(target.capturedMaterials, highlightColor, effectiveStrength);
        } else {
          applyHighlightState(target.capturedMaterials, highlightColor, effectiveStrength, highlightOptions);
        }
        if (truckIsDelayed) {
          setTruckDelayVisualState(target.root, true, delayedTruckStrength);
        } else if (target.kind === "truck") {
          setTruckDelayVisualState(target.root, false, 0);
        }
        if (target.kind === "rig-component") {
          target.root.scale.copy(target.baseScale);
        } else {
          target.root.scale.copy(target.baseScale);
        }
      });
      if (hoveredRigComponentRef.current) {
        const hoveredTarget = highlightTargets.get(hoveredObjectRef.current);
        const hoverStrength =
          hoveredTarget?.kind === "rig-component" && hoveredObjectRef.current
            ? (0.44 + ((Math.sin(elapsedSeconds * 5.8) + 1) * 0.14)) * (hoveredTarget.intensityFactor ?? 1)
            : 0.58;
        setRigComponentDirectHover(hoveredRigComponentRef.current, hoverStrength);
      }
      controls.update();
      renderer.render(scene, camera);
    }

    animationFrameId = window.requestAnimationFrame(animate);

    return () => {
      disposed = true;
      onReadyStateChange?.(false);
      onRigFocusChange?.(null);
      onTruckFocusChange?.(null);
      onFocusChange?.(null);
      assetsReadyRef.current = false;
      focusedTruckLastTargetRef.current = null;
      window.cancelAnimationFrame(animationFrameId);
      resizeObserver.disconnect();
      renderer.domElement.removeEventListener("pointerdown", handlePointerDown);
      renderer.domElement.removeEventListener("pointermove", handlePointerMove);
      renderer.domElement.removeEventListener("pointerleave", handlePointerLeave);
      renderer.domElement.removeEventListener("dblclick", resetFocus);
      controls.removeEventListener("start", handleControlsStart);
      controls.removeEventListener("change", handleControlsChange);
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
  }, [startPointKey, endPointKey, startLabel, endLabel, routeGeometryKey]);

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
      h("span", { className: "scene-3d-tooltip-line", "data-tooltip-line": "delay" }, ""),
      h("span", { className: "scene-3d-tooltip-line", "data-tooltip-line": "arrival" }, ""),
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

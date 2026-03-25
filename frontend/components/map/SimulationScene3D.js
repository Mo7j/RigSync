import { React, h } from "../../lib/react.js";
import * as THREE from "https://esm.sh/three@0.179.1";
import { OrbitControls } from "https://esm.sh/three@0.179.1/examples/jsm/controls/OrbitControls.js";
import { GLTFLoader } from "https://esm.sh/three@0.179.1/examples/jsm/loaders/GLTFLoader.js";
import { getTruckStatus, haversineKilometers } from "../../features/rigMoves/simulation.js";

const { useEffect, useRef } = React;
const assetLoader = new GLTFLoader();
const assetTemplateCache = new Map();
let platformEdgeFadeTexture = null;

const MODEL_PATHS = {
  flatbedTruck: "/assets/models/FlatBed.glb",
  lowbedTruck: "/assets/models/LowBed.glb",
  heavyHaulerTruck: "/assets/models/HeavyHauler.glb",
  rig: "/assets/models/1.glb",
  terrain: "/assets/models/m.glb",
};

export function preloadSimulationSceneAssets() {
  return Promise.all([
    loadModelTemplate("flatbedTruck"),
    loadModelTemplate("lowbedTruck"),
    loadModelTemplate("heavyHaulerTruck"),
    loadModelTemplate("rig"),
    loadModelTemplate("terrain"),
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
    return { objects: [], root: null };
  }

  const routeSegments = new THREE.Group();
  const routeMaterial = new THREE.MeshStandardMaterial({
    color: 0x31383f,
    emissive: 0x07090b,
    emissiveIntensity: 0.03,
    metalness: 0.12,
    roughness: 0.78,
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
      opacity: 0,
    }),
  );
  routeLine.position.y = 1.16;

  return { objects: [routeSegments, routeLine], root: routeSegments };
}

function createRigBoard(position, routeDirection, radius = 18) {
  const boardHeight = 2.4;
  const approachDirection = routeDirection.clone().setY(0);
  if (approachDirection.lengthSq() < 0.0001) {
    approachDirection.set(0, 0, 1);
  } else {
    approachDirection.normalize();
  }
  const openingHalfAngle = Math.PI / 5.5;
  const openingCenterAngle = Math.atan2(approachDirection.z, approachDirection.x);
  const fenceStartAngle = openingCenterAngle + openingHalfAngle;
  const fenceArcAngle = (Math.PI * 2) - (openingHalfAngle * 2);
  const board = new THREE.Mesh(
    new THREE.CylinderGeometry(radius, radius, boardHeight, 48),
    new THREE.MeshStandardMaterial({
      color: 0x2d3339,
      emissive: 0x050608,
      emissiveIntensity: 0.03,
      metalness: 0.12,
      roughness: 0.78,
      transparent: true,
      opacity: 0.94,
    }),
  );
  board.position.copy(position);
  board.position.y = boardHeight / 2;
  board.receiveShadow = true;

  const boardRing = new THREE.Mesh(
    new THREE.RingGeometry(radius * 0.8, radius * 0.84, 64),
    new THREE.MeshStandardMaterial({
      color: 0x333940,
      emissive: 0x06080a,
      emissiveIntensity: 0.02,
      metalness: 0.08,
      roughness: 0.84,
      transparent: true,
      opacity: 0.32,
      side: THREE.DoubleSide,
      polygonOffset: true,
      polygonOffsetFactor: -1,
      polygonOffsetUnits: -2,
    }),
  );
  boardRing.position.copy(position);
  boardRing.position.y = boardHeight + 0.01;
  boardRing.rotation.x = Math.PI / 2;

  const fenceWall = new THREE.Mesh(
    new THREE.CylinderGeometry(radius * 0.96, radius * 0.96, 1.4, 48, 1, true, fenceStartAngle, fenceArcAngle),
    new THREE.MeshStandardMaterial({
      color: 0x30363d,
      emissive: 0x06080a,
      emissiveIntensity: 0.02,
      metalness: 0.12,
      roughness: 0.82,
      transparent: true,
      opacity: 0.55,
      side: THREE.DoubleSide,
    }),
  );
  fenceWall.position.copy(position);
  fenceWall.position.y = boardHeight + 0.7;

  const fenceTopRing = new THREE.Mesh(
    new THREE.TorusGeometry(radius * 0.96, 0.16, 16, 64, fenceArcAngle),
    new THREE.MeshStandardMaterial({
      color: 0x383f47,
      emissive: 0x06080a,
      emissiveIntensity: 0.02,
      metalness: 0.14,
      roughness: 0.8,
    }),
  );
  fenceTopRing.position.copy(position);
  fenceTopRing.position.y = boardHeight + 1.42;
  fenceTopRing.rotation.x = Math.PI / 2;
  fenceTopRing.rotation.z = fenceStartAngle;

  const fencePosts = [];
  const postCount = 12;
  for (let index = 0; index < postCount; index += 1) {
    const angle = (index / postCount) * Math.PI * 2;
    const radialDirection = new THREE.Vector3(Math.cos(angle), 0, Math.sin(angle));
    if (radialDirection.angleTo(approachDirection) < openingHalfAngle) {
      continue;
    }
    const post = new THREE.Mesh(
      new THREE.CylinderGeometry(0.16, 0.16, 1.4, 12),
      new THREE.MeshStandardMaterial({
        color: 0x343b42,
        emissive: 0x06080a,
        emissiveIntensity: 0.02,
        metalness: 0.14,
        roughness: 0.78,
      }),
    );
    post.position.set(
      position.x + (Math.cos(angle) * radius * 0.96),
      boardHeight + 0.7,
      position.z + (Math.sin(angle) * radius * 0.96),
    );
    fencePosts.push(post);
  }

  return [board, boardRing, fenceWall, fenceTopRing, ...fencePosts];
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
  sceneFocusResetKey = 0,
  heightClass = "map-frame",
  showOverlay = true,
  onReadyStateChange = null,
  onRigFocusChange = null,
}) {
  const hostRef = useRef(null);
  const overlayRef = useRef(null);
  const tooltipRef = useRef(null);
  const currentMinuteRef = useRef(currentMinute);
  const sceneFocusResetKeyRef = useRef(sceneFocusResetKey);
  const handledSceneFocusResetKeyRef = useRef(sceneFocusResetKey);
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
  const focusedTruckIdRef = useRef(null);
  const focusedTruckOffsetRef = useRef(null);
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
    tooltip.querySelector("[data-tooltip-line='state']").textContent = content.state;
    tooltip.querySelector("[data-tooltip-line='assigned']").textContent = content.assigned;
    tooltip.querySelector("[data-tooltip-line='progress']").textContent = content.progress;
    tooltip.querySelector("[data-tooltip-line='moving']").textContent = content.moving;

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

    return {
      title: `Truck ${truckInfo.truckId}`,
      state: `State: ${truckInfo.status || "Waiting"}`,
      assigned: loadLabel,
      progress: `Route progress: ${progress}%`,
      moving: `Distance: ${distanceKm.toFixed(1)} / ${routeDistanceKm.toFixed(1)} km`,
    };
  }

  function buildRouteTooltip(routeInfo) {
    const distanceKm = Number.isFinite(routeInfo.distanceKm) ? routeInfo.distanceKm : 0;
    return {
      title: "Move Route",
      state: "State: Source to destination",
      assigned: `Distance: ${distanceKm.toFixed(1)} km`,
      progress: "Path: Active haul corridor",
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
    const routeSideWorld = new THREE.Vector3(-routeDirectionWorld.z, 0, routeDirectionWorld.x).normalize();
    const parkedTruckHeading = Math.atan2(routeDirectionWorld.x, routeDirectionWorld.z);
    const sourceParkingAnchor = straightStartWorld.clone()
      .add(routeDirectionWorld.clone().multiplyScalar(-30));
    const destinationParkingAnchor = straightEndWorld.clone()
      .add(routeDirectionWorld.clone().multiplyScalar(30));

    function getParkingWorld(anchor, truckId) {
      const slotIndex = Math.max(0, truckId - 1);
      const truckCount = Math.max(1, simulationRef.current?.truckCount || truckMeshes.size);
      const centeredIndex = slotIndex - ((truckCount - 1) / 2);

      return anchor.clone().add(routeSideWorld.clone().multiplyScalar(centeredIndex * 11));
    }

    function getSourceParkingWorld(truckId) {
      return getParkingWorld(sourceParkingAnchor, truckId);
    }

    function getDestinationParkingWorld(truckId) {
      return getParkingWorld(destinationParkingAnchor, truckId);
    }

    const scene = new THREE.Scene();
    scene.background = null;
    scene.fog = new THREE.FogExp2(0x25292f, 0.0018);

    const camera = new THREE.PerspectiveCamera(44, 1, 0.1, 1200);
    const cameraDistance = Math.max(120, Math.min(220, projection.extent * 0.12));
    camera.position.set(cameraDistance, cameraDistance * 0.56, cameraDistance * 1.02);
    const defaultCameraPosition = camera.position.clone();
    const defaultTarget = new THREE.Vector3(0, 7, 0);
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
    controls.maxPolarAngle = Math.PI * 0.4;
    controls.minPolarAngle = Math.PI * 0.2;
    const handleControlsStart = () => {
      cameraTransitioningRef.current = false;
      zoomState.currentTarget.copy(controls.target);
      zoomState.desiredTarget.copy(controls.target);
      zoomState.currentPosition.copy(camera.position);
      zoomState.desiredPosition.copy(camera.position);
    };
    controls.addEventListener("start", handleControlsStart);

    const floorGroup = createFloor(projection.extent);
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
    const routeObjects = createRouteObjects(projectedRoute);
    routeObjects.objects.forEach((object) => routeGroup.add(object));
    scene.add(routeGroup);
    const truckPoolCount = Math.max(24, simulation?.truckCount || 0, (simulation?.truckSetup?.length || 1) * 8);

    const truckAccent = 0x647587;
    const padAssetsGroup = new THREE.Group();
    scene.add(padAssetsGroup);

    const trucksGroup = new THREE.Group();
    scene.add(trucksGroup);

    const truckMeshes = new Map();
    const pulseTargets = [];
    const rigPickTargets = [];
    const truckPickTargets = [];
    const boardPickTargets = [];
    const routePickTargets = [];
    const highlightTargets = new Map();

    if (routeObjects.root) {
      routeObjects.root.userData = {
        ...routeObjects.root.userData,
        routeInfo: {
          distanceKm: measuredRouteMetrics.totalKm,
          startName: getLocationLabel(startLabel, "Source"),
          endName: getLocationLabel(endLabel, "Destination"),
        },
        highlightKey: "move-route",
      };
      routePickTargets.push(routeObjects.root);
      highlightTargets.set("move-route", {
        root: routeObjects.root,
        capturedMaterials: captureHighlightMaterials(routeObjects.root),
        color: 0xfbbf24,
        kind: "route",
        intensityFactor: 0.52,
        highlightOptions: {
          maxSurfaceMix: 0.24,
          surfaceMixScale: 0.3,
          emissiveMixScale: 0.22,
        },
        baseScale: routeObjects.root.scale.clone(),
      });
    }

    function registerPulseTargets(root) {
      root.traverse((child) => {
        if (child.userData?.pulse) {
          pulseTargets.push(child);
        }
      });
    }

    function createTruckInstance(truckId) {
      const truckRoot = new THREE.Group();
      const fallbackMesh = createTruckFallbackMesh(truckAccent);
      truckRoot.add(fallbackMesh);
      truckRoot.visible = false;
      truckRoot.userData = {
        truckId,
        status: "",
        truckVariants: {
          fallback: fallbackMesh,
        },
        activeTruckVariantKey: "fallback",
      };
      return truckRoot;
    }

    async function buildAssets() {
      const truckTemplates = {};
      let rigTemplate = null;
      let terrainTemplate = null;

      try {
        const [flatbedTruckTemplate, lowbedTruckTemplate, heavyHaulerTruckTemplate, nextRigTemplate, nextTerrainTemplate] = await Promise.all([
          loadModelTemplate("flatbedTruck"),
          loadModelTemplate("lowbedTruck"),
          loadModelTemplate("heavyHaulerTruck"),
          loadModelTemplate("rig"),
          loadModelTemplate("terrain"),
        ]);
        truckTemplates.flatbedTruck = flatbedTruckTemplate;
        truckTemplates.lowbedTruck = lowbedTruckTemplate;
        truckTemplates.heavyHaulerTruck = heavyHaulerTruckTemplate;
        rigTemplate = nextRigTemplate;
        terrainTemplate = nextTerrainTemplate;
      } catch (error) {
        console.warn("3D assets failed to load, using fallback geometry instead.", error);
      }

      if (disposed) {
        return;
      }

      if (terrainTemplate) {
        const terrainInset = platformSize * 0.31;
        const terrainPresets = [
          { x: -terrainInset * 0.82, z: -terrainInset * 0.64, width: 156, height: 36, rotation: Math.PI * 0.5 },
          { x: terrainInset * 0.86, z: -terrainInset, width: 128, height: 29, rotation: -Math.PI * 0.5 },
          { x: terrainInset * 0.18, z: terrainInset, width: 124, height: 27, rotation: Math.PI * 0.5 },
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
      }

      if (startPoint) {
        const startBoardParts = createRigBoard(projection.project(startPoint, 0), routeDirectionWorld, 18);
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
        const startAsset = rigTemplate
          ? centerAndScaleModel(cloneModelWithUniqueMaterials(rigTemplate), { targetWidth: 49, targetHeight: 27, lift: 0 })
          : createPadFallback(projection.project(startPoint, 0), 0x1de9d5, -6);
        if (rigTemplate) {
          tintModel(startAsset, 0x596069);
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
        const endBoardParts = createRigBoard(projection.project(endPoint, 0), routeDirectionWorld.clone().multiplyScalar(-1), 22);
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
        const endAsset = rigTemplate
          ? centerAndScaleModel(cloneModelWithUniqueMaterials(rigTemplate), { targetWidth: 63, targetHeight: 36, lift: 0 })
          : createPadFallback(projection.project(endPoint, 0), 0xc6ff00, 6);
        if (rigTemplate) {
          tintModel(endAsset, 0x596069);
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
          centerAndScaleModel(variantMesh, { targetWidth: 16.2, targetHeight: 9.2, lift: 0 });
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
      onRigFocusChange?.(focusedRigSideRef.current);
      cameraTransitioningRef.current = true;
    }

    function focusOnTruck(targetObject) {
      const bounds = new THREE.Box3().setFromObject(targetObject);
      const center = bounds.getCenter(new THREE.Vector3());
      const size = bounds.getSize(new THREE.Vector3());
      const focusDistance = Math.max(size.x, size.y, size.z, 10);
      const direction = new THREE.Vector3(0.94, 0.3, 0.86).normalize();

      zoomState.desiredTarget.copy(center);
      zoomState.desiredTarget.y = Math.max(center.y, 2.8);
      zoomState.desiredPosition.copy(center).add(direction.multiplyScalar(focusDistance * 2.4));
      focusedRigSideRef.current = null;
      focusedTruckIdRef.current = targetObject.userData?.truckId ?? null;
      focusedTruckOffsetRef.current = zoomState.desiredPosition.clone().sub(zoomState.desiredTarget);
      onRigFocusChange?.(null);
      cameraTransitioningRef.current = true;
    }

    function resetFocus() {
      zoomState.desiredTarget.copy(defaultTarget);
      zoomState.desiredPosition.copy(defaultCameraPosition);
      focusedRigSideRef.current = null;
      focusedTruckIdRef.current = null;
      focusedTruckOffsetRef.current = null;
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
      const activeTruckCount = Math.max(1, nextSimulation?.truckCount || 0);
      const truckTypeAssignments = buildTruckTypeAssignments(nextSimulation?.truckSetup, activeTruckCount);
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
          return;
        }

        const assignedTruckType = truckTypeAssignments[truckId - 1] || "LowBed";
        if (mesh.userData?.truckType !== assignedTruckType) {
          setTruckVariantVisible(mesh, assignedTruckType);
        }

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
            currentWorld = getDestinationParkingWorld(truckId);
            nextWorld = currentWorld;
            distanceKm = routeDistanceKm;
          } else {
            currentWorld = getSourceParkingWorld(truckId);
            nextWorld = currentWorld;
          }
        } else if (minute < activeTrip.rigDownFinish) {
          currentWorld = getSourceParkingWorld(truckId);
          nextWorld = currentWorld;
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
          currentWorld = getDestinationParkingWorld(truckId);
          nextWorld = currentWorld;
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
          currentWorld = getDestinationParkingWorld(truckId);
          nextWorld = currentWorld;
          distanceKm = routeDistanceKm;
        }

        const deltaX = nextWorld.x - currentWorld.x;
        const deltaZ = nextWorld.z - currentWorld.z;
        const movementMagnitude = Math.hypot(deltaX, deltaZ);
        const lastHeading = truckHeadingRef.current.get(truckId) ?? 0;
        const isParked =
          (!activeTrip && !deliveredTrip) ||
          (!activeTrip && Boolean(deliveredTrip && !deliveredTrip.returnToSource)) ||
          (activeTrip && minute < activeTrip.rigDownFinish) ||
          (activeTrip && minute >= activeTrip.arrivalAtDestination && minute < activeTrip.rigUpFinish) ||
          (activeTrip && !activeTrip.returnToSource && minute >= activeTrip.rigUpFinish);
        const heading =
          isParked
            ? parkedTruckHeading
            : movementMagnitude > 0.02
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

      if (sceneFocusResetKeyRef.current !== handledSceneFocusResetKeyRef.current) {
        handledSceneFocusResetKeyRef.current = sceneFocusResetKeyRef.current;
        resetFocus();
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
      if (
        focusedTruckIdRef.current != null &&
        playback?.totalMinutes != null &&
        currentMinuteRef.current >= playback.totalMinutes
      ) {
        resetFocus();
      }
      if (focusedTruckIdRef.current != null) {
        const focusedTruck = truckMeshes.get(focusedTruckIdRef.current);
        const cameraOffset = focusedTruckOffsetRef.current;
        if (focusedTruck?.visible && cameraOffset) {
          const nextTarget = focusedTruck.position.clone();
          nextTarget.y = Math.max(nextTarget.y, 3.4);
          zoomState.desiredTarget.copy(nextTarget);
          zoomState.desiredPosition.copy(nextTarget).add(cameraOffset);
          cameraTransitioningRef.current = true;
        }
      }
      highlightTargets.forEach((target, key) => {
        const isActive = hoveredObjectRef.current === key;
        const highlightStrength = isActive
          ? (0.44 + ((Math.sin(elapsedSeconds * 5.8) + 1) * 0.14)) * (target.intensityFactor ?? 1)
          : 0;
        if (target.kind === "rig-component" && isActive) {
          applyRigComponentHoverState(target.capturedMaterials, target.color, highlightStrength);
        } else {
          applyHighlightState(target.capturedMaterials, target.color, highlightStrength, target.highlightOptions);
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
      assetsReadyRef.current = false;
      window.cancelAnimationFrame(animationFrameId);
      resizeObserver.disconnect();
      renderer.domElement.removeEventListener("pointerdown", handlePointerDown);
      renderer.domElement.removeEventListener("pointermove", handlePointerMove);
      renderer.domElement.removeEventListener("pointerleave", handlePointerLeave);
      renderer.domElement.removeEventListener("dblclick", resetFocus);
      controls.removeEventListener("start", handleControlsStart);
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
  }, [startPoint, endPoint, startLabel, endLabel]);

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

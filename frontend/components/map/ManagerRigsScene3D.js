import { React, h } from "../../lib/react.js";
import * as THREE from "https://esm.sh/three@0.179.1";
import { OrbitControls } from "https://esm.sh/three@0.179.1/examples/jsm/controls/OrbitControls.js";
import { GLTFLoader } from "https://esm.sh/three@0.179.1/examples/jsm/loaders/GLTFLoader.js";
import {
  SAUDI_BORDER_POINTS,
} from "./saudiShape.js";

const { useEffect, useRef } = React;

const BOARD_WIDTH = 168;
const BOARD_HEIGHT = 186;
const TERRAIN_DEPTH = 7.5;
const SURFACE_SEGMENTS = 18;
const modelLoader = new GLTFLoader();
let rigTemplatePromise = null;

function pointsMatch(a, b, epsilon = 0.0001) {
  return Math.abs((a?.x || 0) - (b?.x || 0)) <= epsilon && Math.abs((a?.y || 0) - (b?.y || 0)) <= epsilon;
}

function normalizePolygon(points) {
  const normalized = (points || []).map((point) => point.clone());
  if (normalized.length > 2 && pointsMatch(normalized[0], normalized[normalized.length - 1])) {
    normalized.pop();
  }
  if (!THREE.ShapeUtils.isClockWise(normalized)) {
    normalized.reverse();
  }
  return normalized;
}

function createBoardProjection() {
  const mercatorPoints = SAUDI_BORDER_POINTS.map(([lat, lng]) => {
    const clampedLat = Math.max(-85, Math.min(85, lat));
    const latRad = (clampedLat * Math.PI) / 180;
    return {
      x: (lng * Math.PI) / 180,
      y: Math.log(Math.tan((Math.PI / 4) + (latRad / 2))),
    };
  });

  const minX = Math.min(...mercatorPoints.map((point) => point.x));
  const maxX = Math.max(...mercatorPoints.map((point) => point.x));
  const minY = Math.min(...mercatorPoints.map((point) => point.y));
  const maxY = Math.max(...mercatorPoints.map((point) => point.y));
  const spanX = Math.max(maxX - minX, 0.00001);
  const spanY = Math.max(maxY - minY, 0.00001);
  const scale = Math.min(BOARD_WIDTH / spanX, BOARD_HEIGHT / spanY);
  const fittedWidth = spanX * scale;
  const fittedHeight = spanY * scale;

  return {
    project(point) {
      const clampedLat = Math.max(-85, Math.min(85, point.lat));
      const latRad = (clampedLat * Math.PI) / 180;
      const mercatorX = (point.lng * Math.PI) / 180;
      const mercatorY = Math.log(Math.tan((Math.PI / 4) + (latRad / 2)));
      const normalizedX = (mercatorX - minX) / spanX;
      const normalizedY = 1 - ((mercatorY - minY) / spanY);

      return new THREE.Vector2(
        (normalizedX - 0.5) * fittedWidth,
        (normalizedY - 0.5) * fittedHeight,
      );
    },
  };
}

function isPointInsidePolygon(point, polygon) {
  let inside = false;
  for (let index = 0, previous = polygon.length - 1; index < polygon.length; previous = index, index += 1) {
    const current = polygon[index];
    const previousPoint = polygon[previous];
    const intersects = (
      ((current.y > point.y) !== (previousPoint.y > point.y)) &&
      (point.x < ((previousPoint.x - current.x) * (point.y - current.y)) / ((previousPoint.y - current.y) || 0.00001) + current.x)
    );
    if (intersects) {
      inside = !inside;
    }
  }
  return inside;
}

function closestPointOnSegment(point, start, end) {
  const segment = end.clone().sub(start);
  const lengthSquared = segment.lengthSq();
  if (!lengthSquared) {
    return start.clone();
  }
  const ratio = Math.max(0, Math.min(1, point.clone().sub(start).dot(segment) / lengthSquared));
  return start.clone().add(segment.multiplyScalar(ratio));
}

function clampPointToPolygon(point, polygon, insetDistance = 1.8) {
  if (isPointInsidePolygon(point, polygon)) {
    return point.clone();
  }

  let nearestPoint = polygon[0].clone();
  let nearestDistance = Infinity;

  for (let index = 0; index < polygon.length; index += 1) {
    const start = polygon[index];
    const end = polygon[(index + 1) % polygon.length];
    const candidate = closestPointOnSegment(point, start, end);
    const distance = candidate.distanceToSquared(point);
    if (distance < nearestDistance) {
      nearestDistance = distance;
      nearestPoint = candidate;
    }
  }

  const polygonCenter = polygon.reduce(
    (accumulator, entry) => accumulator.add(entry),
    new THREE.Vector2(0, 0),
  ).multiplyScalar(1 / Math.max(polygon.length, 1));

  const inward = polygonCenter.clone().sub(nearestPoint);
  if (inward.lengthSq()) {
    inward.normalize().multiplyScalar(insetDistance);
    nearestPoint.add(inward);
  }

  return nearestPoint;
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

function resolveRigCurrentPoint(rig) {
  if (rig?.executionState === "active" && rig?.routeGeometry?.length > 1) {
    return interpolateRoutePoint(rig.routeGeometry, rig.completionPercentage || 0);
  }
  if (rig?.operatingState === "drilling" || rig?.executionState === "completed") {
    return rig?.endPoint || rig?.startPoint || null;
  }
  return rig?.startPoint || rig?.endPoint || null;
}

function worldPoint(point2D, y) {
  return new THREE.Vector3(point2D.x, y, point2D.y);
}

function loadRigTemplate() {
  if (!rigTemplatePromise) {
    rigTemplatePromise = new Promise((resolve) => {
      modelLoader.load(
        "/assets/models/fRig.glb",
        (gltf) => resolve(gltf.scene),
        undefined,
        () => resolve(null),
      );
    });
  }
  return rigTemplatePromise;
}

function cloneModel(source) {
  const clone = source.clone(true);
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

function centerAndScaleModel(root, targetSize = 8.6) {
  const bounds = new THREE.Box3().setFromObject(root);
  const size = new THREE.Vector3();
  const center = new THREE.Vector3();
  bounds.getSize(size);
  bounds.getCenter(center);
  const scale = targetSize / Math.max(size.x, size.y, size.z, 1);
  root.scale.multiplyScalar(scale);

  const nextBounds = new THREE.Box3().setFromObject(root);
  const nextCenter = new THREE.Vector3();
  nextBounds.getCenter(nextCenter);
  root.position.x -= nextCenter.x;
  root.position.z -= nextCenter.z;
  root.position.y -= nextBounds.min.y;
  return root;
}

function tintRigModel(root, colorHex) {
  const tone = new THREE.Color(colorHex);
  root.traverse((child) => {
    if (!child.isMesh || !child.material) {
      return;
    }

    const materials = Array.isArray(child.material) ? child.material : [child.material];
    materials.forEach((material) => {
      if (material.color) {
        material.color.lerp(tone, 0.62);
      }
      if ("emissive" in material && material.emissive) {
        material.emissive.copy(tone).multiplyScalar(0.22);
        material.emissiveIntensity = 0.9;
      }
      if ("metalness" in material) {
        material.metalness = Math.min(0.24, material.metalness ?? 0.18);
      }
      if ("roughness" in material) {
        material.roughness = Math.max(0.42, material.roughness ?? 0.56);
      }
    });
  });
}

function createFallbackRig(color) {
  const group = new THREE.Group();
  const mast = new THREE.Mesh(
    new THREE.CylinderGeometry(0.22, 0.3, 6.4, 12),
    new THREE.MeshStandardMaterial({
      color,
      emissive: new THREE.Color(color).multiplyScalar(0.1),
      roughness: 0.48,
      metalness: 0.16,
    }),
  );
  mast.position.y = 4.2;
  mast.castShadow = true;
  group.add(mast);

  const crown = new THREE.Mesh(
    new THREE.ConeGeometry(0.92, 2.1, 6),
    new THREE.MeshStandardMaterial({
      color: 0xf4efdf,
      roughness: 0.58,
      metalness: 0.1,
    }),
  );
  crown.position.y = 8.2;
  crown.castShadow = true;
  group.add(crown);
  return group;
}

function createTerrainTexture() {
  const canvas = document.createElement("canvas");
  canvas.width = 1024;
  canvas.height = 1024;
  const context = canvas.getContext("2d");
  if (!context) {
    return null;
  }

  const gradient = context.createLinearGradient(0, 0, canvas.width, canvas.height);
  gradient.addColorStop(0, "#223f37");
  gradient.addColorStop(0.5, "#33594a");
  gradient.addColorStop(1, "#214236");
  context.fillStyle = gradient;
  context.fillRect(0, 0, canvas.width, canvas.height);

  for (let index = 0; index < 520; index += 1) {
    const x = Math.random() * canvas.width;
    const y = Math.random() * canvas.height;
    const radius = 8 + (Math.random() * 28);
    context.fillStyle = `rgba(110, 255, 177, ${0.015 + (Math.random() * 0.05)})`;
    context.beginPath();
    context.arc(x, y, radius, 0, Math.PI * 2);
    context.fill();
  }

  context.strokeStyle = "rgba(196,255,220,0.08)";
  context.lineWidth = 1;
  for (let index = 0; index < 24; index += 1) {
    const y = (index / 24) * canvas.height;
    context.beginPath();
    context.moveTo(0, y);
    context.lineTo(canvas.width, y + ((Math.random() - 0.5) * 40));
    context.stroke();
  }

  for (let index = 0; index < 18; index += 1) {
    const x = (index / 18) * canvas.width;
    context.beginPath();
    context.moveTo(x, 0);
    context.lineTo(x + ((Math.random() - 0.5) * 60), canvas.height);
    context.stroke();
  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.needsUpdate = true;
  return texture;
}

function createPointSpriteTexture(colorHex = "#7dffbc") {
  const canvas = document.createElement("canvas");
  canvas.width = 64;
  canvas.height = 64;
  const context = canvas.getContext("2d");
  if (!context) {
    return null;
  }

  const gradient = context.createRadialGradient(32, 32, 2, 32, 32, 28);
  gradient.addColorStop(0, "#ffffff");
  gradient.addColorStop(0.25, colorHex);
  gradient.addColorStop(1, "rgba(0,0,0,0)");
  context.fillStyle = gradient;
  context.beginPath();
  context.arc(32, 32, 28, 0, Math.PI * 2);
  context.fill();

  const texture = new THREE.CanvasTexture(canvas);
  texture.needsUpdate = true;
  return texture;
}

function createTerrainGlow(centeredOutline) {
  const glowGroup = new THREE.Group();
  [1.02, 1.035, 1.055].forEach((scale, index) => {
    const ring = new THREE.LineLoop(
      new THREE.BufferGeometry().setFromPoints(
        centeredOutline.map((point) => worldPoint(point.clone().multiplyScalar(scale), TERRAIN_DEPTH - (index * 0.18))),
      ),
      new THREE.LineBasicMaterial({
        color: index === 0 ? 0x88ffb9 : 0x42ff8e,
        transparent: true,
        opacity: index === 0 ? 0.3 : 0.12,
      }),
    );
    glowGroup.add(ring);
  });
  return glowGroup;
}

function createStarField(count = 260) {
  const geometry = new THREE.BufferGeometry();
  const positions = new Float32Array(count * 3);
  const sizes = new Float32Array(count);

  for (let index = 0; index < count; index += 1) {
    positions[index * 3] = (Math.random() - 0.5) * 520;
    positions[(index * 3) + 1] = 40 + (Math.random() * 160);
    positions[(index * 3) + 2] = (Math.random() - 0.5) * 520;
    sizes[index] = 1 + (Math.random() * 2.6);
  }

  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute("size", new THREE.BufferAttribute(sizes, 1));

  const texture = createPointSpriteTexture("#96ffd2");
  const material = new THREE.PointsMaterial({
    color: 0xbefee4,
    size: 2.4,
    transparent: true,
    opacity: 0.7,
    map: texture,
    alphaTest: 0.02,
    depthWrite: false,
    sizeAttenuation: true,
  });

  return new THREE.Points(geometry, material);
}

function createDustField(centeredOutline, count = 180) {
  const bounds = new THREE.Box2().setFromPoints(centeredOutline);
  const positions = [];
  const polygon = centeredOutline;

  while (positions.length < count * 3) {
    const x = bounds.min.x + (Math.random() * (bounds.max.x - bounds.min.x));
    const y = bounds.min.y + (Math.random() * (bounds.max.y - bounds.min.y));
    const point = new THREE.Vector2(x, y);
    if (!isPointInsidePolygon(point, polygon)) {
      continue;
    }
    positions.push(x, TERRAIN_DEPTH + 0.28 + (Math.random() * 0.35), y);
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  const texture = createPointSpriteTexture("#6effb1");
  const material = new THREE.PointsMaterial({
    color: 0x9fffd0,
    size: 1.6,
    transparent: true,
    opacity: 0.22,
    map: texture,
    alphaTest: 0.02,
    depthWrite: false,
    sizeAttenuation: true,
  });
  return new THREE.Points(geometry, material);
}

function createPulseLine(points, color, count = 12, size = 4.2) {
  const positions = new Float32Array(Math.max(count, 1) * 3);
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));

  const texture = createPointSpriteTexture(color);
  const material = new THREE.PointsMaterial({
    color: new THREE.Color(color),
    size,
    transparent: true,
    opacity: 0.9,
    map: texture,
    alphaTest: 0.04,
    depthWrite: false,
    sizeAttenuation: true,
  });

  const pulses = new THREE.Points(geometry, material);
  pulses.userData.routePoints = points.map((point) => point.clone());
  pulses.userData.progress = Array.from({ length: Math.max(count, 1) }, (_, index) => index / Math.max(count, 1));
  pulses.userData.speed = 0.06 + (Math.random() * 0.04);
  return pulses;
}

function updatePulseLine(pointsObject, elapsed) {
  const routePoints = pointsObject.userData.routePoints || [];
  if (routePoints.length < 2) {
    return;
  }

  const positions = pointsObject.geometry.attributes.position.array;
  const segmentCount = routePoints.length - 1;

  pointsObject.userData.progress.forEach((baseProgress, index) => {
    const travel = (baseProgress + (elapsed * pointsObject.userData.speed)) % 1;
    const scaled = travel * segmentCount;
    const segmentIndex = Math.min(Math.floor(scaled), segmentCount - 1);
    const ratio = scaled - segmentIndex;
    const start = routePoints[segmentIndex];
    const end = routePoints[segmentIndex + 1];
    const point = start.clone().lerp(end, ratio);
    positions[index * 3] = point.x;
    positions[(index * 3) + 1] = point.y;
    positions[(index * 3) + 2] = point.z;
  });

  pointsObject.geometry.attributes.position.needsUpdate = true;
}

function buildRigNetworkConnections(rigEntries) {
  if (rigEntries.length < 2) {
    return [];
  }

  const byId = new Map(rigEntries.map((entry) => [entry.rig.id, entry]));
  const connectedKeys = new Set();
  const connections = [];

  rigEntries.forEach((entry) => {
    const candidates = rigEntries
      .filter((candidate) => candidate.rig.id !== entry.rig.id)
      .map((candidate) => ({
        targetId: candidate.rig.id,
        distance: entry.position.distanceTo(candidate.position),
      }))
      .sort((left, right) => left.distance - right.distance)
      .slice(0, Math.min(2, rigEntries.length - 1));

    candidates.forEach(({ targetId }) => {
      const key = [entry.rig.id, targetId].sort().join(":");
      if (connectedKeys.has(key)) {
        return;
      }
      connectedKeys.add(key);
      connections.push({
        from: entry,
        to: byId.get(targetId),
      });
    });
  });

  return connections.filter((connection) => connection.from && connection.to);
}

function buildTerrain(outlineWorld2D) {
  const normalizedOutline = normalizePolygon(outlineWorld2D);
  const bounds = new THREE.Box2().setFromPoints(normalizedOutline);
  const center = bounds.getCenter(new THREE.Vector2());
  const centeredWorldOutline = normalizedOutline.map((point) => point.clone().sub(center));
  const shapePoints = centeredWorldOutline.map((point) => new THREE.Vector2(point.x, -point.y));
  const terrainShape = new THREE.Shape(shapePoints);
  const terrainTexture = createTerrainTexture();
  const terrainGeometry = new THREE.ExtrudeGeometry(terrainShape, {
    depth: TERRAIN_DEPTH,
    bevelEnabled: false,
    steps: 1,
    curveSegments: SURFACE_SEGMENTS,
  });
  terrainGeometry.rotateX(-Math.PI / 2);

  const terrain = new THREE.Mesh(
    terrainGeometry,
    [
      new THREE.MeshStandardMaterial({
        color: 0x355948,
        roughness: 0.82,
        metalness: 0.04,
        emissive: new THREE.Color(0x13362c),
        emissiveIntensity: 0.34,
        map: terrainTexture,
      }),
      new THREE.MeshStandardMaterial({
        color: 0x17342b,
        roughness: 0.9,
        metalness: 0.02,
      }),
    ],
  );
  terrain.castShadow = true;
  terrain.receiveShadow = true;

  const topFace = new THREE.Mesh(
    new THREE.ShapeGeometry(terrainShape),
    new THREE.MeshBasicMaterial({
      color: 0x6aa186,
      transparent: true,
      opacity: 0.18,
    }),
  );
  topFace.rotation.x = -Math.PI / 2;
  topFace.position.y = TERRAIN_DEPTH + 0.02;

  const topGrid = new THREE.Mesh(
    new THREE.ShapeGeometry(terrainShape),
    new THREE.MeshBasicMaterial({
      color: 0xc7ffe2,
      wireframe: true,
      transparent: true,
      opacity: 0.045,
    }),
  );
  topGrid.rotation.x = -Math.PI / 2;
  topGrid.position.y = TERRAIN_DEPTH + 0.05;

  const topOutline = new THREE.LineLoop(
    new THREE.BufferGeometry().setFromPoints(centeredWorldOutline.map((point) => worldPoint(point, TERRAIN_DEPTH + 0.08))),
    new THREE.LineBasicMaterial({
      color: 0xc8ffe0,
      transparent: true,
      opacity: 0.96,
    }),
  );

  const glowOutline = new THREE.LineLoop(
    new THREE.BufferGeometry().setFromPoints(centeredWorldOutline.map((point) => worldPoint(point, TERRAIN_DEPTH + 0.03))),
    new THREE.LineBasicMaterial({
      color: 0x6effb1,
      transparent: true,
      opacity: 0.3,
    }),
  );

  const sideOutline = new THREE.LineLoop(
    new THREE.BufferGeometry().setFromPoints(centeredWorldOutline.map((point) => worldPoint(point, 0.12))),
    new THREE.LineBasicMaterial({
      color: 0x7cffb6,
      transparent: true,
      opacity: 0.18,
    }),
  );

  return {
    root: terrain,
    topFace,
    topGrid,
    topOutline,
    glowOutline,
    sideOutline,
    edgeGlow: createTerrainGlow(centeredWorldOutline),
    dust: createDustField(centeredWorldOutline),
    centeredWorldOutline,
    center,
  };
}

function drawRoundRect(context, x, y, width, height, radius) {
  const safeRadius = Math.min(radius, width / 2, height / 2);
  context.beginPath();
  context.moveTo(x + safeRadius, y);
  context.lineTo(x + width - safeRadius, y);
  context.quadraticCurveTo(x + width, y, x + width, y + safeRadius);
  context.lineTo(x + width, y + height - safeRadius);
  context.quadraticCurveTo(x + width, y + height, x + width - safeRadius, y + height);
  context.lineTo(x + safeRadius, y + height);
  context.quadraticCurveTo(x, y + height, x, y + height - safeRadius);
  context.lineTo(x, y + safeRadius);
  context.quadraticCurveTo(x, y, x + safeRadius, y);
  context.closePath();
}

function createTextSprite(text, { width = 240, height = 72, fontSize = 22, fill = "#dff5ea", background = "rgba(10,18,22,0.76)", stroke = "rgba(255,255,255,0.14)" } = {}) {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) {
    return null;
  }

  context.clearRect(0, 0, width, height);
  context.fillStyle = background;
  context.strokeStyle = stroke;
  context.lineWidth = 2;
  drawRoundRect(context, 8, 8, width - 16, height - 16, 20);
  context.fill();
  context.stroke();

  context.font = `700 ${fontSize}px Space Grotesk`;
  context.textAlign = "center";
  context.textBaseline = "middle";
  context.fillStyle = fill;
  context.fillText(text, width / 2, height / 2);

  const texture = new THREE.CanvasTexture(canvas);
  texture.needsUpdate = true;
  const material = new THREE.SpriteMaterial({ map: texture, transparent: true, depthWrite: false });
  const sprite = new THREE.Sprite(material);
  sprite.scale.set(width / 22, height / 22, 1);
  return sprite;
}

function buildRigTone(rig, isSelected) {
  if (isSelected) {
    return 0xffe082;
  }
  if (rig?.executionState === "active") {
    return 0xf6c654;
  }
  if (rig?.operatingState === "drilling" || rig?.executionState === "completed") {
    return 0x8fd77a;
  }
  return 0x84bfff;
}

function createRigMarker(rig, index, isSelected) {
  return new THREE.Group();
}

function findSelectableParent(object) {
  let current = object;
  while (current) {
    if (current.userData?.rigId) {
      return current;
    }
    current = current.parent || null;
  }
  return null;
}

export function ManagerRigsScene3D({
  rigs = [],
  selectedRigId = null,
  onSelectRig = null,
  heightClass = "manager-map-fullscreen",
}) {
  const hostRef = useRef(null);
  const selectedRigIdRef = useRef(selectedRigId);
  const sceneApiRef = useRef(null);
  const hasInitializedSelectionRef = useRef(false);

  useEffect(() => {
    selectedRigIdRef.current = selectedRigId;

    const api = sceneApiRef.current;
    if (!api) {
      return;
    }

    if (!hasInitializedSelectionRef.current) {
      hasInitializedSelectionRef.current = true;
      return;
    }

    const selectedRigNode = api.rigNodes.find(({ rig }) => rig.id === selectedRigId) || null;
    const nextTarget = selectedRigNode
      ? selectedRigNode.group.position.clone().setY(TERRAIN_DEPTH + 3.2)
      : api.defaultTarget.clone();
    const nextDistance = selectedRigNode ? 72 : 184;
    const currentOffset = api.camera.position.clone().sub(api.controls.target);

    api.cameraTransition = {
      active: true,
      startedAt: performance.now(),
      durationMs: 900,
      fromTarget: api.controls.target.clone(),
      toTarget: nextTarget,
      fromOffset: currentOffset.clone(),
      toDistance: nextDistance,
    };
  }, [selectedRigId]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) {
      return undefined;
    }

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x071116);
    scene.fog = new THREE.Fog(0x071116, 170, 360);

    const camera = new THREE.PerspectiveCamera(
      34,
      Math.max((host.clientWidth || 1) / (host.clientHeight || 1), 0.01),
      0.1,
      1200,
    );
    camera.position.set(96, 124, 132);

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2.25));
    renderer.setSize(host.clientWidth || 1, host.clientHeight || 1, false);
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.08;
    host.innerHTML = "";
    host.appendChild(renderer.domElement);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.06;
    controls.enablePan = true;
    controls.screenSpacePanning = false;
    controls.minDistance = 58;
    controls.maxDistance = 380;
    controls.zoomSpeed = 1.05;
    controls.minPolarAngle = 0.7;
    controls.maxPolarAngle = 1.16;
    controls.maxTargetRadius = 55;
    controls.mouseButtons.LEFT = THREE.MOUSE.ROTATE;
    controls.mouseButtons.RIGHT = THREE.MOUSE.PAN;
    controls.touches.ONE = THREE.TOUCH.ROTATE;
    controls.touches.TWO = THREE.TOUCH.DOLLY_PAN;
    controls.target.set(0, TERRAIN_DEPTH + 3, 0);
    controls.update();

    const ambient = new THREE.HemisphereLight(0xc8ffe8, 0x071218, 1.26);
    scene.add(ambient);
    scene.add(createStarField());

    const fillLight = new THREE.AmbientLight(0x72dfbc, 0.24);
    scene.add(fillLight);

    const keyLight = new THREE.DirectionalLight(0xd4ffd8, 1.5);
    keyLight.position.set(120, 160, 80);
    keyLight.castShadow = true;
    keyLight.shadow.mapSize.set(2048, 2048);
    keyLight.shadow.camera.left = -120;
    keyLight.shadow.camera.right = 120;
    keyLight.shadow.camera.top = 120;
    keyLight.shadow.camera.bottom = -120;
    scene.add(keyLight);

    const rimLight = new THREE.PointLight(0x6fffc0, 44, 320, 2);
    rimLight.position.set(-88, 48, -76);
    scene.add(rimLight);

    const iceLight = new THREE.PointLight(0x66d8ff, 26, 300, 2);
    iceLight.position.set(90, 42, 96);
    scene.add(iceLight);

    const projection = createBoardProjection();
    const projectedOutline = SAUDI_BORDER_POINTS.map(([lat, lng]) => projection.project({ lat, lng }));
    const terrain = buildTerrain(projectedOutline);
    const outlinePolygon = terrain.centeredWorldOutline.map((point) => point.clone());

    scene.add(terrain.root);
    scene.add(terrain.topFace);
    scene.add(terrain.topGrid);
    scene.add(terrain.topOutline);
    scene.add(terrain.glowOutline);
    scene.add(terrain.sideOutline);
    scene.add(terrain.edgeGlow);
    scene.add(terrain.dust);

    const terrainShadow = new THREE.Mesh(
      new THREE.CircleGeometry(118, 72),
      new THREE.MeshBasicMaterial({
        color: 0x000000,
        transparent: true,
        opacity: 0.24,
      }),
    );
    terrainShadow.rotation.x = -Math.PI / 2;
    terrainShadow.position.set(0, -10, 0);
    terrainShadow.scale.set(1.3, 0.96, 1);
    scene.add(terrainShadow);

    const atmosphere = new THREE.Mesh(
      new THREE.CircleGeometry(146, 80),
      new THREE.MeshBasicMaterial({
        color: 0x2cff88,
        transparent: true,
        opacity: 0.06,
      }),
    );
    atmosphere.rotation.x = -Math.PI / 2;
    atmosphere.position.set(0, -9.8, 0);
    atmosphere.scale.set(1.2, 0.92, 1);
    scene.add(atmosphere);

    const grid = new THREE.GridHelper(280, 18, 0x14342b, 0x0a171a);
    grid.position.y = -10.4;
    grid.material.transparent = true;
    grid.material.opacity = 0.2;
    scene.add(grid);

    const geographyRoot = new THREE.Group();
    const routeRoot = new THREE.Group();
    const rigRoot = new THREE.Group();
    const pulseRoot = new THREE.Group();
    scene.add(geographyRoot);
    scene.add(routeRoot);
    scene.add(rigRoot);
    scene.add(pulseRoot);

    const animatedPulseObjects = [];

    const rigEntries = (rigs || [])
      .map((rig, index) => ({ rig, index, point: resolveRigCurrentPoint(rig) }))
      .filter((entry) => entry.point);
    const rigNetworkEntries = [];

    const selectableRoots = [];
    const rigNodes = [];
    const raycaster = new THREE.Raycaster();
    const pointer = new THREE.Vector2();
    let pointerDownAt = null;
    let isDragging = false;

    rigEntries.forEach(({ rig, index, point }) => {
      const point2D = projection.project(point).sub(terrain.center);
      const clamped2D = isPointInsidePolygon(point2D, outlinePolygon)
        ? point2D
        : clampPointToPolygon(point2D, outlinePolygon, 0.8);

      const rigGroup = createRigMarker(rig, index, rig.id === selectedRigId);
        const rigWorldPosition = worldPoint(clamped2D, TERRAIN_DEPTH + 0.08);
        rigGroup.position.copy(rigWorldPosition);
        rigGroup.userData = {
          rigId: rig.id,
          baseY: rigGroup.position.y,
          floatOffset: index * 0.55,
        selectionBoost: rig.id === selectedRigIdRef.current ? 1 : 0,
      };
      rigRoot.add(rigGroup);
      selectableRoots.push(rigGroup);
      rigNodes.push({ group: rigGroup, rig, index });
      rigNetworkEntries.push({ rig, index, group: rigGroup, position: rigWorldPosition.clone() });

      const routePoints = (rig.routeGeometry || [])
        .filter((routePoint) => Array.isArray(routePoint) && routePoint.length >= 2)
        .map((routePoint) => projection.project({ lat: routePoint[0], lng: routePoint[1] }).sub(terrain.center))
        .map((routePoint) => (
          isPointInsidePolygon(routePoint, outlinePolygon)
            ? routePoint
            : clampPointToPolygon(routePoint, outlinePolygon, 0.78)
        ))
        .map((routePoint) => worldPoint(routePoint, TERRAIN_DEPTH + 0.9));

      if (routePoints.length > 1) {
        const line = new THREE.Line(
          new THREE.BufferGeometry().setFromPoints(routePoints),
          new THREE.LineBasicMaterial({
            color: rig.executionState === "active" ? 0xff7468 : rig.id === selectedRigId ? 0xffe082 : 0x7fd7ff,
            transparent: true,
            opacity: rig.id === selectedRigId ? 0.98 : 0.7,
          }),
        );
        routeRoot.add(line);

        const glow = new THREE.Line(
          new THREE.BufferGeometry().setFromPoints(routePoints),
          new THREE.LineBasicMaterial({
            color: rig.executionState === "active" ? 0xffbaa8 : 0xbceaff,
            transparent: true,
            opacity: rig.id === selectedRigId ? 0.22 : 0.12,
          }),
        );
        glow.scale.multiplyScalar(1.0018);
        routeRoot.add(glow);

        const pulses = createPulseLine(
          routePoints,
          rig.executionState === "active" ? "#ff9c87" : "#bfe7ff",
          rig.executionState === "active" ? 9 : 6,
          rig.executionState === "active" ? 4.8 : 3.8,
        );
        pulseRoot.add(pulses);
        animatedPulseObjects.push(pulses);
      }
    });

    buildRigNetworkConnections(rigNetworkEntries).forEach((connection) => {
      const networkPoints = [
        connection.from.position.clone().setY(TERRAIN_DEPTH + 1.05),
        connection.to.position.clone().setY(TERRAIN_DEPTH + 1.05),
      ];

      const glow = new THREE.Line(
        new THREE.BufferGeometry().setFromPoints(networkPoints),
        new THREE.LineBasicMaterial({
          color: 0x76ffc0,
          transparent: true,
          opacity: 0.08,
        }),
      );
      geographyRoot.add(glow);

      const line = new THREE.Line(
        new THREE.BufferGeometry().setFromPoints(networkPoints),
        new THREE.LineBasicMaterial({
          color: 0x7dffd0,
          transparent: true,
          opacity: 0.22,
        }),
      );
      geographyRoot.add(line);

      const pulses = createPulseLine(networkPoints, "#7dffd0", 5, 3.2);
      pulseRoot.add(pulses);
      animatedPulseObjects.push(pulses);
    });

    loadRigTemplate().then((template) => {
      if (!host.isConnected) {
        return;
      }

      rigNodes.forEach(({ group, rig, index }) => {
        const color = buildRigTone(rig, rig.id === selectedRigIdRef.current);
        const visual = template
          ? centerAndScaleModel(cloneModel(template), 13.2)
          : createFallbackRig(color);

        if (template) {
          tintRigModel(visual, color);
        }

        visual.position.y = 0;
        visual.rotation.y = (-Math.PI / 8) + (((index % 5) - 2) * 0.06);
        const scaleFactor = rig.id === selectedRigIdRef.current ? 1.12 : 1;
        visual.scale.multiplyScalar(scaleFactor);
        group.add(visual);
        group.userData.visual = visual;
        group.userData.visualBaseScale = visual.scale.clone();
      });
    });

    function runRaycast(event) {
      const rect = renderer.domElement.getBoundingClientRect();
      pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
      pointer.y = -(((event.clientY - rect.top) / rect.height) * 2 - 1);
      raycaster.setFromCamera(pointer, camera);
      const hits = raycaster.intersectObjects(selectableRoots, true);
      return hits.length ? findSelectableParent(hits[0].object) : null;
    }

    function updateCursor(event) {
      const hit = event ? runRaycast(event) : null;
      if (isDragging || pointerDownAt) {
        renderer.domElement.style.cursor = "grabbing";
        return;
      }
      renderer.domElement.style.cursor = hit ? "pointer" : "grab";
    }

    function handlePointerMove(event) {
      if (pointerDownAt) {
        const dragDistance = Math.hypot(event.clientX - pointerDownAt.x, event.clientY - pointerDownAt.y);
        if (dragDistance > 4) {
          isDragging = true;
        }
      }
      updateCursor(event);
    }

    function handlePointerDown(event) {
      if (event.button !== 0) {
        return;
      }
      pointerDownAt = { x: event.clientX, y: event.clientY };
      updateCursor(event);
    }

    function handlePointerUp(event) {
      const downPoint = pointerDownAt;
      pointerDownAt = null;
      const wasDragging = isDragging;
      isDragging = false;
      updateCursor(event);

      if (!downPoint || event.button !== 0 || typeof onSelectRig !== "function") {
        return;
      }

      const dragDistance = Math.hypot(event.clientX - downPoint.x, event.clientY - downPoint.y);
      if (wasDragging || dragDistance > 6) {
        return;
      }

      const hit = runRaycast(event);
      if (hit?.userData?.rigId) {
        onSelectRig(hit.userData.rigId);
      }
    }

    function handleDoubleClick(event) {
      event.preventDefault();
      const api = sceneApiRef.current;
      if (!api) {
        return;
      }
      api.cameraTransition = {
        active: true,
        startedAt: performance.now(),
        durationMs: 950,
        fromTarget: api.controls.target.clone(),
        toTarget: api.defaultTarget.clone(),
        fromOffset: api.camera.position.clone().sub(api.controls.target),
        toDistance: api.defaultDistance,
      };
      if (typeof onSelectRig === "function") {
        onSelectRig(null);
      }
    }

    renderer.domElement.addEventListener("pointermove", handlePointerMove);
    renderer.domElement.addEventListener("pointerdown", handlePointerDown);
    renderer.domElement.addEventListener("pointerup", handlePointerUp);
    renderer.domElement.addEventListener("pointerleave", handlePointerUp);
    renderer.domElement.addEventListener("dblclick", handleDoubleClick);
    renderer.domElement.style.cursor = "grab";

    const defaultTarget = new THREE.Vector3(0, TERRAIN_DEPTH + 3, 0);
    const defaultDistance = 220;
    sceneApiRef.current = {
      camera,
      controls,
      rigNodes,
      defaultTarget,
      defaultDistance,
      cameraTransition: {
        active: true,
        startedAt: performance.now(),
        durationMs: 1,
        fromTarget: controls.target.clone(),
        toTarget: defaultTarget.clone(),
        fromOffset: camera.position.clone().sub(controls.target),
        toDistance: defaultDistance,
      },
    };

    const resizeObserver = new ResizeObserver(() => {
      const width = host.clientWidth || 1;
      const height = host.clientHeight || 1;
      camera.aspect = Math.max(width / height, 0.01);
      camera.updateProjectionMatrix();
      renderer.setSize(width, height, false);
    });
    resizeObserver.observe(host);

    let animationFrameId = 0;
    function animate(now) {
      animationFrameId = window.requestAnimationFrame(animate);
      const elapsed = now / 1000;

      terrain.edgeGlow.children.forEach((ring, index) => {
        ring.material.opacity = (index === 0 ? 0.2 : 0.08) + (((Math.sin((elapsed * 1.6) + index) + 1) * 0.05));
      });
      terrain.dust.rotation.y = Math.sin(elapsed * 0.18) * 0.12;

      animatedPulseObjects.forEach((pulseObject) => updatePulseLine(pulseObject, elapsed));

      const activeTransition = sceneApiRef.current?.cameraTransition;
      if (activeTransition?.active && !isDragging && !pointerDownAt) {
        const transitionElapsed = Math.min(1, (performance.now() - activeTransition.startedAt) / activeTransition.durationMs);
        const eased = 1 - ((1 - transitionElapsed) * (1 - transitionElapsed) * (1 - transitionElapsed));
        const nextTarget = activeTransition.fromTarget.clone().lerp(activeTransition.toTarget, eased);
        const nextDistance = THREE.MathUtils.lerp(
          activeTransition.fromOffset.length(),
          activeTransition.toDistance,
          eased,
        );
        const nextOffset = activeTransition.fromOffset.clone().normalize().multiplyScalar(nextDistance);
        controls.target.copy(nextTarget);
        camera.position.copy(nextTarget.clone().add(nextOffset));
        if (transitionElapsed >= 1) {
          activeTransition.active = false;
        }
      }

      rigNodes.forEach(({ group, index }) => {
        const isSelected = group.userData?.rigId === selectedRigIdRef.current;
        const targetBoost = isSelected ? 1 : 0;
        group.userData.selectionBoost += (targetBoost - group.userData.selectionBoost) * 0.08;
        const lift = 0.04 + (group.userData.selectionBoost * 0.05);
        group.position.y = group.userData.baseY + (Math.sin((elapsed * 1.8) + group.userData.floatOffset) * lift);
        group.rotation.y += 0.002 + (group.userData.selectionBoost * 0.0011);
        if (group.userData?.visual) {
          group.userData.visual.rotation.y = (-Math.PI / 8) + (Math.sin((elapsed * 0.9) + index) * 0.05);
          if (group.userData.visualBaseScale) {
            const scaled = group.userData.visualBaseScale.clone().multiplyScalar(1 + (group.userData.selectionBoost * 0.08));
            group.userData.visual.scale.copy(scaled);
          }
        }
      });

      controls.update();
      renderer.render(scene, camera);
    }
    animationFrameId = window.requestAnimationFrame(animate);

    return () => {
      window.cancelAnimationFrame(animationFrameId);
      resizeObserver.disconnect();
      renderer.domElement.removeEventListener("pointermove", handlePointerMove);
      renderer.domElement.removeEventListener("pointerdown", handlePointerDown);
      renderer.domElement.removeEventListener("pointerup", handlePointerUp);
      renderer.domElement.removeEventListener("pointerleave", handlePointerUp);
      renderer.domElement.removeEventListener("dblclick", handleDoubleClick);
      controls.dispose();
      renderer.dispose();
      sceneApiRef.current = null;
      scene.traverse((object) => {
        if (object.geometry) {
          object.geometry.dispose();
        }
        const materials = Array.isArray(object.material)
          ? object.material
          : object.material
            ? [object.material]
            : [];
        materials.forEach((material) => {
          if (material.map) {
            material.map.dispose();
          }
          material.dispose();
        });
      });
      host.innerHTML = "";
    };
  }, [onSelectRig, rigs]);

  return h(
    "div",
    { className: `${heightClass} manager-kingdom-scene` },
    h("div", { ref: hostRef, className: "manager-kingdom-scene-canvas" }),
    h(
      "div",
      { className: "manager-kingdom-legend" },
      h("span", { className: "manager-kingdom-legend-chip is-active" }, "Active"),
      h("span", { className: "manager-kingdom-legend-chip is-drilling" }, "Drilling"),
      h("span", { className: "manager-kingdom-legend-chip is-planning" }, "Planning"),
    ),
  );
}

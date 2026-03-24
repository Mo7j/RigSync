import { React, h } from "../../lib/react.js";

const { useEffect, useRef } = React;

const NODE_COUNT = 136;
const AMBIENT_NODE_COUNT = 28;
const CONNECTION_DISTANCE = 92;
const CONNECTION_DISTANCE_SQ = CONNECTION_DISTANCE * CONNECTION_DISTANCE;
const MOUSE_DISTANCE = 220;

function createNodes() {
  return Array.from({ length: NODE_COUNT }, (_, index) => ({
    theta: Math.random() * Math.PI * 2,
    phi: Math.acos((Math.random() * 2) - 1),
    radius: 1.1 + (Math.random() * 1.8),
    pulse: Math.random() * Math.PI * 2,
    speed: 0.28 + ((index % 11) * 0.028),
    thetaSpeed: 0.00016 + ((index % 7) * 0.000022),
    phiOffset: (Math.random() - 0.5) * 0.16,
    drift: Math.random() * Math.PI * 2,
  }));
}

function createAmbientNodes() {
  return Array.from({ length: AMBIENT_NODE_COUNT }, (_, index) => {
    const edgeBand = index % 4;
    const edgeProgress = Math.random();
    const inset = 0.06 + (Math.random() * 0.12);
    let x = 0.5;
    let y = 0.5;

    if (edgeBand === 0) {
      x = inset;
      y = edgeProgress;
    } else if (edgeBand === 1) {
      x = 1 - inset;
      y = edgeProgress;
    } else if (edgeBand === 2) {
      x = edgeProgress;
      y = inset;
    } else {
      x = edgeProgress;
      y = 1 - inset;
    }

    return {
      drift: Math.random() * Math.PI * 2,
      radius: 0.8 + (Math.random() * 1.8),
      speed: 0.18 + (Math.random() * 0.22),
      x,
      y,
    };
  });
}

export function HeroNetwork() {
  const canvasRef = useRef(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) {
      return undefined;
    }

    const context = canvas.getContext("2d");
    if (!context) {
      return undefined;
    }

    const pointer = { x: 0, y: 0, active: false };
    let animationFrameId = 0;
    let width = 0;
    let height = 0;
    let dpr = 1;
    let nodes = [];
    let ambientNodes = [];
    let sphereRadius = 0;
    let currentSceneIndex = 0;
    let targetSceneIndex = 0;

    function resize() {
      const bounds = canvas.getBoundingClientRect();
      width = Math.max(bounds.width, 320);
      height = Math.max(bounds.height, 320);
      sphereRadius = Math.min(width, height) * 0.33;
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
      context.setTransform(dpr, 0, 0, dpr, 0, 0);
      nodes = createNodes();
      ambientNodes = createAmbientNodes();
    }

    function handleSceneChange(event) {
      const next = Number.parseInt(String(event.detail?.index ?? 0), 10);
      targetSceneIndex = Number.isFinite(next) ? next : 0;
    }

    function drawGlowBackground(time) {
      const driftX = width * 0.5 + (Math.sin(time * 0.00012) * width * 0.08);
      const driftY = height * 0.5 + (Math.cos(time * 0.00015) * height * 0.06);
      const glow = context.createRadialGradient(driftX, driftY, 0, driftX, driftY, width * 0.46);
      glow.addColorStop(0, "rgba(255, 222, 89, 0.22)");
      glow.addColorStop(0.4, "rgba(255, 191, 36, 0.12)");
      glow.addColorStop(1, "rgba(0, 0, 0, 0)");
      context.fillStyle = glow;
      context.fillRect(0, 0, width, height);
    }

    function drawGrid() {
      context.strokeStyle = "rgba(255, 255, 255, 0.04)";
      context.lineWidth = 1;
      const step = 34;
      for (let x = 0; x < width; x += step) {
        context.beginPath();
        context.moveTo(x + 0.5, 0);
        context.lineTo(x + 0.5, height);
        context.stroke();
      }
      for (let y = 0; y < height; y += step) {
        context.beginPath();
        context.moveTo(0, y + 0.5);
        context.lineTo(width, y + 0.5);
        context.stroke();
      }
    }

    function animate(time) {
      currentSceneIndex += (targetSceneIndex - currentSceneIndex) * 0.045;

      const centerX = width * 0.5;
      const centerY = height * 0.5;
      const scenePhase = currentSceneIndex * 0.72;
      const rotationY = (time * 0.00012) + scenePhase + (pointer.active ? ((pointer.x - centerX) / width) * 0.9 : 0.18);
      const rotationX = (time * 0.00008) + (scenePhase * 0.18) + (pointer.active ? ((pointer.y - centerY) / height) * 0.45 : -0.12);
      const perspective = sphereRadius * 2.5;
      const projectedNodes = [];

      context.clearRect(0, 0, width, height);
      drawGlowBackground(time);
      drawGrid();

      for (let index = 0; index < ambientNodes.length; index += 1) {
        const node = ambientNodes[index];
        const px = (node.x * width) + (Math.sin((time * 0.00022 * node.speed) + node.drift + scenePhase) * 32);
        const py = (node.y * height) + (Math.cos((time * 0.00018 * node.speed) + node.drift + scenePhase) * 28);
        const pulse = 0.58 + (Math.sin((time * 0.0009 * node.speed) + node.drift) * 0.2);

        context.beginPath();
        context.arc(px, py, node.radius * pulse, 0, Math.PI * 2);
        context.fillStyle = `rgba(255, 216, 92, ${0.18 + (pulse * 0.26)})`;
        context.shadowBlur = 10;
        context.shadowColor = "rgba(255, 205, 64, 0.18)";
        context.fill();
      }

      for (let index = 0; index < nodes.length; index += 1) {
        const node = nodes[index];
        const animatedTheta = node.theta + (time * node.thetaSpeed) + (scenePhase * 0.22);
        const animatedPhi = node.phi + (Math.sin((time * 0.00042 * node.speed) + node.drift + (scenePhase * 0.7)) * node.phiOffset);

        const baseX = Math.sin(animatedPhi) * Math.cos(animatedTheta);
        const baseY = Math.cos(animatedPhi);
        const baseZ = Math.sin(animatedPhi) * Math.sin(animatedTheta);

        const cosY = Math.cos(rotationY);
        const sinY = Math.sin(rotationY);
        const xRotY = (baseX * cosY) - (baseZ * sinY);
        const zRotY = (baseX * sinY) + (baseZ * cosY);

        const cosX = Math.cos(rotationX);
        const sinX = Math.sin(rotationX);
        const yRotX = (baseY * cosX) - (zRotY * sinX);
        const zRotX = (baseY * sinX) + (zRotY * cosX);

        const depth = (zRotX + 1) * 0.5;
        const scale = perspective / (perspective - (zRotX * sphereRadius * 0.9));
        const px = centerX + (xRotY * sphereRadius * scale);
        const py = centerY + (yRotX * sphereRadius * scale * 0.94);

        projectedNodes.push({
          depth,
          radius: node.radius,
          pulse: node.pulse,
          px,
          py,
          scale,
          speed: node.speed,
          visible: zRotX > -0.32,
          x: xRotY * sphereRadius,
          y: yRotX * sphereRadius,
        });
      }

      context.beginPath();
      context.arc(centerX, centerY, sphereRadius * 1.06, 0, Math.PI * 2);
      context.fillStyle = "rgba(255, 196, 48, 0.035)";
      context.fill();

      for (let left = 0; left < projectedNodes.length; left += 1) {
        const a = projectedNodes[left];
        if (!a.visible) {
          continue;
        }

        let localConnections = 0;
        for (let right = left + 1; right < projectedNodes.length; right += 1) {
          const b = projectedNodes[right];
          if (!b.visible) {
            continue;
          }

          const dx = a.px - b.px;
          const dy = a.py - b.py;
          const distanceSq = (dx * dx) + (dy * dy);

          if (distanceSq > CONNECTION_DISTANCE_SQ) {
            continue;
          }

          const distance = Math.sqrt(distanceSq);
          const pointerDx = pointer.x - ((a.px + b.px) * 0.5);
          const pointerDy = pointer.y - ((a.py + b.py) * 0.5);
          const pointerDistance = Math.sqrt((pointerDx * pointerDx) + (pointerDy * pointerDy));
          const pointerBoost = pointer.active && pointerDistance < MOUSE_DISTANCE
            ? 1 + ((1 - (pointerDistance / MOUSE_DISTANCE)) * 0.5)
            : 1;
          const opacity = 0.42 * (1 - (distance / CONNECTION_DISTANCE)) * ((a.depth + b.depth) * 0.5) * pointerBoost;
          const gradient = context.createLinearGradient(a.px, a.py, b.px, b.py);
          gradient.addColorStop(0, `rgba(255, 225, 118, ${opacity})`);
          gradient.addColorStop(1, `rgba(255, 177, 38, ${opacity * 0.9})`);

          context.beginPath();
          context.moveTo(a.px, a.py);
          context.lineTo(b.px, b.py);
          context.strokeStyle = gradient;
          context.lineWidth = 0.8 + (((a.depth + b.depth) * 0.5) * 0.7);
          context.stroke();

          localConnections += 1;
          if (localConnections >= 5) {
            break;
          }
        }
      }

      projectedNodes.sort((left, right) => left.depth - right.depth);

      for (let index = 0; index < projectedNodes.length; index += 1) {
        const node = projectedNodes[index];
        if (!node.visible) {
          continue;
        }

        const pulse = 0.78 + (Math.sin((time * 0.0012 * node.speed) + node.pulse) * 0.22);
        const size = node.radius * node.scale * (0.8 + (node.depth * 0.55));

        context.beginPath();
        context.arc(node.px, node.py, size * (1 + ((pulse - 0.8) * 0.7)), 0, Math.PI * 2);
        context.fillStyle = `rgba(255, 219, 84, ${(0.42 + (node.depth * 0.5)) * pulse})`;
        context.shadowBlur = 12 + (node.depth * 16);
        context.shadowColor = "rgba(255, 205, 64, 0.34)";
        context.fill();

        context.beginPath();
        context.arc(node.px, node.py, size * 0.46, 0, Math.PI * 2);
        context.fillStyle = `rgba(255, 249, 226, ${(0.5 + (node.depth * 0.44)) * pulse})`;
        context.fill();
      }

      context.shadowBlur = 0;
      animationFrameId = window.requestAnimationFrame(animate);
    }

    function handlePointerMove(event) {
      const bounds = canvas.getBoundingClientRect();
      pointer.x = event.clientX - bounds.left;
      pointer.y = event.clientY - bounds.top;
      pointer.active = true;
    }

    function handlePointerLeave() {
      pointer.active = false;
    }

    const resizeObserver = new ResizeObserver(() => resize());
    resizeObserver.observe(canvas);
    canvas.addEventListener("pointermove", handlePointerMove);
    canvas.addEventListener("pointerleave", handlePointerLeave);
    window.addEventListener("home-scene-change", handleSceneChange);

    resize();
    animationFrameId = window.requestAnimationFrame(animate);

    return () => {
      window.cancelAnimationFrame(animationFrameId);
      resizeObserver.disconnect();
      canvas.removeEventListener("pointermove", handlePointerMove);
      canvas.removeEventListener("pointerleave", handlePointerLeave);
      window.removeEventListener("home-scene-change", handleSceneChange);
    };
  }, []);

  return h("canvas", { ref: canvasRef, className: "hero-network-canvas" });
}

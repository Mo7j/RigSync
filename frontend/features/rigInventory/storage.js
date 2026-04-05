import { fetchRigInventoryDoc, saveRigInventoryDoc } from "../../lib/firebaseOperations.js";

const rigInventoryCache = new Map();

function normalizeInventoryEntry(value) {
  if (value && typeof value === "object") {
    return {
      onSite: Math.max(0, Number.parseInt(value.onSite, 10) || 0),
      transferable: Math.max(0, Number.parseInt(value.transferable, 10) || 0),
    };
  }

  const onSite = Math.max(0, Number.parseInt(value, 10) || 0);
  return {
    onSite,
    transferable: 0,
  };
}

export function setRigInventoryCache(rigId, adjustments) {
  rigInventoryCache.set(rigId, adjustments || {});
  return adjustments || {};
}

export function readRigInventoryAdjustments(rigId) {
  const rigInventory = rigInventoryCache.get(rigId);
  return rigInventory && typeof rigInventory === "object" ? rigInventory : {};
}

export async function hydrateRigInventoryAdjustments(rigId) {
  if (!rigId) {
    return {};
  }

  const payload = await fetchRigInventoryDoc(rigId);
  const adjustments = payload?.adjustments && typeof payload.adjustments === "object" ? payload.adjustments : {};
  rigInventoryCache.set(rigId, adjustments);
  return adjustments;
}

export async function writeRigInventoryAdjustments(rigId, adjustments) {
  const normalized = Object.fromEntries(
    Object.entries(adjustments || {}).map(([key, value]) => [key, normalizeInventoryEntry(value)]),
  );

  await saveRigInventoryDoc(rigId, normalized);
  rigInventoryCache.set(rigId, normalized);
  return normalized;
}

export function applyRigInventoryAdjustments(snapshot, adjustments = {}) {
  if (!snapshot) {
    return snapshot;
  }

  const reusableInventory = snapshot.reusableInventory || [];
  const startupLoads = (snapshot.startupLoads || []).map((item) => {
    if (!item.isReusable) {
      return {
        ...item,
        onSiteCount: 0,
        transferableCount: 0,
      };
    }

    const normalized = normalizeInventoryEntry(adjustments[item.id]);
    const onSiteCount = normalized.onSite;
    const transferableCount = normalized.transferable;
    const coveredCount = Math.min(item.count, (item.coveredCount || 0) + onSiteCount);
    const missingCount = Math.max(0, item.count - coveredCount);

    return {
      ...item,
      onSiteCount,
      transferableCount,
      coveredCount,
      missingCount,
      readiness: missingCount === 0 ? "covered" : coveredCount > 0 ? "partial" : "missing",
    };
  });

  const startupSummary = {
    totalUnits: startupLoads.reduce((sum, item) => sum + item.count, 0),
    coveredUnits: startupLoads.reduce((sum, item) => sum + (item.coveredCount || 0), 0),
    missingUnits: startupLoads.reduce((sum, item) => sum + (item.missingCount || 0), 0),
    donorRigCount: snapshot.startupSummary?.donorRigCount || 0,
  };

  return {
    ...snapshot,
    reusableInventory,
    startupLoads,
    startupSummary,
  };
}

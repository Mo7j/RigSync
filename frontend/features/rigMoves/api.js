const locationLabelCache = new Map();

export async function fetchLoads() {
  const [loadsResponse, startupResponse, truckSpecsResponse, workerRolesResponse] = await Promise.all([
    fetch("/api/loads"),
    fetch("/api/startup-loads"),
    fetch("/api/truck-specs"),
    fetch("/api/worker-roles"),
  ]);

  if (!loadsResponse.ok) {
    throw new Error(`Load request failed with ${loadsResponse.status}`);
  }
  if (!startupResponse.ok) {
    throw new Error(`Startup load request failed with ${startupResponse.status}`);
  }
  if (!truckSpecsResponse.ok) {
    throw new Error(`Truck spec request failed with ${truckSpecsResponse.status}`);
  }
  if (!workerRolesResponse.ok) {
    throw new Error(`Worker roles request failed with ${workerRolesResponse.status}`);
  }

  const [rigLoads, startupLoads, truckSpecs, workerRoles] = await Promise.all([
    loadsResponse.json(),
    startupResponse.json(),
    truckSpecsResponse.json(),
    workerRolesResponse.json(),
  ]);

  return {
    rigLoads,
    startupLoads,
    truckSpecs,
    workerRoles,
  };
}

export async function fetchLocationLabel(point) {
  if (!point || !Number.isFinite(point.lat) || !Number.isFinite(point.lng)) {
    return null;
  }

  const cacheKey = `${point.lat.toFixed(5)},${point.lng.toFixed(5)}`;
  if (locationLabelCache.has(cacheKey)) {
    return locationLabelCache.get(cacheKey);
  }

  const params = new URLSearchParams({
    lat: String(point.lat),
    lng: String(point.lng),
  });
  const response = await fetch(`/api/location-label?${params.toString()}`);

  if (!response.ok) {
    throw new Error(`Location label request failed with ${response.status}`);
  }

  const payload = await response.json();
  const label = payload?.label || null;

  if (label) {
    locationLabelCache.set(cacheKey, label);
  }
  return label;
}

const locationLabelCache = new Map();

export async function fetchLoads() {
  const response = await fetch("/api/loads");

  if (!response.ok) {
    throw new Error(`Load request failed with ${response.status}`);
  }

  return response.json();
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

const locationLabelCache = new Map();

export async function fetchLoads() {
  const [loadsResponse, startupResponse, truckSpecsResponse] = await Promise.all([
    fetch("/api/loads"),
    fetch("/api/startup-loads"),
    fetch("/api/truck-specs"),
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
  const [rigLoads, startupLoads, truckSpecs] = await Promise.all([
    loadsResponse.json(),
    startupResponse.json(),
    truckSpecsResponse.json(),
  ]);

  return {
    rigLoads,
    startupLoads,
    truckSpecs,
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

export async function fetchMoveRecords(managerId, { summary = false } = {}) {
  const params = new URLSearchParams();
  if (managerId) {
    params.set("managerId", managerId);
  }
  if (summary) {
    params.set("summary", "1");
  }

  const response = await fetch(`/api/moves${params.toString() ? `?${params.toString()}` : ""}`);
  if (!response.ok) {
    throw new Error(`Move list request failed with ${response.status}`);
  }

  return response.json();
}

export async function fetchMoveRecord(moveId) {
  const response = await fetch(`/api/moves/${encodeURIComponent(moveId)}`);
  if (response.status === 404) {
    return null;
  }
  if (!response.ok) {
    throw new Error(`Move request failed with ${response.status}`);
  }

  return response.json();
}

export async function saveMoveRecord(move) {
  const response = await fetch(`/api/moves/${encodeURIComponent(move.id)}`, {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(move),
  });

  if (!response.ok) {
    let message = `Move save request failed with ${response.status}`;
    try {
      const payload = await response.json();
      if (payload?.error) {
        message = payload.error;
      }
    } catch {
      // Keep the default HTTP error message.
    }
    throw new Error(message);
  }

  return response.json();
}

export async function deleteMoveRecord(moveId) {
  const response = await fetch(`/api/moves/${encodeURIComponent(moveId)}`, {
    method: "DELETE",
  });

  if (!response.ok) {
    throw new Error(`Move delete request failed with ${response.status}`);
  }

  return response.json();
}

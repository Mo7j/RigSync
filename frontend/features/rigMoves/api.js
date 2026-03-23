export async function fetchLoads() {
  const response = await fetch("/api/loads");

  if (!response.ok) {
    throw new Error(`Load request failed with ${response.status}`);
  }

  return response.json();
}

export async function fetchLocationLabel(point) {
  const response = await fetch(
    `https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${point.lat}&lon=${point.lng}&zoom=10`,
  );

  if (!response.ok) {
    throw new Error(`Reverse geocode failed with ${response.status}`);
  }

  const payload = await response.json();
  const address = payload?.address || {};
  const primary =
    address.city ||
    address.town ||
    address.village ||
    address.municipality ||
    address.county ||
    address.state_district ||
    address.state;

  if (primary) {
    return primary;
  }

  if (payload?.name) {
    return payload.name;
  }

  throw new Error("No readable location label found");
}

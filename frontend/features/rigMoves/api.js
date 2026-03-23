export async function fetchLoads() {
  const response = await fetch("/api/loads");

  if (!response.ok) {
    throw new Error(`Load request failed with ${response.status}`);
  }

  return response.json();
}

export async function loadTrips() {
  const response = await fetch("/api/trips");
  return response.json();
}

export async function addStop(tripId, stop) {
  return fetch(`/api/trips/${tripId}/stops`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(stop),
  });
}

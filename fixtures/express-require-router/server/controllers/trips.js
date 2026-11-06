const trips = [{ id: "t1", name: "Coast road" }];

exports.listTrips = (req, res) => res.json(trips);

exports.getTrip = (req, res) => {
  const trip = trips.find((t) => t.id === req.params.tripId);
  if (!trip) return res.status(404).end();
  return res.json(trip);
};

const router = require("express").Router();
const stops = require("./stops");
const { listTrips, getTrip } = require("../controllers/trips");

router.get("/", listTrips);
router.get("/:tripId", getTrip);
router.use("/:tripId/stops", stops);

module.exports = router;

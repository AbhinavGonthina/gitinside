const router = require('express').Router({ mergeParams: true });

router.post("/", (req, res) => res.status(201).json({ trip: req.params.tripId }));

module.exports = router;

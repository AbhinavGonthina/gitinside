const { Router } = require("express");

function startRun(req, res) {
  res.status(202).json({ queued: req.body && req.body.robotId });
}

module.exports = Router().post("/runs", startRun);

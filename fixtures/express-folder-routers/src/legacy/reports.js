const { Router } = require("express");

function daily(req, res) {
  res.json([]);
}

const router = Router();
router.get("/daily", daily);

module.exports = router;

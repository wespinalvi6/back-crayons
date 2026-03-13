const express = require("express");
const router = express.Router();
const dashboardController = require("../controllers/dashboardController");
const { verifyToken, isDirector } = require("../middleware/auth");

// Ruta para el Dashboard del Director
router.get("/estadisticas", verifyToken, isDirector, dashboardController.getEstadisticasDirector);

module.exports = router;

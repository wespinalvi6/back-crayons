const express = require("express");
const router = express.Router();

const { getGrados } = require("../controllers/gradoController");

// Rutas públicas

router.get("/lista-grado", getGrados);

module.exports = router;

const express = require("express");
const router = express.Router();

const { buscarPersonaPorDni } = require("../controllers/reniecController");

// Rutas públicas

router.get("/buscar-dni/:dni", buscarPersonaPorDni);

module.exports = router;

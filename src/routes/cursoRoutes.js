const express = require("express");
const router = express.Router();
const { getCursos } = require("../controllers/cursoController");

// Rutas públicas
router.get("/lista-cursos", getCursos);

module.exports = router;

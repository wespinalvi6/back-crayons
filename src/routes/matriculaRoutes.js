const express = require("express");
const router = express.Router();
const { verifyToken, isDirector, checkChangePasswordRequired } = require("../middleware/auth");
const MatriculaController = require("../controllers/matriculaController");

// Rutas protegidas (Solo Directores con contraseña actualizada)
router.post("/matricula", verifyToken, checkChangePasswordRequired, isDirector, MatriculaController.registrarMatricula);
router.post("/matricula/insertar-extraidos", verifyToken, checkChangePasswordRequired, isDirector, MatriculaController.insertarDatosExtraidos);

module.exports = router;
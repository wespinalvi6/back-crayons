const express = require("express");
const {
  listarAlumnosConApoderados,
  verMiAsistencia,
  verMisFaltas,
  obtenerMisDatos,
  obtenerDatosEstudiante,
  editarDatosEstudiante,
  listarAlumnosPaginado
} = require("../controllers/alumnoController");
const { verifyToken, isDirector, isAlumno } = require("../middleware/auth");
const router = express.Router();

// Rutas protegidas para Directores y Docentes (Gestión y Listado)
router.get("/lista-paginada", verifyToken, isDirector, listarAlumnosPaginado);
router.get("/lista-alumnos/:anio/:grado", verifyToken, listarAlumnosConApoderados); // Puede ser Docente o Director

// Rutas protegidas (requieren autenticación)
router.get("/mi-asistencia", verifyToken, isAlumno, verMiAsistencia);
router.get("/mis-faltas", verifyToken, isAlumno, verMisFaltas);
router.get("/mis-datos", verifyToken, isAlumno, obtenerMisDatos);

// Rutas para directores (requieren autenticación y rol de director)
router.get("/estudiante/:id", verifyToken, isDirector, obtenerDatosEstudiante);
router.put("/estudiante/:id", verifyToken, isDirector, editarDatosEstudiante);

module.exports = router;

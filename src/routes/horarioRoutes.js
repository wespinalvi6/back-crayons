const express = require("express");
const router = express.Router();

const horarioController = require("../controllers/horarioController");
const { verifyToken, isDirector, isDocente } = require("../middleware/auth");

router.get("/catalogos", verifyToken, isDirector, horarioController.obtenerCatalogos);
router.get("/docente/:idDocente/asignaciones", verifyToken, isDirector, horarioController.obtenerAsignacionesPorDocente);
router.get("/reporte", verifyToken, isDirector, horarioController.obtenerReporteHorarios);
router.post("/asignaciones", verifyToken, isDirector, horarioController.crearAsignacionDocente);
router.post("/", verifyToken, isDirector, horarioController.crearHorario);
router.get("/seccion/:idSeccion", verifyToken, horarioController.obtenerHorarioPorSeccion);
router.post("/asistencia", verifyToken, horarioController.registrarAsistenciaConHorario);
router.get("/docente/bloques", verifyToken, isDocente, horarioController.obtenerMisBloquesDocente);
router.get("/docente/bloques/:idHorario/alumnos", verifyToken, isDocente, horarioController.obtenerAlumnosPorBloqueDocente);
router.post("/docente/asistencia-bloque", verifyToken, isDocente, horarioController.registrarAsistenciaBloqueMasiva);
router.get("/docente/reporte-bloque", verifyToken, isDocente, horarioController.reporteBloqueDocente);
router.get("/docente/reporte-diario", verifyToken, isDocente, horarioController.reporteDiarioDocente);
router.get("/docente/reporte-alumno", verifyToken, isDocente, horarioController.reporteAlumnoDocente);
router.get("/docente/reporte-diario/exportar-excel", verifyToken, isDocente, horarioController.exportarReporteDiarioExcel);
router.get("/docente/reporte-diario/exportar-pdf", verifyToken, isDocente, horarioController.exportarReporteDiarioPDF);

module.exports = router;

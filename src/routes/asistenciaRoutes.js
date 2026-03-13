const express = require('express');
const router = express.Router();
const { verifyToken, isDocente, isAlumno } = require('../middleware/auth');
const {
  marcarAsistencia,
  marcarAsistenciaMasiva,
  obtenerAsistenciasPorDocente,
  obtenerAsistenciasPorAlumno,
  obtenerFaltasParaJustificar,
  reportePorCurso,
  reportePorDia,
  reporteDiarioPorGrado
} = require('../controllers/asistenciaController');

// Rutas para docentes
router.post('/marcar', verifyToken, isDocente, marcarAsistencia);
router.post('/marcar-masivo', verifyToken, isDocente, marcarAsistenciaMasiva);
router.get('/docente', verifyToken, isDocente, obtenerAsistenciasPorDocente);

// Rutas para reportes (pueden ser para directores o docentes)
router.get('/reporte-curso', verifyToken, reportePorCurso);
router.get('/reporte-dia', verifyToken, reportePorDia);
router.get('/reporte-grado', verifyToken, reporteDiarioPorGrado);

// Rutas para alumnos
router.get('/alumno', verifyToken, isAlumno, obtenerAsistenciasPorAlumno);
router.get('/faltas-justificar', verifyToken, isAlumno, obtenerFaltasParaJustificar);

module.exports = router;
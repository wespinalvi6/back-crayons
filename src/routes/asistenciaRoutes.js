const express = require('express');
const router = express.Router();
const { verifyToken, isDocente, isAlumno, isDirector } = require('../middleware/auth');
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

// Rutas para reportes (solo directores y docentes)
router.get('/reporte-curso', verifyToken, isDocente, reportePorCurso);
router.get('/reporte-dia', verifyToken, isDocente, reportePorDia);
router.get('/reporte-grado', verifyToken, (req, res, next) => {
  if (req.user.id_rol === 1 || req.user.id_rol === 2) return next();
  res.status(403).json({ success: false, message: 'Acceso denegado.' });
}, reporteDiarioPorGrado);

// Rutas para alumnos
router.get('/alumno', verifyToken, isAlumno, obtenerAsistenciasPorAlumno);
router.get('/faltas-justificar', verifyToken, isAlumno, obtenerFaltasParaJustificar);

module.exports = router;
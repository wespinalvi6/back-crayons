const express = require('express');
const multer = require('multer');
const router = express.Router();
const { verifyToken, isAlumno, isDocente, isDirector } = require('../middleware/auth');
const {
  crearJustificacion,
  obtenerJustificacionesAlumno,
  obtenerJustificacionesDocente,
  obtenerTodasJustificaciones,
  obtenerJustificacionPorId,
  actualizarEstadoJustificacion,
  eliminarJustificacion
} = require('../controllers/justificacionController');

// Configurar multer para subir archivos
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 10 * 1024 * 1024 // 10MB máximo
  },
  fileFilter: (req, file, cb) => {
    // Permitir PDF e imágenes para las justificaciones
    if (file.mimetype === 'application/pdf' || file.mimetype.startsWith('image/')) {
      cb(null, true);
    } else {
      cb(new Error('Solo se permiten archivos PDF o Imágenes'), false);
    }
  }
});

// Rutas para alumnos
router.post('/crear', verifyToken, isAlumno, upload.single('archivo'), crearJustificacion);
router.get('/mis-justificaciones', verifyToken, isAlumno, obtenerJustificacionesAlumno);
router.get('/:id', verifyToken, obtenerJustificacionPorId);

// Rutas para docentes
router.get('/docente/pendientes', verifyToken, isDocente, obtenerJustificacionesDocente);
router.get('/docente/historial', verifyToken, isDocente, obtenerJustificacionesDocente);
router.put('/:id/estado', verifyToken, isDocente, actualizarEstadoJustificacion);

// Rutas para admin (Director)
router.get('/admin/todas', verifyToken, isDirector, obtenerTodasJustificaciones);
router.delete('/:id', verifyToken, isDirector, eliminarJustificacion);

module.exports = router;

const express = require('express');
const router = express.Router();
const CuotasController = require('../controllers/cuotasController');
const { verifyToken } = require('../middleware/auth');

// Ruta para listar cuotas del alumno autenticado
router.get('/mi-cuota', verifyToken, CuotasController.listarCuotasAlumno);

// Ruta para listar cuotas del alumno autenticado por año
router.get('/mi-cuota/:anio', verifyToken, CuotasController.listarCuotasAlumnoPorAnio);

// Ruta para obtener cuotas completas por DNI y año (protegida - solo director)
router.get('/estudiante/:dni/:anio', verifyToken, CuotasController.obtenerCuotasPorDniYAnio);

// Ruta para marcar cuota como pagada (protegida - solo director)
router.put('/marcar-pagada', verifyToken, CuotasController.marcarCuotaComoPagada);

// Ruta para filtrar cuotas por año, grado y estado (protegida - solo director)
router.get('/filtro/:anio/:idGrado/:estado', verifyToken, CuotasController.obtenerCuotasPorFiltros);

module.exports = router;
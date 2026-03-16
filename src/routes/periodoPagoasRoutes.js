const express = require('express');
const router = express.Router();
const periodoPagoasController = require('../controllers/periodoPagoasController');

// Obtener costos por año
router.get('/anio/:anio', periodoPagoasController.getByAnio);

// Crear nuevo periodo
router.post('/agregar-periodo', periodoPagoasController.create);

// Obtener todos los periodos
router.get('/periodos', periodoPagoasController.getAll);

// Actualizar periodo
router.put('/actualizar-periodo/:id', periodoPagoasController.update);

// Eliminar periodo
router.delete('/eliminar-periodo/:id', periodoPagoasController.delete);

module.exports = router;
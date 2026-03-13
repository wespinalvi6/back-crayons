const express = require('express');
const router = express.Router();
const periodoPagoasController = require('../controllers/periodoPagoasController');

// Obtener costos por año
router.get('/anio/:anio', periodoPagoasController.getByAnio);

// Crear nuevo periodo
router.post('/agregar-periodo', periodoPagoasController.create);

// Obtener todos los periodos
router.get('/periodos', periodoPagoasController.getAll);

module.exports = router; 
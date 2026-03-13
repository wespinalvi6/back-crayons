const express = require('express');
const router = express.Router();
const { generarPagoCuota, webhookMercadoPago, registrarPagoPresencial, generarConstanciaPago } = require('../controllers/pagoController');
const { verifyToken, isDirector } = require('../middleware/auth');

router.post('/mercadopago/cuota', verifyToken, generarPagoCuota);

// Registro de pago presencial (Solo Director)
router.post('/presencial/cuota', verifyToken, isDirector, registrarPagoPresencial);

// Generar PDF de constancia de pago
router.get('/constancia/:id_cuota', verifyToken, isDirector, generarConstanciaPago);

// Webhook de Mercado Pago (no requiere autenticación)
router.post('/mercadopago/webhook', webhookMercadoPago);

module.exports = router; 
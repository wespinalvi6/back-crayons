
const mercadopago = require('mercadopago');
const { Preference, Payment, MercadoPagoConfig } = require('mercadopago');
const Cuota = require('../models/Cuota');
const pool = require('../config/database');
const Alumno = require('../models/Alumno');
const PDFDocument = require('pdfkit');
const { decrypt } = require('../utils/cryptoUtils');

const mpClient = require('../services/mercadoPago');

const generarPagoCuota = async (req, res) => {
  let connection;
  try {
    const id_persona = req.user.id_persona;
    const { id_cuota } = req.body;

    if (!id_cuota) {
      return res.status(400).json({ success: false, message: 'El ID de la cuota es obligatorio' });
    }

    connection = await pool.getConnection();

    // 1. Validar que la cuota exista y pertenezca al alumno logueado (o su apoderado)
    // Para simplificar, primero buscamos la cuota y verificamos el alumno
    const [rows] = await connection.query(`
      SELECT c.*, CAST(c.monto AS DECIMAL(10,2)) as monto_decimal,
             a.id as id_alumno, p.id as id_persona, p.nombres, p.apellido_paterno, p.apellido_materno, p.dni, p.email
      FROM cuotas c
      JOIN matriculas m ON c.id_matricula = m.id
      JOIN alumnos a ON m.id_alumno = a.id
      JOIN personas p ON a.id_persona = p.id
      WHERE c.id = ?
    `, [id_cuota]);

    if (rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Cuota no encontrada' });
    }

    const item = rows[0];
    const decryptedDni = decrypt(item.dni);
    const decryptedNombres = decrypt(item.nombres);
    const decryptedApPaterno = decrypt(item.apellido_paterno);

    // Verificar autorización: El usuario debe ser el alumno
    // TODO: Extender para permitir apoderados
    if (item.id_persona !== id_persona) {
      return res.status(403).json({ success: false, message: 'No tienes permiso para pagar esta cuota' });
    }

    if (item.estado === 'Pagada') {
      return res.status(400).json({ success: false, message: 'Esta cuota ya está pagada' });
    }

    // 2. Crear Preferencia en Mercado Pago
    const preference = new Preference(mpClient);

    const descripcion = `${item.tipo} ${item.numero_cuota > 0 ? item.numero_cuota : ''} - ${decryptedNombres} ${decryptedApPaterno}`;

    // Obtener la URL base y asegurar que no tenga slash final para construir rutas limpias
    let DOMAIN = process.env.DOMAIN || 'https://nodejsback-production.up.railway.app';
    if (DOMAIN.endsWith('/')) {
      DOMAIN = DOMAIN.slice(0, -1);
    }

    const result = await preference.create({
      body: {
        items: [
          {
            id: String(item.id),
            title: descripcion,
            unit_price: Number(item.monto_decimal),
            quantity: 1,
            currency_id: 'PEN'
          }
        ],
        payer: {
          name: decryptedNombres,
          surname: decryptedApPaterno,
          email: item.email || 'test_user_123456@testuser.com', // Email de prueba si no hay uno real válido
          identification: {
            type: 'DNI',
            number: decryptedDni
          }
        },
        back_urls: {
          success: `${DOMAIN}/pago-exitoso`,
          failure: `${DOMAIN}/pago-fallido`,
          pending: `${DOMAIN}/pago-pendiente`,
        },
        auto_return: 'approved',
        notification_url: `${DOMAIN}/api/pago/mercadopago/webhook`,
        external_reference: String(item.id), // ID de la cuota para identificarla en el webhook
        payment_methods: {
          excluded_payment_types: [
            { id: "ticket" } // Excluir pago en efectivo si se desea inmediatez
          ],
          installments: 1
        }
      }
    });

    res.json({
      success: true,
      preferenceId: result.id,
      init_point: result.init_point,
      sandbox_init_point: result.sandbox_init_point
    });

  } catch (error) {
    res.status(500).json({ success: false, message: 'Error al generar la preferencia de pago' });
  } finally {
    if (connection) connection.release();
  }
};

const crypto = require('crypto');

const webhookMercadoPago = async (req, res) => {
  const { query, body, headers } = req;
  const mpWebhookSecret = process.env.MP_WEBHOOK_SECRET;

  // VERIFICACIÓN DE SEGURIDAD: Validar X-Signature para prevenir falsificación (Spoofing)
  const xSignature = headers['x-signature'];
  if (process.env.NODE_ENV === 'production') {
    if (!xSignature || !mpWebhookSecret) {
      return res.status(403).send('Configuración de seguridad incompleta');
    }

    try {
      // Formato esperado de x-signature: "ts=...,v1=..."
      const parts = xSignature.split(',');
      const ts = parts.find(p => p.startsWith('ts='))?.split('=')[1];
      const v1 = parts.find(p => p.startsWith('v1='))?.split('=')[1];

      if (!ts || !v1) throw new Error('Formato de firma inválido');

      const resourceId = query.id || (body.data && body.data.id) || body.id;
      const manifest = `id:${resourceId};request-id:${headers['x-request-id'] || ''};ts:${ts};`;

      const hmac = crypto.createHmac('sha256', mpWebhookSecret);
      const calculatedSignature = hmac.update(manifest).digest('hex');

      if (calculatedSignature !== v1) {
        return res.status(403).send('Firma inválida');
      }
    } catch (err) {
      return res.status(403).send('Error de validación');
    }
  }

  // Mercado Pago envía notificaciones de diferentes formas según la versión/configuración
  const type = query.type || body.type || (query.topic === 'payment' ? 'payment' : null);
  const id = query.id || (body.data && body.data.id) || body.id;

  try {
    // Responder 200 OK inmediatamente para evitar reintentos de MP
    res.sendStatus(200);

    if (type === 'payment') {
      const paymentId = id;

      const paymentClient = new Payment(mpClient);
      const payment = await paymentClient.get({ id: paymentId });

      const { status, status_detail, external_reference, transaction_amount, payment_method_id } = payment;

      console.log(`Estado del pago ${paymentId}: ${status} (${status_detail})`);
      console.log(`Referencia externa (ID Cuota): ${external_reference}`);

      if (status === 'approved') {
        const idCuota = external_reference;

        // Identificar si es Yape (algunas integraciones lo reportan como 'yape' o 'account_money' para wallet)
        const esYape = (payment_method_id === 'yape' || (payment_method_id === 'account_money' && payment.payment_type_id === 'account_money'));
        const metodoFinal = esYape ? 'Yape' : 'Tarjeta';

        console.log(`Registrando pago aprobado para cuota ${idCuota} vía ${metodoFinal}`);

        // Actualizar base de datos
        const pagado = await Cuota.registrarPago(
          idCuota,
          transaction_amount,
          metodoFinal,
          String(paymentId),
          `Pago online MercadoPago (${status_detail})`
        );

        if (pagado) {
        } else {
        }
      } else {
      }
    } else {
    }
  } catch (error) {
  }
};

const registrarPagoPresencial = async (req, res) => {
  try {
    const { id_cuota, monto_pagado, metodo_pago, numero_recibo, observaciones } = req.body;

    if (!id_cuota || !monto_pagado) {
      return res.status(400).json({ success: false, message: 'Faltan campos obligatorios (id_cuota, monto_pagado)' });
    }

    // 1. Verificar existencia de la cuota
    const [cuotaRows] = await pool.pool.query("SELECT * FROM cuotas WHERE id = ?", [id_cuota]);
    if (cuotaRows.length === 0) {
      return res.status(404).json({ success: false, message: 'Cuota no encontrada' });
    }

    if (cuotaRows[0].estado === 'Pagada') {
      return res.status(400).json({ success: false, message: 'Esta cuota ya figura como pagada' });
    }

    // 2. Generar número de recibo correlativo automáticamente
    const anioActual = new Date().getFullYear();
    const [lastRec] = await pool.pool.query(
      "SELECT numero_recibo FROM cuotas WHERE numero_recibo LIKE ? ORDER BY id DESC LIMIT 1",
      [`REC-${anioActual}-%`]
    );

    let nuevoNumeroRecibo;
    if (lastRec.length > 0) {
      const lastNum = lastRec[0].numero_recibo;
      const correlativo = parseInt(lastNum.split('-')[2]) + 1;
      nuevoNumeroRecibo = `REC-${anioActual}-${String(correlativo).padStart(5, '0')}`;
    } else {
      nuevoNumeroRecibo = `REC-${anioActual}-00001`;
    }

    // 3. Registrar el pago usando el modelo existente
    const pagado = await Cuota.registrarPago(
      id_cuota,
      monto_pagado,
      metodo_pago || 'Efectivo',
      numero_recibo || nuevoNumeroRecibo, // Si envían uno manual lo respeta, si no usa el generado
      observaciones || 'Pago presencial en oficina'
    );

    if (pagado) {
      res.json({
        success: true,
        message: 'Pago presencial registrado correctamente',
        numero_recibo: numero_recibo || nuevoNumeroRecibo
      });
    } else {
      res.status(500).json({ success: false, message: 'Error al actualizar la cuota' });
    }

  } catch (error) {
    res.status(500).json({ success: false, message: 'Error interno del servidor' });
  }
};

const generarConstanciaPago = async (req, res) => {
  try {
    const { id_cuota } = req.params;

    const query = `
      SELECT 
        c.*, 
        p.nombres, p.apellido_paterno, p.apellido_materno, p.dni, 
        g.nombre AS grado_nombre,
        pa.anio AS anio_academico
      FROM cuotas c
      JOIN matriculas m ON c.id_matricula = m.id
      JOIN alumnos a ON m.id_alumno = a.id
      JOIN personas p ON a.id_persona = p.id
      JOIN grados g ON m.id_grado = g.id
      JOIN periodos_academicos pa ON m.id_periodo = pa.id
      WHERE c.id = ?
    `;

    const [rows] = await pool.pool.query(query, [id_cuota]);

    if (rows.length === 0) {
      return res.status(404).json({ success: false, message: 'La cuota no existe.' });
    }

    const info = rows[0];
    const decryptedDni = decrypt(info.dni);
    const decryptedNombres = decrypt(info.nombres);
    const decryptedApPaterno = decrypt(info.apellido_paterno);
    const decryptedApMaterno = decrypt(info.apellido_materno);

    if (info.estado !== 'Pagada') {
      return res.status(400).json({ success: false, message: 'No se puede generar comprobante de una cuota pendiente.' });
    }

    // Crear el documento PDF
    const doc = new PDFDocument({ margin: 50 });

    // Configurar cabeceras de respuesta
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename=recibo-${info.numero_recibo}.pdf`);

    doc.pipe(res);

    // --- Diseño del Recibo ---

    // Header
    doc.fillColor("#444444")
      .fontSize(20)
      .text("CRAYONS ACADEMY", 110, 57)
      .fontSize(10)
      .text("RUC: 20600000001", 200, 65, { align: "right" })
      .text("Av. Las Flores 123 - Lima", 200, 80, { align: "right" })
      .moveDown();

    doc.lineCap('butt')
      .moveTo(50, 110)
      .lineTo(550, 110)
      .stroke();

    // Título y Número
    doc.fillColor("#333333")
      .fontSize(16)
      .text("CONSTANCIA DE PAGO", 50, 130)
      .fontSize(14)
      .fillColor("#e63946")
      .text(`N° ${info.numero_recibo}`, 400, 130, { align: "right" });

    doc.moveDown();

    // Información del Alumno
    doc.fillColor("#333333").fontSize(12).text("DATOS DEL ESTUDIANTE", 50, 170);
    doc.fontSize(10)
      .text(`Nombre: ${decryptedNombres} ${decryptedApPaterno} ${decryptedApMaterno}`, 50, 190)
      .text(`DNI: ${decryptedDni}`, 50, 205)
      .text(`Grado: ${info.grado_nombre}`, 50, 220)
      .text(`Año Académico: ${info.anio_academico}`, 50, 235);

    // Detalles del Pago
    doc.fontSize(12).text("DETALLES DEL PAGO", 300, 170);
    doc.fontSize(10)
      .text(`Fecha de Pago: ${new Date(info.fecha_pago).toLocaleDateString()}`, 300, 190)
      .text(`Método: ${info.metodo_pago}`, 300, 205)
      .text(`Concepto: ${info.tipo} ${info.numero_cuota > 0 ? 'N° ' + info.numero_cuota : ''}`, 300, 220)
      .text(`Estado: ${info.estado}`, 300, 235);

    // Tabla de Montos
    const tableTop = 280;
    doc.rect(50, tableTop, 500, 30).fill("#f1f1f1");
    doc.fillColor("#333333").fontSize(10).text("DESCRIPCIÓN", 60, tableTop + 10);
    doc.text("TOTAL", 500, tableTop + 10);

    const rowTop = tableTop + 40;
    doc.text(`${info.tipo} - Periodo ${info.anio_academico}`, 60, rowTop);
    doc.text(`S/ ${info.monto_pagado}`, 500, rowTop);

    doc.moveTo(50, rowTop + 20).lineTo(550, rowTop + 20).stroke();

    // Total final
    doc.fontSize(12).text("TOTAL PAGADO:", 380, rowTop + 40);
    doc.fontSize(14).fillColor("#000000").text(`S/ ${info.monto_pagado}`, 480, rowTop + 38);

    // Pie de página
    doc.fontSize(10).fillColor("#777777").text(
      "Este documento es una constancia de pago válida emitida por el sistema de gestión de CRAYONS ACADEMY.",
      50, 700, { align: "center", width: 500 }
    );

    doc.end();

  } catch (error) {
    res.status(500).json({ success: false, message: 'Error al generar el PDF del comprobante.' });
  }
};

module.exports = {
  generarPagoCuota,
  webhookMercadoPago,
  registrarPagoPresencial,
  generarConstanciaPago
};
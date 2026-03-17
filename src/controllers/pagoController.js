const mercadopago = require('mercadopago');
const { Preference, Payment, MercadoPagoConfig } = require('mercadopago');
const Cuota = require('../models/Cuota');
const pool = require('../config/database');
const Alumno = require('../models/Alumno');
const PDFDocument = require('pdfkit');
const { decrypt } = require('../utils/cryptoUtils');
const https = require('https');

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

    const [rows] = await connection.query(`
      SELECT c.*, CAST(c.monto AS DECIMAL(10,2)) as monto_decimal,
             a.id as id_alumno, p.id as id_persona, p.nombres, p.apellido_paterno, p.apellido_materno, p.dni, p.email,
             pa.activo as periodo_activo, m.estado as matricula_estado
      FROM cuotas c
      JOIN matriculas m ON c.id_matricula = m.id
      JOIN alumnos a ON m.id_alumno = a.id
      JOIN personas p ON a.id_persona = p.id
      JOIN periodos_academicos pa ON m.id_periodo = pa.id
      WHERE c.id = ?
    `, [id_cuota]);

    if (rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Cuota no encontrada' });
    }

    const item = rows[0];

    if (!item.periodo_activo) {
      return res.status(400).json({ success: false, message: 'No se pueden realizar pagos en un periodo académico inactivo.' });
    }

    if (item.matricula_estado === 'Retirado') {
      return res.status(400).json({ success: false, message: 'No se pueden realizar pagos para un estudiante con estado Retirado.' });
    }

    const decryptedDni = decrypt(item.dni);
    const decryptedNombres = decrypt(item.nombres);
    const decryptedApPaterno = decrypt(item.apellido_paterno);

    if (item.id_persona !== id_persona) {
      return res.status(403).json({ success: false, message: 'No tienes permiso para pagar esta cuota' });
    }

    if (item.estado === 'Pagada') {
      return res.status(400).json({ success: false, message: 'Esta cuota ya está pagada' });
    }

    const preference = new Preference(mpClient);
    const descripcion = `${item.tipo} ${item.numero_cuota > 0 ? item.numero_cuota : ''} - ${decryptedNombres} ${decryptedApPaterno}`;

    let DOMAIN = process.env.DOMAIN || 'https://api.colegiocrayons.com';
    if (DOMAIN.endsWith('/')) DOMAIN = DOMAIN.slice(0, -1);

    const result = await preference.create({
      body: {
        items: [{
          id: String(item.id),
          title: descripcion,
          unit_price: Number(item.monto_decimal),
          quantity: 1,
          currency_id: 'PEN'
        }],
        payer: {
          name: decryptedNombres,
          surname: decryptedApPaterno,
          email: item.email || 'test_user_123456@testuser.com',
          identification: { type: 'DNI', number: decryptedDni }
        },
        back_urls: {
          success: `${DOMAIN}/pago-exitoso`,
          failure: `${DOMAIN}/pago-fallido`,
          pending: `${DOMAIN}/pago-pendiente`,
        },
        auto_return: 'approved',
        notification_url: `${DOMAIN}/api/pago/mercadopago/webhook`,
        external_reference: String(item.id),
        payment_methods: {
          excluded_payment_types: [{ id: "ticket" }],
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

  const xSignature = headers['x-signature'];
  if (process.env.NODE_ENV === 'production') {
    if (!xSignature || !mpWebhookSecret) {
      return res.status(403).send('Configuración de seguridad incompleta');
    }
    try {
      const parts = xSignature.split(',');
      const ts = parts.find(p => p.startsWith('ts='))?.split('=')[1];
      const v1 = parts.find(p => p.startsWith('v1='))?.split('=')[1];
      if (!ts || !v1) throw new Error('Formato de firma inválido');
      const resourceId = query.id || (body.data && body.data.id) || body.id;
      const manifest = `id:${resourceId};request-id:${headers['x-request-id'] || ''};ts:${ts};`;
      const hmac = crypto.createHmac('sha256', mpWebhookSecret);
      const calculatedSignature = hmac.update(manifest).digest('hex');
      if (calculatedSignature !== v1) return res.status(403).send('Firma inválida');
    } catch (err) {
      return res.status(403).send('Error de validación');
    }
  }

  const type = query.type || body.type || (query.topic === 'payment' ? 'payment' : null);
  const id = query.id || (body.data && body.data.id) || body.id;

  try {
    res.sendStatus(200);
    if (type === 'payment') {
      const paymentClient = new Payment(mpClient);
      const payment = await paymentClient.get({ id });
      const { status, status_detail, external_reference, transaction_amount, payment_method_id } = payment;
      if (status === 'approved') {
        const esYape = (payment_method_id === 'yape' || (payment_method_id === 'account_money' && payment.payment_type_id === 'account_money'));
        await Cuota.registrarPago(
          external_reference,
          transaction_amount,
          esYape ? 'Yape' : 'Tarjeta',
          String(id),
          `Pago online MercadoPago (${status_detail})`
        );
      }
    }
  } catch (error) { /* silent */ }
};

const registrarPagoPresencial = async (req, res) => {
  try {
    const { id_cuota, monto_pagado, metodo_pago, numero_recibo, observaciones } = req.body;

    if (!id_cuota || !monto_pagado) {
      return res.status(400).json({ success: false, message: 'Faltan campos obligatorios (id_cuota, monto_pagado)' });
    }

    const [cuotaRows] = await pool.pool.query(`
      SELECT c.*, pa.activo as periodo_activo, m.estado as matricula_estado
      FROM cuotas c
      JOIN matriculas m ON c.id_matricula = m.id
      JOIN periodos_academicos pa ON m.id_periodo = pa.id
      WHERE c.id = ?
    `, [id_cuota]);

    if (cuotaRows.length === 0) return res.status(404).json({ success: false, message: 'Cuota no encontrada' });

    const info = cuotaRows[0];
    if (!info.periodo_activo) return res.status(400).json({ success: false, message: 'No se pueden registrar pagos en un periodo académico inactivo.' });
    if (info.matricula_estado === 'Retirado') return res.status(400).json({ success: false, message: 'No se pueden registrar pagos para un estudiante con estado Retirado.' });
    if (info.estado === 'Pagada') return res.status(400).json({ success: false, message: 'Esta cuota ya figura como pagada' });

    const anioActual = new Date().getFullYear();
    const [lastRec] = await pool.pool.query(
      "SELECT numero_recibo FROM cuotas WHERE numero_recibo LIKE ? ORDER BY id DESC LIMIT 1",
      [`REC-${anioActual}-%`]
    );

    let nuevoNumeroRecibo;
    if (lastRec.length > 0) {
      const correlativo = parseInt(lastRec[0].numero_recibo.split('-')[2]) + 1;
      nuevoNumeroRecibo = `REC-${anioActual}-${String(correlativo).padStart(5, '0')}`;
    } else {
      nuevoNumeroRecibo = `REC-${anioActual}-00001`;
    }

    const pagado = await Cuota.registrarPago(
      id_cuota, monto_pagado,
      metodo_pago || 'Efectivo',
      numero_recibo || nuevoNumeroRecibo,
      observaciones || 'Pago presencial en oficina'
    );

    if (pagado) {
      res.json({ success: true, message: 'Pago presencial registrado correctamente', numero_recibo: numero_recibo || nuevoNumeroRecibo });
    } else {
      res.status(500).json({ success: false, message: 'Error al actualizar la cuota' });
    }
  } catch (error) {
    res.status(500).json({ success: false, message: 'Error interno del servidor' });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// Helper: descarga imagen remota → Buffer
// ─────────────────────────────────────────────────────────────────────────────
function descargarImagen(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (response) => {
      if (response.statusCode !== 200) return reject(new Error(`HTTP ${response.statusCode}`));
      const chunks = [];
      response.on('data', c => chunks.push(c));
      response.on('end', () => resolve(Buffer.concat(chunks)));
      response.on('error', reject);
    }).on('error', reject);
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Helper: fecha DD/MM/AAAA
// ─────────────────────────────────────────────────────────────────────────────
function fmtFecha(date) {
  const d = new Date(date);
  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  return `${dd}/${mm}/${d.getFullYear()}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Helper: monto en letras  →  "TRESCIENTOS CINCUENTA Y 00/100 SOLES"
// ─────────────────────────────────────────────────────────────────────────────
function montoEnLetras(monto) {
  const unidades = ['', 'UN', 'DOS', 'TRES', 'CUATRO', 'CINCO', 'SEIS', 'SIETE', 'OCHO', 'NUEVE',
    'DIEZ', 'ONCE', 'DOCE', 'TRECE', 'CATORCE', 'QUINCE', 'DIECISEIS', 'DIECISIETE', 'DIECIOCHO', 'DIECINUEVE'];
  const decenas = ['', '', 'VEINTE', 'TREINTA', 'CUARENTA', 'CINCUENTA', 'SESENTA', 'SETENTA', 'OCHENTA', 'NOVENTA'];
  const centenas = ['', 'CIENTO', 'DOSCIENTOS', 'TRESCIENTOS', 'CUATROCIENTOS', 'QUINIENTOS',
    'SEISCIENTOS', 'SETECIENTOS', 'OCHOCIENTOS', 'NOVECIENTOS'];

  function convertir(n) {
    if (n === 0) return '';
    if (n === 100) return 'CIEN';
    if (n < 20) return unidades[n];
    if (n < 100) {
      const u = n % 10;
      return u === 0 ? decenas[Math.floor(n / 10)] : `${decenas[Math.floor(n / 10)]} Y ${unidades[u]}`;
    }
    const c = Math.floor(n / 100);
    const r = n % 100;
    return r === 0 ? centenas[c] : `${centenas[c]} ${convertir(r)}`;
  }

  const total = parseFloat(monto);
  const entero = Math.floor(total);
  const centavos = Math.round((total - entero) * 100);
  return `${entero === 0 ? 'CERO' : convertir(entero)} Y ${String(centavos).padStart(2, '0')}/100 SOLES`;
}

// ─────────────────────────────────────────────────────────────────────────────
// CONSTANCIA DE PAGO — Formato estándar peruano
// ─────────────────────────────────────────────────────────────────────────────
const generarConstanciaPago = async (req, res) => {
  try {
    const { id_cuota } = req.params;

    const [rows] = await pool.pool.query(`
      SELECT c.*,
             p.nombres, p.apellido_paterno, p.apellido_materno, p.dni,
             g.nombre AS grado_nombre,
             pa.anio  AS anio_academico
      FROM cuotas c
      JOIN matriculas m           ON c.id_matricula = m.id
      JOIN alumnos a              ON m.id_alumno    = a.id
      JOIN personas p             ON a.id_persona   = p.id
      JOIN grados g               ON m.id_grado     = g.id
      JOIN periodos_academicos pa ON m.id_periodo   = pa.id
      WHERE c.id = ?
    `, [id_cuota]);

    if (rows.length === 0)
      return res.status(404).json({ success: false, message: 'La cuota no existe.' });

    const info = rows[0];

    if (info.estado !== 'Pagada')
      return res.status(400).json({ success: false, message: 'No se puede generar comprobante de una cuota pendiente.' });

    const nombres = decrypt(info.nombres);
    const apPaterno = decrypt(info.apellido_paterno);
    const apMaterno = decrypt(info.apellido_materno);
    const dni = decrypt(info.dni);
    const nombreCompleto = `${nombres} ${apPaterno} ${apMaterno}`.toUpperCase();
    const montoNum = parseFloat(info.monto_pagado);
    const montoFmt = `S/ ${montoNum.toFixed(2)}`;
    const concepto = `${info.tipo}${info.numero_cuota > 0 ? ' - Cuota N° ' + info.numero_cuota : ''}`;

    // Logo

    let logoBuffer = null;
    try { logoBuffer = await descargarImagen(LOGO_URL); } catch (_) { }

    // ── Documento ────────────────────────────────────────────────────────────
    const doc = new PDFDocument({ size: 'A4', margin: 0 });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename=recibo-${info.numero_recibo}.pdf`);
    doc.pipe(res);

    // ── Constantes ───────────────────────────────────────────────────────────
    const PW = 595.28;
    const PH = 841.89;
    const ML = 48;          // margen izquierdo
    const MR = 48;          // margen derecho
    const CW = PW - ML - MR;

    // Colores — paleta sobria, profesional
    const C_DARK = '#1A2E4A';   // azul oscuro (encabezados)
    const C_TEXT = '#1C1C1C';   // texto principal
    const C_SUB = '#4A4A4A';   // texto secundario
    const C_MUTED = '#7A7A7A';   // etiquetas
    const C_BORDER = '#BBBBBB';   // líneas y bordes
    const C_BG = '#F5F5F5';   // fondo filas alternas / totales
    const C_WHITE = '#FFFFFF';
    const C_STRIPE = '#F0F0F0';   // raya suave en tabla

    let y = 0;  // cursor vertical

    // ════════════════════════════════════════════════════════════════════════
    // FRANJA SUPERIOR (azul oscuro, delgada — solo 6 px)
    // ════════════════════════════════════════════════════════════════════════
    doc.rect(0, 0, PW, 6).fill(C_DARK);
    y = 22;

    // ════════════════════════════════════════════════════════════════════════
    // CABECERA: Logo + Empresa + Caja N° Recibo
    // ════════════════════════════════════════════════════════════════════════
    const LOGO_H = 70;

    if (logoBuffer) {
      doc.image(logoBuffer, ML, y, { height: LOGO_H, fit: [LOGO_H, LOGO_H] });
    }

    const txtX = ML + (logoBuffer ? LOGO_H + 14 : 0);
    const txtW = 280;

    doc.font('Helvetica-Bold').fontSize(11.5).fillColor(C_DARK)
      .text('SERVICIOS EDUCATIVOS CRAYOLITAS S.A.C.', txtX, y + 4, { width: txtW });

    doc.font('Helvetica').fontSize(8.5).fillColor(C_SUB)
      .text('RUC: 20600184742', txtX, y + 22)
      .text('Colegio Crayons Academy', txtX, y + 33)
      .text('Av. Las Flores 123 - Satipo, Perú', txtX, y + 44)
      .text('Teléf.: (01) 000-0000  |  www.colegiocrayons.com', txtX, y + 55);

    // Caja de número de comprobante (derecha)
    const bxW = 150;
    const bxH = 74;
    const bxX = PW - MR - bxW;
    const bxY = y;

    // Borde exterior
    doc.rect(bxX, bxY, bxW, bxH).lineWidth(1).stroke(C_DARK);

    // Franja de título dentro de la caja
    doc.rect(bxX, bxY, bxW, 22).fill(C_DARK);
    doc.font('Helvetica-Bold').fontSize(8).fillColor(C_WHITE)
      .text('CONSTANCIA DE PAGO', bxX, bxY + 7, { width: bxW, align: 'center' });

    // Número de recibo
    doc.font('Helvetica-Bold').fontSize(13).fillColor(C_DARK)
      .text(info.numero_recibo, bxX, bxY + 30, { width: bxW, align: 'center' });

    // Fecha de emisión
    doc.font('Helvetica').fontSize(7.5).fillColor(C_MUTED)
      .text(`Emisión: ${fmtFecha(new Date())}`, bxX, bxY + 55, { width: bxW, align: 'center' });

    y += LOGO_H + 18;

    // ── Línea separadora fina ────────────────────────────────────────────────
    doc.moveTo(ML, y).lineTo(PW - MR, y).lineWidth(0.5).stroke(C_BORDER);
    y += 14;

    // ════════════════════════════════════════════════════════════════════════
    // SECCIÓN: DATOS DEL CLIENTE
    // ════════════════════════════════════════════════════════════════════════
    doc.font('Helvetica-Bold').fontSize(7.5).fillColor(C_MUTED)
      .text('DATOS DEL CLIENTE', ML, y);
    y += 11;

    // Función auxiliar para fila etiqueta + valor
    const campo = (lbl, val, x, yy, w) => {
      doc.font('Helvetica').fontSize(7.5).fillColor(C_MUTED).text(lbl, x, yy, { width: w });
      doc.font('Helvetica-Bold').fontSize(9).fillColor(C_TEXT).text(val, x, yy + 10, { width: w });
    };

    // Distribución en dos columnas
    const colA_x = ML;
    const colB_x = ML + 260;
    const colC_x = ML + 390;

    campo('Alumno:', nombreCompleto, colA_x, y, 250);
    campo('DNI:', dni, colB_x, y, 120);
    campo('Fecha de pago:', fmtFecha(info.fecha_pago), colC_x, y, 130);
    y += 30;

    campo('Grado:', info.grado_nombre.toUpperCase(), colA_x, y, 160);
    campo('Año académico:', String(info.anio_academico), colB_x, y, 120);
    campo('Método de pago:', info.metodo_pago.toUpperCase(), colC_x, y, 130);
    y += 32;

    // ── Línea separadora ─────────────────────────────────────────────────────
    doc.moveTo(ML, y).lineTo(PW - MR, y).lineWidth(0.5).stroke(C_BORDER);
    y += 14;

    // ════════════════════════════════════════════════════════════════════════
    // TABLA DE DETALLE
    // Columnas: N° | DESCRIPCIÓN / CONCEPTO | PERÍODO | CANT. | P.UNIT. | TOTAL
    // ════════════════════════════════════════════════════════════════════════

    // Anchos (ajustados para que sumen CW exactamente)
    const cols = [
      { lbl: 'N°', x: ML, w: 26, align: 'center' },
      { lbl: 'DESCRIPCIÓN', x: ML + 28, w: 228, align: 'left' },
      { lbl: 'PERÍODO', x: ML + 258, w: 72, align: 'center' },
      { lbl: 'CANT.', x: ML + 332, w: 40, align: 'center' },
      { lbl: 'P. UNIT.', x: ML + 374, w: 70, align: 'right' },
      { lbl: 'TOTAL', x: ML + 446, w: CW - 446 + ML - ML, align: 'right' },
    ];
    // Corregir el ancho de la última columna
    cols[5].w = (PW - MR) - cols[5].x;

    // ── Encabezado de tabla ───────────────────────────────────────────────────
    const TH_H = 20;
    doc.rect(ML, y, CW, TH_H).fill(C_DARK);
    cols.forEach(c => {
      doc.font('Helvetica-Bold').fontSize(8).fillColor(C_WHITE)
        .text(c.lbl, c.x + (c.align === 'right' ? 0 : 4), y + 6, { width: c.w - 4, align: c.align });
    });
    y += TH_H;

    // ── Fila de datos ─────────────────────────────────────────────────────────
    const ROW_H = 26;
    doc.rect(ML, y, CW, ROW_H).fill(C_WHITE);
    // Borde inferior de fila
    doc.moveTo(ML, y + ROW_H).lineTo(PW - MR, y + ROW_H).lineWidth(0.4).stroke(C_BORDER);

    const ry = y + 9;
    doc.font('Helvetica').fontSize(8.5).fillColor(C_TEXT)
      .text('1', cols[0].x + 4, ry, { width: cols[0].w - 4, align: 'center' });
    doc.font('Helvetica-Bold').fontSize(8.5)
      .text(concepto, cols[1].x + 4, ry, { width: cols[1].w - 4 });
    doc.font('Helvetica').fontSize(8.5)
      .text(String(info.anio_academico), cols[2].x, ry, { width: cols[2].w, align: 'center' })
      .text('1', cols[3].x, ry, { width: cols[3].w, align: 'center' })
      .text(montoFmt, cols[4].x, ry, { width: cols[4].w, align: 'right' });
    doc.font('Helvetica-Bold').fontSize(8.5)
      .text(montoFmt, cols[5].x, ry, { width: cols[5].w, align: 'right' });

    y += ROW_H + 1;

    // ════════════════════════════════════════════════════════════════════════
    // BLOQUE DE TOTALES (alineado a la derecha)
    // ════════════════════════════════════════════════════════════════════════
    y += 8;

    const totLblW = 100;
    const totValW = 80;
    const totLblX = (PW - MR) - totLblW - totValW - 4;
    const totValX = (PW - MR) - totValW;

    const filaTot = (lbl, val, bold = false, grande = false) => {
      const fs = grande ? 10.5 : 8.5;
      doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(fs).fillColor(C_SUB)
        .text(lbl, totLblX, y, { width: totLblW, align: 'right' });
      doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(fs).fillColor(bold ? C_TEXT : C_SUB)
        .text(val, totValX, y, { width: totValW, align: 'right' });
      y += grande ? 16 : 13;
    };

    filaTot('Sub total:', montoFmt);
    filaTot('IGV (0%):', 'S/ 0.00');

    // Línea antes del total final
    doc.moveTo(totLblX, y).lineTo(PW - MR, y).lineWidth(0.5).stroke(C_BORDER);
    y += 5;

    // Fondo gris para el total
    doc.rect(totLblX - 8, y - 2, totLblW + totValW + 12, 22).fill(C_BG);
    doc.font('Helvetica-Bold').fontSize(10.5).fillColor(C_DARK)
      .text('TOTAL PAGADO:', totLblX, y + 3, { width: totLblW, align: 'right' });
    doc.font('Helvetica-Bold').fontSize(10.5).fillColor(C_DARK)
      .text(montoFmt, totValX, y + 3, { width: totValW, align: 'right' });
    y += 28;

    // ════════════════════════════════════════════════════════════════════════
    // SON: monto en letras
    // ════════════════════════════════════════════════════════════════════════
    doc.font('Helvetica').fontSize(8).fillColor(C_MUTED).text('SON:', ML, y);
    doc.font('Helvetica-Bold').fontSize(8).fillColor(C_TEXT)
      .text(montoEnLetras(montoNum), ML + 30, y, { width: CW - 30 });
    y += 18;

    // ── Línea separadora ─────────────────────────────────────────────────────
    doc.moveTo(ML, y).lineTo(PW - MR, y).lineWidth(0.5).stroke(C_BORDER);
    y += 10;

    // ════════════════════════════════════════════════════════════════════════
    // ESTADO + REFERENCIA
    // ════════════════════════════════════════════════════════════════════════
    doc.font('Helvetica').fontSize(8).fillColor(C_MUTED)
      .text('Estado:', ML, y);
    doc.font('Helvetica-Bold').fontSize(8).fillColor('#1A6B3A')
      .text('PAGADO', ML + 40, y);

    doc.font('Helvetica').fontSize(8).fillColor(C_MUTED)
      .text('N° referencia:', ML + 160, y);
    doc.font('Helvetica').fontSize(8).fillColor(C_TEXT)
      .text(info.referencia_pago || info.numero_recibo, ML + 230, y);

    y += 12;

    // Observaciones
    if (info.observaciones) {
      doc.font('Helvetica-Oblique').fontSize(8).fillColor(C_MUTED)
        .text(`Observaciones: ${info.observaciones}`, ML, y, { width: CW });
      y += 14;
    }

    // ════════════════════════════════════════════════════════════════════════
    // FIRMAS
    // ════════════════════════════════════════════════════════════════════════
    const sigY = y + 50;
    const fW = 155;
    const fxL = ML + 10;
    const fxR = PW - MR - 10 - fW;

    [fxL, fxR].forEach((fx, i) => {
      doc.moveTo(fx, sigY).lineTo(fx + fW, sigY).lineWidth(0.7).stroke(C_TEXT);
      const lbl = i === 0 ? 'Cajero / Administrador' : 'Cliente / Apoderado';
      doc.font('Helvetica').fontSize(8).fillColor(C_SUB)
        .text(lbl, fx, sigY + 5, { width: fW, align: 'center' });
      doc.font('Helvetica').fontSize(7.5).fillColor(C_MUTED)
        .text('Firma y sello', fx, sigY + 17, { width: fW, align: 'center' });
    });

    // ════════════════════════════════════════════════════════════════════════
    // FOOTER
    // ════════════════════════════════════════════════════════════════════════
    const footerY = PH - 38;

    // Franja inferior azul oscuro
    doc.rect(0, PH - 28, PW, 28).fill(C_DARK);

    // Texto legal encima de la franja
    doc.moveTo(ML, footerY - 12).lineTo(PW - MR, footerY - 12).lineWidth(0.4).stroke(C_BORDER);
    doc.font('Helvetica').fontSize(7).fillColor(C_MUTED)
      .text(
        'Documento válido emitido por el Sistema de Gestión Académica de Crayons Academy. Consérvelo como respaldo de su pago.',
        ML, footerY - 8, { width: CW, align: 'center' }
      );

    // Texto en la franja footer
    doc.font('Helvetica').fontSize(7.5).fillColor(C_WHITE)
      .text(
        'SERVICIOS EDUCATIVOS CRAYOLITAS S.A.C.  |  RUC: 20600184742  |  Lima, Perú  |  www.colegiocrayons.com',
        ML, PH - 19, { width: CW, align: 'center' }
      );

    doc.end();

  } catch (error) {
    console.error('Error generarConstanciaPago:', error);
    res.status(500).json({ success: false, message: 'Error al generar el PDF del comprobante.' });
  }
};

module.exports = {
  generarPagoCuota,
  webhookMercadoPago,
  registrarPagoPresencial,
  generarConstanciaPago
};
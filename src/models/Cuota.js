const db = require("../config/database");
const { blindIndex, decrypt } = require("../utils/cryptoUtils");

class CuotasModel {
  // Método para listar cuotas de una matrícula
  static async listarPorMatricula(idMatricula) {
    const [rows] = await db.pool.query(
      "SELECT * FROM cuotas WHERE id_matricula = ? ORDER BY fecha_vencimiento ASC",
      [idMatricula]
    );
    return rows;
  }

  static async crear(connection, { id_matricula, tipo, numero_cuota, monto, fecha_vencimiento }) {
    const [result] = await connection.execute(
      `INSERT INTO cuotas (id_matricula, tipo, numero_cuota, monto, fecha_vencimiento, estado) 
       VALUES (?, ?, ?, ?, ?, 'Pendiente')`,
      [id_matricula, tipo, numero_cuota, monto, fecha_vencimiento]
    );
    return result.insertId;
  }

  // Método para listar cuotas por id_persona (alumno autenticado)
  static async listarPorIdPersona(idPersona) {
    const query = `
      SELECT c.*, cu.nombre as curso_nombre
      FROM cuotas c
      JOIN matriculas m ON c.id_matricula = m.id
      JOIN alumnos a ON m.id_alumno = a.id
      LEFT JOIN asignaciones asig ON m.id_grado = asig.id_grado AND m.id_seccion = asig.id_seccion AND m.id_periodo = asig.id_periodo
      LEFT JOIN cursos cu ON asig.id_curso = cu.id
      WHERE a.id_persona = ?
      ORDER BY c.fecha_vencimiento ASC
    `;
    const [rows] = await db.pool.query(query, [idPersona]);
    return rows;
  }

  // Método para listar cuotas por id_persona y año
  static async listarPorIdPersonaYAnio(idPersona, anio) {
    const query = `
      SELECT c.*, g.nombre as grado, pa.anio
      FROM cuotas c
      JOIN matriculas m ON c.id_matricula = m.id
      JOIN alumnos a ON m.id_alumno = a.id
      JOIN periodos_academicos pa ON m.id_periodo = pa.id
      JOIN grados g ON m.id_grado = g.id
      WHERE a.id_persona = ? AND pa.anio = ?
      ORDER BY c.fecha_vencimiento ASC
    `;
    const [rows] = await db.pool.query(query, [idPersona, anio]);
    return rows;
  }

  // Obtener resumen de pagos usando la vista
  static async obtenerResumenPorMatricula(idMatricula) {
    const [rows] = await db.pool.query(
      "SELECT * FROM v_resumen_pagos WHERE id_matricula = ?",
      [idMatricula]
    );
    return rows.length > 0 ? rows[0] : null;
  }

  // Actualizar estado de una cuota (pago realizado)
  static async registrarPago(idCuota, montoPagado, metodoPago, numeroRecibo, observaciones) {
    const query = `
      UPDATE cuotas 
      SET 
        estado = 'Pagada',
        monto_pagado = ?,
        fecha_pago = CURDATE(),
        metodo_pago = ?,
        numero_recibo = ?,
        observaciones = ?,
        updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `;
    const [result] = await db.pool.query(query, [montoPagado, metodoPago, numeroRecibo, observaciones, idCuota]);
    return result.affectedRows > 0;
  }

  // Buscar cuotas por DNI y Año (Cifrado At Rest)
  static async buscarPorDniYAnio(dni, anio) {
    const dniHash = blindIndex(dni);
    const query = `
        SELECT c.*, p.nombres, p.apellido_paterno, p.apellido_materno, g.nombre as grado, p.dni
        FROM cuotas c
        JOIN matriculas m ON c.id_matricula = m.id
        JOIN alumnos a ON m.id_alumno = a.id
        JOIN personas p ON a.id_persona = p.id
        JOIN periodos_academicos pa ON m.id_periodo = pa.id
        JOIN grados g ON m.id_grado = g.id
        WHERE p.dni_hash = ? AND pa.anio = ?
        ORDER BY c.fecha_vencimiento ASC
      `;
    const [rows] = await db.pool.query(query, [dniHash, anio]);
    return rows.map(r => ({
      ...r,
      dni: decrypt(r.dni),
      nombres: decrypt(r.nombres),
      apellido_paterno: decrypt(r.apellido_paterno),
      apellido_materno: decrypt(r.apellido_materno)
    }));
  }

  // Buscar cuotas por Filtros (Año, Grado, Estado)
  static async buscarPorFiltros(anio, idGrado, estado) {
    let query = `
        SELECT c.*, p.nombres, p.apellido_paterno, p.apellido_materno, g.nombre as grado, p.dni
        FROM cuotas c
        JOIN matriculas m ON c.id_matricula = m.id
        JOIN alumnos a ON m.id_alumno = a.id
        JOIN personas p ON a.id_persona = p.id
        JOIN periodos_academicos pa ON m.id_periodo = pa.id
        JOIN grados g ON m.id_grado = g.id
        WHERE pa.anio = ? AND m.id_grado = ?
      `;

    const params = [anio, idGrado];

    if (estado === 'deudas') {
      query += " AND c.estado != 'Pagada'";
    } else if (estado === 'pagadas') {
      query += " AND c.estado = 'Pagada'";
    }

    query += " ORDER BY p.apellido_paterno ASC, c.fecha_vencimiento ASC";

    const [rows] = await db.pool.query(query, params);
    return rows.map(r => ({
      ...r,
      dni: decrypt(r.dni),
      nombres: decrypt(r.nombres),
      apellido_paterno: decrypt(r.apellido_paterno),
      apellido_materno: decrypt(r.apellido_materno)
    }));
  }
}

module.exports = CuotasModel;

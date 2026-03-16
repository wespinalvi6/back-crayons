const db = require("../config/database");
const AlumnoModel = require("../models/Alumno");
const PersonaModel = require("../models/Persona");
const pool = require("../config/database");
const { decrypt, blindIndex } = require("../utils/cryptoUtils");
const AuditService = require("../services/AuditService");

const listarAlumnosConApoderados = async (req, res) => {
  try {
    const anio = req.params.anio;
    const grado = req.params.grado;
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;
    const offset = (page - 1) * limit;

    const [countResult] = await db.pool.query(
      `SELECT COUNT(DISTINCT e.id) as total
       FROM alumnos e
       JOIN matriculas m ON m.id_alumno = e.id
       JOIN periodos_academicos pa ON m.id_periodo = pa.id
       WHERE pa.anio = ? AND m.id_grado = ?`,
      [anio, grado]
    );

    const total = countResult[0].total;
    const totalPages = Math.ceil(total / limit);

    const [alumnos] = await db.pool.query(
      `
      SELECT
        e.id AS alumno_id, p.dni AS alumno_dni, p.nombres AS alumno_nombre, p.apellido_paterno AS alumno_apellido_paterno, p.apellido_materno AS alumno_apellido_materno, p.fecha_nacimiento,
        e.estado, u.activo, pa3.activo AS periodo_activo,
        pax.dni AS apoderado_dni, pax.nombres AS apoderado_nombre, pax.apellido_paterno AS apoderado_apellido_paterno, pax.apellido_materno AS apoderado_apellido_materno, pax.telefono,
        ea.parentesco, g.nombre AS grado_nombre, m.fecha_matricula
      FROM (
        SELECT a2.id FROM alumnos a2 JOIN matriculas m2 ON m2.id_alumno = a2.id JOIN periodos_academicos pa2 ON m2.id_periodo = pa2.id
        WHERE pa2.anio = ? AND m2.id_grado = ? ORDER BY a2.id ASC LIMIT ? OFFSET ?
      ) AS filtered
      JOIN alumnos e ON e.id = filtered.id
      JOIN personas p ON e.id_persona = p.id
      JOIN users u ON u.id_persona = p.id
      LEFT JOIN alumno_apoderado ea ON ea.id_alumno = e.id
      LEFT JOIN apoderados ap ON ap.id = ea.id_apoderado
      LEFT JOIN personas pax ON pax.id = ap.id_persona
      JOIN matriculas m ON m.id_alumno = e.id
      JOIN grados g ON g.id = m.id_grado
      JOIN periodos_academicos pa3 ON m.id_periodo = pa3.id
      WHERE pa3.anio = ? AND g.id = ?
      `,
      [anio, grado, limit, offset, anio, grado]
    );

    const alumnosMap = new Map();
    alumnos.forEach(row => {
      if (!alumnosMap.has(row.alumno_id)) {
        alumnosMap.set(row.alumno_id, {
          alumno_id: row.alumno_id,
          alumno_dni: decrypt(row.alumno_dni),
          alumno_nombre: decrypt(row.alumno_nombre),
          alumno_apellido_paterno: decrypt(row.alumno_apellido_paterno),
          alumno_apellido_materno: decrypt(row.alumno_apellido_materno),
          fecha_nacimiento: row.fecha_nacimiento,
          grado: row.grado_nombre,
          fecha_matricula: row.fecha_matricula,
          estado: row.estado,
          activo: row.activo,
          periodo_activo: row.periodo_activo,
          apoderados: []
        });
      }
      const alumno = alumnosMap.get(row.alumno_id);
      if (row.apoderado_dni) {
        alumno.apoderados.push({
          dni: decrypt(row.apoderado_dni),
          nombre: decrypt(row.apoderado_nombre),
          apellido_paterno: decrypt(row.apoderado_apellido_paterno),
          apellido_materno: decrypt(row.apoderado_apellido_materno),
          telefono: decrypt(row.telefono),
          parentesco: row.parentesco
        });
      }
    });

    await AuditService.log({
      userId: req.user.id,
      action: 'PII_BATCH_ACCESS_FULL',
      details: { count: alumnosMap.size, anio, grado },
      ipAddress: req.ip
    });

    res.status(200).json({ success: true, data: Array.from(alumnosMap.values()), pagination: { total, page, limit, totalPages } });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
};

const verMiAsistencia = async (req, res) => {
  const connection = await pool.getConnection();
  try {
    const id_persona = req.user.id_persona;
    const { anio, mes, dia } = req.query;
    let query = `
      SELECT ast.id, ast.fecha, ast.estado, ast.hora_llegada, ast.observaciones, c.nombre AS curso,
             pd.nombres, pd.apellido_paterno, pd.apellido_materno, g.nombre AS grado
      FROM asistencia ast
      JOIN matriculas m ON ast.id_matricula = m.id
      JOIN alumnos a ON m.id_alumno = a.id
      LEFT JOIN asignaciones asig ON ast.id_asignacion = asig.id
      LEFT JOIN cursos c ON asig.id_curso = c.id
      LEFT JOIN docentes d ON asig.id_docente = d.id
      LEFT JOIN personas pd ON d.id_persona = pd.id
      LEFT JOIN grados g ON m.id_grado = g.id
      WHERE a.id_persona = ?
    `;
    const params = [id_persona];
    if (anio) { query += " AND YEAR(ast.fecha) = ?"; params.push(anio); }
    if (mes) { query += " AND MONTH(ast.fecha) = ?"; params.push(mes); }
    if (dia) { query += " AND DAY(ast.fecha) = ?"; params.push(dia); }
    query += " ORDER BY ast.fecha DESC";
    const [rows] = await connection.query(query, params);

    const decryptedRows = rows.map(r => ({
      ...r,
      nombre_docente: `${decrypt(r.nombres)} ${decrypt(r.apellido_paterno)} ${decrypt(r.apellido_materno)}`.trim(),
      nombres: undefined, apellido_paterno: undefined, apellido_materno: undefined
    }));

    return res.status(200).json({ success: true, data: decryptedRows });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  } finally {
    connection.release();
  }
};

const verMisFaltas = async (req, res) => {
  const connection = await pool.getConnection();
  try {
    const id_persona = req.user.id_persona;
    const [rows] = await connection.query(`
      SELECT ast.id, ast.fecha, ast.estado, c.nombre AS curso
      FROM asistencia ast
      JOIN matriculas m ON ast.id_matricula = m.id
      JOIN alumnos a ON m.id_alumno = a.id
      JOIN asignaciones asig ON ast.id_asignacion = asig.id
      JOIN cursos c ON asig.id_curso = c.id
      WHERE a.id_persona = ? AND ast.estado = 'Ausente'
      ORDER BY ast.fecha DESC
    `, [id_persona]);
    return res.status(200).json({ success: true, total: rows.length, data: rows });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  } finally {
    connection.release();
  }
};

const obtenerMisDatos = async (req, res) => {
  const connection = await pool.getConnection();
  try {
    const id_persona = req.user.id_persona;
    const datosAlumno = await AlumnoModel.obtenerDatosCompletosPorIdPersona(connection, id_persona);
    if (!datosAlumno) return res.status(404).json({ success: false, message: "No encontrado" });

    datosAlumno.dni = decrypt(datosAlumno.dni);
    datosAlumno.nombres = decrypt(datosAlumno.nombres);
    datosAlumno.apellido_paterno = decrypt(datosAlumno.apellido_paterno);
    datosAlumno.apellido_materno = decrypt(datosAlumno.apellido_materno);
    if (datosAlumno.telefono) datosAlumno.telefono = decrypt(datosAlumno.telefono);

    await AuditService.log({
      userId: req.user.id,
      action: 'PII_ACCESS_SELF',
      details: { personaId: id_persona },
      ipAddress: req.ip
    });

    return res.status(200).json({ success: true, data: datosAlumno });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  } finally {
    connection.release();
  }
};

const obtenerDatosEstudiante = async (req, res) => {
  const connection = await pool.getConnection();
  try {
    const { id } = req.params;
    const datosAlumno = await AlumnoModel.obtenerDatosCompletos(connection, id);
    if (!datosAlumno) return res.status(404).json({ success: false, message: "No encontrado" });

    datosAlumno.dni = decrypt(datosAlumno.dni);
    datosAlumno.nombres = decrypt(datosAlumno.nombres);
    datosAlumno.apellido_paterno = decrypt(datosAlumno.apellido_paterno);
    datosAlumno.apellido_materno = decrypt(datosAlumno.apellido_materno);
    if (datosAlumno.telefono) datosAlumno.telefono = decrypt(datosAlumno.telefono);

    await AuditService.log({
      userId: req.user.id,
      action: 'PII_ACCESS_STUDENT',
      details: { alumnoId: id, dni: datosAlumno.dni },
      ipAddress: req.ip
    });

    return res.status(200).json({ success: true, data: datosAlumno });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  } finally {
    connection.release();
  }
};

const editarDatosEstudiante = async (req, res) => {
  const connection = await pool.getConnection();
  try {
    const { id } = req.params;
    const { dni, nombres, apellido_paterno, apellido_materno, fecha_nacimiento, email, telefono, direccion } = req.body;
    const alumno = await AlumnoModel.buscarPorId(connection, id);
    if (!alumno) return res.status(404).json({ success: false, message: "No encontrado." });

    const actualizado = await PersonaModel.actualizar(
      connection, alumno.id_persona, dni, nombres, apellido_paterno, apellido_materno, fecha_nacimiento, email, telefono, direccion
    );

    await AuditService.log({
      userId: req.user.id,
      action: 'PII_UPDATE_STUDENT',
      details: { alumnoId: id, fields: Object.keys(req.body) },
      ipAddress: req.ip
    });

    return res.status(200).json({ success: true, message: "Actualizado." });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  } finally {
    connection.release();
  }
};

const listarAlumnosPaginado = async (req, res) => {
  const connection = await pool.getConnection();
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;
    const offset = (page - 1) * limit;
    const search = req.query.search || '';

    let mainQuery = `
      SELECT e.id as id_alumno, p.dni, p.nombres, p.apellido_paterno, p.apellido_materno, e.codigo_alumno, g.nombre as grado
      FROM alumnos e
      JOIN personas p ON e.id_persona = p.id
      JOIN matriculas m ON m.id_alumno = e.id
      JOIN grados g ON m.id_grado = g.id
      JOIN periodos_academicos pa ON m.id_periodo = pa.id
      WHERE pa.activo = 1
    `;
    let queryParams = [];
    if (search) {
      if (search.match(/^\d{8}$/)) {
        mainQuery += " AND p.dni_hash = ?";
        queryParams.push(blindIndex(search));
      } else {
        mainQuery += " AND e.codigo_alumno LIKE ?";
        queryParams.push(`%${search}%`);
      }
    }

    const [alumnos] = await connection.query(mainQuery + " ORDER BY p.apellido_paterno ASC LIMIT ? OFFSET ?", [...queryParams, limit, offset]);

    const decryptedAlumnos = alumnos.map(a => ({
      ...a,
      dni: decrypt(a.dni),
      nombre_completo: `${decrypt(a.nombres)} ${decrypt(a.apellido_paterno)} ${decrypt(a.apellido_materno)}`.trim()
    }));

    await AuditService.log({
      userId: req.user.id,
      action: 'PII_BATCH_ACCESS',
      details: { count: decryptedAlumnos.length, search },
      ipAddress: req.ip
    });

    return res.status(200).json({ success: true, data: decryptedAlumnos, pagination: { page, limit } });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  } finally {
    connection.release();
  }
};

const toggleEstadoAlumno = async (req, res) => {
  const connection = await pool.getConnection();
  try {
    const { id } = req.params;
    const { estado, activo } = req.body; // e.g., { estado: 'Retirado', activo: 0 }

    const alumno = await AlumnoModel.buscarPorId(connection, id);
    if (!alumno) return res.status(404).json({ success: false, message: "Alumno no encontrado." });

    await connection.beginTransaction();

    // Actualizar estado del alumno
    await connection.query(
      "UPDATE alumnos SET estado = ? WHERE id = ?",
      [estado, id]
    );

    // Actualizar activo del usuario
    await connection.query(
      "UPDATE users SET activo = ? WHERE id_persona = ?",
      [activo, alumno.id_persona]
    );

    await connection.commit();

    res.status(200).json({
      success: true,
      message: `Alumno ${estado === 'Retirado' ? 'retirado' : 'activado'} correctamente.`
    });
  } catch (error) {
    if (connection) await connection.rollback();
    res.status(500).json({ success: false, error: error.message });
  } finally {
    connection.release();
  }
};

module.exports = {
  listarAlumnosConApoderados,
  verMiAsistencia,
  verMisFaltas,
  obtenerMisDatos,
  obtenerDatosEstudiante,
  editarDatosEstudiante,
  listarAlumnosPaginado,
  toggleEstadoAlumno
};

const pool = require('../config/database');
const { decrypt, blindIndex } = require('../utils/cryptoUtils');
const { notifyAbsenceToParents } = require('../utils/notificationHelper');

// Helper para sanitizar strings
const sanitizeString = (str) => {
  if (typeof str !== 'string') return '';
  return str.replace(/[<>\"'%;()&+\-\*\/\\]/g, '').trim();
};

// Helper para validar fecha ISO
const isValidISODate = (dateString) => {
  if (typeof dateString !== 'string') return false;
  const regex = /^\d{4}-\d{2}-\d{2}$/;
  if (!regex.test(dateString)) return false;
  const date = new Date(dateString);
  return date instanceof Date && !isNaN(date) && dateString === date.toISOString().split('T')[0];
};

const marcarAsistencia = async (req, res) => {
  let connection;
  try {
    const { id_alumno, id_matricula, id_asignacion, fecha, estado, observaciones } = req.body;
    const final_id_alumno = id_alumno || id_matricula;

    if (!final_id_alumno || !id_asignacion || !fecha || !estado) {
      return res.status(400).json({
        success: false,
        message: 'Faltan datos obligatorios: id_alumno, id_asignacion, fecha, estado'
      });
    }

    let fechaFinal = fecha;
    if (fecha && fecha.includes('T')) {
      const d = new Date(fecha);
      if (!isNaN(d.getTime())) {
        const formatter = new Intl.DateTimeFormat('es-PE', {
          timeZone: 'America/Lima',
          year: 'numeric', month: '2-digit', day: '2-digit'
        });
        const parts = formatter.formatToParts(d);
        const day = parts.find(p => p.type === 'day').value;
        const month = parts.find(p => p.type === 'month').value;
        const year = parts.find(p => p.type === 'year').value;
        fechaFinal = `${year}-${month}-${day}`;
      }
    }

    connection = await pool.getConnection();

    const [existingRow] = await connection.query(
      'SELECT id FROM asistencia WHERE id_alumno = ? AND id_asignacion = ? AND fecha = ?',
      [final_id_alumno, id_asignacion, fechaFinal]
    );

    if (existingRow && existingRow.length > 0) {
      await connection.query(
        'UPDATE asistencia SET asistio = ?, observacion = ? WHERE id = ?',
        [estado === 'Presente' || estado === 1 ? 1 : 0, observaciones || null, existingRow[0].id]
      );
    } else {
      await connection.query(
        'INSERT INTO asistencia (id_alumno, id_asignacion, fecha, asistio, observacion) VALUES (?, ?, ?, ?, ?)',
        [final_id_alumno, id_asignacion, fecha, estado === 'Presente' || estado === 1 ? 1 : 0, observaciones || null]
      );
    }

    // Notificar si es falta (segundo plano)
    if (estado === 'Ausente' || estado === 0 || estado === '0') {
      console.log(`[DEBUG] Marcando falta para Alumno ID: ${final_id_alumno}, triggering notification...`);
      (async () => {
        try {
          const [asigInfo] = await connection.query(
            `SELECT c.nombre as curso, CONCAT(p.nombres, ' ', p.apellido_paterno) as docente
             FROM asignaciones a
             JOIN cursos c ON c.id = a.id_curso
             JOIN docentes d ON d.id = a.id_docente
             JOIN personas p ON p.id = d.id_persona
             WHERE a.id = ?`, [id_asignacion]
          );
          if (asigInfo.length) {
            console.log(`[DEBUG] Encontrada info para notificación: Curso=${asigInfo[0].curso}, Docente=${asigInfo[0].docente}`);
            await notifyAbsenceToParents(pool, final_id_alumno, asigInfo[0].curso, fechaFinal, asigInfo[0].docente);
          } else {
            console.warn(`[DEBUG] No se encontró info de asignación para ID: ${id_asignacion}`);
          }
        } catch (e) { console.error('Error at notifyAbsence single:', e.message); }
      })();
    }

    res.json({
      success: true,
      message: 'Asistencia procesada correctamente',
      data: { id_alumno: final_id_alumno, id_asignacion, fecha, asistio: estado === 'Presente' || estado === 1 ? 1 : 0 }
    });

  } catch (error) {
    console.error('Error al marcar asistencia:', error);
    res.status(500).json({
      success: false,
      message: 'Error al procesar la asistencia',
      error: error.message
    });
  } finally {
    if (connection) connection.release();
  }
};

const obtenerAsistenciasPorDocente = async (req, res) => {
  let connection;
  try {
    const id_persona = req.user.id_persona;
    const { fecha, grado, seccion } = req.query;

    connection = await pool.getConnection();

    let query = "SELECT * FROM v_asistencias_completo WHERE 1=1";
    let params = [];

    const [p] = await connection.query("SELECT nombres, apellido_paterno, apellido_materno FROM personas WHERE id = ?", [id_persona]);
    if (p.length > 0) {
      const nombreDocente = `${decrypt(p[0].nombres)} ${decrypt(p[0].apellido_paterno)} ${decrypt(p[0].apellido_materno)}`;
      query += " AND nombre_docente = ?";
      params.push(nombreDocente);
    }

    if (fecha) {
      query += ' AND fecha = ?';
      params.push(fecha);
    }
    if (grado) {
      query += ' AND grado = ?';
      params.push(grado);
    }
    if (seccion) {
      query += ' AND seccion = ?';
      params.push(seccion);
    }

    query += ' ORDER BY fecha DESC, nombre_alumno ASC';

    const [rows] = await connection.query(query, params);

    const decryptedRows = rows.map(r => ({
      ...r,
      nombre_alumno: r.nombre_alumno ? decrypt(r.nombre_alumno) : r.nombre_alumno,
      nombre_docente: r.nombre_docente ? decrypt(r.nombre_docente) : r.nombre_docente
    }));

    res.json({
      success: true,
      data: decryptedRows
    });

  } catch (error) {
    console.error('Error al obtener asistencia del docente:', error);
    res.status(500).json({
      success: false,
      message: 'Error al obtener las asistencia',
      error: error.message
    });
  } finally {
    if (connection) connection.release();
  }
};

// Obtener asistencia por alumno
const obtenerAsistenciasPorAlumno = async (req, res) => {
  let connection;
  try {
    const id_persona = req.user.id_persona;
    const { anio, mes, dia } = req.query;
    connection = await pool.getConnection();

    let query = `
      SELECT 
        ast.id,
        ast.id_asignacion,
        ast.fecha,
        ast.asistio,
        ast.observacion as observaciones,
        c.nombre AS curso,
        pd.nombres, pd.apellido_paterno, pd.apellido_materno,
        g.nombre AS grado,
        j.estado as justificacion_estado,
        j.comentario_revision as comentario_justificacion
      FROM asistencia ast
      JOIN alumnos a ON ast.id_alumno = a.id
      LEFT JOIN asignaciones asig ON ast.id_asignacion = asig.id
      LEFT JOIN matriculas m ON a.id = m.id_alumno AND asig.id_periodo = m.id_periodo
      LEFT JOIN cursos c ON asig.id_curso = c.id
      LEFT JOIN docentes d ON asig.id_docente = d.id
      LEFT JOIN personas pd ON d.id_persona = pd.id
      LEFT JOIN grados g ON m.id_grado = g.id
      LEFT JOIN justificaciones j ON j.id = (
          SELECT id FROM justificaciones 
          WHERE id_asistencia = ast.id 
          ORDER BY created_at DESC LIMIT 1
      )
      WHERE (a.id_persona = ? OR EXISTS (
        SELECT 1 FROM alumno_apoderado aa
        JOIN apoderados ap ON aa.id_apoderado = ap.id
        WHERE aa.id_alumno = a.id AND ap.id_persona = ?
      ))
    `;
    let params = [id_persona, id_persona];

    if (anio) { query += " AND YEAR(ast.fecha) = ?"; params.push(anio); }
    if (mes) { query += " AND MONTH(ast.fecha) = ?"; params.push(mes); }
    if (dia) { query += " AND DAY(ast.fecha) = ?"; params.push(dia); }

    query += " ORDER BY ast.fecha DESC";

    const [rows] = await connection.query(query, params);

    const decryptedRows = rows.map(r => ({
      ...r,
      estado: r.asistio === 1 ? 'Presente' : 'Ausente',
      justificacion_estado: r.justificacion_estado || null,
      comentario_justificacion: r.comentario_justificacion,
      permite_justificar: r.asistio === 0 && (!r.justificacion_estado || r.justificacion_estado === 'Rechazada'),
      nombre_docente: `${decrypt(r.nombres || '')} ${decrypt(r.apellido_paterno || '')} ${decrypt(r.apellido_materno || '')}`.trim(),
      nombres: undefined, apellido_paterno: undefined, apellido_materno: undefined
    }));

    const resumen = {
      total: decryptedRows.length,
      presente: decryptedRows.filter(r => r.asistio === 1).length,
      ausente: decryptedRows.filter(r => r.asistio === 0).length,
      tardanza: 0,
      justificado: 0
    };

    res.json({
      success: true,
      resumen,
      data: decryptedRows
    });

  } catch (error) {
    console.error('Error al obtener asistencia del alumno:', error);
    res.status(500).json({ success: false, message: 'Error al obtener la asistencia', error: error.message });
  } finally {
    if (connection) connection.release();
  }
};

// Obtener faltas disponibles para justificar
const obtenerFaltasParaJustificar = async (req, res) => {
  let connection;
  try {
    const id_persona = req.user.id_persona;
    connection = await pool.getConnection();

    const [rows] = await connection.query(`
      SELECT 
        ast.*, 
        c.nombre as curso,
        g.nombre as grado,
        pd.nombres, pd.apellido_paterno, pd.apellido_materno,
        j.estado as justificacion_estado,
        j.comentario_revision as comentario_justificacion
      FROM asistencia ast
      JOIN alumnos a ON ast.id_alumno = a.id
      JOIN asignaciones asig ON ast.id_asignacion = asig.id
      JOIN cursos c ON asig.id_curso = c.id
      JOIN matriculas m ON a.id = m.id_alumno AND asig.id_periodo = m.id_periodo
      JOIN grados g ON m.id_grado = g.id
      LEFT JOIN docentes d ON asig.id_docente = d.id
      LEFT JOIN personas pd ON d.id_persona = pd.id
      LEFT JOIN justificaciones j ON j.id = (
          SELECT id FROM justificaciones 
          WHERE id_asistencia = ast.id 
          ORDER BY created_at DESC LIMIT 1
      )
      WHERE (a.id_persona = ? OR EXISTS (
          SELECT 1 FROM alumno_apoderado aa
          JOIN apoderados ap ON aa.id_apoderado = ap.id
          WHERE aa.id_alumno = a.id AND ap.id_persona = ?
      )) AND ast.asistio = 0
      ORDER BY ast.fecha DESC
    `, [id_persona, id_persona]);

    const decryptedRows = rows.map(r => ({
      ...r,
      observaciones: r.observacion,
      observacion: undefined,
      estado: r.asistio === 1 ? 'Presente' : 'Ausente',
      justificacion_estado: r.justificacion_estado,
      comentario_justificacion: r.comentario_justificacion,
      permite_justificar: r.asistio === 0 && (!r.justificacion_estado || r.justificacion_estado === 'Rechazada'),
      nombre_docente: `${decrypt(r.nombres || '')} ${decrypt(r.apellido_paterno || '')} ${decrypt(r.apellido_materno || '')}`.trim(),
      nombres: undefined, apellido_paterno: undefined, apellido_materno: undefined
    }));

    res.json({
      success: true,
      data: decryptedRows
    });

  } catch (error) {
    console.error('Error al obtener faltas:', error);
    res.status(500).json({ success: false, message: 'Error interno', error: error.message });
  } finally {
    if (connection) connection.release();
  }
};

// Marcar asistencia masiva
const marcarAsistenciaMasiva = async (req, res) => {
  let connection;
  try {
    const { asistencia } = req.body;

    if (!asistencia || !Array.isArray(asistencia)) {
      return res.status(400).json({ success: false, message: 'Se requiere un array de asistencia.' });
    }

    connection = await pool.getConnection();
    await connection.beginTransaction();

    const values = asistencia.map(item => [
      item.id_alumno || item.id_matricula,
      item.id_asignacion,
      item.fecha,
      item.estado === 'Presente' || item.estado === 1 ? 1 : 0,
      item.observaciones || item.observacion || null
    ]);

    if (values.length > 0) {
      await connection.query(
        `INSERT INTO asistencia (id_alumno, id_asignacion, fecha, asistio, observacion) VALUES ? 
         ON DUPLICATE KEY UPDATE asistio = VALUES(asistio), observacion = VALUES(observacion)`,
        [values]
      );
    }

    await connection.commit();

    // Notificar ausencias masivas (segundo plano)
    asistencia.filter(a => a.estado === 'Ausente' || a.estado === 0 || a.estado === '0').forEach(async (item) => {
      try {
        console.log(`[DEBUG-MASS] Procesando falta para alumno ID: ${item.id_alumno || item.id_matricula}`);
        const [asigInfo] = await pool.query(
          `SELECT c.nombre as curso, CONCAT(p.nombres, ' ', p.apellido_paterno) as docente
           FROM asignaciones a
           JOIN cursos c ON c.id = a.id_curso
           JOIN docentes d ON d.id = a.id_docente
           JOIN personas p ON p.id = d.id_persona
           WHERE a.id = ?`, [item.id_asignacion]
        );
        if (asigInfo.length) {
          const idAlumno = item.id_alumno || item.id_matricula;
          console.log(`[DEBUG-MASS] Notificando Ausencia: Curso=${asigInfo[0].curso}, Fecha=${item.fecha}`);
          await notifyAbsenceToParents(pool, idAlumno, asigInfo[0].curso, item.fecha, asigInfo[0].docente);
        } else {
          console.warn(`[DEBUG-MASS] No hay info para asignación: ${item.id_asignacion}`);
        }
      } catch (e) { console.error('Error notifying from mass:', e.message); }
    });

    res.json({ success: true, message: `${asistencia.length} registros procesados.` });

  } catch (error) {
    if (connection) await connection.rollback();
    res.status(500).json({ success: false, message: 'Error masivo', error: error.message });
  } finally {
    if (connection) connection.release();
  }
};

// Reporte por curso
const reportePorCurso = async (req, res) => {
  let connection;
  try {
    const { id_asignacion, fecha_inicio, fecha_fin } = req.query;
    if (!id_asignacion) return res.status(400).json({ success: false, message: 'id_asignacion es requerido' });

    connection = await pool.getConnection();
    let query = `
      SELECT ast.fecha, p.dni, p.nombres, p.apellido_paterno, p.apellido_materno, ast.asistio, ast.observacion as observaciones, c.nombre as nombre_curso, g.nombre as nombre_grado
      FROM asistencia ast
      JOIN alumnos a ON ast.id_alumno = a.id
      JOIN personas p ON a.id_persona = p.id
      JOIN asignaciones asig ON ast.id_asignacion = asig.id
      JOIN matriculas m ON a.id = m.id_alumno AND asig.id_periodo = m.id_periodo
      JOIN cursos c ON asig.id_curso = c.id
      JOIN grados g ON m.id_grado = g.id
      WHERE ast.id_asignacion = ?
    `;
    let params = [id_asignacion];

    if (fecha_inicio && fecha_fin) {
      query += ' AND ast.fecha BETWEEN ? AND ?';
      params.push(fecha_inicio, fecha_fin);
    }

    query += ' ORDER BY ast.fecha DESC';
    const [rows] = await connection.query(query, params);

    const decryptedRows = rows.map(r => ({
      ...r,
      dni: decrypt(r.dni),
      estado: r.asistio === 1 ? 'Presente' : 'Ausente',
      nombre_alumno: `${decrypt(r.nombres || '')} ${decrypt(r.apellido_paterno || '')} ${decrypt(r.apellido_materno || '')}`.trim(),
      nombres: undefined, apellido_paterno: undefined, apellido_materno: undefined
    }));

    res.json({ success: true, data: decryptedRows });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  } finally {
    if (connection) connection.release();
  }
};

// Reporte por día
const reportePorDia = async (req, res) => {
  let connection;
  try {
    let { fecha, fecha_inicio, fecha_fin, id_grado } = req.query;
    if (fecha) { fecha_inicio = fecha; fecha_fin = fecha; }
    if (!fecha_inicio || !fecha_fin) return res.status(400).json({ success: false, message: 'Fecha requerida' });

    connection = await pool.getConnection();
    const [rows] = await connection.query(`
      SELECT ast.fecha, a.id as id_alumno, p.dni, p.nombres, p.apellido_paterno, p.apellido_materno, c.nombre as nombre_curso, ast.asistio, g.nombre as nombre_grado
      FROM asistencia ast
      JOIN alumnos a ON ast.id_alumno = a.id
      JOIN personas p ON a.id_persona = p.id
      JOIN asignaciones asig ON ast.id_asignacion = asig.id
      JOIN matriculas m ON a.id = m.id_alumno AND asig.id_periodo = m.id_periodo
      JOIN cursos c ON asig.id_curso = c.id
      JOIN grados g ON g.id = m.id_grado
      WHERE ast.fecha BETWEEN ? AND ?
      ${id_grado ? "AND g.id = ?" : ""}
      ORDER BY ast.fecha ASC
    `, [fecha_inicio, fecha_fin, id_grado].filter(Boolean));

    const grouped = {};
    rows.forEach(row => {
      const fechaStr = new Date(row.fecha).toISOString().split('T')[0];
      const key = `${fechaStr}_${row.id_alumno}`;
      if (!grouped[key]) {
        grouped[key] = {
          fecha: fechaStr,
          dni: decrypt(row.dni),
          nombre_alumno: `${decrypt(row.nombres || '')} ${decrypt(row.apellido_paterno || '')} ${decrypt(row.apellido_materno || '')}`.trim(),
          grado: row.nombre_grado,
          asistencias: []
        };
      }
      grouped[key].asistencias.push({ curso: row.nombre_curso, estado: row.asistio === 1 ? 'Presente' : 'Ausente' });
    });

    res.json({
      success: true,
      asistencia_registrada: rows.length > 0,
      mensaje: rows.length > 0 ? null : 'No se encontraron registros de asistencia para la fecha seleccionada.',
      data: Object.values(grouped)
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  } finally {
    if (connection) connection.release();
  }
};

// Reporte diario por grado
const reporteDiarioPorGrado = async (req, res) => {
  let connection;
  try {
    const { fecha, id_grado } = req.query;
    if (!fecha) return res.status(400).json({ success: false, message: 'Fecha requerida' });

    connection = await pool.getConnection();
    const anio = new Date(fecha).getFullYear();

    const [rows] = await connection.query(`
      SELECT a.id as id_alumno, p.dni, p.nombres, p.apellido_paterno, p.apellido_materno, g.nombre as nombre_grado,
             ast.asistio, ast.observacion as observaciones, c.nombre as nombre_curso, 
             pd.nombres as d_nombres, pd.apellido_paterno as d_ap, pd.apellido_materno as d_am
      FROM alumnos a
      JOIN personas p ON a.id_persona = p.id
      JOIN matriculas m ON a.id = m.id_alumno
      JOIN grados g ON m.id_grado = g.id
      JOIN periodos_academicos pa ON m.id_periodo = pa.id
      LEFT JOIN asistencia ast ON ast.id_alumno = a.id AND ast.fecha = ?
      LEFT JOIN asignaciones asig ON ast.id_asignacion = asig.id
      LEFT JOIN cursos c ON asig.id_curso = c.id
      LEFT JOIN docentes d ON asig.id_docente = d.id
      LEFT JOIN personas pd ON d.id_persona = pd.id
      WHERE pa.anio = ? ${id_grado ? "AND g.id = ?" : ""}
      ORDER BY g.nombre, p.apellido_paterno
    `, [fecha, anio, id_grado].filter(Boolean));

    const grouped = {};
    rows.forEach(row => {
      if (row.asistio !== null) {
        if (!grouped[row.id_alumno]) {
          grouped[row.id_alumno] = {
            id_alumno: row.id_alumno,
            dni: decrypt(row.dni),
            nombre_alumno: `${decrypt(row.nombres)} ${decrypt(row.apellido_paterno)} ${decrypt(row.apellido_materno)}`,
            grado: row.nombre_grado,
            asistencias: []
          };
        }
        grouped[row.id_alumno].asistencias.push({
          curso: row.nombre_curso,
          docente: `${decrypt(row.d_nombres || '')} ${decrypt(row.d_ap || '')} ${decrypt(row.d_am || '')}`.trim(),
          estado: row.asistio === 1 ? 'Presente' : 'Ausente',
          observaciones: row.observaciones
        });
      }
    });

    const totalRegistros = rows.reduce((sum, row) => sum + (row.asistio !== null ? 1 : 0), 0);
    const asistencia_registrada = totalRegistros > 0;

    res.json({
      success: true,
      asistencia_registrada,
      mensaje: asistencia_registrada ? null : 'Aún no se ha registrado asistencia para este grado en la fecha seleccionada.',
      data: asistencia_registrada ? Object.values(grouped) : []
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  } finally {
    if (connection) connection.release();
  }
};

module.exports = { marcarAsistencia, marcarAsistenciaMasiva, obtenerAsistenciasPorDocente, obtenerAsistenciasPorAlumno, obtenerFaltasParaJustificar, reportePorCurso, reportePorDia, reporteDiarioPorGrado };

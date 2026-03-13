const db = require("../config/database");

class JustificacionModel {
  static async crear(datos) {
    const { id_matricula, id_asistencia, id_docente, titulo, descripcion, tipo, fecha_inicio, fecha_fin, url_documento, cloudinary_public_id } = datos;
    const [result] = await db.pool.execute(
      `INSERT INTO justificaciones (
        id_matricula, id_asistencia, id_docente, titulo, descripcion, tipo, 
        fecha_inicio, fecha_fin, url_documento, cloudinary_public_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id_matricula, id_asistencia || null, id_docente, titulo, descripcion, tipo, fecha_inicio, fecha_fin, url_documento, cloudinary_public_id]
    );
    return result.insertId;
  }

  static async obtenerPorAlumnoPaginado(idAlumno, limit, offset) {
    const [rows] = await db.pool.query(
      `SELECT j.* 
       FROM justificaciones j
       JOIN matriculas m ON j.id_matricula = m.id
       WHERE m.id_alumno = ? 
       ORDER BY j.created_at DESC 
       LIMIT ? OFFSET ?`,
      [idAlumno, limit, offset]
    );

    const [totalRows] = await db.pool.query(
      `SELECT COUNT(*) as total 
       FROM justificaciones j
       JOIN matriculas m ON j.id_matricula = m.id
       WHERE m.id_alumno = ?`,
      [idAlumno]
    );

    return { rows, total: totalRows[0].total };
  }

  static async obtenerPorDocentePaginado(idDocente, limit, offset, filtros = {}) {
    const { anio, mes, dia, estado } = filtros;
    let query = `
      SELECT j.*, 
        p.nombres as alumno_nombres, p.apellido_paterno as alumno_ap_p, p.apellido_materno as alumno_ap_m,
        c.nombre as curso, g.nombre as grado,
        ast.fecha as fecha_falta, ast.observacion as observacion_falta
      FROM justificaciones j
      JOIN matriculas m ON j.id_matricula = m.id
      JOIN alumnos a ON m.id_alumno = a.id
      JOIN personas p ON a.id_persona = p.id
      LEFT JOIN asistencia ast ON j.id_asistencia = ast.id
      LEFT JOIN asignaciones asig ON ast.id_asignacion = asig.id
      LEFT JOIN cursos c ON asig.id_curso = c.id
      LEFT JOIN grados g ON m.id_grado = g.id
      WHERE j.id_docente = ?
    `;
    let countQuery = "SELECT COUNT(*) as total FROM justificaciones WHERE id_docente = ?";
    let params = [idDocente];
    let countParams = [idDocente];

    if (estado) {
      query += " AND j.estado = ?";
      countQuery += " AND estado = ?";
      params.push(estado);
      countParams.push(estado);
    }

    if (anio) {
      query += " AND YEAR(j.fecha_inicio) = ?";
      countQuery += " AND YEAR(fecha_inicio) = ?";
      params.push(anio);
      countParams.push(anio);
    }
    if (mes) {
      query += " AND MONTH(j.fecha_inicio) = ?";
      countQuery += " AND MONTH(fecha_inicio) = ?";
      params.push(mes);
      countParams.push(mes);
    }
    if (dia) {
      query += " AND DAY(j.fecha_inicio) = ?";
      countQuery += " AND DAY(fecha_inicio) = ?";
      params.push(dia);
      countParams.push(dia);
    }

    query += " ORDER BY j.created_at DESC LIMIT ? OFFSET ?";
    params.push(limit, offset);

    const [rows] = await db.pool.query(query, params);
    const [totalRows] = await db.pool.query(countQuery, countParams);

    return { rows, total: totalRows[0].total };
  }

  static async obtenerTodas() {
    const [rows] = await db.pool.query(
      `SELECT j.*, p.nombres as alumno_nombres, p.apellido_paterno as alumno_ap_p, pd.nombres as docente_nombres
       FROM justificaciones j
       JOIN matriculas m ON j.id_matricula = m.id
       JOIN alumnos a ON m.id_alumno = a.id
       JOIN personas p ON a.id_persona = p.id
       LEFT JOIN docentes d ON j.id_docente = d.id
       LEFT JOIN personas pd ON d.id_persona = pd.id
       ORDER BY j.created_at DESC`
    );
    return rows;
  }

  static async obtenerPorId(id) {
    const [rows] = await db.pool.query("SELECT * FROM justificaciones WHERE id = ?", [id]);
    return rows.length > 0 ? rows[0] : null;
  }

  static async actualizarEstado(id, estado, comentario_revision) {
    const [result] = await db.pool.execute(
      "UPDATE justificaciones SET estado = ?, comentario_revision = ?, fecha_revision = CURRENT_TIMESTAMP WHERE id = ?",
      [estado, comentario_revision, id]
    );
    return result.affectedRows > 0;
  }

  static async eliminar(id) {
    const [result] = await db.pool.execute("DELETE FROM justificaciones WHERE id = ?", [id]);
    return result.affectedRows > 0;
  }
}

module.exports = JustificacionModel;
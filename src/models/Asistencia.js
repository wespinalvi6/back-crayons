const db = require("../config/database");

class AsistenciaModel {
  static async crear(
    connection,
    idAlumno,
    idDocenteCurso,
    fecha,
    asistio = true,
    observacion = null
  ) {
    const [result] = await connection.execute(
      "INSERT INTO asistencia (id_alumno, id_docente_curso, fecha, asistio, observacion) VALUES (?, ?, ?, ?, ?)",
      [idAlumno, idDocenteCurso, fecha, asistio, observacion]
    );
    return result.insertId;
  }

  static async listarPorCurso(connection, idDocenteCurso) {
    const [rows] = await connection.execute(
      "SELECT * FROM asistencia WHERE id_docente_curso = ?",
      [idDocenteCurso]
    );
    return rows;
  }

  static async buscarPorFecha(connection, idDocenteCurso, fecha) {
    const [rows] = await connection.execute(
      "SELECT * FROM asistencia WHERE id_docente_curso = ? AND fecha = ?",
      [idDocenteCurso, fecha]
    );
    return rows;
  }
}

module.exports = AsistenciaModel;

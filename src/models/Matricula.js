const db = require("../config/database");

class MatriculaModel {
  static async crear(
    connection,
    idAlumno,
    idGrado,
    idPeriodo,
    idSeccion = null,
    dniEntregado,
    certificadoEstudiosEntregado,
    partidaNacimiento = 0,
    fotos = 0,
    estado = 'Pendiente'
  ) {
    const [result] = await connection.execute(
      `INSERT INTO matriculas (
        id_alumno, id_grado, id_periodo, id_seccion, fecha_matricula, 
        dni_entregado, certificado_estudios, partida_nacimiento, fotos, estado
      ) VALUES (?, ?, ?, ?, CURDATE(), ?, ?, ?, ?, ?)`,
      [
        idAlumno, idGrado, idPeriodo, idSeccion,
        dniEntregado, certificadoEstudiosEntregado, partidaNacimiento, fotos, estado
      ]
    );
    return result.insertId;
  }

  static async buscarPorAlumnoGrado(connection, idAlumno, idGrado) {
    const [rows] = await connection.execute(
      "SELECT * FROM matriculas WHERE id_alumno = ? AND id_grado = ?",
      [idAlumno, idGrado]
    );
    return rows.length > 0 ? rows[0] : null;
  }
}
module.exports = MatriculaModel;

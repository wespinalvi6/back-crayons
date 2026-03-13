const db = require("../config/database");

class DocenteCursoModel {
  static async crear(connection, idDocente, idCurso, idGrado) {
    const [result] = await connection.execute(
      "INSERT INTO docente_curso (id_docente, id_curso, id_grado) VALUES (?, ?, ?)",
      [idDocente, idCurso, idGrado]
    );
    return result.insertId;
  }

  static async listar(connection) {
    const [rows] = await connection.execute("SELECT * FROM docente_curso");
    return rows;
  }

  static async buscarPorId(connection, id) {
    const [rows] = await connection.execute(
      "SELECT * FROM docente_curso WHERE id = ?",
      [id]
    );
    return rows.length > 0 ? rows[0] : null;
  }
}

module.exports = DocenteCursoModel;

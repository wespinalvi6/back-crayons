const db = require("../config/database");

class CursoModel {
  static async crear(connection, nombre) {
    const [result] = await connection.execute(
      "INSERT INTO curso (nombre) VALUES (?)",
      [nombre]
    );
    return result.insertId;
  }

  static async listar(connection) {
    const [rows] = await connection.execute("SELECT * FROM curso");
    return rows;
  }

  static async buscarPorId(connection, id) {
    const [rows] = await connection.execute(
      "SELECT * FROM curso WHERE id = ?",
      [id]
    );
    return rows.length > 0 ? rows[0] : null;
  }
}

module.exports = CursoModel;

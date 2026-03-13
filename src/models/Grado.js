const db = require("../config/database");

class GradoModel {
  static async listar(connection) {
    const [rows] = await connection.execute("SELECT * FROM grados");
    return rows;
  }

  static async listarCompleto(connection) {
    const [rows] = await connection.execute("SELECT * FROM grados");
    return rows;
  }

  static async buscarPorId(connection, id) {
    const [rows] = await connection.execute(
      "SELECT * FROM grados WHERE id = ?",
      [id]
    );
    return rows.length > 0 ? rows[0] : null;
  }
}
module.exports = GradoModel;

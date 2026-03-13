const db = require("../config/database");

class ApoderadoModel {
  static async crear(connection, idPersona, ocupacion = null) {
    try {
      const [result] = await connection.execute(
        "INSERT INTO apoderados (id_persona, ocupacion) VALUES (?, ?)",
        [idPersona, ocupacion]
      );
      return result.insertId;
    } catch (error) {
      // Comprobar si ya existe un apoderado con ese id_persona
      const [rows] = await connection.execute(
        "SELECT id FROM apoderados WHERE id_persona = ?",
        [idPersona]
      );
      if (rows.length > 0) {
        return rows[0].id;
      }
      throw error;
    }
  }

  static async buscarPorIdPersona(connection, idPersona) {
    const [rows] = await connection.execute(
      "SELECT * FROM apoderados WHERE id_persona = ?",
      [idPersona]
    );
    return rows.length > 0 ? rows[0] : null;
  }
}

module.exports = ApoderadoModel;

const db = require("../config/database");

class AlumnoApoderadoModel {
  static async crear(connection, idAlumno, idApoderado, parentesco = 'Padre') {
    try {
      const [result] = await connection.execute(
        "INSERT INTO alumno_apoderado (id_alumno, id_apoderado, parentesco) VALUES (?, ?, ?)",
        [idAlumno, idApoderado, parentesco]
      );
      return result.insertId;
    } catch (error) {
      // Verificar si ya existe la relación
      const [rows] = await connection.execute(
        "SELECT id FROM alumno_apoderado WHERE id_alumno = ? AND id_apoderado = ?",
        [idAlumno, idApoderado]
      );
      if (rows.length > 0) {
        // Si ya existe, actualizamos el parentesco por si acaso
        await connection.execute(
          "UPDATE alumno_apoderado SET parentesco = ? WHERE id = ?",
          [parentesco, rows[0].id]
        );
        return rows[0].id;
      }
      throw error;
    }
  }
}

module.exports = AlumnoApoderadoModel;

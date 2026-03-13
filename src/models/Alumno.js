const { decrypt } = require("../utils/cryptoUtils");

class AlumnoModel {
  static async crear(connection, idPersona, codigoAlumno = null, religion = null, lenguaMaterna = null, tipoIngreso = null) {
    try {
      if (!codigoAlumno) {
        const [persona] = await connection.execute("SELECT dni FROM personas WHERE id = ?", [idPersona]);
        if (persona.length > 0) {
          const decryptedDni = decrypt(persona[0].dni);
          const anio = new Date().getFullYear();
          codigoAlumno = `${anio}${decryptedDni}`;
        } else {
          throw new Error("No se pudo generar código de estudiante: Persona no encontrada");
        }
      }

      const [result] = await connection.execute(
        "INSERT INTO alumnos (id_persona, codigo_alumno, religion, lengua_materna, tipo_ingreso) VALUES (?, ?, ?, ?, ?)",
        [idPersona, codigoAlumno, religion, lenguaMaterna, tipoIngreso]
      );
      return result.insertId;
    } catch (error) {
      const [rows] = await connection.execute(
        "SELECT id FROM alumnos WHERE id_persona = ?",
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
      "SELECT * FROM alumnos WHERE id_persona = ?",
      [idPersona]
    );
    return rows.length > 0 ? rows[0] : null;
  }

  static async buscarPorId(connection, id) {
    const [rows] = await connection.execute(
      "SELECT * FROM alumnos WHERE id = ?",
      [id]
    );
    return rows.length > 0 ? rows[0] : null;
  }

  static async obtenerDatosCompletos(connection, idAlumno) {
    const [rows] = await connection.execute(
      "SELECT * FROM v_alumnos_completo WHERE id_alumno = ?",
      [idAlumno]
    );
    return rows.length > 0 ? rows[0] : null;
  }

  static async obtenerDatosCompletosPorIdPersona(connection, idPersona) {
    const [rows] = await connection.execute(
      "SELECT v.* FROM v_alumnos_completo v JOIN alumnos a ON v.id_alumno = a.id WHERE a.id_persona = ?",
      [idPersona]
    );
    return rows.length > 0 ? rows[0] : null;
  }
}

module.exports = AlumnoModel;

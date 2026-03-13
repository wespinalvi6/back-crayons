const db = require("../config/database");

class DocenteModel {
  static async crear(connection, idPersona, codigoDocente, especialidad = null, gradoAcademico = null) {
    const [result] = await connection.execute(
      "INSERT INTO docentes (id_persona, codigo_docente, especialidad, grado_academico, fecha_ingreso) VALUES (?, ?, ?, ?, CURDATE())",
      [idPersona, codigoDocente, especialidad, gradoAcademico]
    );
    return result.insertId;
  }

  static async obtenerDatosCompletos(connection, id_docente) {
    const query = `
      SELECT 
        p.id as id_persona,
        p.dni,
        p.nombres as nombre,
        p.apellido_paterno as ap_p,
        p.apellido_materno as ap_m,
        p.fecha_nacimiento,
        d.id as id_docente,
        d.codigo_docente,
        d.especialidad,
        d.grado_academico,
        GROUP_CONCAT(
          DISTINCT
          JSON_OBJECT(
            'id_curso', c.id,
            'nombre_curso', c.nombre,
            'id_grado', g.id,
            'descripcion_grado', g.nombre
          )
          SEPARATOR ','
        ) as cursos
      FROM docentes d
      INNER JOIN personas p ON d.id_persona = p.id
      LEFT JOIN asignaciones asig ON d.id = asig.id_docente
      LEFT JOIN cursos c ON asig.id_curso = c.id
      LEFT JOIN grados g ON asig.id_grado = g.id
      WHERE d.id = ?
      GROUP BY d.id, p.id
    `;

    const [rows] = await connection.execute(query, [id_docente]);

    if (rows.length === 0) {
      return null;
    }

    const docente = rows[0];

    // Convertir la cadena de cursos a un array de objetos
    if (docente.cursos) {
      try {
        // Handle potentially malformed JSON if GROUP_CONCAT is too long
        docente.cursos = docente.cursos
          .split("},{")
          .map((item, index, array) => {
            let str = item;
            if (index !== 0) str = "{" + str;
            if (index !== array.length - 1) str = str + "}";
            return JSON.parse(str);
          });
      } catch (e) {
        // Fallback simpler split or empty array if JSON fails
        docente.cursos = [];
      }
    } else {
      docente.cursos = [];
    }

    return docente;
  }

  static async listar(connection) {
    const [rows] = await connection.execute("SELECT * FROM docentes");
    return rows;
  }

  static async buscarPorId(connection, id) {
    const [rows] = await connection.execute(
      "SELECT * FROM docentes WHERE id = ?",
      [id]
    );
    return rows.length > 0 ? rows[0] : null;
  }

  static async obtenerDocentesConCursos(connection, anio = null) {
    const query = `
      SELECT 
        d.id AS docente_id,
        p.dni,
        CONCAT(p.nombres, ' ', p.apellido_paterno, ' ', p.apellido_materno) AS nombre_completo,
        d.fecha_ingreso,
        asig.id AS asignacion_id,
        c.nombre AS curso,
        g.nombre AS grado
      FROM docentes d
      JOIN personas p ON d.id_persona = p.id
      JOIN asignaciones asig ON asig.id_docente = d.id
      JOIN cursos c ON asig.id_curso = c.id
      JOIN grados g ON asig.id_grado = g.id
      JOIN periodos_academicos pa ON asig.id_periodo = pa.id
      ${anio ? "WHERE pa.anio = ?" : ""}
      ORDER BY p.apellido_paterno, p.apellido_materno, p.nombres
    `;

    const [rows] = await connection.execute(query, anio ? [anio] : []);
    return rows;
  }

  static async buscarPorIdPersona(connection, idPersona) {
    const [rows] = await connection.execute(
      "SELECT * FROM docentes WHERE id_persona = ?",
      [idPersona]
    );
    return rows.length > 0 ? rows[0] : null;
  }
}

module.exports = DocenteModel;

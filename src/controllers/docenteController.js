const PersonaModel = require("../models/Persona");
const UserModel = require("../models/User");
const DocenteModel = require("../models/Docente");
const { pool, withTransaction } = require("../config/database");
const bcrypt = require("bcryptjs");
const ExcelJS = require('exceljs');
const { decrypt, blindIndex } = require("../utils/cryptoUtils");

const docenteController = {
  // Las funciones auxiliares generarUsername y generarPassword se mantienen si son útiles
  generarUsername(nombre, ap_p, fecha_nacimiento) {
    const primerNombre = nombre.split(' ')[0].toLowerCase();
    const primerApellido = ap_p.split(' ')[0].toLowerCase();
    const año = fecha_nacimiento.split('-')[0];
    return `${primerNombre}${primerApellido}${año}`;
  },

  generarPassword(nombre, ap_p, ap_m, dni, fecha_nacimiento) {
    const nombreInicial = nombre.charAt(0).toUpperCase();
    const ap_pInicial = ap_p.charAt(0).toUpperCase();
    const ap_mInicial = ap_m.charAt(0).toUpperCase();
    const dniFinal = dni.slice(-4);
    const fecha = new Date(fecha_nacimiento);
    const dia = fecha.getDate().toString().padStart(2, "0");
    const mes = (fecha.getMonth() + 1).toString().padStart(2, "0");
    const anio = fecha.getFullYear();
    return `${nombreInicial}${ap_pInicial}${ap_mInicial}${dniFinal}${dia}${mes}${anio}`;
  },

  async registrarCompleto(pool, datos) {
    try {
      const resultado = await withTransaction(async (connection) => {
        const {
          dni,
          nombres,
          apellido_paterno,
          apellido_materno,
          fecha_nacimiento,
          id_rol,
          email,
          telefono,
          direccion,
          sexo,
          especialidad,
          grado_academico,
          id_periodo,
          cursos_asignados
        } = datos;

        const username = dni;
        const salt = await bcrypt.genSalt(10);
        const passwordEncriptada = await bcrypt.hash(dni, salt);

        const personaExistente = await PersonaModel.buscarPorDni(connection, dni);
        let id_persona;

        if (personaExistente) {
          id_persona = personaExistente.id;
          // Opcional: Actualizar datos de persona si es necesario
          await PersonaModel.actualizar(connection, id_persona, dni, nombres, apellido_paterno, apellido_materno, fecha_nacimiento, email, telefono, direccion, sexo);
        } else {
          id_persona = await PersonaModel.crear(
            connection,
            dni,
            nombres,
            apellido_paterno,
            apellido_materno,
            fecha_nacimiento,
            email,
            telefono,
            direccion,
            sexo
          );
        }

        try {
          await UserModel.crear(connection, {
            username,
            email: email || `${dni}@colegio.edu.pe`,
            password: passwordEncriptada,
            id_rol: id_rol || 2,
            id_persona,
          });
        } catch (error) {
          if (error.code !== 'ER_DUP_ENTRY') throw error;
        }

        const codigo_docente = `DOC${dni}`;

        // Verificar si ya existe como docente
        let id_docente;
        const [docenteExistente] = await connection.execute(
          "SELECT id FROM docentes WHERE id_persona = ?",
          [id_persona]
        );

        if (docenteExistente.length > 0) {
          id_docente = docenteExistente[0].id;
          // Actualizar datos del docente si es necesario
          await connection.execute(
            "UPDATE docentes SET especialidad = ?, grado_academico = ? WHERE id = ?",
            [especialidad, grado_academico, id_docente]
          );
        } else {
          // Determinar fecha_ingreso basado en el periodo seleccionado o CURDATE()
          let fecha_ingreso_sql = "CURDATE()";
          const valores_docente = [id_persona, codigo_docente, especialidad, grado_academico];

          if (id_periodo) {
            const [periodoRows] = await connection.execute("SELECT anio FROM periodos_academicos WHERE id = ?", [id_periodo]);
            if (periodoRows.length > 0) {
              const anioPeriodo = periodoRows[0].anio;
              const hoy = new Date();
              if (anioPeriodo !== hoy.getFullYear()) {
                fecha_ingreso_sql = "?";
                valores_docente.push(`${anioPeriodo}-01-01`);
              }
            }
          }

          const [docenteResult] = await connection.execute(
            `INSERT INTO docentes (id_persona, codigo_docente, especialidad, grado_academico, fecha_ingreso) VALUES (?, ?, ?, ?, ${fecha_ingreso_sql})`,
            valores_docente
          );
          id_docente = docenteResult.insertId;
        }

        if (cursos_asignados && cursos_asignados.length > 0) {
          for (const { idCurso, idGrado, idSeccion, idPeriodo } of cursos_asignados) {
            const cleanId = (val) => {
              if (val === null || val === undefined || val === "" || val === "null") return null;
              const num = parseInt(val);
              return (!isNaN(num) && num > 0) ? num : null;
            };

            const cleanSeccion = cleanId(idSeccion);
            const cleanPeriodo = cleanId(idPeriodo || id_periodo);

            // Validar si ya existe la asignación para ese curso-grado-seccion-periodo
            // Usamos <=> para comparar con NULL de forma segura en MySQL
            const [existente] = await connection.execute(
              `SELECT p.nombres, p.apellido_paterno, c.nombre as curso_nombre, g.nombre as grado_nombre
               FROM asignaciones asig
               JOIN docentes d ON asig.id_docente = d.id
               JOIN personas p ON d.id_persona = p.id
               JOIN cursos c ON asig.id_curso = c.id
               JOIN grados g ON asig.id_grado = g.id
               WHERE asig.id_curso = ? AND asig.id_grado = ? 
                 AND asig.id_seccion <=> ? AND asig.id_periodo <=> ?`,
              [idCurso, idGrado, cleanSeccion, cleanPeriodo]
            );

            if (existente.length > 0) {
              const ocupante = existente[0];
              throw new Error(`El curso ${ocupante.curso_nombre} para ${ocupante.grado_nombre} ya está asignado al docente ${ocupante.nombres} ${ocupante.apellido_paterno}.`);
            }

            // INSERCIÓN DINÁMICA: Solo incluimos las columnas que tienen valor real
            const campos = ["id_docente", "id_curso", "id_grado"];
            const valores = [id_docente, idCurso, idGrado];
            const placeholders = ["?", "?", "?"];

            if (cleanSeccion !== null) {
              campos.push("id_seccion");
              valores.push(cleanSeccion);
              placeholders.push("?");
            }

            if (cleanPeriodo !== null) {
              campos.push("id_periodo");
              valores.push(cleanPeriodo);
              placeholders.push("?");
            }

            const sql = `INSERT INTO asignaciones (${campos.join(", ")}) VALUES (${placeholders.join(", ")})`;
            await connection.execute(sql, valores);
          }
        }

        return {
          success: true,
          message: "Docente registrado con éxito.",
          credenciales: { username, password: dni },
        };
      });

      return resultado;
    } catch (error) {
      return { success: false, message: "Error interno.", error: error.message };
    }
  },

  async getPeriodos(req, res) {
    try {
      const [rows] = await pool.query("SELECT * FROM periodos_academicos ORDER BY anio DESC");
      res.json({ success: true, data: rows });
    } catch (error) {
      res.status(500).json({ success: false, message: "Error al obtener periodos.", error: error.message });
    }
  },

  async buscarPorDniLocal(req, res) {
    try {
      const { dni } = req.params;
      const [rows] = await pool.query(
        `SELECT p.*, d.id as id_docente, d.especialidad, d.grado_academico
         FROM personas p
         LEFT JOIN docentes d ON p.id = d.id_persona
         WHERE p.dni_hash = ?`,
        [blindIndex(dni)]
      );
      if (rows.length > 0) {
        const data = rows[0];
        data.dni = decrypt(data.dni);
        data.telefono = decrypt(data.telefono);
        res.json({ success: true, data });
      } else {
        res.json({ success: false, message: "Docente no encontrado localmente." });
      }
    } catch (error) {
      res.status(500).json({ success: false, message: "Error al buscar docente.", error: error.message });
    }
  },

  async getDisponibilidadCursos(req, res) {
    const connection = await pool.getConnection();
    try {
      const { anio } = req.params;

      const query = `
        SELECT 
          c.id AS id_curso,
          c.nombre AS curso,
          g.id AS id_grado,
          g.numero_grado,
          g.nombre AS grado,
          (SELECT COUNT(*) 
           FROM asignaciones a
           JOIN periodos_academicos pa ON a.id_periodo = pa.id
           WHERE a.id_curso = c.id 
             AND a.id_grado = g.id 
             AND pa.anio = ?
          ) AS ocupado
        FROM cursos c
        CROSS JOIN grados g
        ORDER BY c.nombre, g.numero_grado
      `;

      const [rows] = await connection.query(query, [anio]);

      const estructura = {};
      for (const row of rows) {
        if (!estructura[row.curso]) {
          estructura[row.curso] = {
            id_curso: row.id_curso,
            nombre: row.curso,
            grados: []
          };
        }
        estructura[row.curso].grados.push({
          id_grado: row.id_grado,
          numero_grado: row.numero_grado,
          nombre_grado: row.grado,
          ocupado: row.ocupado > 0
        });
      }

      res.json({ success: true, data: Object.values(estructura) });
    } catch (error) {
      res.status(500).json({ success: false, message: "Error al obtener disponibilidad.", error: error.message });
    } finally {
      connection.release();
    }
  },

  async obtenerDatosCompletos(pool, id_docente) {
    try {
      const connection = await pool.getConnection();
      try {
        const docente = await DocenteModel.obtenerDatosCompletos(connection, id_docente);
        if (!docente) return { success: false, message: "Docente no encontrado." };
        // Decrypt PII data
        if (docente.dni) docente.dni = decrypt(docente.dni);
        if (docente.telefono) docente.telefono = decrypt(docente.telefono);
        return { success: true, data: docente };
      } finally {
        connection.release();
      }
    } catch (error) {
      return { success: false, message: "Error al obtener datos del docente.", error: error.message };
    }
  },

  async listarConCursos(pool, anio = null) {
    try {
      const connection = await pool.getConnection();
      try {
        const rows = await DocenteModel.obtenerDocentesConCursos(connection, anio);
        const docentesMap = {};
        for (const row of rows) {
          if (!docentesMap[row.docente_id]) {
            docentesMap[row.docente_id] = {
              docente_id: row.docente_id,
              dni: decrypt(row.dni),
              nombre_completo: row.nombre_completo,
              fecha_registro: row.fecha_ingreso,
              activo: row.activo,
              periodo_activo: row.periodo_activo,
              cursos: [],
            };
          }
          if (row.curso && row.grado) {
            docentesMap[row.docente_id].cursos.push({
              id_asignacion: row.asignacion_id,
              curso: row.curso,
              grado: row.grado,
            });
          }
        }
        return { success: true, data: Object.values(docentesMap), anio: anio || "todos" };
      } finally {
        connection.release();
      }
    } catch (error) {
      return { success: false, message: "Error al obtener docentes con cursos", error: error.message };
    }
  },

  getDatosDocentePorAnio: async (req, res) => {
    const connection = await pool.getConnection();
    try {
      const { anio } = req.params;
      const { docente_id } = req.query;
      if (!anio || !docente_id) return res.status(400).json({ message: "Se requiere el año y el ID del docente" });

      const [docenteRows] = await connection.query(
        `SELECT d.id, p.nombres as nombre, p.apellido_paterno as apellido, p.apellido_materno, p.dni, p.email, p.telefono, d.fecha_ingreso as fecha_registro
         FROM docentes d JOIN personas p ON d.id_persona = p.id WHERE d.id = ?`,
        [docente_id]
      );

      if (!docenteRows || docenteRows.length === 0) return res.status(404).json({ message: "No se encontraron datos" });
      const docente = docenteRows[0];
      docente.dni = decrypt(docente.dni);
      docente.telefono = decrypt(docente.telefono);
      res.json({ docente });
    } catch (error) {
      res.status(500).json({ message: "Error al obtener los datos" });
    } finally {
      connection.release();
    }
  },

  exportarDatosDocenteExcel: async (req, res) => {
    const connection = await pool.getConnection();
    try {
      const { anio } = req.params;
      const [docentes] = await connection.query(
        `SELECT d.id, p.nombres as nombre, p.apellido_paterno, p.apellido_materno, p.dni, p.fecha_nacimiento, p.email, d.fecha_ingreso,
         GROUP_CONCAT(DISTINCT CONCAT(c.nombre, ' - ', g.nombre) SEPARATOR ', ') as cursos
         FROM docentes d
         INNER JOIN personas p ON d.id_persona = p.id
         LEFT JOIN asignaciones asig ON d.id = asig.id_docente
         LEFT JOIN cursos c ON asig.id_curso = c.id
         LEFT JOIN grados g ON asig.id_grado = g.id
         WHERE YEAR(d.fecha_ingreso) = ?
         GROUP BY d.id, p.id
         ORDER BY d.id DESC`,
        [anio]
      );

      if (!docentes || docentes.length === 0) return res.status(404).json({ message: `No se encontraron docentes para el año ${anio}` });

      const workbook = new ExcelJS.Workbook();
      const infoDocentes = workbook.addWorksheet('Docentes');
      infoDocentes.columns = [
        { header: 'Año', key: 'anio', width: 10 },
        { header: 'ID', key: 'id', width: 10 },
        { header: 'Nombre', key: 'nombre', width: 20 },
        { header: 'Apellido Paterno', key: 'apellido_paterno', width: 20 },
        { header: 'Apellido Materno', key: 'apellido_materno', width: 20 },
        { header: 'DNI', key: 'dni', width: 15 },
        { header: 'Fecha de Nacimiento', key: 'fecha_nacimiento', width: 20 },
        { header: 'Email', key: 'email', width: 30 },
        { header: 'Fecha de Registro', key: 'fecha_registro', width: 20 },
        { header: 'Cursos', key: 'cursos', width: 40 }
      ];

      docentes.forEach(docente => {
        infoDocentes.addRow({
          anio: anio, id: docente.id, nombre: docente.nombre,
          apellido_paterno: docente.apellido_paterno, apellido_materno: docente.apellido_materno,
          dni: decrypt(docente.dni), fecha_nacimiento: new Date(docente.fecha_nacimiento).toLocaleDateString(),
          email: docente.email, fecha_registro: new Date(docente.fecha_ingreso).toLocaleDateString(),
          cursos: docente.cursos || 'Sin cursos asignados'
        });
      });

      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', `attachment; filename=docentes_${anio}.xlsx`);
      await workbook.xlsx.write(res);
      res.end();
    } catch (error) {
      res.status(500).json({ message: "Error al exportar los datos" });
    } finally {
      connection.release();
    }
  },

  async listarAlumnosMatriculados(req, res) {
    const connection = await pool.getConnection();
    try {
      const { anio } = req.params;
      const id_grado = req.query.id_grado || req.params.id_grado;
      const id_persona = req.user.id_persona;
      const docente = await DocenteModel.buscarPorIdPersona(connection, id_persona);
      if (!docente) return res.status(404).json({ success: false, message: "No se encontró el docente." });

      const [grados] = await connection.query(
        `SELECT DISTINCT asig.id_grado, g.nombre as descripcion
         FROM asignaciones asig
         JOIN grados g ON g.id = asig.id_grado
         JOIN periodos_academicos pa ON asig.id_periodo = pa.id
         WHERE asig.id_docente = ? AND pa.anio = ?`,
        [docente.id, anio]
      );

      if (!grados || grados.length === 0) return res.status(200).json({ success: true, data: [], message: "Sin grados asignados." });

      const resultado = [];
      for (const grado of grados) {
        if (id_grado && grado.id_grado != id_grado) continue;
        const [alumnosRows] = await connection.query(
          `SELECT a.id AS alumno_id, p.dni AS alumno_dni, p.nombres AS alumno_nombre, p.apellido_paterno AS alumno_apellido_paterno,
           p.apellido_materno AS alumno_apellido_materno, p.fecha_nacimiento, g.nombre AS grado, m.fecha_matricula
           FROM alumnos a
           JOIN personas p ON a.id_persona = p.id
           JOIN matriculas m ON m.id_alumno = a.id
           JOIN grados g ON g.id = m.id_grado
           JOIN periodos_academicos pa ON m.id_periodo = pa.id
           WHERE pa.anio = ? AND g.id = ?
           ORDER BY p.apellido_paterno, p.apellido_materno, p.nombres`,
          [anio, grado.id_grado]
        );
        const alumnos = alumnosRows.map(a => ({ ...a, alumno_dni: decrypt(a.alumno_dni) }));
        resultado.push({ grado: grado.descripcion, id_grado: grado.id_grado, alumnos });
      }
      return res.status(200).json({ success: true, data: resultado, anio });
    } catch (error) {
      res.status(500).json({ success: false, message: "Error al listar alumnos.", error: error.message });
    } finally {
      connection.release();
    }
  },

  async registrarAsistencia(req, res) {
    const connection = await pool.getConnection();
    try {
      const { id_alumno, id_matricula, id_asignacion, fecha, estado, asistio, hora_llegada, observaciones, observacion } = req.body;
      const id_persona = req.user.id_persona;
      const docente = await DocenteModel.buscarPorIdPersona(connection, id_persona);
      if (!docente) return res.status(403).json({ success: false, message: "No tiene permisos." });

      const [rows] = await connection.query("SELECT * FROM asignaciones WHERE id = ? AND id_docente = ?", [id_asignacion, docente.id]);
      if (!rows || rows.length === 0) return res.status(403).json({ success: false, message: "No tiene permisos sobre esa asignación." });

      let fechaFinal = fecha;
      if (fecha && fecha.includes('T')) {
        const d = new Date(fecha);
        if (!isNaN(d.getTime())) {
          const formatter = new Intl.DateTimeFormat('es-PE', {
            timeZone: 'America/Lima',
            year: 'numeric', month: '2-digit', day: '2-digit'
          });
          const parts = formatter.formatToParts(d);
          const day = parts.find(p => p.type === 'day').value;
          const month = parts.find(p => p.type === 'month').value;
          const year = parts.find(p => p.type === 'year').value;
          fechaFinal = `${year}-${month}-${day}`;
        }
      }

      await connection.beginTransaction();
      await connection.query(
        "INSERT INTO asistencia (id_alumno, id_asignacion, fecha, asistio, observacion) VALUES (?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE asistio=VALUES(asistio), observacion=VALUES(observacion)",
        [id_alumno || id_matricula, id_asignacion, fechaFinal, estado === 'Presente' || estado === 1 ? 1 : 0, observaciones || observacion || null]
      );
      await connection.commit();
      return res.status(201).json({ success: true, message: "Asistencia registrada." });
    } catch (error) {
      if (connection) await connection.rollback();
      res.status(500).json({ success: false, message: "Error al registrar asistencia.", error: error.message });
    } finally {
      connection.release();
    }
  },

  async registrarAsistenciaMasiva(req, res) {
    const connection = await pool.getConnection();
    try {
      let { asistencia } = req.body;
      const id_persona = req.user.id_persona;

      if (!asistencia || !Array.isArray(asistencia) || asistencia.length === 0) {
        return res.status(400).json({ success: false, message: "Se requiere un array de asistencia." });
      }

      const docente = await DocenteModel.buscarPorIdPersona(connection, id_persona);
      if (!docente) return res.status(403).json({ success: false, message: "No tiene permisos." });

      // Validar que todas las asignaciones pertenecen al docente
      const [rows] = await connection.query(
        "SELECT id FROM asignaciones WHERE id IN (?) AND id_docente = ?",
        [idAsignaciones, docente.id]
      );

      if (rows.length !== idAsignaciones.length) {
        return res.status(403).json({ success: false, message: "No tiene permisos sobre una o más asignaciones." });
      }

      await connection.beginTransaction();

      // Mapeo de campos para coincidir con la base de datos (id_alumno, id_asignacion, fecha, asistio, observacion)
      const values = asistencia.map(a => {
        let fechaFinal = a.fecha;
        if (a.fecha && a.fecha.includes('T')) {
          const d = new Date(a.fecha);
          if (!isNaN(d.getTime())) {
            const formatter = new Intl.DateTimeFormat('es-PE', {
              timeZone: 'America/Lima',
              year: 'numeric', month: '2-digit', day: '2-digit'
            });
            const parts = formatter.formatToParts(d);
            const day = parts.find(p => p.type === 'day').value;
            const month = parts.find(p => p.type === 'month').value;
            const year = parts.find(p => p.type === 'year').value;
            fechaFinal = `${year}-${month}-${day}`;
          }
        }

        return [
          a.id_alumno || a.id_matricula,
          a.id_asignacion,
          fechaFinal,
          a.estado === 'Presente' || a.estado === 1 || a.asistio === true ? 1 : 0,
          a.observaciones || a.observacion || null
        ];
      });



      // Usar los nombres de columna reales: id_alumno, id_asignacion, fecha, asistio, observacion
      await connection.query(
        "INSERT INTO asistencia (id_alumno, id_asignacion, fecha, asistio, observacion) VALUES ? ON DUPLICATE KEY UPDATE asistio=VALUES(asistio), observacion=VALUES(observacion)",
        [values]
      );

      await connection.commit();
      return res.status(201).json({ success: true, message: `${values.length} asistencias registradas.` });
    } catch (error) {
      if (connection) await connection.rollback();
      res.status(500).json({ success: false, message: "Error al registrar asistencia.", error: error.message });
    } finally {
      connection.release();
    }
  },
  async verificarAsistenciaHoy(req, res) {
    const connection = await pool.getConnection();
    try {
      const { id_asignacion, fecha } = req.query;
      if (!id_asignacion || !fecha) {
        return res.status(400).json({ success: false, message: "Faltan parámetros: id_asignacion y fecha." });
      }

      const [rows] = await connection.query(
        "SELECT COUNT(*) as total FROM asistencia WHERE id_asignacion = ? AND fecha = ?",
        [id_asignacion, fecha]
      );

      return res.status(200).json({
        success: true,
        ya_registrada: rows[0].total > 0,
        total_alumnos: rows[0].total
      });
    } catch (error) {
      res.status(500).json({ success: false, message: "Error al verificar la asistencia.", error: error.message });
    } finally {
      connection.release();
    }
  },


  async exportarAsistenciaExcel(req, res) {
    const connection = await pool.getConnection();
    try {
      const { fecha, id_grado, id_curso } = req.query;
      const id_persona = req.user.id_persona;
      const docente = await DocenteModel.buscarPorIdPersona(connection, id_persona);
      if (!docente) return res.status(403).json({ success: false, message: "No tiene permisos." });

      const [rowsAsig] = await connection.query(
        `SELECT asig.id, c.nombre AS nombre_curso, g.nombre AS nombre_grado
         FROM asignaciones asig JOIN cursos c ON c.id = asig.id_curso JOIN grados g ON g.id = asig.id_grado
         WHERE asig.id_docente = ? AND asig.id_curso = ? AND asig.id_grado = ?`,
        [docente.id, id_curso, id_grado]
      );
      if (!rowsAsig || rowsAsig.length === 0) return res.status(403).json({ success: false, message: "Sin asignación." });

      const [asistencia] = await connection.query(
        `SELECT ast.*, p.dni, p.nombres as nombre, p.apellido_paterno as ap_p, p.apellido_materno as ap_m
         FROM asistencia ast 
         JOIN alumnos al ON ast.id_alumno = al.id 
         JOIN personas p ON al.id_persona = p.id
         WHERE ast.id_asignacion = ? AND ast.fecha = ? 
         ORDER BY p.apellido_paterno, p.apellido_materno, p.nombres`,
        [rowsAsig[0].id, fecha]
      );

      const workbook = new ExcelJS.Workbook();
      const sheet = workbook.addWorksheet('Asistencia');
      sheet.columns = [
        { header: 'DNI', key: 'dni', width: 12 },
        { header: 'Nombre', key: 'nombre', width: 20 },
        { header: 'Apellido Paterno', key: 'ap_p', width: 18 },
        { header: 'Apellido Materno', key: 'ap_m', width: 18 },
        { header: 'Estado', key: 'estado', width: 12 },
        { header: 'Hora', key: 'hora', width: 12 },
        { header: 'Observación', key: 'observacion', width: 25 }
      ];
      asistencia.forEach(a => sheet.addRow({
        dni: decrypt(a.dni),
        nombre: a.nombre,
        ap_p: a.ap_p,
        ap_m: a.ap_m,
        estado: a.asistio ? 'Presente' : 'Ausente',
        hora: a.created_at ? new Date(a.created_at).toLocaleTimeString('es-PE', { hour: '2-digit', minute: '2-digit', hour12: true }) : '--:--',
        observacion: a.observacion || ''
      }));

      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', `attachment; filename=asistencia_${fecha}.xlsx`);
      await workbook.xlsx.write(res);
      res.end();
    } catch (error) {
      res.status(500).json({ success: false, message: "Error.", error: error.message });
    } finally {
      connection.release();
    }
  },

  async listarAsistencias(req, res) {
    const connection = await pool.getConnection();
    try {
      const { fecha, id_grado, id_curso } = req.query;
      const id_persona = req.user.id_persona;
      const docente = await DocenteModel.buscarPorIdPersona(connection, id_persona);
      if (!docente) return res.status(403).json({ success: false, message: "Sin permisos." });

      const [rowsAsig] = await connection.query("SELECT id FROM asignaciones WHERE id_docente = ? AND id_curso = ? AND id_grado = ?", [docente.id, id_curso, id_grado]);
      if (!rowsAsig || rowsAsig.length === 0) return res.status(403).json({ success: false, message: "Sin asignación." });

      const [asistenciaRows] = await connection.query(
        `SELECT ast.*, p.dni, p.nombres as nombre, p.apellido_paterno as ap_p, p.apellido_materno as ap_m
         FROM asistencia ast 
         JOIN alumnos al ON ast.id_alumno = al.id 
         JOIN personas p ON al.id_persona = p.id
         WHERE ast.id_asignacion = ? AND ast.fecha = ? 
         ORDER BY p.apellido_paterno, p.apellido_materno, p.nombres`,
        [rowsAsig[0].id, fecha]
      );
      const asistencias = asistenciaRows.map(a => ({
        ...a,
        dni: decrypt(a.dni),
        estado: a.asistio ? 'Presente' : 'Ausente',
        hora_llegada: a.created_at ? new Date(a.created_at).toLocaleTimeString('es-PE', { hour: '2-digit', minute: '2-digit', hour12: true }) : '--:--',
        observaciones: a.observacion
      }));
      return res.status(200).json({ success: true, data: asistencias });
    } catch (error) {
      res.status(500).json({ success: false, message: "Error.", error: error.message });
    } finally {
      connection.release();
    }
  },

  async misCursosPorAnio(req, res) {
    const connection = await pool.getConnection();
    try {
      const { anio } = req.params;
      const id_persona = req.user.id_persona;
      const docente = await DocenteModel.buscarPorIdPersona(connection, id_persona);
      if (!docente) return res.status(404).json({ success: false, message: "Docente no encontrado." });

      const [cursos] = await connection.query(
        `SELECT asig.id AS id_asignacion, c.id AS id_curso, c.nombre AS curso, g.id AS id_grado, g.nombre AS grado, s.nombre AS seccion
         FROM asignaciones asig
         JOIN cursos c ON c.id = asig.id_curso
         JOIN grados g ON g.id = asig.id_grado
         LEFT JOIN secciones s ON s.id = asig.id_seccion
         JOIN periodos_academicos pa ON (asig.id_periodo = pa.id OR (asig.id_periodo IS NULL AND YEAR(asig.created_at) = pa.anio))
         WHERE asig.id_docente = ? AND pa.anio = ?
         ORDER BY g.nombre, s.nombre, c.nombre`,
        [docente.id, anio]
      );
      return res.status(200).json({ success: true, data: cursos });
    } catch (error) {
      res.status(500).json({ success: false, message: "Error.", error: error.message });
    } finally {
      connection.release();
    }
  },

  async getCursosYAlumnosAsignados(req, res) {
    const connection = await pool.getConnection();
    try {
      const { anio } = req.params;
      const id_persona = req.user.id_persona;
      const docente = await DocenteModel.buscarPorIdPersona(connection, id_persona);

      if (!docente) {
        return res.status(404).json({ success: false, message: "Docente no encontrado." });
      }

      // Obtener las asignaciones del docente para el año especificado
      const [asignaciones] = await connection.query(
        `SELECT 
          asig.id AS id_asignacion,
          c.id AS id_curso,
          c.nombre AS nombre_curso,
          g.id AS id_grado,
          g.nombre AS nombre_grado,
          pa.anio AS anio_academico,
          pa.id AS id_periodo
         FROM asignaciones asig
         JOIN cursos c ON asig.id_curso = c.id
         JOIN grados g ON asig.id_grado = g.id
         JOIN periodos_academicos pa ON (
           (asig.id_periodo IS NOT NULL AND asig.id_periodo = pa.id) OR
           (asig.id_periodo IS NULL AND YEAR(asig.created_at) = pa.anio)
         )
         WHERE asig.id_docente = ? AND pa.anio = ?
         ORDER BY g.nombre, c.nombre`,
        [docente.id, anio]
      );

      const data = [];
      const alumnosPorGradoPeriodo = {};

      for (const asig of asignaciones) {
        const key = `${asig.id_grado}_${asig.id_periodo}`;
        if (!alumnosPorGradoPeriodo[key]) {
          const [alumnosRows] = await connection.query(
            `SELECT 
              a.id AS id_alumno,
              m.id AS id_matricula,
              p.dni,
              CONCAT(p.apellido_paterno, ' ', p.apellido_materno, ', ', p.nombres) AS nombre_completo
             FROM matriculas m
             JOIN alumnos a ON m.id_alumno = a.id
             JOIN personas p ON a.id_persona = p.id
             WHERE m.id_grado = ? AND m.id_periodo = ?
             ORDER BY p.apellido_paterno, p.apellido_materno, p.nombres`,
            [asig.id_grado, asig.id_periodo]
          );
          alumnosPorGradoPeriodo[key] = alumnosRows.map(a => ({ ...a, dni: decrypt(a.dni) }));
        }

        data.push({
          id_asignacion: asig.id_asignacion,
          id_curso: asig.id_curso,
          curso: asig.nombre_curso,
          id_grado: asig.id_grado,
          grado: asig.nombre_grado,
          anio: asig.anio_academico,
          alumnos: alumnosPorGradoPeriodo[key]
        });
      }

      res.status(200).json({
        success: true,
        data: data
      });

    } catch (error) {
      res.status(500).json({ success: false, message: "Error interno del servidor.", error: error.message });
    } finally {
      connection.release();
    }
  },

  async toggleEstadoDocente(req, res) {
    const connection = await pool.getConnection();
    try {
      const { id_docente } = req.params;
      const { activo } = req.body; // Nuevo estado deseado (0 o 1)

      // Obtener el id_persona asociado al docente
      const [rows] = await connection.query(
        "SELECT id_persona FROM docentes WHERE id = ?",
        [id_docente]
      );

      if (rows.length === 0) {
        return res.status(404).json({ success: false, message: "Docente no encontrado." });
      }

      const id_persona = rows[0].id_persona;

      // Actualizar el estado en la tabla users
      await connection.query(
        "UPDATE users SET activo = ? WHERE id_persona = ?",
        [activo, id_persona]
      );

      res.json({ success: true, message: `Acceso del docente ${activo === 1 ? 'activado' : 'desactivado'} con éxito.` });
    } catch (error) {
      res.status(500).json({ success: false, message: "Error al cambiar estado del docente.", error: error.message });
    } finally {
      connection.release();
    }
  }
};

module.exports = docenteController;

const { pool } = require("../config/database");
const ExcelJS = require("exceljs");
const PDFDocument = require("pdfkit");
const { decrypt } = require("../utils/cryptoUtils");
const { notifyAbsenceToParents } = require("../utils/notificationHelper");

const DIA_TO_JS = {
  Lunes: 1,
  Martes: 2,
  Miercoles: 3,
  Jueves: 4,
  Viernes: 5,
  Sabado: 6,
  Domingo: 0,
};

const ESTADOS_VALIDOS = new Set(["Presente", "Ausente", "Tardanza", "Justificado"]);

function normalizeDate(input) {
  if (!input) return null;
  if (typeof input === "string" && /^\d{4}-\d{2}-\d{2}$/.test(input)) return input;

  const d = new Date(input);
  if (Number.isNaN(d.getTime())) return null;

  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Lima",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  return formatter.format(d);
}

function overlaps(aStart, aEnd, bStart, bEnd) {
  return aStart < bEnd && aEnd > bStart;
}

function toLimaDateParts(inputDate = null) {
  const base = inputDate ? new Date(inputDate) : new Date();
  const formatter = new Intl.DateTimeFormat("es-PE", {
    timeZone: "America/Lima",
    weekday: "long",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const parts = formatter.formatToParts(base);
  const get = (type) => parts.find((p) => p.type === type)?.value || "";
  const weekdayRaw = get("weekday")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
  const weekdayMap = {
    lunes: "Lunes",
    martes: "Martes",
    miercoles: "Miercoles",
    jueves: "Jueves",
    viernes: "Viernes",
    sabado: "Sabado",
    domingo: "Domingo",
  };

  return {
    fecha: `${get("year")}-${get("month")}-${get("day")}`,
    horaHHMM: `${get("hour")}:${get("minute")}`,
    diaSemana: weekdayMap[weekdayRaw] || "",
  };
}

async function getDocenteIdFromUser(connection, req) {
  const [rows] = await connection.query(
    "SELECT id FROM docentes WHERE id_persona = ? LIMIT 1",
    [req.user.id_persona]
  );
  return rows.length ? rows[0].id : null;
}

function buildResumenEstados(items) {
  return items.reduce(
    (acc, curr) => {
      const key = curr.estado;
      acc[key] = (acc[key] || 0) + 1;
      return acc;
    },
    { Presente: 0, Ausente: 0, Tardanza: 0, Justificado: 0 }
  );
}

const horarioController = {
  async obtenerCatalogos(req, res) {
    const connection = await pool.getConnection();
    try {
      const [periodos] = await connection.query(
        `SELECT id, anio, activo
         FROM periodos_academicos
         ORDER BY anio DESC`
      );

      const [cursos] = await connection.query(
        `SELECT id, nombre
         FROM cursos
         ORDER BY nombre ASC`
      );

      const [grados] = await connection.query(
        `SELECT id, nombre
         FROM grados
         ORDER BY id ASC`
      );

      const [secciones] = await connection.query(
        `SELECT id, nombre
         FROM secciones
         ORDER BY nombre ASC`
      );

      const [docentes] = await connection.query(
        `SELECT d.id, d.codigo_docente,
                CONCAT(p.nombres, ' ', p.apellido_paterno, ' ', p.apellido_materno) AS nombre_completo
         FROM docentes d
         JOIN personas p ON p.id = d.id_persona
         ORDER BY p.apellido_paterno, p.apellido_materno, p.nombres`
      );

      return res.status(200).json({
        success: true,
        data: {
          periodos,
          docentes,
          cursos,
          grados,
          secciones,
        },
      });
    } catch (error) {
      return res.status(500).json({ success: false, message: "Error al obtener catálogos.", error: error.message });
    } finally {
      connection.release();
    }
  },

  async obtenerAsignacionesPorDocente(req, res) {
    const connection = await pool.getConnection();
    try {
      const { idDocente } = req.params;
      const { id_periodo } = req.query;

      if (!idDocente || !id_periodo) {
        return res.status(400).json({
          success: false,
          message: "Parámetros requeridos: idDocente y id_periodo",
        });
      }

      const [rows] = await connection.query(
        `SELECT
            a.id AS id_asignacion,
            a.id_curso,
            c.nombre AS curso,
            a.id_grado,
            g.nombre AS grado,
            a.id_seccion,
            s.nombre AS seccion
         FROM asignaciones a
         JOIN cursos c ON c.id = a.id_curso
         JOIN grados g ON g.id = a.id_grado
         LEFT JOIN secciones s ON s.id = a.id_seccion
         WHERE a.id_docente = ?
           AND a.id_periodo = ?
         ORDER BY g.id, c.nombre, s.nombre`,
        [idDocente, id_periodo]
      );

      return res.status(200).json({
        success: true,
        total: rows.length,
        data: rows,
      });
    } catch (error) {
      return res.status(500).json({ success: false, message: "Error al obtener asignaciones del docente.", error: error.message });
    } finally {
      connection.release();
    }
  },

  async obtenerReporteHorarios(req, res) {
    const connection = await pool.getConnection();
    try {
      const { id_periodo, id_docente, id_grado, id_curso, id_seccion } = req.query;

      const where = ["h.activo = 1"];
      const params = [];

      if (id_periodo) {
        where.push("a.id_periodo = ?");
        params.push(id_periodo);
      }
      if (id_docente) {
        where.push("a.id_docente = ?");
        params.push(id_docente);
      }
      if (id_grado) {
        where.push("a.id_grado = ?");
        params.push(id_grado);
      }
      if (id_curso) {
        where.push("a.id_curso = ?");
        params.push(id_curso);
      }
      if (id_seccion) {
        where.push("a.id_seccion = ?");
        params.push(id_seccion);
      }

      const [rows] = await connection.query(
        `SELECT
            pa.id AS id_periodo,
            pa.anio,
            a.id AS id_asignacion,
            a.id_docente,
            CONCAT(p.nombres, ' ', p.apellido_paterno, ' ', p.apellido_materno) AS docente,
            a.id_curso,
            c.nombre AS curso,
            a.id_grado,
            g.nombre AS grado,
            a.id_seccion,
            COALESCE(s.nombre, 'Sin sección') AS seccion,
            h.id AS id_horario,
            h.dia_semana,
            h.hora_inicio,
            h.hora_fin,
            h.aula
         FROM horarios h
         JOIN asignaciones a ON a.id = h.id_asignacion
         JOIN periodos_academicos pa ON pa.id = a.id_periodo
         JOIN docentes d ON d.id = a.id_docente
         JOIN personas p ON p.id = d.id_persona
         JOIN cursos c ON c.id = a.id_curso
         JOIN grados g ON g.id = a.id_grado
         LEFT JOIN secciones s ON s.id = a.id_seccion
         WHERE ${where.join(" AND ")}
         ORDER BY
           pa.anio DESC,
           docente ASC,
           g.id ASC,
           c.nombre ASC,
           FIELD(h.dia_semana, 'Lunes','Martes','Miercoles','Jueves','Viernes','Sabado','Domingo'),
           h.hora_inicio ASC`,
        params
      );

      return res.status(200).json({
        success: true,
        total: rows.length,
        data: rows,
      });
    } catch (error) {
      return res.status(500).json({ success: false, message: "Error al obtener reporte de horarios.", error: error.message });
    } finally {
      connection.release();
    }
  },

  async crearAsignacionDocente(req, res) {
    const connection = await pool.getConnection();
    try {
      const { id_docente, id_curso, id_grado, id_seccion, id_periodo } = req.body;
      const seccionValue = id_seccion ? Number(id_seccion) : null;

      if (!id_docente || !id_curso || !id_grado || !id_periodo) {
        return res.status(400).json({
          success: false,
          message: "Faltan datos obligatorios: id_docente, id_curso, id_grado, id_periodo",
        });
      }

      const [exists] = await connection.query(
        `SELECT id
         FROM asignaciones
         WHERE id_docente = ? AND id_curso = ? AND id_grado = ? AND id_seccion <=> ? AND id_periodo = ?`,
        [id_docente, id_curso, id_grado, seccionValue, id_periodo]
      );

      if (exists.length > 0) {
        return res.status(409).json({
          success: false,
          message: "La asignación ya existe para ese docente/curso/grado/sección/periodo.",
          id_asignacion: exists[0].id,
        });
      }

      const [result] = await connection.query(
        `INSERT INTO asignaciones (id_docente, id_curso, id_grado, id_seccion, id_periodo)
         VALUES (?, ?, ?, ?, ?)`,
        [id_docente, id_curso, id_grado, seccionValue, id_periodo]
      );

      return res.status(201).json({
        success: true,
        message: "Asignación docente creada correctamente.",
        id_asignacion: result.insertId,
      });
    } catch (error) {
      return res.status(500).json({ success: false, message: "Error al crear asignación.", error: error.message });
    } finally {
      connection.release();
    }
  },

  async crearHorario(req, res) {
    const connection = await pool.getConnection();
    try {
      const { id_asignacion, bloques } = req.body;

      if (!id_asignacion || !Array.isArray(bloques) || bloques.length === 0) {
        return res.status(400).json({
          success: false,
          message: "Debe enviar id_asignacion y un arreglo bloques con al menos un bloque.",
        });
      }

      const [asigRows] = await connection.query(
        `SELECT id, id_docente, id_grado, id_seccion, id_periodo
         FROM asignaciones
         WHERE id = ?`,
        [id_asignacion]
      );

      if (asigRows.length === 0) {
        return res.status(404).json({ success: false, message: "Asignación no encontrada." });
      }

      const asig = asigRows[0];

      const normalizedBloques = bloques.map((b) => ({
        dia_semana: b.dia_semana,
        hora_inicio: b.hora_inicio,
        hora_fin: b.hora_fin,
        aula: b.aula || null,
      }));

      for (const b of normalizedBloques) {
        if (!Object.prototype.hasOwnProperty.call(DIA_TO_JS, b.dia_semana)) {
          return res.status(400).json({
            success: false,
            message: `Día inválido: ${b.dia_semana}. Use Lunes..Domingo.`,
          });
        }
        if (!b.hora_inicio || !b.hora_fin || b.hora_inicio >= b.hora_fin) {
          return res.status(400).json({
            success: false,
            message: `Bloque inválido para ${b.dia_semana}. hora_inicio debe ser menor a hora_fin.`,
          });
        }
      }

      for (let i = 0; i < normalizedBloques.length; i += 1) {
        for (let j = i + 1; j < normalizedBloques.length; j += 1) {
          const a = normalizedBloques[i];
          const b = normalizedBloques[j];
          if (a.dia_semana === b.dia_semana) {
            return res.status(409).json({
              success: false,
              message: `No se permite tener dos bloques del mismo curso el día ${a.dia_semana}. Combine ambos en un solo bloque si es necesario.`,
            });
          }
        }
      }

      for (const b of normalizedBloques) {
        const [conflicts] = await connection.query(
          `SELECT h.id, h.dia_semana, h.hora_inicio, h.hora_fin, h.aula,
                  a.id_docente, a.id_grado, a.id_seccion,
                  c.nombre AS curso_nombre,
                  g.nombre AS grado_nombre,
                  COALESCE(s.nombre, 'Sin sección') AS seccion_nombre,
                  CONCAT(p.nombres, ' ', p.apellido_paterno) AS docente_nombre
           FROM horarios h
           JOIN asignaciones a ON a.id = h.id_asignacion
           JOIN cursos c ON c.id = a.id_curso
           JOIN grados g ON g.id = a.id_grado
           LEFT JOIN secciones s ON s.id = a.id_seccion
           JOIN docentes d ON d.id = a.id_docente
           JOIN personas p ON p.id = d.id_persona
           WHERE h.activo = 1
             AND a.id_periodo = ?
             AND h.dia_semana = ?
             AND h.hora_inicio < ?
             AND h.hora_fin > ?
             AND a.id <> ?
             AND (
               a.id_docente = ?
               OR (a.id_grado = ? AND (IFNULL(a.id_seccion, 0) = 0 OR IFNULL(?, 0) = 0 OR a.id_seccion = ?))
               OR (h.aula IS NOT NULL AND ? IS NOT NULL AND h.aula = ?)
             )`,
          [
            asig.id_periodo,
            b.dia_semana,
            b.hora_fin,
            b.hora_inicio,
            asig.id,
            asig.id_docente,
            asig.id_grado,
            asig.id_seccion,
            asig.id_seccion,
            b.aula,
            b.aula,
          ]
        );

        if (conflicts.length > 0) {
          const c = conflicts[0];
          let motivo = "Conflicto de horario";

          if (c.id_docente === asig.id_docente) {
            motivo = `El docente ${c.docente_nombre} ya tiene clase de ${c.curso_nombre}`;
          } else if (c.id_grado === asig.id_grado) {
            motivo = `El ${c.grado_nombre} (${c.seccion_nombre}) ya tiene clase de ${c.curso_nombre} con ${c.docente_nombre}`;
          } else if (b.aula && c.aula === b.aula) {
            motivo = `El aula ${c.aula} ya está ocupada por ${c.docente_nombre}`;
          }

          return res.status(409).json({
            success: false,
            message: `${motivo} el ${b.dia_semana} de ${b.hora_inicio.slice(0, 5)} a ${b.hora_fin.slice(0, 5)}.`,
          });
        }
      }

      await connection.beginTransaction();

      const [currentHorarios] = await connection.query(
        "SELECT id, dia_semana, hora_inicio, hora_fin, aula FROM horarios WHERE id_asignacion = ? AND activo = 1",
        [id_asignacion]
      );

      // Mapear por clave natural para comparación: "DIA|HH:MM:SS"
      const currentMap = new Map();
      currentHorarios.forEach((h) => {
        const hInicio = String(h.hora_inicio).length === 5 ? `${h.hora_inicio}:00` : h.hora_inicio;
        const key = `${h.dia_semana}|${hInicio}`;
        currentMap.set(key, h);
      });

      const idsToKeep = [];

      for (const b of normalizedBloques) {
        // Asegurar formato HH:MM:00 para la comparación si viene como HH:MM
        const bInicio = b.hora_inicio.length === 5 ? `${b.hora_inicio}:00` : b.hora_inicio;
        const bFin = b.hora_fin.length === 5 ? `${b.hora_fin}:00` : b.hora_fin;
        const key = `${b.dia_semana}|${bInicio}`;

        if (currentMap.has(key)) {
          // Ya existe: Actualizar si algo cambió (hora_fin o aula)
          const existing = currentMap.get(key);
          const existingFin = String(existing.hora_fin);

          if (existingFin !== bFin || existing.aula !== b.aula) {
            await connection.query(
              "UPDATE horarios SET hora_fin = ?, aula = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
              [b.hora_fin, b.aula, existing.id]
            );
          }
          idsToKeep.push(existing.id);
        } else {
          // No existe: Insertar nuevo
          const [insertResult] = await connection.query(
            "INSERT INTO horarios (id_asignacion, dia_semana, hora_inicio, hora_fin, aula) VALUES (?, ?, ?, ?, ?)",
            [id_asignacion, b.dia_semana, b.hora_inicio, b.hora_fin, b.aula]
          );
          idsToKeep.push(insertResult.insertId);
        }
      }

      if (currentHorarios.length > 0) {
        const idsToDelete = currentHorarios
          .filter((h) => !idsToKeep.includes(h.id))
          .map((h) => h.id);

        if (idsToDelete.length > 0) {
          await connection.query("DELETE FROM horarios WHERE id IN (?)", [idsToDelete]);
        }
      }

      await connection.commit();

      return res.status(200).json({
        success: true,
        message: "Horario sincronizado correctamente.",
        bloques_procesados: normalizedBloques.length,
      });
    } catch (error) {
      if (connection) await connection.rollback();
      return res.status(500).json({ success: false, message: "Error al guardar horario.", error: error.message });
    } finally {
      connection.release();
    }
  },

  async obtenerHorarioPorSeccion(req, res) {
    const connection = await pool.getConnection();
    try {
      const { idSeccion } = req.params;
      const { id_periodo, dia_semana } = req.query;

      let periodoId = id_periodo;
      if (!periodoId) {
        const [periodoActivo] = await connection.query(
          "SELECT id FROM periodos_academicos WHERE activo = 1 ORDER BY id DESC LIMIT 1"
        );
        if (periodoActivo.length === 0) {
          return res.status(400).json({ success: false, message: "No se encontró periodo activo." });
        }
        periodoId = periodoActivo[0].id;
      }

      const params = [idSeccion, periodoId];
      let filterDia = "";
      if (dia_semana) {
        filterDia = " AND h.dia_semana = ? ";
        params.push(dia_semana);
      }

      const [rows] = await connection.query(
        `SELECT
            h.id AS id_horario,
            h.dia_semana,
            h.hora_inicio,
            h.hora_fin,
            h.aula,
            a.id AS id_asignacion,
            c.id AS id_curso,
            c.nombre AS curso,
            g.id AS id_grado,
            g.nombre AS grado,
            s.id AS id_seccion,
            s.nombre AS seccion,
            d.id AS id_docente,
            CONCAT(p.nombres, ' ', p.apellido_paterno, ' ', p.apellido_materno) AS docente
          FROM horarios h
          JOIN asignaciones a ON a.id = h.id_asignacion
          JOIN cursos c ON c.id = a.id_curso
          JOIN grados g ON g.id = a.id_grado
          JOIN secciones s ON s.id = a.id_seccion
          JOIN docentes d ON d.id = a.id_docente
          JOIN personas p ON p.id = d.id_persona
          WHERE a.id_seccion = ?
            AND a.id_periodo = ?
            AND h.activo = 1
            ${filterDia}
          ORDER BY FIELD(h.dia_semana, 'Lunes','Martes','Miercoles','Jueves','Viernes','Sabado','Domingo'), h.hora_inicio`,
        params
      );

      return res.status(200).json({
        success: true,
        id_seccion: Number(idSeccion),
        id_periodo: Number(periodoId),
        total: rows.length,
        data: rows,
      });
    } catch (error) {
      return res.status(500).json({ success: false, message: "Error al obtener horario.", error: error.message });
    } finally {
      connection.release();
    }
  },

  async obtenerMisBloquesDocente(req, res) {
    const connection = await pool.getConnection();
    try {
      const fechaFinal = normalizeDate(req.query.fecha) || toLimaDateParts().fecha;
      const fechaInfo = toLimaDateParts(`${fechaFinal}T00:00:00-05:00`);
      const docenteId = await getDocenteIdFromUser(connection, req);

      if (!docenteId) {
        return res.status(403).json({ success: false, message: "Docente no encontrado para el usuario autenticado." });
      }

      const [rows] = await connection.query(
        `SELECT
            h.id AS id_horario,
            h.dia_semana,
            h.hora_inicio,
            h.hora_fin,
            h.aula,
            a.id AS id_asignacion,
            a.id_periodo,
            c.nombre AS curso,
            g.nombre AS grado,
            COALESCE(s.nombre, 'Sin sección') AS seccion
         FROM horarios h
         JOIN asignaciones a ON a.id = h.id_asignacion
         JOIN cursos c ON c.id = a.id_curso
         JOIN grados g ON g.id = a.id_grado
         LEFT JOIN secciones s ON s.id = a.id_seccion
         WHERE h.activo = 1
           AND a.id_docente = ?
           AND h.dia_semana = ?
         ORDER BY h.hora_inicio`,
        [docenteId, fechaInfo.diaSemana]
      );

      const ahora = toLimaDateParts();
      const data = rows.map((row) => {
        const inicio = String(row.hora_inicio).slice(0, 5);
        const fin = String(row.hora_fin).slice(0, 5);
        const enRango = ahora.fecha === fechaFinal && ahora.horaHHMM >= inicio && ahora.horaHHMM <= fin;
        return { ...row, puede_registrar: enRango };
      });

      return res.status(200).json({
        success: true,
        fecha: fechaFinal,
        dia_semana: fechaInfo.diaSemana,
        total: data.length,
        data,
      });
    } catch (error) {
      return res.status(500).json({ success: false, message: "Error al obtener bloques del docente.", error: error.message });
    } finally {
      connection.release();
    }
  },

  async obtenerAlumnosPorBloqueDocente(req, res) {
    const connection = await pool.getConnection();
    try {
      const { idHorario } = req.params;
      const fechaFinal = normalizeDate(req.query.fecha) || toLimaDateParts().fecha;
      const docenteId = await getDocenteIdFromUser(connection, req);

      if (!docenteId) {
        return res.status(403).json({ success: false, message: "Docente no encontrado para el usuario autenticado." });
      }

      const [horarioRows] = await connection.query(
        `SELECT
            h.id AS id_horario,
            h.dia_semana,
            h.hora_inicio,
            h.hora_fin,
            h.aula,
            a.id AS id_asignacion,
            a.id_grado,
            a.id_seccion,
            a.id_periodo,
            c.nombre AS curso,
            g.nombre AS grado
         FROM horarios h
         JOIN asignaciones a ON a.id = h.id_asignacion
         JOIN cursos c ON c.id = a.id_curso
         JOIN grados g ON g.id = a.id_grado
         WHERE h.id = ?
           AND h.activo = 1
           AND a.id_docente = ?`,
        [idHorario, docenteId]
      );

      if (!horarioRows.length) {
        return res.status(404).json({ success: false, message: "Bloque no encontrado o sin permisos." });
      }

      const horario = horarioRows[0];

      const [alumnos] = await connection.query(
        `SELECT
            a.id AS id_alumno,
            p.dni,
            CONCAT(p.nombres, ' ', p.apellido_paterno, ' ', p.apellido_materno) AS nombre_completo,
            ah.estado,
            ah.observacion
         FROM matriculas m
         JOIN alumnos a ON a.id = m.id_alumno
         JOIN personas p ON p.id = a.id_persona
         LEFT JOIN asistencia_horario ah
           ON ah.id_horario = ?
          AND ah.id_alumno = a.id
          AND ah.fecha = ?
         WHERE m.id_grado = ?
           AND m.id_periodo = ?
           AND (? IS NULL OR m.id_seccion = ?)
           AND m.estado IN ('Activa', 'Pendiente')
           AND a.estado != 'Retirado'
         ORDER BY p.apellido_paterno, p.apellido_materno, p.nombres`,
        [idHorario, fechaFinal, horario.id_grado, horario.id_periodo, horario.id_seccion, horario.id_seccion]
      );

      const alumnosDecrypted = alumnos.map(a => ({
        ...a,
        dni: decrypt(a.dni)
      }));

      const [existing] = await connection.query(
        `SELECT id FROM asistencia_horario WHERE id_horario = ? AND fecha = ? LIMIT 1`,
        [idHorario, fechaFinal]
      );

      const yaRegistrada = existing.length > 0;

      return res.status(200).json({
        success: true,
        fecha: fechaFinal,
        bloque: horario,
        total_alumnos: alumnosDecrypted.length,
        ya_registrada: yaRegistrada,
        data: alumnosDecrypted,
      });
    } catch (error) {
      return res.status(500).json({ success: false, message: "Error al obtener alumnos del bloque.", error: error.message });
    } finally {
      connection.release();
    }
  },

  async registrarAsistenciaBloqueMasiva(req, res) {
    const connection = await pool.getConnection();
    try {
      const { id_horario, fecha, asistencia, observacion } = req.body;

      if (!id_horario || !fecha || !Array.isArray(asistencia) || asistencia.length === 0) {
        return res.status(400).json({
          success: false,
          message: "Faltan datos obligatorios: id_horario, fecha, asistencia[]",
        });
      }

      const fechaFinal = normalizeDate(fecha);
      if (!fechaFinal) {
        return res.status(400).json({ success: false, message: "Fecha inválida." });
      }

      const [existing] = await connection.query(
        `SELECT id FROM asistencia_horario WHERE id_horario = ? AND fecha = ? LIMIT 1`,
        [id_horario, fechaFinal]
      );

      if (existing.length > 0) {
        return res.status(409).json({
          success: false,
          message: "La asistencia para este bloque y fecha ya ha sido registrada previamente.",
        });
      }

      const docenteId = await getDocenteIdFromUser(connection, req);
      if (!docenteId) {
        return res.status(403).json({ success: false, message: "Docente no encontrado para el usuario autenticado." });
      }

      const [horarioRows] = await connection.query(
        `SELECT
            h.id,
            h.dia_semana,
            h.hora_inicio,
            h.hora_fin,
            a.id AS id_asignacion,
            a.id_docente,
            a.id_grado,
            a.id_seccion,
            a.id_periodo,
            c.nombre AS nombre_curso,
            CONCAT(p.nombres, ' ', p.apellido_paterno) AS nombre_docente
         FROM horarios h
         JOIN asignaciones a ON a.id = h.id_asignacion
         JOIN cursos c ON c.id = a.id_curso
         JOIN docentes d ON d.id = a.id_docente
         JOIN personas p ON p.id = d.id_persona
         WHERE h.id = ? AND h.activo = 1`,
        [id_horario]
      );

      if (!horarioRows.length) {
        return res.status(404).json({ success: false, message: "Bloque horario no encontrado." });
      }
      const horario = horarioRows[0];

      if (horario.id_docente !== docenteId) {
        return res.status(403).json({ success: false, message: "No tiene permisos para este bloque." });
      }

      const fechaObj = toLimaDateParts(`${fechaFinal}T00:00:00-05:00`);
      if (fechaObj.diaSemana !== horario.dia_semana) {
        return res.status(400).json({
          success: false,
          message: `La fecha ${fechaFinal} no corresponde al día ${horario.dia_semana} del bloque.`,
        });
      }

      const now = toLimaDateParts();
      const inicio = String(horario.hora_inicio).slice(0, 5);
      const fin = String(horario.hora_fin).slice(0, 5);
      if (fechaFinal !== now.fecha || now.horaHHMM < inicio || now.horaHHMM > fin) {
        return res.status(403).json({
          success: false,
          message: `Solo puede registrar dentro del horario del bloque (${inicio} - ${fin}) en la fecha actual.`,
        });
      }

      for (const item of asistencia) {
        if (!item.id_alumno || !ESTADOS_VALIDOS.has(item.estado)) {
          return res.status(400).json({
            success: false,
            message: "Cada registro debe incluir id_alumno y estado válido.",
          });
        }
      }

      const [alumnosValidosRows] = await connection.query(
        `SELECT a.id AS id_alumno
         FROM matriculas m
         JOIN alumnos a ON a.id = m.id_alumno
         WHERE m.id_grado = ?
           AND m.id_periodo = ?
           AND (? IS NULL OR m.id_seccion = ?)
           AND m.estado IN ('Activa', 'Pendiente')`,
        [horario.id_grado, horario.id_periodo, horario.id_seccion, horario.id_seccion]
      );

      const validos = new Set(alumnosValidosRows.map((r) => Number(r.id_alumno)));
      const invalidos = asistencia.filter((item) => !validos.has(Number(item.id_alumno)));
      if (invalidos.length) {
        return res.status(400).json({
          success: false,
          message: "Uno o más alumnos no pertenecen al bloque seleccionado.",
        });
      }

      await connection.beginTransaction();

      const values = asistencia.map((item) => [
        id_horario,
        item.id_alumno,
        fechaFinal,
        item.estado,
        item.observacion || null,
        req.user.id,
      ]);

      await connection.query(
        `INSERT INTO asistencia_horario (id_horario, id_alumno, fecha, estado, observacion, registrado_por)
         VALUES ?
         ON DUPLICATE KEY UPDATE
           estado = VALUES(estado),
           observacion = VALUES(observacion),
           registrado_por = VALUES(registrado_por)`,
        [values]
      );

      const alumnosIds = [...new Set(asistencia.map((a) => Number(a.id_alumno)))];
      const [aggRows] = await connection.query(
        `SELECT
            ah.id_alumno,
            COUNT(*) AS total,
            SUM(CASE WHEN ah.estado = 'Ausente' THEN 1 ELSE 0 END) AS total_ausente
         FROM asistencia_horario ah
         JOIN horarios h ON h.id = ah.id_horario
         WHERE h.id_asignacion = ?
           AND ah.fecha = ?
           AND ah.id_alumno IN (?)
         GROUP BY ah.id_alumno`,
        [horario.id_asignacion, fechaFinal, alumnosIds]
      );

      for (const row of aggRows) {
        const total = Number(row.total || 0);
        const ausentes = Number(row.total_ausente || 0);
        const asistioDiario = total > 0 && ausentes < total ? 1 : 0;

        await connection.query(
          `INSERT INTO asistencia (id_alumno, id_asignacion, fecha, asistio, observacion)
           VALUES (?, ?, ?, ?, ?)
           ON DUPLICATE KEY UPDATE
             asistio = VALUES(asistio),
             observacion = VALUES(observacion)`,
          [row.id_alumno, horario.id_asignacion, fechaFinal, asistioDiario, asistencia.find(a => a.id_alumno == row.id_alumno)?.observacion || null]
        );
      }

      await connection.query(
        `UPDATE asistencia_horario ah
         JOIN horarios h ON h.id = ah.id_horario
         JOIN asistencia ast
           ON ast.id_alumno = ah.id_alumno
          AND ast.id_asignacion = h.id_asignacion
          AND ast.fecha = ah.fecha
         SET ah.id_asistencia = ast.id
         WHERE ah.id_horario = ?
           AND ah.fecha = ?`,
        [id_horario, fechaFinal]
      );

      await connection.commit();

      // Enviar notificaciones de falta (Ausente) en segundo plano
      asistencia.filter(a => a.estado === 'Ausente').forEach(item => {
        notifyAbsenceToParents(
          pool,
          item.id_alumno,
          horario.nombre_curso,
          fechaFinal,
          horario.nombre_docente
        ).catch(e => console.error('Error notifying from masiva:', e.message));
      });

      return res.status(201).json({
        success: true,
        message: "Asistencia por bloque registrada correctamente.",
        resumen: buildResumenEstados(asistencia),
        total_registros: asistencia.length,
      });
    } catch (error) {
      if (connection) await connection.rollback();
      return res.status(500).json({ success: false, message: "Error al registrar asistencia por bloque.", error: error.message });
    } finally {
      connection.release();
    }
  },

  async reporteBloqueDocente(req, res) {
    const connection = await pool.getConnection();
    try {
      const { id_horario, fecha } = req.query;
      const fechaFinal = normalizeDate(fecha) || toLimaDateParts().fecha;
      const docenteId = await getDocenteIdFromUser(connection, req);

      if (!id_horario) {
        return res.status(400).json({ success: false, message: "id_horario es requerido." });
      }

      const [metaRows] = await connection.query(
        `SELECT
            h.id AS id_horario, h.dia_semana, h.hora_inicio, h.hora_fin, h.aula,
            c.nombre AS curso, g.nombre AS grado, COALESCE(s.nombre, 'Sin sección') AS seccion
         FROM horarios h
         JOIN asignaciones a ON a.id = h.id_asignacion
         JOIN cursos c ON c.id = a.id_curso
         JOIN grados g ON g.id = a.id_grado
         LEFT JOIN secciones s ON s.id = a.id_seccion
         WHERE h.id = ? AND a.id_docente = ?`,
        [id_horario, docenteId]
      );
      if (!metaRows.length) {
        return res.status(404).json({ success: false, message: "Bloque no encontrado o sin permisos." });
      }

      const [detalle] = await connection.query(
        `SELECT
            ah.id_alumno,
            p.dni,
            CONCAT(p.nombres, ' ', p.apellido_paterno, ' ', p.apellido_materno) AS alumno,
            ah.estado,
            ah.observacion
         FROM asistencia_horario ah
         JOIN alumnos a ON a.id = ah.id_alumno
         JOIN personas p ON p.id = a.id_persona
         WHERE ah.id_horario = ?
           AND ah.fecha = ?
         ORDER BY p.apellido_paterno, p.apellido_materno, p.nombres`,
        [id_horario, fechaFinal]
      );

      const resumen = buildResumenEstados(detalle.map((d) => ({ estado: d.estado })));
      return res.status(200).json({
        success: true,
        fecha: fechaFinal,
        bloque: metaRows[0],
        resumen,
        total: detalle.length,
        data: detalle,
      });
    } catch (error) {
      return res.status(500).json({ success: false, message: "Error en reporte por bloque.", error: error.message });
    } finally {
      connection.release();
    }
  },

  async reporteDiarioDocente(req, res) {
    const connection = await pool.getConnection();
    try {
      const docenteId = await getDocenteIdFromUser(connection, req);
      const fechaFinal = normalizeDate(req.query.fecha) || toLimaDateParts().fecha;
      const { id_curso, id_grado } = req.query;
      const fechaInfo = toLimaDateParts(`${fechaFinal}T00:00:00-05:00`);

      const where = ["a.id_docente = ?", "h.dia_semana = ?"];
      const params = [fechaFinal, docenteId, fechaInfo.diaSemana];
      if (id_curso) {
        where.push("a.id_curso = ?");
        params.push(id_curso);
      }
      if (id_grado) {
        where.push("a.id_grado = ?");
        params.push(id_grado);
      }

      const [rows] = await connection.query(
        `SELECT
            h.id AS id_horario,
            c.nombre AS curso,
            g.nombre AS grado,
            COALESCE(s.nombre, 'Sin sección') AS seccion,
            h.dia_semana,
            h.hora_inicio,
            h.hora_fin,
            h.aula,
            COUNT(ah.id) AS total_registros,
            SUM(CASE WHEN ah.estado='Presente' THEN 1 ELSE 0 END) AS presentes,
            SUM(CASE WHEN ah.estado='Ausente' THEN 1 ELSE 0 END) AS ausentes,
            SUM(CASE WHEN ah.estado='Tardanza' THEN 1 ELSE 0 END) AS tardanzas,
            SUM(CASE WHEN ah.estado='Justificado' THEN 1 ELSE 0 END) AS justificados
         FROM horarios h
         JOIN asignaciones a ON a.id = h.id_asignacion
         JOIN cursos c ON c.id = a.id_curso
         JOIN grados g ON g.id = a.id_grado
         LEFT JOIN secciones s ON s.id = a.id_seccion
         LEFT JOIN asistencia_horario ah ON ah.id_horario = h.id AND ah.fecha = ?
         WHERE ${where.join(" AND ")}
         GROUP BY h.id, c.nombre, g.nombre, s.nombre, h.dia_semana, h.hora_inicio, h.hora_fin, h.aula
         ORDER BY h.hora_inicio`,
        params
      );

      return res.status(200).json({
        success: true,
        fecha: fechaFinal,
        dia_semana: fechaInfo.diaSemana,
        total: rows.length,
        data: rows,
      });
    } catch (error) {
      return res.status(500).json({ success: false, message: "Error en reporte diario.", error: error.message });
    } finally {
      connection.release();
    }
  },

  async reporteAlumnoDocente(req, res) {
    const connection = await pool.getConnection();
    try {
      const docenteId = await getDocenteIdFromUser(connection, req);
      const { id_alumno, fecha_inicio, fecha_fin } = req.query;

      if (!id_alumno || !fecha_inicio || !fecha_fin) {
        return res.status(400).json({ success: false, message: "Parámetros requeridos: id_alumno, fecha_inicio, fecha_fin." });
      }

      const [rows] = await connection.query(
        `SELECT
            ah.fecha,
            c.nombre AS curso,
            g.nombre AS grado,
            COALESCE(s.nombre, 'Sin sección') AS seccion,
            h.dia_semana,
            h.hora_inicio,
            h.hora_fin,
            ah.estado,
            ah.observacion
         FROM asistencia_horario ah
         JOIN horarios h ON h.id = ah.id_horario
         JOIN asignaciones a ON a.id = h.id_asignacion
         JOIN cursos c ON c.id = a.id_curso
         JOIN grados g ON g.id = a.id_grado
         LEFT JOIN secciones s ON s.id = a.id_seccion
         WHERE a.id_docente = ?
           AND ah.id_alumno = ?
           AND ah.fecha BETWEEN ? AND ?
         ORDER BY ah.fecha, FIELD(h.dia_semana, 'Lunes','Martes','Miercoles','Jueves','Viernes','Sabado','Domingo'), h.hora_inicio`,
        [docenteId, id_alumno, fecha_inicio, fecha_fin]
      );

      const total = rows.length;
      const asistidos = rows.filter((r) => r.estado !== "Ausente").length;
      const porcentaje = total > 0 ? Number(((asistidos / total) * 100).toFixed(2)) : 0;

      return res.status(200).json({
        success: true,
        total_bloques: total,
        asistidos,
        porcentaje_asistencia: porcentaje,
        data: rows,
      });
    } catch (error) {
      return res.status(500).json({ success: false, message: "Error en reporte por alumno.", error: error.message });
    } finally {
      connection.release();
    }
  },

  async exportarReporteDiarioExcel(req, res) {
    const connection = await pool.getConnection();
    try {
      const docenteId = await getDocenteIdFromUser(connection, req);
      const fechaFinal = normalizeDate(req.query.fecha) || toLimaDateParts().fecha;
      const fechaInfo = toLimaDateParts(`${fechaFinal}T00:00:00-05:00`);

      const [rows] = await connection.query(
        `SELECT
            c.nombre AS curso,
            g.nombre AS grado,
            COALESCE(s.nombre, 'Sin sección') AS seccion,
            h.hora_inicio,
            h.hora_fin,
            h.aula,
            COUNT(ah.id) AS total_registros,
            SUM(CASE WHEN ah.estado='Presente' THEN 1 ELSE 0 END) AS presentes,
            SUM(CASE WHEN ah.estado='Ausente' THEN 1 ELSE 0 END) AS ausentes,
            SUM(CASE WHEN ah.estado='Tardanza' THEN 1 ELSE 0 END) AS tardanzas,
            SUM(CASE WHEN ah.estado='Justificado' THEN 1 ELSE 0 END) AS justificados
         FROM horarios h
         JOIN asignaciones a ON a.id = h.id_asignacion
         JOIN cursos c ON c.id = a.id_curso
         JOIN grados g ON g.id = a.id_grado
         LEFT JOIN secciones s ON s.id = a.id_seccion
         LEFT JOIN asistencia_horario ah ON ah.id_horario = h.id AND ah.fecha = ?
         WHERE a.id_docente = ?
           AND h.dia_semana = ?
         GROUP BY c.nombre, g.nombre, s.nombre, h.hora_inicio, h.hora_fin, h.aula
         ORDER BY h.hora_inicio`,
        [fechaFinal, docenteId, fechaInfo.diaSemana]
      );

      const wb = new ExcelJS.Workbook();
      const ws = wb.addWorksheet("Reporte Diario");
      ws.addRow(["Fecha", fechaFinal]);
      ws.addRow(["Día", fechaInfo.diaSemana]);
      ws.addRow([]);
      ws.addRow(["Curso", "Grado", "Sección", "Hora Inicio", "Hora Fin", "Aula", "Registros", "Presentes", "Ausentes", "Tardanzas", "Justificados"]);
      rows.forEach((r) =>
        ws.addRow([
          r.curso,
          r.grado,
          r.seccion,
          String(r.hora_inicio).slice(0, 5),
          String(r.hora_fin).slice(0, 5),
          r.aula || "-",
          Number(r.total_registros || 0),
          Number(r.presentes || 0),
          Number(r.ausentes || 0),
          Number(r.tardanzas || 0),
          Number(r.justificados || 0),
        ])
      );

      res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
      res.setHeader("Content-Disposition", `attachment; filename=reporte_bloques_${fechaFinal}.xlsx`);
      await wb.xlsx.write(res);
      res.end();
    } catch (error) {
      return res.status(500).json({ success: false, message: "Error al exportar Excel.", error: error.message });
    } finally {
      connection.release();
    }
  },

  async exportarReporteDiarioPDF(req, res) {
    const connection = await pool.getConnection();
    try {
      const docenteId = await getDocenteIdFromUser(connection, req);
      const fechaFinal = normalizeDate(req.query.fecha) || toLimaDateParts().fecha;
      const fechaInfo = toLimaDateParts(`${fechaFinal}T00:00:00-05:00`);

      const [rows] = await connection.query(
        `SELECT
            c.nombre AS curso,
            g.nombre AS grado,
            COALESCE(s.nombre, 'Sin sección') AS seccion,
            h.hora_inicio,
            h.hora_fin,
            SUM(CASE WHEN ah.estado='Presente' THEN 1 ELSE 0 END) AS presentes,
            SUM(CASE WHEN ah.estado='Ausente' THEN 1 ELSE 0 END) AS ausentes,
            SUM(CASE WHEN ah.estado='Tardanza' THEN 1 ELSE 0 END) AS tardanzas,
            SUM(CASE WHEN ah.estado='Justificado' THEN 1 ELSE 0 END) AS justificados
         FROM horarios h
         JOIN asignaciones a ON a.id = h.id_asignacion
         JOIN cursos c ON c.id = a.id_curso
         JOIN grados g ON g.id = a.id_grado
         LEFT JOIN secciones s ON s.id = a.id_seccion
         LEFT JOIN asistencia_horario ah ON ah.id_horario = h.id AND ah.fecha = ?
         WHERE a.id_docente = ?
           AND h.dia_semana = ?
         GROUP BY c.nombre, g.nombre, s.nombre, h.hora_inicio, h.hora_fin
         ORDER BY h.hora_inicio`,
        [fechaFinal, docenteId, fechaInfo.diaSemana]
      );

      res.setHeader("Content-Type", "application/pdf");
      res.setHeader("Content-Disposition", `attachment; filename=reporte_bloques_${fechaFinal}.pdf`);

      const doc = new PDFDocument({ margin: 32, size: "A4" });
      doc.pipe(res);
      doc.fontSize(14).text("Reporte Diario de Asistencia por Bloques", { align: "left" });
      doc.moveDown(0.4);
      doc.fontSize(10).text(`Fecha: ${fechaFinal} - Día: ${fechaInfo.diaSemana}`);
      doc.moveDown(0.8);

      rows.forEach((r, idx) => {
        const line = `${idx + 1}. ${r.curso} | ${r.grado} | ${r.seccion} | ${String(r.hora_inicio).slice(0, 5)}-${String(r.hora_fin).slice(0, 5)} | P:${r.presentes || 0} A:${r.ausentes || 0} T:${r.tardanzas || 0} J:${r.justificados || 0}`;
        doc.fontSize(9).text(line);
      });

      doc.end();
    } catch (error) {
      return res.status(500).json({ success: false, message: "Error al exportar PDF.", error: error.message });
    } finally {
      connection.release();
    }
  },

  async registrarAsistenciaConHorario(req, res) {
    const connection = await pool.getConnection();
    try {
      const { id_horario, id_alumno, fecha, estado, observacion } = req.body;

      if (!id_horario || !id_alumno || !fecha || !estado) {
        return res.status(400).json({
          success: false,
          message: "Faltan datos obligatorios: id_horario, id_alumno, fecha, estado",
        });
      }

      if (!ESTADOS_VALIDOS.has(estado)) {
        return res.status(400).json({
          success: false,
          message: "Estado inválido. Use: Presente, Ausente, Tardanza, Justificado",
        });
      }

      const fechaFinal = normalizeDate(fecha);
      if (!fechaFinal) {
        return res.status(400).json({ success: false, message: "Fecha inválida." });
      }

      const [horarioRows] = await connection.query(
        `SELECT h.id, h.dia_semana, h.hora_inicio, h.hora_fin, a.id AS id_asignacion, a.id_docente
         FROM horarios h
         JOIN asignaciones a ON a.id = h.id_asignacion
         WHERE h.id = ? AND h.activo = 1`,
        [id_horario]
      );

      if (horarioRows.length === 0) {
        return res.status(404).json({ success: false, message: "Horario no encontrado." });
      }

      const horario = horarioRows[0];

      const fechaJs = new Date(`${fechaFinal}T00:00:00-05:00`);
      if (Number.isNaN(fechaJs.getTime())) {
        return res.status(400).json({ success: false, message: "Fecha inválida para validación de día." });
      }

      if (DIA_TO_JS[horario.dia_semana] !== fechaJs.getDay()) {
        return res.status(400).json({
          success: false,
          message: `La fecha ${fechaFinal} no corresponde al día ${horario.dia_semana} del horario.`,
        });
      }

      if (req.user.id_rol === 2) {
        const [docRows] = await connection.query(
          "SELECT id FROM docentes WHERE id_persona = ? LIMIT 1",
          [req.user.id_persona]
        );

        if (docRows.length === 0) {
          return res.status(403).json({ success: false, message: "Docente no encontrado para el usuario autenticado." });
        }

        if (docRows[0].id !== horario.id_docente) {
          return res.status(403).json({ success: false, message: "No tiene permisos para este horario." });
        }

        const now = toLimaDateParts();
        const inicio = String(horario.hora_inicio).slice(0, 5);
        const fin = String(horario.hora_fin).slice(0, 5);
        if (fechaFinal !== now.fecha || now.horaHHMM < inicio || now.horaHHMM > fin) {
          return res.status(403).json({
            success: false,
            message: `Solo puede registrar dentro del horario del bloque (${inicio} - ${fin}) en la fecha actual.`,
          });
        }
      }

      if (req.user.id_rol !== 1 && req.user.id_rol !== 2) {
        return res.status(403).json({ success: false, message: "Solo director o docente puede registrar asistencia." });
      }

      await connection.beginTransaction();

      await connection.query(
        `INSERT INTO asistencia_horario (id_horario, id_alumno, fecha, estado, observacion, registrado_por)
         VALUES (?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE
           estado = VALUES(estado),
           observacion = VALUES(observacion),
           registrado_por = VALUES(registrado_por)`,
        [id_horario, id_alumno, fechaFinal, estado, observacion || null, req.user.id]
      );

      const [aggRows] = await connection.query(
        `SELECT
            COUNT(*) AS total,
            SUM(CASE WHEN ah.estado = 'Ausente' THEN 1 ELSE 0 END) AS total_ausente
          FROM asistencia_horario ah
          JOIN horarios h ON h.id = ah.id_horario
          WHERE ah.id_alumno = ?
            AND ah.fecha = ?
            AND h.id_asignacion = ?`,
        [id_alumno, fechaFinal, horario.id_asignacion]
      );

      const total = Number(aggRows[0].total || 0);
      const ausentes = Number(aggRows[0].total_ausente || 0);
      const asistioDiario = total > 0 && ausentes < total ? 1 : 0;

      await connection.query(
        `INSERT INTO asistencia (id_alumno, id_asignacion, fecha, asistio, observacion)
         VALUES (?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE
           asistio = VALUES(asistio),
           observacion = VALUES(observacion)`,
        [
          id_alumno,
          horario.id_asignacion,
          fechaFinal,
          asistioDiario,
          observacion || null,
        ]
      );

      const [asistenciaRows] = await connection.query(
        "SELECT id FROM asistencia WHERE id_alumno = ? AND id_asignacion = ? AND fecha = ? LIMIT 1",
        [id_alumno, horario.id_asignacion, fechaFinal]
      );

      const idAsistencia = asistenciaRows.length ? asistenciaRows[0].id : null;

      if (idAsistencia) {
        await connection.query(
          `UPDATE asistencia_horario ah
           JOIN horarios h ON h.id = ah.id_horario
           SET ah.id_asistencia = ?
           WHERE ah.id_alumno = ?
             AND ah.fecha = ?
             AND h.id_asignacion = ?`,
          [idAsistencia, id_alumno, fechaFinal, horario.id_asignacion]
        );
      }

      await connection.commit();

      return res.status(201).json({
        success: true,
        message: "Asistencia por bloque registrada correctamente.",
        data: {
          id_horario,
          id_alumno,
          fecha: fechaFinal,
          estado,
          id_asistencia: idAsistencia,
          asistio_diario: asistioDiario,
        },
      });
    } catch (error) {
      if (connection) await connection.rollback();
      return res.status(500).json({
        success: false,
        message: "Error al registrar asistencia por horario.",
        error: error.message,
      });
    } finally {
      connection.release();
    }
  },

  // Horario visual semanal del docente (L-V, todas las horas)
  async obtenerMiHorarioSemanal(req, res) {
    const connection = await pool.getConnection();
    try {
      const docenteId = await getDocenteIdFromUser(connection, req);
      if (!docenteId) {
        return res.status(403).json({ success: false, message: "Docente no encontrado para el usuario autenticado." });
      }

      // Obtener el periodo activo
      const [periodoRows] = await connection.query(
        "SELECT id, anio FROM periodos_academicos WHERE activo = 1 ORDER BY id DESC LIMIT 1"
      );
      if (!periodoRows.length) {
        return res.status(400).json({ success: false, message: "No se encontró periodo activo." });
      }
      const periodoId = periodoRows[0].id;

      const [rows] = await connection.query(
        `SELECT
            h.id AS id_horario,
            h.dia_semana,
            h.hora_inicio,
            h.hora_fin,
            h.aula,
            a.id AS id_asignacion,
            c.nombre AS curso,
            g.nombre AS grado,
            COALESCE(s.nombre, '') AS seccion
         FROM horarios h
         JOIN asignaciones a ON a.id = h.id_asignacion
         JOIN cursos c ON c.id = a.id_curso
         JOIN grados g ON g.id = a.id_grado
         LEFT JOIN secciones s ON s.id = a.id_seccion
         WHERE h.activo = 1
           AND a.id_docente = ?
           AND a.id_periodo = ?
         ORDER BY FIELD(h.dia_semana, 'Lunes','Martes','Miercoles','Jueves','Viernes','Sabado','Domingo'), h.hora_inicio`,
        [docenteId, periodoId]
      );

      return res.status(200).json({
        success: true,
        total: rows.length,
        data: rows,
      });
    } catch (error) {
      return res.status(500).json({ success: false, message: "Error al obtener horario semanal.", error: error.message });
    } finally {
      connection.release();
    }
  },

  // Horario visual semanal del alumno (para la app móvil — rol padre)
  async obtenerHorarioAlumno(req, res) {
    const connection = await pool.getConnection();
    try {
      const id_persona = req.user.id_persona;

      // Buscar el alumno vinculado (padre puede tener un alumno)
      // Primero buscamos si es padre (id_persona de un apoderado)
      const [apoderadoRows] = await connection.query(
        `SELECT ap.id FROM apoderados ap WHERE ap.id_persona = ?`,
        [id_persona]
      );

      let alumnoId = null;

      if (apoderadoRows.length > 0) {
        // Es padre, buscar el alumno vinculado
        const [alumnoApRows] = await connection.query(
          `SELECT id_alumno FROM alumno_apoderado WHERE id_apoderado = ? LIMIT 1`,
          [apoderadoRows[0].id]
        );
        if (alumnoApRows.length > 0) alumnoId = alumnoApRows[0].id_alumno;
      } else {
        // Podría ser el propio alumno
        const [alumnoRows] = await connection.query(
          `SELECT id FROM alumnos WHERE id_persona = ? LIMIT 1`,
          [id_persona]
        );
        if (alumnoRows.length > 0) alumnoId = alumnoRows[0].id;
      }

      if (!alumnoId) {
        return res.status(404).json({ success: false, message: "Alumno no encontrado para este usuario." });
      }

      // Buscar la matrícula activa del alumno
      const [matriculaRows] = await connection.query(
        `SELECT m.id, m.id_grado, m.id_periodo
         FROM matriculas m
         JOIN periodos_academicos pa ON m.id_periodo = pa.id
         WHERE m.id_alumno = ? AND pa.activo = 1
         ORDER BY m.id DESC LIMIT 1`,
        [alumnoId]
      );

      if (!matriculaRows.length) {
        return res.status(404).json({ success: false, message: "No se encontró matrícula activa para el alumno." });
      }

      const { id_grado, id_periodo } = matriculaRows[0];

      const [rows] = await connection.query(
        `SELECT
            h.id AS id_horario,
            h.dia_semana,
            h.hora_inicio,
            h.hora_fin,
            h.aula,
            a.id AS id_asignacion,
            c.nombre AS curso,
            g.nombre AS grado,
            COALESCE(s.nombre, '') AS seccion,
            d.id AS id_docente,
            CONCAT(p.nombres, ' ', p.apellido_paterno, ' ', p.apellido_materno) AS docente
         FROM horarios h
         JOIN asignaciones a ON a.id = h.id_asignacion
         JOIN cursos c ON c.id = a.id_curso
         JOIN grados g ON g.id = a.id_grado
         LEFT JOIN secciones s ON s.id = a.id_seccion
         LEFT JOIN docentes d ON d.id = a.id_docente
         LEFT JOIN personas p ON p.id = d.id_persona
         WHERE h.activo = 1
           AND a.id_grado = ?
           AND a.id_periodo = ?
         ORDER BY FIELD(h.dia_semana, 'Lunes','Martes','Miercoles','Jueves','Viernes','Sabado','Domingo'), h.hora_inicio`,
        [id_grado, id_periodo]
      );

      return res.status(200).json({
        success: true,
        total: rows.length,
        data: rows,
      });
    } catch (error) {
      return res.status(500).json({ success: false, message: "Error al obtener horario del alumno.", error: error.message });
    } finally {
      connection.release();
    }
  },
};

module.exports = horarioController;

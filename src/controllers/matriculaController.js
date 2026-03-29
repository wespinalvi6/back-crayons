const { withTransaction } = require("../config/database");
const Persona = require("../models/Persona");
const Alumno = require("../models/Alumno");
const Apoderado = require("../models/Apoderado");
const Grado = require("../models/Grado");
const Matricula = require("../models/Matricula");
const Cuota = require("../models/Cuota");
const AlumnoApoderado = require("../models/AlumnoApoderado");
const User = require("../models/User");
const bcrypt = require("bcryptjs");
const pool = require("../config/database");

class MatriculaController {
  static async registrarMatricula(req, res) {
    try {
      const {
        estudiante,
        padre,
        madre,
        economica,
        documentos
      } = req.body;

      if (!estudiante || !estudiante.dni || !estudiante.nombres || !estudiante.apellido_paterno || !estudiante.id_grado) {
        return res.status(400).json({ status: false, message: "Faltan campos obligatorios del estudiante." });
      }

      const resultado = await withTransaction(async (connection) => {
        // 1. Crear Persona y Alumno (Estudiante)
        const alumnoPersonaId = await Persona.crear(
          connection,
          estudiante.dni,
          estudiante.nombres,
          estudiante.apellido_paterno,
          estudiante.apellido_materno,
          estudiante.fecha_nacimiento,
          null,
          estudiante.telefono,
          estudiante.direccion,
          estudiante.sexo
        );

        const anioActual = new Date().getFullYear();
        const codigoAlumno = `${anioActual}${estudiante.dni}`;
        const alumnoId = await Alumno.crear(
          connection,
          alumnoPersonaId,
          codigoAlumno,
          estudiante.religion,
          estudiante.lengua_materna,
          estudiante.tipo_ingreso
        );

        // NO se crea usuario para el alumno.
        // Los usuarios se crean para los PADRES en la función procesarApoderado.

        // 2. Procesar Apoderados (Padre y Madre) y crear sus usuarios
        const usuariosCreados = [];
        const procesarApoderado = async (datos, relacion) => {
          if (!datos || !datos.dni) return;
          // Crear persona del apoderado (si ya existe, devuelve el ID)
          const personaId = await Persona.crear(
            connection,
            datos.dni,
            datos.nombres || "",
            datos.apellido_paterno || "",
            datos.apellido_materno || "",
            datos.fecha_nacimiento || null,
            datos.email || null,
            datos.telefono,
            null
          );
          const apoderadoId = await Apoderado.crear(connection, personaId, datos.ocupacion || null);
          await AlumnoApoderado.crear(connection, alumnoId, apoderadoId, relacion);

          // Crear usuario para el apoderado con id_rol=3
          const usernameApoderado = datos.dni;
          const saltApoderado = await bcrypt.genSalt(10);
          const hashedPasswordApoderado = await bcrypt.hash(datos.dni, saltApoderado);
          try {
            await User.crear(connection, {
              id_persona: personaId,
              email: datos.email || `${datos.dni}@colegio.edu.pe`,
              password: hashedPasswordApoderado,
              username: usernameApoderado,
              id_rol: 3
            });
            usuariosCreados.push({ relacion, username: usernameApoderado, password: datos.dni });
          } catch (error) {
            if (error.code !== 'ER_DUP_ENTRY') throw error;
            // Si ya existe el usuario, solo lo registramos como ya existente
            usuariosCreados.push({ relacion, username: usernameApoderado, password: datos.dni, ya_existia: true });
          }
        };

        if (padre) await procesarApoderado(padre, 'Padre');
        if (madre) await procesarApoderado(madre, 'Madre');

        // 3. Crear Matrícula
        let periodoId = estudiante.id_periodo;
        let numeroCuotas = 10;
        let periodoAnio = anioActual;

        // Obtener o validar periodo
        let queryPeriodo = "SELECT * FROM periodos_academicos ";
        let paramsPeriodo = [];
        if (periodoId) {
          queryPeriodo += "WHERE id = ?";
          paramsPeriodo = [periodoId];
        } else {
          queryPeriodo += "WHERE activo = 1 LIMIT 1";
        }

        const [periodos] = await connection.query(queryPeriodo, paramsPeriodo);
        if (periodos.length > 0) {
          periodoId = periodos[0].id;
          numeroCuotas = periodos[0].numero_cuotas || 10;
          periodoAnio = periodos[0].anio;
        } else {
          throw new Error("No hay un periodo académico activo");
        }

        const [matriculaResult] = await connection.execute(
          "INSERT INTO matriculas (id_alumno, id_periodo, id_grado, id_seccion, fecha_matricula, dni_entregado, certificado_estudios, partida_nacimiento) VALUES (?, ?, ?, ?, CURDATE(), ?, ?, ?)",
          [alumnoId, periodoId, estudiante.id_grado, estudiante.id_seccion || null, documentos?.dni_entregado ? 1 : 0, documentos?.certificado_estudios ? 1 : 0, documentos?.partida_nacimiento ? 1 : 0]
        );
        const matriculaId = matriculaResult.insertId;

        // 4. Generar Cuotas
        if (economica) {
          // Cuota de Matrícula
          if (economica.precio_matricula > 0) {
            await Cuota.crear(connection, {
              id_matricula: matriculaId,
              tipo: 'Matricula',
              numero_cuota: 0,
              monto: economica.precio_matricula,
              fecha_vencimiento: new Date().toISOString().split('T')[0]
            });
          }

          // Cuotas Mensuales (Pensiones)
          const montoMensual = economica.costo_cuota_mensual || 0;
          if (montoMensual > 0) {
            // Generar cuotas de Marzo a Diciembre (o según numeroCuotas)
            // Asumimos inicio en Marzo (mes 2)
            let mesInicio = 2;

            for (let i = 1; i <= numeroCuotas; i++) {
              let year = periodoAnio;
              let month = mesInicio + (i - 1);
              if (month > 11) {
                year++;
                month -= 12;
              }
              // Último día del mes
              const fechaStr = new Date(year, month + 1, 0).toISOString().split('T')[0];

              await Cuota.crear(connection, {
                id_matricula: matriculaId,
                tipo: 'Mensualidad',
                numero_cuota: i,
                monto: montoMensual,
                fecha_vencimiento: fechaStr
              });
            }
          }
        }

        return { alumno_id: alumnoId, matricula_id: matriculaId, usuarios_padres: usuariosCreados };
      });

      return res.status(201).json({ status: true, message: "Matrícula registrada correctamente.", data: resultado });
    } catch (error) {
      return res.status(500).json({ status: false, message: "Error al registrar la matrícula", error: error.message });
    }
  }

  static async insertarDatosExtraidos(req, res) {
    try {
      const { datos } = req.body;
      if (!datos) return res.status(400).json({ status: false, message: 'No se proporcionaron datos' });

      const convertirFecha = (fechaStr) => {
        if (!fechaStr || fechaStr === '') return null;
        if (fechaStr.match(/^\d{4}-\d{2}-\d{2}$/)) return fechaStr;
        const partes = fechaStr.split('/');
        if (partes.length === 3) return `${partes[2]}-${partes[1].padStart(2, '0')}-${partes[0].padStart(2, '0')}`;
        return null;
      };

      const resultado = await withTransaction(async (connection) => {
        const idPersonaEstudiante = await Persona.crear(
          connection, datos.dni, datos.nombres, datos.apellidoPaterno, datos.apellidoMaterno,
          convertirFecha(datos.fechaNacimiento), datos.email, datos.telefono, datos.direccion
        );

        const codigoAlumno = datos.codigoEstudiante || `${new Date().getFullYear()}${datos.dni}`;
        const idAlumno = await Alumno.crear(connection, idPersonaEstudiante, codigoAlumno, datos.religion);

        // Padre y Madre son opcionales
        if (datos.nombresPadre) {
          const idPersonaPadre = await Persona.crear(connection, `P${datos.dni.substring(1)}`, datos.nombresPadre, datos.apellidoPaternoPadre, datos.apellidoMaternoPadre, convertirFecha(datos.fechaNacimientoPadre), null, datos.telefonoPadre, null);
          const idApoderadoPadre = await Apoderado.crear(connection, idPersonaPadre, datos.ocupacionPadre);
          await AlumnoApoderado.crear(connection, idAlumno, idApoderadoPadre, 'Padre');
        }

        if (datos.nombresMadre) {
          const idPersonaMadre = await Persona.crear(connection, `M${datos.dni.substring(1)}`, datos.nombresMadre, datos.apellidoPaternoMadre, datos.apellidoMaternoMadre, convertirFecha(datos.fechaNacimientoMadre), null, datos.telefonoMadre, null);
          const idApoderadoMadre = await Apoderado.crear(connection, idPersonaMadre, datos.ocupacionMadre);
          await AlumnoApoderado.crear(connection, idAlumno, idApoderadoMadre, 'Madre');
        }

        return { alumno_id: idAlumno };
      });

      return res.status(201).json({ status: true, message: "Datos extraídos insertados.", data: resultado });
    } catch (error) {
      return res.status(500).json({ status: false, message: "Error al insertar datos extraídos", error: error.message });
    }
  }
}

module.exports = MatriculaController;

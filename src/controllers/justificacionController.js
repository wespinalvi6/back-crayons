const cloudinary = require('cloudinary').v2;
const Justificacion = require('../models/Justificacion');
const { pool } = require('../config/database');
const { decrypt } = require('../utils/cryptoUtils');

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET
});

// Subir PDF a Cloudinary
const subirArchivo = async (file) => {
  try {
    const base64String = file.buffer.toString('base64');
    const dataURI = `data:${file.mimetype};base64,${base64String}`;

    const result = await cloudinary.uploader.upload(dataURI, {
      resource_type: 'auto',
      folder: 'justificaciones',
      public_id: `justificacion_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      access_mode: 'public',
      delivery_type: 'upload'
    });

    return {
      url: result.secure_url,
      public_id: result.public_id
    };
  } catch (error) {
    throw new Error('Error al subir el archivo');
  }
};

// Crear nueva justificación
const crearJustificacion = async (req, res) => {
  let connection;
  try {
    const { titulo, descripcion, tipo, id_asistencia } = req.body;
    let { fecha_inicio, fecha_fin } = req.body;
    const id_persona = req.user.id_persona;

    if (!req.file) {
      return res.status(400).json({ success: false, message: 'Debe subir un comprobante (PDF o Imagen)' });
    }

    // Vuln #11: Validación estricta de Magic Numbers para el contenido del archivo subido
    const magic = req.file.buffer.toString('hex', 0, 4);
    const allowedMagics = [
      '25504446', // PDF
      'ffd8ffe0', 'ffd8ffe1', 'ffd8ffee', 'ffd8ffdb', 'ffd8ffe2', // JPEG
      '89504e47'  // PNG
    ];
    if (!allowedMagics.includes(magic)) {
      return res.status(400).json({ success: false, message: 'El archivo subido no es un PDF o una imagen válidos.' });
    }

    connection = await pool.getConnection();

    // 1. Obtener datos del alumno y su matrícula activa (Soportar tanto alumnos como padres)
    let id_alumno, id_matricula;

    if (id_asistencia) {
      // Si tenemos la asistencia, sabemos exactamente quién es el alumno
      const [rows] = await connection.query(
        `SELECT ast.id_alumno, m.id as id_matricula 
         FROM asistencia ast
         JOIN matriculas m ON ast.id_alumno = m.id_alumno
         WHERE ast.id = ? 
         ORDER BY m.created_at DESC LIMIT 1`,
        [id_asistencia]
      );
      if (rows.length > 0) {
        id_alumno = rows[0].id_alumno;
        id_matricula = rows[0].id_matricula;

        // VERIFICAR ACCESO: El usuario debe ser el propio alumno o uno de sus apoderados
        const [acceso] = await connection.query(
          `SELECT 1 FROM alumnos a WHERE a.id = ? AND a.id_persona = ?
           UNION
           SELECT 1 
           FROM apoderados ap
           JOIN alumno_apoderado aa ON ap.id = aa.id_apoderado
           WHERE aa.id_alumno = ? AND ap.id_persona = ?`,
          [id_alumno, id_persona, id_alumno, id_persona]
        );

        if (acceso.length === 0) {
          return res.status(403).json({ success: false, message: 'No tiene permiso para justificar esta falta.' });
        }
      }
    }

    // Si aún no tenemos los IDs (vía asistencia o si falló la búsqueda por asistencia), buscar por id_persona del usuario
    if (!id_alumno) {
      const [matriculaRow] = await connection.query(
        `SELECT m.id as id_matricula, a.id as id_alumno 
         FROM alumnos a 
         JOIN matriculas m ON a.id = m.id_alumno 
         WHERE a.id_persona = ? 
         ORDER BY m.created_at DESC LIMIT 1`,
        [id_persona]
      );

      if (matriculaRow && matriculaRow.length > 0) {
        id_alumno = matriculaRow[0].id_alumno;
        id_matricula = matriculaRow[0].id_matricula;
      } else {
        // Intentar como apoderado
        const [apoderadoRow] = await connection.query(
          `SELECT m.id as id_matricula, a.id as id_alumno 
           FROM apoderados ap
           JOIN alumno_apoderado aa ON ap.id = aa.id_apoderado
           JOIN alumnos a ON aa.id_alumno = a.id
           JOIN matriculas m ON a.id = m.id_alumno
           WHERE ap.id_persona = ? 
           ORDER BY m.created_at DESC LIMIT 1`,
          [id_persona]
        );
        if (apoderadoRow && apoderadoRow.length > 0) {
          id_alumno = apoderadoRow[0].id_alumno;
          id_matricula = apoderadoRow[0].id_matricula;
        }
      }
    }

    if (!id_alumno) {
      return res.status(404).json({ success: false, message: 'No se encontró matrícula activa o alumno asociado.' });
    }
    let id_docente = null;

    // 2. Si se proporciona una asistencia específica, obtener el docente y la fecha
    if (id_asistencia) {
      // Verificar que no exista una justificación pendiente o aprobada para esta falta
      const [existeJustificacion] = await connection.query(
        `SELECT id, estado FROM justificaciones 
         WHERE id_asistencia = ? AND estado IN ('Pendiente', 'Aprobada')`,
        [id_asistencia]
      );

      if (existeJustificacion && existeJustificacion.length > 0) {
        return res.status(400).json({
          success: false,
          message: `Esta falta ya tiene una justificación ${existeJustificacion[0].estado.toLowerCase()}. No puede enviar otra.`
        });
      }

      const [asistenciaRow] = await connection.query(
        `SELECT ast.fecha, asig.id_docente 
         FROM asistencia ast
         JOIN asignaciones asig ON ast.id_asignacion = asig.id
         WHERE ast.id = ? AND ast.id_alumno = ?`,
        [id_asistencia, id_alumno]
      );

      if (asistenciaRow && asistenciaRow.length > 0) {
        id_docente = asistenciaRow[0].id_docente;
        // Forzar fechas de la asistencia
        fecha_inicio = asistenciaRow[0].fecha;
        fecha_fin = asistenciaRow[0].fecha;
      } else {
        return res.status(400).json({
          success: false,
          message: 'La falta seleccionada no es válida o no le pertenece.'
        });
      }
    }

    if (!fecha_inicio || !fecha_fin) {
      return res.status(400).json({
        success: false,
        message: 'Debe especificar el rango de fechas o seleccionar una falta registrada.'
      });
    }

    const { url, public_id } = await subirArchivo(req.file);

    // Mapear el tipo a los valores permitidos en el ENUM de la DB
    const tiposPermitidos = {
      'Salud': 'Medica',
      'Medica': 'Medica',
      'Personal': 'Personal',
      'Familiar': 'Familiar',
      'Academica': 'Academica',
      'Otro': 'Otro'
    };

    const tipoFinal = tiposPermitidos[tipo] || 'Otro';

    const justificacionData = {
      id_matricula,
      id_asistencia: id_asistencia || null,
      id_docente,
      titulo,
      descripcion: descripcion || '',
      tipo: tipoFinal,
      fecha_inicio: fecha_inicio,
      fecha_fin: fecha_fin,
      url_documento: url,
      cloudinary_public_id: public_id
    };

    const justificacionId = await Justificacion.crear(justificacionData);

    res.status(201).json({
      success: true,
      message: 'Justificación enviada correctamente. El docente la revisará pronto.',
      data: {
        id: justificacionId,
        estado: 'Pendiente',
        fecha: fecha_inicio
      }
    });

  } catch (error) {
    console.error('Error al crear justificación:', error);
    res.status(500).json({
      success: false,
      message: 'Error al procesar la justificación',
      error: error.message
    });
  } finally {
    if (connection) connection.release();
  }
};

// Obtener justificaciones del alumno
const obtenerJustificacionesAlumno = async (req, res) => {
  let connection;
  try {
    const id_persona = req.user.id_persona;
    const page = parseInt(req.query.page) || 1;
    const limit = 5;
    const offset = (page - 1) * limit;

    connection = await pool.getConnection();

    const [alumnoRow] = await connection.query(
      'SELECT id FROM alumnos WHERE id_persona = ?',
      [id_persona]
    );

    if (!alumnoRow || alumnoRow.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'No se encontró el alumno'
      });
    }

    const id_alumno = alumnoRow[0].id;
    const { rows, total } = await Justificacion.obtenerPorAlumnoPaginado(id_alumno, limit, offset);

    res.json({
      success: true,
      data: rows,
      page,
      total,
      totalPages: Math.ceil(total / limit)
    });

  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Error al obtener las justificaciones',
      error: error.message
    });
  } finally {
    if (connection) connection.release();
  }
};

// Obtener justificaciones por docente
const obtenerJustificacionesDocente = async (req, res) => {
  let connection;
  try {
    const id_persona = req.user.id_persona;
    const page = parseInt(req.query.page) || 1;
    const limit = 50; // Aumentar límite para vista de docentes
    const offset = (page - 1) * limit;

    connection = await pool.getConnection();

    const [docenteRow] = await connection.query(
      'SELECT id FROM docentes WHERE id_persona = ?',
      [id_persona]
    );

    if (!docenteRow || docenteRow.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'No se encontró el docente'
      });
    }

    const id_docente = docenteRow[0].id;
    const { anio, mes, dia, estado } = req.query;

    let estadoFinal = estado;
    let filtrarPorFecha = true;

    if (!estado && req.path.includes('/historial')) {
      estadoFinal = null;
    } else if (!estado) {
      estadoFinal = 'Pendiente';
      // Para pendientes, si no se especifica fecha, mostrar todas
      if (!anio && !mes && !dia) filtrarPorFecha = false;
    } else if (estado === 'todas' || estado === 'todos') {
      estadoFinal = null;
    }

    const { rows, total } = await Justificacion.obtenerPorDocentePaginado(
      id_docente,
      limit,
      offset,
      {
        anio: filtrarPorFecha ? anio : null,
        mes: filtrarPorFecha ? mes : null,
        dia: filtrarPorFecha ? dia : null,
        estado: estadoFinal
      }
    );

    // Descifrar nombres del alumno
    const decryptedRows = rows.map(r => ({
      ...r,
      nombre_alumno: `${decrypt(r.alumno_nombres || '')} ${decrypt(r.alumno_ap_p || '')} ${decrypt(r.alumno_ap_m || '')}`.trim(),
      alumno_nombres: undefined, alumno_ap_p: undefined, alumno_ap_m: undefined
    }));

    // Agrupar por fecha o estado según sea el caso
    // Si buscamos pendientes globales, agrupamos por "Pendientes"
    const dataResponse = decryptedRows;

    res.json({
      success: true,
      data: dataResponse,
      page,
      total,
      totalPages: Math.ceil(total / limit)
    });

  } catch (error) {
    console.error('Error al obtener justificaciones docente:', error);
    res.status(500).json({
      success: false,
      message: 'Error al obtener las justificaciones',
      error: error.message
    });
  } finally {
    if (connection) connection.release();
  }
};

// Obtener todas las justificaciones (admin)
const obtenerTodasJustificaciones = async (req, res) => {
  try {
    const justificaciones = await Justificacion.obtenerTodas();

    res.json({
      success: true,
      data: justificaciones
    });

  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Error al obtener las justificaciones',
      error: error.message
    });
  }
};

// Obtener justificación por ID
const obtenerJustificacionPorId = async (req, res) => {
  try {
    const { id } = req.params;
    const justificacion = await Justificacion.obtenerPorId(id);

    if (!justificacion) {
      return res.status(404).json({
        success: false,
        message: 'Justificación no encontrada'
      });
    }

    res.json({
      success: true,
      data: justificacion
    });

  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Error al obtener la justificación',
      error: error.message
    });
  }
};

// Actualizar estado de justificación
const actualizarEstadoJustificacion = async (req, res) => {
  let connection;
  try {
    const { id } = req.params;
    const { estado, comentario_revision } = req.body;
    const id_persona = req.user.id_persona;

    const estadosMapeo = {
      'pendiente': 'Pendiente',
      'aprobada': 'Aprobada',
      'rechazada': 'Rechazada',
      'Pendiente': 'Pendiente',
      'Aprobada': 'Aprobada',
      'Rechazada': 'Rechazada'
    };

    const estadoFinal = estadosMapeo[estado];
    if (!estadoFinal) {
      return res.status(400).json({
        success: false,
        message: 'Estado no válido. Use: pendiente, aprobada o rechazada'
      });
    }

    connection = await pool.getConnection();

    let id_docente = null;
    const [docenteRow] = await connection.query(
      'SELECT id FROM docentes WHERE id_persona = ?',
      [id_persona]
    );

    if (docenteRow && docenteRow.length > 0) {
      id_docente = docenteRow[0].id;
    }

    const actualizado = await Justificacion.actualizarEstado(
      id,
      estadoFinal,
      comentario_revision,
      id_docente
    );

    if (!actualizado) {
      return res.status(404).json({
        success: false,
        message: 'Justificación no encontrada'
      });
    }

    // Notificar al alumno/padre en segundo plano
    const { notifyJustificationUpdate } = require('../utils/notificationHelper');
    notifyJustificationUpdate(pool, id, estadoFinal, comentario_revision).catch(err => {
      console.error('Error enviando notificación de justificación:', err);
    });

    res.json({
      success: true,
      message: 'Estado de justificación actualizado exitosamente'
    });

  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Error al actualizar el estado',
      error: error.message
    });
  } finally {
    if (connection) connection.release();
  }
};

// Eliminar justificación
const eliminarJustificacion = async (req, res) => {
  try {
    const { id } = req.params;

    const justificacion = await Justificacion.obtenerPorId(id);

    if (!justificacion) {
      return res.status(404).json({
        success: false,
        message: 'Justificación no encontrada'
      });
    }

    try {
      await cloudinary.uploader.destroy(justificacion.public_id_cloudinary, {
        resource_type: 'raw'
      });
    } catch (cloudinaryError) {
    }

    const eliminado = await Justificacion.eliminar(id);

    if (!eliminado) {
      return res.status(404).json({
        success: false,
        message: 'Justificación no encontrada'
      });
    }

    res.json({
      success: true,
      message: 'Justificación eliminada exitosamente'
    });

  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Error al eliminar la justificación',
      error: error.message
    });
  }
};

module.exports = {
  crearJustificacion,
  obtenerJustificacionesAlumno,
  obtenerJustificacionesDocente,
  obtenerTodasJustificaciones,
  obtenerJustificacionPorId,
  actualizarEstadoJustificacion,
  eliminarJustificacion
}; 
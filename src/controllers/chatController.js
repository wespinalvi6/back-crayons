const axios = require("axios");
const Cuota = require("../models/Cuota");
const pool = require("../config/database");
const { blindIndex, decrypt } = require("../utils/cryptoUtils");

// Utilidad: detectar intención simple (cuotas vs asistencia vs perfil) y extraer DNI/año
function detectIntentAndParams(text, user) {
  const normalized = String(text || "").toLowerCase();
  const intent = /\b(cuota|cuotas|pago|pagos|matricula|matrícula)\b/.test(normalized)
    ? "cuotas"
    : /(asistencia|faltas|inasistencia|asistencias)/.test(normalized)
      ? "asistencia"
      : /(como se llama|nombre|identidad|quien es|de que grado|grado|nivel)/.test(normalized)
        ? "perfil"
        : "general";

  const dniMatch = normalized.match(/\b(\d{8})\b/);
  const yearMatch = normalized.match(/\b(20\d{2})\b/);

  const params = {
    dni: dniMatch ? dniMatch[1] : undefined,
    anio: yearMatch ? Number(yearMatch[1]) : undefined,
  };

  return { intent, params };
}

async function fetchCuotas({ reqUser, dni, anio }) {
  const resolvedYear = anio || new Date().getFullYear();

  // Si es director puede consultar por DNI, si es alumno usa su DNI
  let dniToUse = dni;
  if (!dniToUse && reqUser) {
    // Buscar DNI del usuario autenticado desde personas
    const connection = await pool.getConnection();
    try {
      const [rows] = await connection.query(
        "SELECT p.dni FROM personas p WHERE p.id = ?",
        [reqUser.id_persona]
      );
      if (rows && rows.length > 0) dniToUse = decrypt(rows[0].dni);
    } finally {
      connection.release();
    }
  }

  if (!dniToUse) {
    return { error: "Falta DNI para consultar cuotas" };
  }

  const data = await Cuota.buscarPorDniYAnio(dniToUse, resolvedYear);
  return { data, anio: resolvedYear, dni: dniToUse };
}

async function fetchPerfil({ reqUser, dni }) {
  // Si es director puede consultar por DNI; si no, usar su propia persona
  let dniToUse = dni;
  const connection = await pool.getConnection();
  try {
    if (!dniToUse) {
      const [dniRow] = await connection.query(
        "SELECT p.dni FROM personas p WHERE p.id = ?",
        [reqUser.id_persona]
      );
      if (dniRow && dniRow.length > 0) dniToUse = decrypt(dniRow[0].dni);
    }
    if (!dniToUse) return { error: "Falta DNI para consultar perfil" };

    const dniHash = blindIndex(dniToUse);
    const [rows] = await connection.query(
      `SELECT p.id AS id_persona, p.dni, p.nombres, p.apellido_paterno, p.apellido_materno,
              a.id AS id_alumno,
              m.id AS id_matricula, m.fecha_matricula,
              g.id AS id_grado, g.nombre AS grado
       FROM personas p
       LEFT JOIN alumnos a ON a.id_persona = p.id
       LEFT JOIN matriculas m ON m.id_alumno = a.id
       LEFT JOIN grados g ON g.id = m.id_grado
       WHERE p.dni_hash = ?
       ORDER BY m.fecha_matricula DESC
      `,
      [dniHash]
    );
    if (!rows || rows.length === 0) return { error: "No se encontró persona/alumno con ese DNI" };

    const first = rows[0];
    const nombres = decrypt(first.nombres);
    const ap_p = decrypt(first.apellido_paterno);
    const ap_m = decrypt(first.apellido_materno);
    const nombreCompleto = `${nombres} ${ap_p} ${ap_m}`.trim();

    return {
      data: {
        dni: dniToUse,
        nombre_completo: nombreCompleto,
        grado: first.grado || null,
        historial: rows.map(r => ({ grado: r.grado, fecha_matricula: r.fecha_matricula }))
      }
    };
  } finally {
    connection.release();
  }
}

async function fetchAsistencias({ reqUser }) {
  // Obtener asistencias del alumno autenticado
  const connection = await pool.getConnection();
  try {
    const [alumnoRow] = await connection.query(
      "SELECT id FROM alumnos WHERE id_persona = ?",
      [reqUser.id_persona]
    );
    if (!alumnoRow || alumnoRow.length === 0) {
      return { error: "No se encontró el alumno del usuario" };
    }
    const idAlumno = alumnoRow[0].id;

    // Obtener matrícula vigente (asumimos la última)
    const [matriculaRow] = await connection.query(
      "SELECT id FROM matriculas WHERE id_alumno = ? ORDER BY created_at DESC LIMIT 1",
      [idAlumno]
    );
    if (!matriculaRow || matriculaRow.length === 0) {
      return { error: "No se encontró matrícula del alumno" };
    }
    const idMatricula = matriculaRow[0].id;

    const [rows] = await connection.query(
      `SELECT ast.*, 
              p.nombres as nombre_docente, p.apellido_paterno as ap_p_docente, p.apellido_materno as ap_m_docente,
              c.nombre as curso_nombre
       FROM asistencia ast
       JOIN asignaciones asig ON ast.id_asignacion = asig.id
       JOIN cursos c ON asig.id_curso = c.id
       JOIN docentes d ON asig.id_docente = d.id
       JOIN personas p ON d.id_persona = p.id
       WHERE ast.id_matricula = ?
       ORDER BY ast.fecha DESC
      `,
      [idMatricula]
    );

    const decryptedRows = rows.map(r => ({
      ...r,
      nombre_completo_docente: `${decrypt(r.nombre_docente)} ${decrypt(r.ap_p_docente)} ${decrypt(r.ap_m_docente)}`.trim()
    }));

    return { data: decryptedRows };
  } finally {
    connection.release();
  }
}

async function callOpenAI(messages) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY no configurada");

  const payload = {
    model: "gpt-4o-mini",
    messages,
    temperature: 0.2,
  };

  const res = await axios.post(
    "https://api.openai.com/v1/chat/completions",
    payload,
    {
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      timeout: 20000,
    }
  );
  const content = res.data?.choices?.[0]?.message?.content || "";
  return content;
}

// POST /api/chat
const chat = async (req, res) => {
  try {
    const { message } = req.body || {};
    if (!message) return res.status(400).json({ success: false, message: "message es requerido" });

    const { intent, params } = detectIntentAndParams(message, req.user);

    let toolResult = null;
    if (intent === "cuotas") {
      toolResult = await fetchCuotas({ reqUser: req.user, dni: params.dni, anio: params.anio });
    } else if (intent === "asistencia") {
      toolResult = await fetchAsistencias({ reqUser: req.user });
    } else if (intent === "perfil") {
      toolResult = await fetchPerfil({ reqUser: req.user, dni: params.dni });
    }

    const roleDesc = req.user?.id_rol === 1 ? "director" : "estudiante";

    const system = `Eres un asistente escolar que responde en español, breve y claro. Tienes rol de ${roleDesc}. Si hay datos consultados, respóndelos en lista simple; si falta info (e.g. DNI para director), pídela de forma directa. Nunca inventes.`;

    const dataSummary = toolResult?.error
      ? `ERROR: ${toolResult.error}`
      : intent === "cuotas"
        ? JSON.stringify({
          dni: toolResult?.dni,
          anio: toolResult?.anio,
          cuotas: toolResult?.data || []
        })
        : intent === "asistencia"
          ? JSON.stringify({ asistencias: toolResult?.data })
          : intent === "perfil"
            ? JSON.stringify({ perfil: toolResult?.data })
            : "";

    const finalMessage = await callOpenAI([
      { role: "system", content: system },
      { role: "user", content: String(message) },
      dataSummary ? { role: "system", content: `DatosConsultados: ${dataSummary}` } : null,
    ].filter(Boolean));

    return res.json({ success: true, intent, data: toolResult?.data || null, message: finalMessage, error: toolResult?.error || null });
  } catch (err) {
    console.error("Error en chat:", err);
    return res.status(500).json({ success: false, message: "Error interno", error: err.message });
  }
};

module.exports = chat;

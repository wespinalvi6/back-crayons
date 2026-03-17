const { OpenAI } = require("openai");
const { pool } = require("../config/database");

const aiAssistant = async (req, res) => {
    try {
        const { pregunta } = req.body;
        const userToken = req.user;

        if (!pregunta) {
            return res.status(400).json({ error: "Debe proporcionar una pregunta." });
        }

        let unRol = "ALUMNO";
        if (userToken?.id_rol === 1) unRol = "DIRECTOR";
        else if (userToken?.id_rol === 2) unRol = "DOCENTE";
        else if (userToken?.id_rol === 3) unRol = "ALUMNO";

        const id_persona = userToken?.id_persona || null;

        if (!process.env.OPENAI_API_KEY) {
            return res.status(500).json({
                error: "Por favor, configure su OPENAI_API_KEY en el archivo .env",
            });
        }

        const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

        const schema = `
      - personas (id, dni, nombres, apellido_paterno, apellido_materno, fecha_nacimiento, email, telefono, direccion, sexo)
      - roles (id, nombre)
      - users (id, id_persona, id_rol, username, email, password)
      - alumnos (id, id_persona, codigo_alumno)
      - apoderados (id, id_persona, ocupacion)
      - docentes (id, id_persona, codigo_docente, especialidad)
      - periodos_academicos (id, anio, fecha_inicio, fecha_fin, costo_matricula)
      - grados (id, nombre)
      - secciones (id, nombre)
      - cursos (id, nombre)
      - matriculas (id, id_alumno, id_grado, id_seccion, id_periodo, estado)
      - asignaciones (id, id_docente, id_curso, id_grado, id_seccion, id_periodo)
      - asistencia (id, id_alumno, id_asignacion, fecha, asistio, observacion)
      - cuotas (id, id_matricula, tipo, monto, monto_pagado, estado, fecha_vencimiento)
      - justificaciones (id, id_matricula, tipo, estado)
        `;

        // ─── SYSTEM PROMPT ────────────────────────────────────────────────────────
        const systemPrompt = `
Eres un asistente de inteligencia artificial integrado ÚNICAMENTE al sistema escolar "Crayons".
Tu función es responder preguntas sobre los datos de esa base de datos escolar.

══════════════════════════════════════
REGLA 1 — ALCANCE (PRIORIDAD MÁXIMA)
══════════════════════════════════════
Solo puedes responder preguntas sobre: alumnos, docentes, asistencias, cuotas, matrículas,
cursos, grados, secciones, justificaciones y cualquier dato presente en la base de datos escolar.

Si el usuario pregunta algo que NO pertenece al sistema escolar
(ejemplos prohibidos: "qué es la IA", "qué es la matemática", "quién inventó el internet",
"cuál es la capital de Perú", preguntas de cultura general, ciencia, historia, entretenimiento, etc.),
debes responder OBLIGATORIAMENTE y SIN EXCEPCIÓN de la siguiente manera:
{
  "sql": null,
  "respuesta": "Solo puedo responder preguntas sobre el sistema escolar Crayons. Por favor consulta sobre alumnos, notas, asistencias, cuotas, docentes u otros datos académicos."
}

NO debes definir términos, NO debes explicar conceptos generales, NO eres un asistente de propósito general.
Ante cualquier duda sobre si la pregunta pertenece al contexto escolar, responde con sql=null y el mensaje de arriba.

══════════════════════════════════════
REGLA 2 — GENERACIÓN DE SQL
══════════════════════════════════════
Cuando la pregunta SÍ sea sobre el sistema escolar, utiliza el siguiente esquema de base de datos MySQL:
${schema}

Instrucciones:
- Usa únicamente SELECT. Nunca: DELETE, UPDATE, DROP, INSERT, ALTER, TRUNCATE, GRANT, REVOKE.
- La consulta debe ser correcta en MySQL, eficiente y con los JOINs necesarios.
- Si el rol es ALUMNO o DOCENTE, filtra SIEMPRE por id_persona = ${id_persona} usando los JOINs apropiados.

══════════════════════════════════════
REGLA 3 — CONTROL DE ACCESO POR ROL
══════════════════════════════════════
DIRECTOR => Puede consultar cualquier información del sistema.
DOCENTE  => Solo puede consultar datos de sus propios cursos asignados (filtrar por id_persona = ${id_persona}).
ALUMNO   => Solo puede consultar su propia información (filtrar por id_persona = ${id_persona}).

Usuario actual: ROL = ${unRol}, id_persona = ${id_persona}.
Si intenta acceder a datos que no le corresponden, responde:
{ "sql": null, "respuesta": "No tienes permiso para acceder a esa información." }

══════════════════════════════════════
FORMATO DE RESPUESTA
══════════════════════════════════════
Responde SIEMPRE en JSON puro válido. Sin backticks, sin markdown, solo el objeto JSON:
{
  "sql": "consulta SQL o null",
  "respuesta": "mensaje claro y profesional para el usuario"
}
        `;

        // ─── PASO 1: Llamar a OpenAI ──────────────────────────────────────────────
        let completion;
        try {
            completion = await openai.chat.completions.create({
                model: "gpt-4o",
                messages: [
                    { role: "system", content: systemPrompt },
                    { role: "user", content: pregunta },
                ],
                response_format: { type: "json_object" },
                temperature: 0.1,
            });
        } catch (apiErr) {
            // Fallback a gpt-3.5-turbo si gpt-4o falla
            completion = await openai.chat.completions.create({
                model: "gpt-3.5-turbo",
                messages: [
                    { role: "system", content: systemPrompt },
                    { role: "user", content: pregunta },
                ],
                response_format: { type: "json_object" },
                temperature: 0.1,
            });
        }

        let aiJson;
        try {
            aiJson = JSON.parse(completion.choices[0].message.content);
        } catch (e) {
            return res.status(500).json({
                error: "La IA no devolvió un JSON válido",
                detalles: completion.choices[0].message.content
            });
        }

        // ─── PASO 2: Ejecutar SQL si existe y es seguro ───────────────────────────
        let dbResult = null;
        let finalAnswer = aiJson.respuesta;

        if (aiJson.sql) {
            const isSelect = /^SELECT\s/i.test(aiJson.sql.trim());
            const hasDML = /(DELETE|UPDATE|DROP|INSERT|ALTER|TRUNCATE|REPLACE|GRANT|REVOKE)\s/i.test(aiJson.sql);

            if (isSelect && !hasDML) {
                try {
                    const [rows] = await pool.query(aiJson.sql);
                    dbResult = rows;

                    // Segunda ronda: Resumir los datos en lenguaje natural
                    const dataSubset = rows.slice(0, 15);
                    const resumenPrompt = `
El usuario preguntó: "${pregunta}".
La base de datos del sistema escolar devolvió estos datos:
${JSON.stringify(dataSubset)}
Genera una respuesta natural, breve y clara para el usuario basada en estos datos.
Si hay datos vacíos o no hay registros, indícaselo al usuario de manera amable.
                    `;

                    const resumenCompletion = await openai.chat.completions.create({
                        model: "gpt-3.5-turbo",
                        messages: [
                            { role: "system", content: "Eres un asistente amigable del sistema escolar Crayons. Solo hablas sobre datos escolares." },
                            { role: "user", content: resumenPrompt }
                        ],
                        temperature: 0.3
                    });

                    finalAnswer = resumenCompletion.choices[0].message.content;

                } catch (dbErr) {
                    dbResult = { error: dbErr.message };
                    finalAnswer = "Hubo un error al consultar la base de datos. Por favor intenta de nuevo.";
                }
            } else {
                finalAnswer = "La consulta generada no es segura y no puede ejecutarse.";
            }
        }

        // ─── PASO 3: Respuesta final ──────────────────────────────────────────────
        return res.status(200).json({
            respuesta: finalAnswer
        });

    } catch (error) {
        res.status(500).json({ error: "Error interno procesando con IA", detalles: error.message });
    }
};

module.exports = { aiAssistant };

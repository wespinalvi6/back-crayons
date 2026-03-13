const { withTransaction, pool } = require("../config/database");
const { decrypt } = require("../utils/cryptoUtils");

class PromocionController {
    // A. Listado de Períodos
    static async listarPeriodos(req, res) {
        try {
            const [rows] = await pool.query("SELECT * FROM periodos_academicos ORDER BY anio ASC");
            return res.status(200).json({ status: true, data: rows });
        } catch (error) {
            return res.status(500).json({ status: false, message: "Error al listar períodos" });
        }
    }

    // B. Cerrar Período
    static async cerrarPeriodo(req, res) {
        try {
            const { id } = req.params;
            await pool.query("UPDATE periodos_academicos SET activo = 0 WHERE id = ?", [id]);
            return res.status(200).json({ status: true, message: "Período cerrado correctamente. Se ha habilitado la promoción masiva." });
        } catch (error) {
            return res.status(500).json({ status: false, message: "Error al cerrar período" });
        }
    }

    // C. Listar Alumnos y Estado (GET /alumnos-estado) - DISEÑO PARA POSTMAN Y FRONT
    static async listarAlumnosEstado(req, res) {
        try {
            const { periodId, gradoId } = req.query;

            if (!periodId || !gradoId) {
                return res.status(400).json({ status: false, message: "Faltan parámetros periodId o gradoId" });
            }

            // 1. Obtener información del grado y periodo actual
            const [[gradoActual]] = await pool.query("SELECT id, numero_grado, nombre FROM grados WHERE id = ?", [gradoId]);
            const [[periodoActual]] = await pool.query("SELECT anio FROM periodos_academicos WHERE id = ?", [periodId]);

            if (!gradoActual || !periodoActual) {
                return res.status(404).json({ status: false, message: "Grado o Periodo no encontrado" });
            }

            // 2. Verificar si es el último grado (máximo numero_grado)
            const [[maxGrado]] = await pool.query("SELECT MAX(numero_grado) as max_grado FROM grados");
            const esUltimo = gradoActual.numero_grado === maxGrado.max_grado;

            // 3. Obtener alumnos con su sección
            const query = `
                SELECT 
                    m.id as id_matricula,
                    a.id as id_alumno,
                    p.dni,
                    p.nombres,
                    p.apellido_paterno,
                    p.apellido_materno,
                    m.puede_promover,
                    m.estado as estado_matricula,
                    a.estado as alumno_estado,
                    m.promedio,
                    s.nombre as seccion_nombre,
                    EXISTS (
                        SELECT 1 FROM cuotas c 
                        WHERE c.id_matricula = m.id AND c.estado != 'Pagada'
                    ) as hasDebt
                FROM matriculas m
                JOIN alumnos a ON m.id_alumno = a.id
                JOIN personas p ON a.id_persona = p.id
                LEFT JOIN secciones s ON m.id_seccion = s.id
                WHERE m.id_periodo = ? AND m.id_grado = ?
                ORDER BY p.apellido_paterno ASC, p.apellido_materno ASC
            `;

            const [rows] = await pool.query(query, [periodId, gradoId]);

            // 4. Formatear y Desencriptar
            const formattedData = rows.map(row => {
                const nombres = decrypt(row.nombres);
                const apPaterno = decrypt(row.apellido_paterno);
                const apMaterno = decrypt(row.apellido_materno);
                const dni = decrypt(row.dni);

                return {
                    id_matricula: row.id_matricula,
                    id_alumno: row.id_alumno,
                    dni: dni,
                    nombre_completo: `${apPaterno} ${apMaterno}, ${nombres}`,
                    seccion: row.seccion_nombre || 'N/A',
                    promedio: row.promedio || '0.0',
                    estado: row.estado_matricula === 'Activa' ? 'Activo' : row.estado_matricula,
                    alumno_estado: row.alumno_estado,
                    puede_promover: !!row.puede_promover,
                    statusDeuda: row.hasDebt ? 'Con Deuda' : 'Al Día'
                };
            });

            return res.status(200).json({
                status: true,
                esUltimoGrado: esUltimo,
                periodoAnio: periodoActual.anio,
                nombreGrado: gradoActual.nombre,
                data: formattedData
            });
        } catch (error) {
            return res.status(500).json({ status: false, message: "Error al listar alumnos y estado" });
        }
    }

    // D. Actualizar Switch de Promoción (Individual)
    static async togglePromocion(req, res) {
        try {
            const { matriculaId } = req.params;
            const { puede_promover } = req.body; // 0 o 1

            await pool.query("UPDATE matriculas SET puede_promover = ? WHERE id = ?", [puede_promover, matriculaId]);

            return res.status(200).json({ status: true, message: "Permiso de promoción actualizado" });
        } catch (error) {
            return res.status(500).json({ status: false, message: "Error al actualizar permiso" });
        }
    }

    // E. PROMOCIÓN / EGRESO INDIVIDUAL (POST /promover-individual/:matriculaId)
    static async promoverIndividual(req, res) {
        try {
            const { matriculaId } = req.params;
            const { periodIdSiguiente } = req.body;

            const resultado = await withTransaction(async (connection) => {
                // 1. Datos actuales
                const [[matricula]] = await connection.query(`
                    SELECT m.*, g.numero_grado 
                    FROM matriculas m 
                    JOIN grados g ON m.id_grado = g.id 
                    WHERE m.id = ?
                `, [matriculaId]);

                if (!matricula) throw new Error("Matrícula no encontrada");
                if (matricula.estado === 'Promovido') throw new Error("El alumno ya ha sido promovido o egresado.");

                // 2. Verificar si ya existe en el destino
                const [[yaMat]] = await connection.query(
                    "SELECT 1 FROM matriculas WHERE id_alumno = ? AND id_periodo = ?",
                    [matricula.id_alumno, periodIdSiguiente]
                );
                if (yaMat) throw new Error("El alumno ya tiene una matrícula registrada en el periodo siguiente.");

                // 3. Grado Siguiente
                const [[nextGrade]] = await connection.query(
                    "SELECT id FROM grados WHERE numero_grado = ?",
                    [matricula.numero_grado + 1]
                );

                if (!nextGrade) {
                    // --- CASO EGRESO ---
                    await connection.execute("UPDATE matriculas SET estado = 'Promovido' WHERE id = ?", [matriculaId]);
                    await connection.execute("UPDATE alumnos SET estado = 'Egresado' WHERE id = ?", [matricula.id_alumno]);

                    // Desactivar acceso de usuario (seguridad)
                    await connection.execute(`
                        UPDATE users u 
                        JOIN personas p ON u.id_persona = p.id 
                        JOIN alumnos a ON a.id_persona = p.id 
                        SET u.activo = 0 
                        WHERE a.id = ?`, [matricula.id_alumno]);

                    return { tipo: 'Egreso', message: "Alumno egresado con éxito. Sus accesos han sido desactivados para el siguiente ciclo." };
                }

                // --- CASO PROMOCIÓN ---
                if (!periodIdSiguiente) throw new Error("Se requiere el ID del periodo académico siguiente para promociones.");
                const [[nextPeriod]] = await connection.query("SELECT * FROM periodos_academicos WHERE id = ?", [periodIdSiguiente]);
                if (!nextPeriod || nextPeriod.activo !== 1) throw new Error("El periodo siguiente no existe o no está abierto.");

                const [newMatResult] = await connection.execute(
                    `INSERT INTO matriculas (id_alumno, id_grado, id_periodo, fecha_matricula, estado, puede_promover) 
                     VALUES (?, ?, ?, CURDATE(), 'Activa', 1)`,
                    [matricula.id_alumno, nextGrade.id, periodIdSiguiente]
                );
                const newMatriculaId = newMatResult.insertId;

                // Cuotas automáticas
                if (nextPeriod.costo_matricula > 0) {
                    await connection.execute(
                        "INSERT INTO cuotas (id_matricula, tipo, numero_cuota, monto, fecha_vencimiento, estado) VALUES (?, 'Matricula', 0, ?, CURDATE(), 'Pendiente')",
                        [newMatriculaId, nextPeriod.costo_matricula]
                    );
                }

                const montoMensual = nextPeriod.costo_cuota_mensual || 0;
                if (montoMensual > 0) {
                    let mesInicio = 2; // Marzo
                    for (let i = 1; i <= (nextPeriod.numero_cuotas || 10); i++) {
                        let year = nextPeriod.anio;
                        let month = mesInicio + (i - 1);
                        if (month > 11) { year++; month -= 12; }
                        const fechaVenc = new Date(year, month + 1, 0).toISOString().split('T')[0];
                        await connection.execute(
                            "INSERT INTO cuotas (id_matricula, tipo, numero_cuota, monto, fecha_vencimiento, estado) VALUES (?, 'Cuota', ?, ?, ?, 'Pendiente')",
                            [newMatriculaId, i, montoMensual, fechaVenc]
                        );
                    }
                }

                // Actualizar Origen
                await connection.execute("UPDATE matriculas SET estado = 'Promovido' WHERE id = ?", [matriculaId]);

                return { tipo: 'Promoción', message: "Alumno promovido al siguiente grado con éxito." };
            });

            return res.status(200).json({ status: true, message: resultado.message, data: resultado });
        } catch (error) {
            return res.status(400).json({ status: false, message: error.message });
        }
    }

    static async procesarPromocionMasiva(req, res) {
        try {
            const { periodIdActual, periodIdSiguiente, gradoId, idsPromovidos } = req.body;

            if (!periodIdActual || !gradoId) {
                return res.status(400).json({ status: false, message: "Faltan parámetros (periodIdActual o gradoId)" });
            }

            // Validar periodo destino si se proporciona
            let nextPeriod = null;
            if (periodIdSiguiente) {
                const [nextPeriodRows] = await pool.query("SELECT * FROM periodos_academicos WHERE id = ? AND activo = 1", [periodIdSiguiente]);
                if (nextPeriodRows.length === 0) {
                    return res.status(400).json({ status: false, message: "El periodo de destino no existe o no está abierto para matrículas" });
                }
                nextPeriod = nextPeriodRows[0];
            }

            const resultado = await withTransaction(async (connection) => {
                // 1. Identificar Candidatos del grado específico
                const queryCandidatos = `
                    SELECT m.id as id_matricula_actual, m.id_alumno, m.id_grado, g.numero_grado, g.nombre as nombre_grado
                    FROM matriculas m
                    JOIN grados g ON m.id_grado = g.id
                    WHERE m.id_periodo = ? AND m.id_grado = ? AND m.estado IN ('Activa', 'Pendiente')
                    ${periodIdSiguiente ? `AND NOT EXISTS (
                        SELECT 1 FROM matriculas m2 
                        WHERE m2.id_alumno = m.id_alumno AND m2.id_periodo = ?
                    )` : ''}
                `;

                const [candidatos] = await connection.query(queryCandidatos,
                    periodIdSiguiente ? [periodIdActual, gradoId, periodIdSiguiente] : [periodIdActual, gradoId]
                );

                const summary = {
                    encontrados: candidatos.length,
                    promovidos: 0,
                    permanecen: 0,
                    egresados: 0,
                    errores: 0,
                    detalles: []
                };

                const promotedSet = new Set((idsPromovidos || []).map(id => Number(id)));

                for (const candidato of candidatos) {
                    try {
                        const debePromover = promotedSet.has(Number(candidato.id_matricula_actual));
                        let targetGradeId = null;

                        if (debePromover) {
                            // Buscar Grado Siguiente
                            const [nextGradeRows] = await connection.query(
                                "SELECT id FROM grados WHERE numero_grado = ?",
                                [candidato.numero_grado + 1]
                            );

                            if (nextGradeRows.length === 0) {
                                // --- CASO EGRESO ---
                                await connection.execute("UPDATE matriculas SET estado = 'Promovido' WHERE id = ?", [candidato.id_matricula_actual]);
                                await connection.execute("UPDATE alumnos SET estado = 'Egresado' WHERE id = ?", [candidato.id_alumno]);

                                // Desactivar accesos
                                await connection.execute(`
                                    UPDATE users u 
                                    JOIN personas p ON u.id_persona = p.id 
                                    JOIN alumnos a ON a.id_persona = p.id 
                                    SET u.activo = 0 
                                    WHERE a.id = ?`, [candidato.id_alumno]);

                                summary.egresados++;
                                continue;
                            }
                            targetGradeId = nextGradeRows[0].id;

                            if (!periodIdSiguiente) {
                                summary.errores++;
                                summary.detalles.push({ alumnoId: candidato.id_alumno, error: "No se puede promover sin un periodo destino" });
                                continue;
                            }

                            summary.promovidos++;
                        } else {
                            // --- CASO PERMANECER (Mismo Grado) ---
                            if (!periodIdSiguiente) {
                                summary.errores++;
                                summary.detalles.push({ alumnoId: candidato.id_alumno, error: "No se puede repetir sin un periodo destino" });
                                continue;
                            }
                            targetGradeId = candidato.id_grado;
                            summary.permanecen++;
                        }

                        // 3. Crear Nueva Matrícula
                        const [newMatResult] = await connection.execute(
                            `INSERT INTO matriculas (id_alumno, id_grado, id_periodo, fecha_matricula, estado, puede_promover) 
                             VALUES (?, ?, ?, CURDATE(), 'Activa', 1)`,
                            [candidato.id_alumno, targetGradeId, periodIdSiguiente]
                        );
                        const newMatriculaId = newMatResult.insertId;

                        // 4. Cuotas automáticas
                        if (nextPeriod.costo_matricula > 0) {
                            await connection.execute(
                                "INSERT INTO cuotas (id_matricula, tipo, numero_cuota, monto, fecha_vencimiento, estado) VALUES (?, 'Matricula', 0, ?, CURDATE(), 'Pendiente')",
                                [newMatriculaId, nextPeriod.costo_matricula]
                            );
                        }

                        const montoMensual = nextPeriod.costo_cuota_mensual || 0;
                        if (montoMensual > 0) {
                            let mesInicio = 2; // Marzo
                            for (let i = 1; i <= (nextPeriod.numero_cuotas || 10); i++) {
                                let year = nextPeriod.anio;
                                let month = mesInicio + (i - 1);
                                if (month > 11) { year++; month -= 12; }
                                const fechaVenc = new Date(year, month + 1, 0).toISOString().split('T')[0];
                                await connection.execute(
                                    "INSERT INTO cuotas (id_matricula, tipo, numero_cuota, monto, fecha_vencimiento, estado) VALUES (?, 'Cuota', ?, ?, ?, 'Pendiente')",
                                    [newMatriculaId, i, montoMensual, fechaVenc]
                                );
                            }
                        }

                        // 5. Actualizar Matrícula Original
                        await connection.execute("UPDATE matriculas SET estado = 'Promovido' WHERE id = ?", [candidato.id_matricula_actual]);

                    } catch (err) {
                        summary.errores++;
                        summary.detalles.push({ alumnoId: candidato.id_alumno, error: err.message });
                    }
                }

                return summary;
            });

            return res.status(200).json({ status: true, message: "Proceso de promoción finalizado", data: resultado });
        } catch (error) {
            return res.status(500).json({ status: false, message: "Error crítico en el proceso de promoción", error: error.message });
        }
    }

    // G. Estadísticas Dashboard
    static async obtenerEstadisticas(req, res) {
        try {
            const { periodId } = req.params;
            const query = `
                SELECT 
                    g.nombre, 
                    COUNT(m.id) as total,
                    COUNT(CASE WHEN m.estado = 'Promovido' THEN 1 END) as promovidos,
                    COUNT(CASE WHEN m.estado = 'Activa' AND m.puede_promover = 0 THEN 1 END) as repitentes_bloqueados
                FROM grados g
                LEFT JOIN matriculas m ON g.id = m.id_grado AND m.id_periodo = ?
                GROUP BY g.id, g.nombre
            `;
            const [rows] = await pool.query(query, [periodId]);
            return res.status(200).json({ status: true, data: rows });
        } catch (error) {
            return res.status(500).json({ status: false, message: "Error al obtener estadísticas" });
        }
    }
}

module.exports = PromocionController;

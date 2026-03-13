const pool = require("../config/database");

const getEstadisticasDirector = async (req, res) => {
    try {
        const anioActual = new Date().getFullYear();
        const mesActual = new Date().getMonth() + 1;

        // 1. Ingresos Totales (Este Mes)
        const [ingresosMes] = await pool.pool.query(
            `SELECT COALESCE(SUM(monto_pagado), 0) as total 
       FROM cuotas 
       WHERE estado = 'Pagada' AND MONTH(fecha_pago) = ? AND YEAR(fecha_pago) = ?`,
            [mesActual, anioActual]
        );

        // 2. Ingresos Mes Anterior (para cálculo de tendencia)
        const mesAnterior = mesActual === 1 ? 12 : mesActual - 1;
        const anioAnterior = mesActual === 1 ? anioActual - 1 : anioActual;
        const [ingresosMesAnterior] = await pool.pool.query(
            `SELECT COALESCE(SUM(monto_pagado), 0) as total 
       FROM cuotas 
       WHERE estado = 'Pagada' AND MONTH(fecha_pago) = ? AND YEAR(fecha_pago) = ?`,
            [mesAnterior, anioAnterior]
        );

        // 3. Estudiantes Activos (Matriculados en el año actual)
        const [estudiantesActivos] = await pool.pool.query(
            `SELECT COUNT(DISTINCT id_alumno) as total 
       FROM matriculas m
       JOIN periodos_academicos pa ON m.id_periodo = pa.id
       WHERE pa.anio = ?`,
            [anioActual]
        );

        // 4. Distribución por Sexo (Varon/Mujer)
        const [distribucionSexo] = await pool.pool.query(
            `SELECT p.sexo, COUNT(*) as cantidad
       FROM alumnos a
       JOIN personas p ON a.id_persona = p.id
       JOIN matriculas m ON a.id = m.id_alumno
       JOIN periodos_academicos pa ON m.id_periodo = pa.id
       WHERE pa.anio = ?
       GROUP BY p.sexo`,
            [anioActual]
        );

        // 5. Pagos Pendientes (Lo que falta cobrar este mes)
        const [pagosPendientes] = await pool.pool.query(
            `SELECT COALESCE(SUM(monto), 0) as total 
       FROM cuotas 
       WHERE estado != 'Pagada' AND MONTH(fecha_vencimiento) = ? AND YEAR(fecha_vencimiento) = ?`,
            [mesActual, anioActual]
        );

        // 6. Tasa de Morosidad (Estudiantes con deuda vs Total)
        const [estudiantesConDeuda] = await pool.pool.query(
            `SELECT COUNT(DISTINCT m.id_alumno) as total
       FROM cuotas c
       JOIN matriculas m ON c.id_matricula = m.id
       JOIN periodos_academicos pa ON m.id_periodo = pa.id
       WHERE c.estado != 'Pagada' AND c.fecha_vencimiento < CURDATE() AND pa.anio = ?`,
            [anioActual]
        );

        // 7. Tendencia de Ingresos (Últimos 6 meses)
        const [tendenciaIngresos] = await pool.pool.query(
            `SELECT 
        MONTH(fecha_pago) as mes, 
        YEAR(fecha_pago) as anio, 
        SUM(monto_pagado) as total
       FROM cuotas
       WHERE estado = 'Pagada' AND fecha_pago >= DATE_SUB(CURDATE(), INTERVAL 6 MONTH)
       GROUP BY YEAR(fecha_pago), MONTH(fecha_pago)
       ORDER BY YEAR(fecha_pago) ASC, MONTH(fecha_pago) ASC`
        );

        // 8. Tasa de Recaudación (Pagado vs Total esperado en el mes)
        const [recaudacionMes] = await pool.pool.query(
            `SELECT 
        SUM(CASE WHEN estado = 'Pagada' THEN monto_pagado ELSE 0 END) as pagado,
        SUM(monto) as total_esperado
       FROM cuotas
       WHERE MONTH(fecha_vencimiento) = ? AND YEAR(fecha_vencimiento) = ?`,
            [mesActual, anioActual]
        );

        const pagado = parseFloat(recaudacionMes[0].pagado || 0);
        const esperado = parseFloat(recaudacionMes[0].total_esperado || 0);
        const tasaRecaudacion = esperado > 0 ? Math.round((pagado / esperado) * 100) : 0;

        res.json({
            success: true,
            data: {
                kpis: {
                    ingresos_mensuales: ingresosMes[0].total,
                    ingresos_mes_anterior: ingresosMesAnterior[0].total,
                    estudiantes_activos: estudiantesActivos[0].total,
                    pagos_pendientes: pagosPendientes[0].total,
                    estudiantes_con_deuda: estudiantesConDeuda[0].total,
                    tasa_recaudacion: tasaRecaudacion,
                    meta_mensual: 60, // Ejemplo de meta estática o configurable
                },
                distribucion_sexo: distribucionSexo,
                tendencia_ingresos: tendenciaIngresos,
                comparativa_pagos: {
                    pagado: pagado,
                    pendiente: esperado - pagado
                }
            }
        });

    } catch (error) {
        console.error("Error en dashboard:", error);
        res.status(500).json({ success: false, message: "Error al obtener estadísticas" });
    }
};

module.exports = {
    getEstadisticasDirector
};

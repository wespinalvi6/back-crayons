const db = require('../config/database');

class PeriodoPagoas {
    static async findByAnio(anio) {
        const [rows] = await db.pool.query(
            'SELECT id, anio, fecha_inicio, fecha_fin, costo_matricula, costo_cuota_mensual, numero_cuotas, activo FROM periodos_academicos WHERE anio = ?',
            [anio]
        );
        return rows[0];
    }

    static async create(periodoData) {
        const { anio, fecha_inicio, fecha_fin, costo_matricula, costo_cuota_mensual, numero_cuotas, activo } = periodoData;
        const [result] = await db.pool.query(
            `INSERT INTO periodos_academicos 
            (anio, fecha_inicio, fecha_fin, costo_matricula, costo_cuota_mensual, numero_cuotas, activo) 
            VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [anio, fecha_inicio, fecha_fin, costo_matricula, costo_cuota_mensual, numero_cuotas, activo || 1]
        );
        return result.insertId;
    }

    static async getAll() {
        const [rows] = await db.pool.query('SELECT id, anio, fecha_inicio, fecha_fin, costo_matricula, costo_cuota_mensual, numero_cuotas, activo FROM periodos_academicos ORDER BY anio DESC');
        return rows;
    }
}

module.exports = PeriodoPagoas;

const PeriodoPagoas = require('../models/PeriodoPagoas');

const periodoPagoasController = {
    // Obtener costos por año
    getByAnio: async (req, res) => {
        try {
            const { anio } = req.params;
            const periodo = await PeriodoPagoas.findByAnio(anio);
            
            if (!periodo) {
                return res.status(404).json({
                    success: false,
                    message: 'No se encontró el periodo para el año especificado'
                });
            }

            res.json({
                success: true,
                data: periodo
            });
        } catch (error) {
            res.status(500).json({
                success: false,
                message: 'Error al obtener los costos',
                error: error.message
            });
        }
    },

    // Crear nuevo periodo
    create: async (req, res) => {
        try {
            const periodoData = req.body;
            const newPeriodoId = await PeriodoPagoas.create(periodoData);
            
            res.status(201).json({
                success: true,
                message: 'Periodo creado exitosamente',
                data: { id: newPeriodoId }
            });
        } catch (error) {
            res.status(500).json({
                success: false,
                message: 'Error al crear el periodo',
                error: error.message
            });
        }
    },

    // Obtener todos los periodos
    getAll: async (req, res) => {
        try {
            const periodos = await PeriodoPagoas.getAll();
            res.json({
                success: true,
                data: periodos
            });
        } catch (error) {
            res.status(500).json({
                success: false,
                message: 'Error al obtener los periodos',
                error: error.message
            });
        }
    }
};

module.exports = periodoPagoasController; 
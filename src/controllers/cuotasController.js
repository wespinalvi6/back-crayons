const Cuota = require('../models/Cuota');

class CuotasController {
  // Listar cuotas del alumno autenticado
  static async listarCuotasAlumno(req, res) {
    try {
      const idPersona = req.user.id_persona;
      if (!idPersona) {
        return res.status(400).json({ status: false, message: 'No se pudo identificar al usuario' });
      }
      const cuotas = await Cuota.listarPorIdPersona(idPersona);
      return res.status(200).json({ status: true, data: cuotas });
    } catch (error) {
      console.error('Error al listar cuotas del alumno:', error);
      return res.status(500).json({ status: false, message: 'Error al listar cuotas', error: error.message });
    }
  }

  // Listar cuotas del alumno autenticado por año
  static async listarCuotasAlumnoPorAnio(req, res) {
    try {
      const idPersona = req.user.id_persona;
      const { anio } = req.params;

      if (!idPersona) {
        return res.status(400).json({ status: false, message: 'No se pudo identificar al usuario' });
      }
      if (!anio) {
        return res.status(400).json({ status: false, message: 'El año es obligatorio' });
      }

      const cuotas = await Cuota.listarPorIdPersonaYAnio(idPersona, anio);
      return res.status(200).json({ status: true, data: cuotas });
    } catch (error) {
      console.error('Error al listar cuotas del alumno por año:', error);
      return res.status(500).json({ status: false, message: 'Error al listar cuotas', error: error.message });
    }
  }

  // Obtener cuotas completas por DNI y año (Para Director)
  static async obtenerCuotasPorDniYAnio(req, res) {
    try {
      const { dni, anio } = req.params;

      if (!dni || !anio) {
        return res.status(400).json({ status: false, message: 'El DNI y el año son obligatorios' });
      }

      const cuotas = await Cuota.buscarPorDniYAnio(dni, anio);

      if (!cuotas || cuotas.length === 0) {
        return res.status(404).json({
          status: false,
          message: `No se encontraron cuotas para el DNI ${dni} en el año ${anio}`
        });
      }

      // Obtener resumen usando la vista si hay al menos una cuota
      const resumen = await Cuota.obtenerResumenPorMatricula(cuotas[0].id_matricula);

      return res.status(200).json({
        status: true,
        data: {
          estudiante: `${cuotas[0].nombres} ${cuotas[0].apellido_paterno} ${cuotas[0].apellido_materno}`,
          grado: cuotas[0].grado,
          anio: anio,
          resumen: resumen,
          detalle: cuotas
        }
      });
    } catch (error) {
      console.error('Error al obtener cuotas por DNI y año:', error);
      return res.status(500).json({
        status: false,
        message: 'Error al obtener las cuotas',
        error: error.message
      });
    }
  }

  // Marcar cuota como pagada
  static async marcarCuotaComoPagada(req, res) {
    try {
      const { id_cuota, monto_pagado, metodo_pago, numero_recibo, observaciones } = req.body;

      if (!id_cuota) {
        return res.status(400).json({ status: false, message: 'El ID de la cuota es obligatorio' });
      }

      const actualizado = await Cuota.registrarPago(
        id_cuota,
        monto_pagado || 0,
        metodo_pago || 'Efectivo',
        numero_recibo || null,
        observaciones || null
      );

      if (!actualizado) {
        return res.status(404).json({ status: false, message: 'No se encontró la cuota o no se pudo actualizar' });
      }

      return res.status(200).json({
        status: true,
        message: 'Cuota marcada como pagada exitosamente'
      });
    } catch (error) {
      console.error('Error al marcar cuota como pagada:', error);
      return res.status(500).json({
        status: false,
        message: 'Error al actualizar el estado de la cuota',
        error: error.message
      });
    }
  }

  // Obtener cuotas por Año, Grado y Estado (Para Director)
  static async obtenerCuotasPorFiltros(req, res) {
    try {
      const { anio, idGrado, estado } = req.params;

      if (!anio || !idGrado || !estado) {
        return res.status(400).json({
          status: false,
          message: 'El año, el grado y el estado son obligatorios'
        });
      }

      const cuotas = await Cuota.buscarPorFiltros(anio, idGrado, estado);

      return res.status(200).json({
        status: true,
        count: cuotas.length,
        data: cuotas
      });
    } catch (error) {
      console.error('Error al obtener cuotas por filtros:', error);
      return res.status(500).json({
        status: false,
        message: 'Error al obtener las cuotas',
        error: error.message
      });
    }
  }
}

module.exports = CuotasController;
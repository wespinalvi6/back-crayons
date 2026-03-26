const axios = require("axios");

const Persona = require("../models/Persona");
const pool = require("../config/database");
const { decrypt } = require("../utils/cryptoUtils");

// Validar token API al cargar el módulo
if (!process.env.RENIEC_API_TOKEN) {
  console.warn("WARN: RENIEC_API_TOKEN no está configurado");
}

const buscarPersonaPorDni = async (req, res) => {
  const { dni } = req.params;

  if (!dni || dni.length !== 8 || !/^\d{8}$/.test(dni)) {
    return res.status(400).json({ status: false, message: "DNI inválido" });
  }

  // Verificar que el token esté configurado
  if (!process.env.RENIEC_API_TOKEN) {
    return res.status(500).json({
      status: false,
      message: "Servicio de consulta no disponible"
    });
  }

  try {
    // 1. Buscar en base de datos local primero
    const connection = await pool.getConnection();
    try {
      const personaLocal = await Persona.buscarPorDni(connection, dni);
      if (personaLocal) {
        return res.json({
          status: true,
          data: {
            nombres: decrypt(personaLocal.nombres),
            apellidoPaterno: decrypt(personaLocal.apellido_paterno),
            apellidoMaterno: decrypt(personaLocal.apellido_materno),
            numeroDocumento: decrypt(personaLocal.dni),
            origen: "local"
          },
        });
      }
    } finally {
      connection.release();
    }

    // 2. Si no existe, buscar en API externa
    const response = await axios.get(
      `https://api.decolecta.com/v1/reniec/dni?numero=${dni}`,
      {
        headers: {
          Authorization: `Bearer ${process.env.RENIEC_API_TOKEN}`,
        },
      }
    );

    return res.json({
      status: true,
      data: response.data,
    });
  } catch (error) {

    if (error.response && error.response.status === 404) {
      return res.status(404).json({
        status: false,
        message: "DNI no encontrado en RENIEC",
      });
    }

    return res.status(500).json({
      status: false,
      message: "Error al buscar persona",
    });
  }
};

module.exports = {
  buscarPersonaPorDni,
};

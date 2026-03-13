const axios = require("axios");

const Persona = require("../models/Persona");
const pool = require("../config/database");
const { decrypt } = require("../utils/cryptoUtils");

const buscarPersonaPorDni = async (req, res) => {
  const { dni } = req.params;

  if (!dni || dni.length !== 8) {
    return res.status(400).json({ status: false, message: "DNI inválido" });
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
          Authorization:
            "Bearer sk_2440.1UO3krDzjhWXoCWcmYRqZ7k2f8IRJBB9",
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

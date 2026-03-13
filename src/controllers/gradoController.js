const Grado = require("../models/Grado");
const { pool } = require("../config/database");

const getGrados = async (req, res) => {
  try {
    // Obtener nivel, grado, sección, capacidad_maxima y descripción de la tabla grados
    const [rows] = await pool.query("SELECT * FROM grados");

    res.json({
      status: true,
      data: rows,
    });
  } catch (error) {
    res.status(500).json({
      status: false,
      message: "Error al obtener grados",
      error: error.message,
    });
  }
};

module.exports = {
  getGrados,
};

const { pool } = require("../config/database");

const getCursos = async (req, res) => {
    try {
        const [rows] = await pool.query("SELECT id, nombre, codigo, descripcion FROM cursos");
        res.json({
            status: true,
            data: rows,
        });
    } catch (error) {
        console.error("Error al obtener cursos:", error);
        res.status(500).json({
            status: false,
            message: "Error al obtener cursos",
            error: error.message,
        });
    }
};

module.exports = {
    getCursos,
};

const { pool } = require("../config/database");

const Role = {
  findById: async (id) => {
    const [rows] = await pool.query("SELECT * FROM roles WHERE id = ?", [id]);
    return rows.length > 0 ? rows[0] : null;
  },

  findAll: async () => {
    const [rows] = await pool.query("SELECT * FROM roles");
    return rows;
  },
};

module.exports = Role;

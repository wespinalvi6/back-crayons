const bcrypt = require("bcryptjs");

const User = {
  // Buscar usuario por email o username (para evitar duplicados al registrar)
  findByEmailOrUsername: async (email, username, connection) => {
    const [rows] = await connection.query(
      "SELECT * FROM users WHERE email = ? OR username = ?",
      [email, username]
    );
    return rows.length > 0 ? rows[0] : null;
  },

  // Buscar usuario por username (para login)
  findByUsername: async (username, connection) => {
    const [rows] = await connection.query(
      "SELECT * FROM users WHERE username = ?",
      [username]
    );
    return rows.length > 0 ? rows[0] : null;
  },

  // Buscar usuario por id
  findById: async (id, connection) => {
    const [rows] = await connection.query("SELECT * FROM users WHERE id = ?", [
      id,
    ]);
    return rows.length > 0 ? rows[0] : null;
  },

  /**
   * Crear nuevo usuario (dentro de una transacción)
   * @param {object} connection - conexión MySQL (transacción activa)
   * @param {object} userData - datos del usuario
   * @param {number} userData.id_persona
   * @param {string} userData.email
   * @param {string} userData.password
   * @param {number} userData.id_rol
   * @param {string} userData.username
   */
  crear: async (
    connection,
    { id_persona, email, password, id_rol, username }
  ) => {
    const [result] = await connection.query(
      `INSERT INTO users (id_persona, email, password, id_rol, username)
       VALUES (?, ?, ?, ?, ?)`,
      [id_persona, email, password, id_rol, username]
    );
    return result.insertId;
  },

  /**
   * Actualizar contraseña (requiere conexión por parámetro)
   * @param {number} id - ID del usuario
   * @param {object} connection - conexión MySQL
   * @param {string} newPassword - nueva contraseña sin hashear
   */
  updatePassword: async (id, connection, newPassword) => {
    if (typeof newPassword !== "string") {
      throw new Error("newPassword debe ser una cadena de texto");
    }

    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(newPassword, salt);

    await connection.query(
      "UPDATE users SET password = ?, cambiar_password = ? WHERE id = ?",
      [hashedPassword, false, id]
    );
  },
};

module.exports = User;

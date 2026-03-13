// actualizar_claves.js
const bcrypt = require('bcryptjs');
const mysql = require('mysql2/promise');
require('dotenv').config();

async function main() {
  // Configuración de conexión (tomada de tu src/config/database.js)
  const connection = await mysql.createConnection({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    port: process.env.DB_PORT
  });

  try {
    console.log("--- Iniciando actualización de contraseñas ---");

    // 1. Obtener todos los usuarios
    const [usuarios] = await connection.query("SELECT id, username FROM users");
    console.log(`Se encontraron ${usuarios.length} usuarios.`);

    for (let u of usuarios) {
      // 2. Usar el username como contraseña y encriptarlo
      const salt = await bcrypt.genSalt(10);
      const hash = await bcrypt.hash(u.username, salt);

      // 3. Actualizar en la base de datos
      await connection.query(
        "UPDATE users SET password = ?, cambiar_password = 0 WHERE id = ?",
        [hash, u.id]
      );

      console.log(`✅ Actualizado: ${u.username}`);
    }

    console.log("--- ¡Proceso completado con éxito! ---");
  } catch (error) {
    console.error("❌ Error:", error);
  } finally {
    await connection.end();
  }
}

main();
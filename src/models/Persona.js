const { encrypt, decrypt, blindIndex } = require("../utils/cryptoUtils");

class PersonaModel {
  static async crear(connection, dni, nombres, apellido_paterno, apellido_materno, fecha_nacimiento, email = null, telefono = null, direccion = null, sexo = null) {
    try {
      const encryptedDni = encrypt(dni);
      const dniHash = blindIndex(dni);
      const encryptedTelefono = encrypt(telefono);
      const telefonoHash = blindIndex(telefono);

      const [result] = await connection.execute(
        `INSERT INTO personas (
          dni, dni_hash, nombres, apellido_paterno, apellido_materno, fecha_nacimiento, 
          email, telefono, telefono_hash, direccion, sexo
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [encryptedDni, dniHash, nombres, apellido_paterno, apellido_materno, fecha_nacimiento, email, encryptedTelefono, telefonoHash, direccion, sexo]
      );
      return result.insertId;
    } catch (error) {
      if (error.code === "ER_DUP_ENTRY") {
        const dniHash = blindIndex(dni);
        const [rows] = await connection.execute(
          "SELECT id FROM personas WHERE dni_hash = ?",
          [dniHash]
        );
        if (rows.length > 0) return rows[0].id;
      }
      throw error;
    }
  }

  static async buscarPorDni(connection, dni) {
    const dniHash = blindIndex(dni);
    const [rows] = await connection.execute(
      "SELECT * FROM personas WHERE dni_hash = ?",
      [dniHash]
    );
    if (rows.length === 0) return null;

    const persona = rows[0];
    persona.dni = decrypt(persona.dni);
    persona.telefono = decrypt(persona.telefono);
    return persona;
  }

  static async buscarPorId(connection, id) {
    const [rows] = await connection.execute(
      "SELECT * FROM personas WHERE id = ?",
      [id]
    );
    if (rows.length === 0) return null;

    const persona = rows[0];
    persona.dni = decrypt(persona.dni);
    persona.telefono = decrypt(persona.telefono);
    return persona;
  }

  static async actualizar(connection, id, dni, nombres, apellido_paterno, apellido_materno, fecha_nacimiento, email, telefono, direccion, sexo = null) {
    const encryptedDni = encrypt(dni);
    const dniHash = blindIndex(dni);
    const encryptedTelefono = encrypt(telefono);
    const telefonoHash = blindIndex(telefono);

    const [result] = await connection.execute(
      `UPDATE personas SET 
        dni = ?, 
        dni_hash = ?,
        nombres = ?, 
        apellido_paterno = ?, 
        apellido_materno = ?, 
        fecha_nacimiento = ?, 
        email = ?,
        telefono = ?,
        telefono_hash = ?,
        direccion = ?,
        sexo = ?,
        updated_at = CURRENT_TIMESTAMP 
      WHERE id = ?`,
      [encryptedDni, dniHash, nombres, apellido_paterno, apellido_materno, fecha_nacimiento, email, encryptedTelefono, telefonoHash, direccion, sexo, id]
    );
    return result.affectedRows > 0;
  }
}

module.exports = PersonaModel;

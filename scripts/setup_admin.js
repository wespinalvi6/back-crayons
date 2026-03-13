require('dotenv').config();
const { pool, withTransaction } = require('../src/config/database');
const Persona = require('../src/models/Persona');
const User = require('../src/models/User');
const bcrypt = require('bcryptjs');

/**
 * Script de configuración inicial del Director (ADMIN)
 */
async function setupAdmin() {
    try {
        await withTransaction(async (connection) => {
            const [existingAdmins] = await connection.query(
                "SELECT id FROM users WHERE id_rol = 1"
            );

            if (existingAdmins.length > 0) {
                process.exit(0);
            }

            const adminData = {
                dni: "12345678",
                nombres: "Wilmer",
                apellido_paterno: "Espinal",
                apellido_materno: "Villanueva",
                fecha_nacimiento: "1990-01-01",
                email: "wilmer@gmail.com",
                username: "admin",
                password: "Password123",
                telefono: "987654321",
                direccion: "Sede Central Colegio"
            };

            const personaId = await Persona.crear(
                connection,
                adminData.dni,
                adminData.nombres,
                adminData.apellido_paterno,
                adminData.apellido_materno,
                adminData.fecha_nacimiento,
                adminData.email,
                adminData.telefono,
                adminData.direccion,
                'M'
            );

            const salt = await bcrypt.genSalt(12);
            const hashedPassword = await bcrypt.hash(adminData.password, salt);

            await User.crear(connection, {
                id_persona: personaId,
                username: adminData.username,
                email: adminData.email,
                password: hashedPassword,
                id_rol: 1
            });
        });
    } catch (error) {
    } finally {
        await pool.end();
    }
}

setupAdmin();

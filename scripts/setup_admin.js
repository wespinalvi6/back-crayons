require('dotenv').config();
const { pool, withTransaction } = require('../src/config/database');
const Persona = require('../src/models/Persona');
const User = require('../src/models/User');
const bcrypt = require('bcryptjs');

/**
 * Script de configuración inicial del Director (ADMIN)
 * Las credenciales deben configurarse via variables de entorno
 */
async function setupAdmin() {
    try {
        // Validar que existan las variables de entorno requeridas
        const requiredEnv = ['ADMIN_DNI', 'ADMIN_NOMBRES', 'ADMIN_APELLIDO_PATERNO', 'ADMIN_EMAIL', 'ADMIN_USERNAME', 'ADMIN_PASSWORD'];
        const missing = requiredEnv.filter(env => !process.env[env]);
        if (missing.length > 0) {
            console.error('Error: Faltan variables de entorno requeridas:', missing.join(', '));
            process.exit(1);
        }

        // Validar fortaleza de contraseña
        const password = process.env.ADMIN_PASSWORD;
        if (password.length < 12) {
            console.error('Error: ADMIN_PASSWORD debe tener al menos 12 caracteres');
            process.exit(1);
        }

        await withTransaction(async (connection) => {
            const [existingAdmins] = await connection.query(
                "SELECT id FROM users WHERE id_rol = 1"
            );

            if (existingAdmins.length > 0) {
                console.log('Ya existe un administrador configurado');
                process.exit(0);
            }

            const adminData = {
                dni: process.env.ADMIN_DNI,
                nombres: process.env.ADMIN_NOMBRES,
                apellido_paterno: process.env.ADMIN_APELLIDO_PATERNO,
                apellido_materno: process.env.ADMIN_APELLIDO_MATERNO || '',
                fecha_nacimiento: process.env.ADMIN_FECHA_NACIMIENTO || '1990-01-01',
                email: process.env.ADMIN_EMAIL,
                username: process.env.ADMIN_USERNAME,
                password: process.env.ADMIN_PASSWORD,
                telefono: process.env.ADMIN_TELEFONO || '000000000',
                direccion: process.env.ADMIN_DIRECCION || 'Sede Central Colegio'
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
            console.log('Administrador configurado con éxito');
        });
    } catch (error) {
        console.error('Error al configurar el administrador:', error);
    } finally {
        await pool.end();
    }
}

setupAdmin();

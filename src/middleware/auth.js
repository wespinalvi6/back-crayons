const jwt = require('jsonwebtoken');

// Validar JWT_SECRET al cargar el módulo
const JWT_SECRET = process.env.JWT_SECRET;

if (!JWT_SECRET) {
    throw new Error('FATAL ERROR: JWT_SECRET no está definida en las variables de entorno.');
}
if (JWT_SECRET.length < 32) {
    throw new Error('FATAL ERROR: JWT_SECRET debe tener al menos 32 caracteres para seguridad adecuada.');
}

const verifyToken = (req, res, next) => {
    const authHeader = req.headers['authorization'];
    const token = authHeader?.split(' ')[1]?.trim();

    if (!token) {
        return res.status(403).json({ message: 'Token no proporcionado' });
    }

    try {
        // Obtenemos el secret dinámicamente asegurando que sea el actual en ejecución
        const secret = process.env.JWT_SECRET;
        const decoded = jwt.verify(token, secret);
        req.user = decoded;
        next();
    } catch (error) {
        return res.status(401).json({ message: 'Token inválido o expirado', error: error.message });
    }
};

const checkChangePasswordRequired = async (req, res, next) => {
    if (req.user.change_password_required) {
        return res.status(403).json({
            message: 'Se requiere cambio de contraseña',
            requirePasswordChange: true
        });
    }
    next();
};

const isDirector = (req, res, next) => {
    // Verificar que el usuario tenga rol de director (Administrador = 1)
    if (req.user.id_rol !== 1) {
        return res.status(403).json({
            message: 'Acceso denegado. Solo los directores pueden realizar esta acción.',
            success: false
        });
    }
    next();
};

const isDocente = (req, res, next) => {
    if (req.user.id_rol !== 2) {
        return res.status(403).json({
            message: 'Acceso denegado. Solo los docentes pueden realizar esta acción.',
            success: false
        });
    }
    next();
};

const isAlumno = (req, res, next) => {
    if (req.user.id_rol !== 3) {
        return res.status(403).json({
            message: 'Acceso denegado. Solo los alumnos pueden realizar esta acción.',
            success: false
        });
    }
    next();
};

const isDocenteOrDirector = (req, res, next) => {
    if (req.user.id_rol !== 1 && req.user.id_rol !== 2) {
        return res.status(403).json({
            message: 'Acceso denegado. No tiene permisos para esta acción.',
            success: false
        });
    }
    next();
};

module.exports = {
    verifyToken,
    checkChangePasswordRequired,
    isDirector,
    isDocente,
    isAlumno
};
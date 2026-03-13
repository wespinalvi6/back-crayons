const jwt = require('jsonwebtoken');

const verifyToken = (req, res, next) => {
    const token = req.headers['authorization']?.split(' ')[1];

    if (!token) {
        return res.status(403).json({ message: 'Token no proporcionado' });
    }

    const secret = process.env.JWT_SECRET;
    if (!secret) {
        return res.status(500).json({ message: 'Error de configuración del servidor' });
    }

    try {
        const decoded = jwt.verify(token, secret);
        req.user = decoded;
        next();
    } catch (error) {
        return res.status(401).json({ message: 'Token inválido o expirado' });
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

module.exports = {
    verifyToken,
    checkChangePasswordRequired,
    isDirector,
    isDocente,
    isAlumno
};
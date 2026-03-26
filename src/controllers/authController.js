const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const User = require("../models/User");
const Role = require("../models/Role");
const pool = require("../config/database");
const { blindIndex } = require("../utils/cryptoUtils");
const AuditService = require("../services/AuditService");

// Registro de usuario
const register = async (req, res) => {
  let connection;

  try {
    connection = await pool.getConnection();
    await connection.beginTransaction();

    const {
      username, email, password, id_rol,
      dni, nombres, apellido_paterno, apellido_materno, fecha_nacimiento,
      telefono, direccion
    } = req.body;

    if (!username || !email || !password || !id_rol || !dni || !nombres || !apellido_paterno || !apellido_materno || !fecha_nacimiento) {
      return res.status(400).json({
        message: "Faltan datos obligatorios: username, email, password, id_rol, dni, nombres, apellido_paterno, apellido_materno, fecha_nacimiento",
      });
    }

    let final_rol = 3;
    if (req.user && req.user.id_rol === 1) {
      final_rol = id_rol;
    }
    const existingUser = await User.findByEmailOrUsername(email, username, connection);
    if (existingUser) {
      await connection.rollback();
      return res.status(400).json({ message: "Usuario o email ya existe" });
    }

    // Verificar si el DNI ya existe
    const [existingDNI] = await connection.query(
      "SELECT id FROM personas WHERE dni_hash = ?",
      [blindIndex(dni)]
    );
    if (existingDNI.length > 0) {
      await connection.rollback();
      return res.status(400).json({ message: "El DNI ya está registrado" });
    }

    // Verificar que el rol existe
    const role = await Role.findById(id_rol, connection);
    if (!role) {
      await connection.rollback();
      return res.status(400).json({ message: "Rol no válido" });
    }

    // 1. Crear persona
    const [personaResult] = await connection.query(
      `INSERT INTO personas (
        dni, nombres, apellido_paterno, apellido_materno, fecha_nacimiento,
        email, telefono, direccion
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        dni,
        nombres,
        apellido_paterno,
        apellido_materno,
        fecha_nacimiento,
        email,
        telefono || null,
        direccion || null
      ]
    );

    const id_persona = personaResult.insertId;

    // 2. Crear usuario
    const salt = await bcrypt.genSalt(12);
    const hashedPassword = await bcrypt.hash(password, salt);

    const userId = await User.crear(connection, {
      id_persona,
      username,
      email,
      password: hashedPassword,
      id_rol: final_rol,
    });

    await connection.commit();

    res.status(201).json({
      message: "Usuario registrado exitosamente",
      userId,
      id_persona,
      username
    });

  } catch (error) {
    if (connection) await connection.rollback();
    console.error("Error en registro:", error);
    res.status(500).json({
      message: "Error en el servidor",
      error: error.message
    });
  } finally {
    if (connection) connection.release();
  }
};

// Login
const login = async (req, res) => {
  let connection;
  try {
    connection = await pool.getConnection();
    const { username, password } = req.body;

    if (!username || !password) {
      return res
        .status(400)
        .json({ message: "Username y password son obligatorios" });
    }

    const user = await User.findByUsername(username, connection);

    // Función de error genérico para evitar enumeración de usuarios
    const handleLoginFailure = async (reason, userId = null) => {
      await AuditService.log({
        userId,
        action: 'LOGIN_FAILURE',
        details: { username, reason },
        ipAddress: req.ip
      });
      return res.status(401).json({ message: "Usuario o contraseña incorrectos" });
    };

    // 1. Verificar existencia del usuario
    if (!user) {
      return await handleLoginFailure('User not found');
    }

    // 2. Verificar contraseña
    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) {
      return await handleLoginFailure('Incorrect password', user.id);
    }

    // 3. Verificar si el usuario está activo (SOLO después de validar la contraseña)
    // Opcional: Podrías usar el mismo mensaje genérico para que un atacante no sepa 
    // si la contraseña fue correcta en una cuenta desactivada.
    if (user.hasOwnProperty('activo') && user.activo === 0) {
      return await handleLoginFailure('User inactive', user.id);
    }

    const accessTokenSecret = process.env.JWT_SECRET;
    console.log('JWT_SECRET en login (longitud):', accessTokenSecret?.length);
    console.log('JWT_SECRET en login (primeros 10 chars):', accessTokenSecret?.substring(0, 10));
    if (!accessTokenSecret) {
      console.error('CRITICAL: JWT_SECRET no definida en el entorno.');
      return res.status(500).json({ message: "Error interno del servidor" });
    }

    if (user.cambiar_password) {
      const resetToken = jwt.sign(
        { id: user.id, id_persona: user.id_persona, username: user.username, id_rol: user.id_rol, change_password_required: true },
        accessTokenSecret,
        { expiresIn: "50m" }
      );
      return res.status(403).json({
        message: "Debe cambiar su contraseña antes de continuar",
        cambiar_password: true,
        token: resetToken
      });
    }

    // Access Token: TTL corto (15 min)
    const accessToken = jwt.sign(
      { id: user.id, id_persona: user.id_persona, username: user.username, id_rol: user.id_rol },
      accessTokenSecret,
      { expiresIn: "15m" }
    );

    await AuditService.log({
      userId: user.id,
      action: 'LOGIN_SUCCESS',
      details: { username: user.username, roleId: user.id_rol },
      ipAddress: req.ip
    });

    // Refresh Token: Opaco y persistente (7 días)
    const crypto = require('crypto');
    const refreshToken = crypto.randomBytes(40).toString('hex');
    const refreshTokenHash = crypto.createHash('sha256').update(refreshToken).digest('hex');
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + 7);

    // Guardar en DB
    await connection.query(
      "INSERT INTO refresh_tokens (id_usuario, token_hash, expira_en, ip_creacion) VALUES (?, ?, ?, ?)",
      [user.id, refreshTokenHash, expiresAt, req.ip]
    );

    // Enviar Refresh Token en cookie segura
    res.cookie('refreshToken', refreshToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'Strict',
      maxAge: 7 * 24 * 60 * 60 * 1000
    });

    // Actualizar FCM Token si viene en la petición
    if (req.body.fcm_token) {
      await connection.query("UPDATE users SET fcm_token = ? WHERE id = ?", [req.body.fcm_token, user.id]);
    }

    res.json({ token: accessToken, roleId: user.id_rol });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Error en el servidor" });
  } finally {
    if (connection) connection.release();
  }
};

const refreshToken = async (req, res) => {
  const token = req.cookies.refreshToken;
  if (!token) return res.status(401).json({ message: "No refresh token provided" });

  let connection;
  try {
    connection = await pool.getConnection();
    const crypto = require('crypto');
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');

    const [rows] = await connection.query(
      `SELECT rt.*, u.id_persona, u.username, u.id_rol 
       FROM refresh_tokens rt 
       JOIN users u ON rt.id_usuario = u.id 
       WHERE rt.token_hash = ? AND rt.revocado = 0 AND rt.expira_en > NOW()`,
      [tokenHash]
    );

    if (rows.length === 0) {
      await AuditService.log({
        action: 'TOKEN_REFRESH_FAILURE',
        details: { token_hash: tokenHash, reason: 'Invalid or expired' },
        ipAddress: req.ip
      });
      return res.status(403).json({ message: "Invalid or expired refresh token" });
    }

    const user = rows[0];

    // Rotación de Token: Revocar el actual y emitir uno nuevo
    await connection.query("UPDATE refresh_tokens SET revocado = 1 WHERE id = ?", [user.id]);

    const newAccessToken = jwt.sign(
      { id: user.id_usuario, id_persona: user.id_persona, username: user.username, id_rol: user.id_rol },
      process.env.JWT_SECRET,
      { expiresIn: "15m" }
    );

    const newRefreshToken = crypto.randomBytes(40).toString('hex');
    const newRefreshTokenHash = crypto.createHash('sha256').update(newRefreshToken).digest('hex');
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + 7);

    await connection.query(
      "INSERT INTO refresh_tokens (id_usuario, token_hash, expira_en, ip_creacion) VALUES (?, ?, ?, ?)",
      [user.id_usuario, newRefreshTokenHash, expiresAt, req.ip]
    );

    res.cookie('refreshToken', newRefreshToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'Strict',
      maxAge: 7 * 24 * 60 * 60 * 1000
    });

    res.json({ token: newAccessToken });
  } catch (error) {
    console.error("Error en refresh token:", error);
    res.status(500).json({ message: "Internal server error" });
  } finally {
    if (connection) connection.release();
  }
};

const changePassword = async (req, res) => {
  let connection;
  try {
    connection = await pool.getConnection();
    const { username, email, password, newPassword, repeatPassword } = req.body;

    if (!username || !email || !password || !newPassword || !repeatPassword) {
      return res
        .status(400)
        .json({ message: "Todos los campos son obligatorios" });
    }

    if (newPassword !== repeatPassword) {
      return res
        .status(400)
        .json({ message: "Las nuevas contraseñas no coinciden" });
    }

    const user = await User.findByEmailOrUsername(email, username, connection);
    if (!user || user.username !== username || user.email !== email) {
      return res
        .status(404)
        .json({ message: "Usuario no encontrado o credenciales inválidas" });
    }

    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) {
      return res.status(400).json({ message: "Contraseña actual incorrecta" });
    }

    // CORRECCIÓN: El orden de parámetros aquí debe coincidir con la función updatePassword
    await User.updatePassword(user.id, connection, newPassword);

    // Vuln #9: Revocar TODOS los refresh tokens del usuario por seguridad
    await connection.query("UPDATE refresh_tokens SET revocado = 1 WHERE id_usuario = ?", [user.id]);

    return res.json({ message: "Contraseña actualizada exitosamente. Todas sus sesiones previas han sido cerradas por seguridad." });
  } catch (error) {
    console.error("Error al cambiar la contraseña:", error);
    return res.status(500).json({ message: "Error en el servidor" });
  } finally {
    if (connection) connection.release();
  }
};

const logout = async (req, res) => {
  try {
    const token = req.cookies.refreshToken;
    if (token) {
      let connection;
      try {
        connection = await pool.getConnection();
        const crypto = require('crypto');
        const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
        await connection.query("UPDATE refresh_tokens SET revocado = 1 WHERE token_hash = ?", [tokenHash]);
      } finally {
        if (connection) connection.release();
      }
    }

    res.clearCookie('refreshToken', {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'Strict'
    });

    res.json({
      message: "Sesión cerrada exitosamente",
      success: true
    });
  } catch (error) {
    console.error("Error en logout:", error);
    res.status(500).json({
      message: "Error al cerrar sesión",
      success: false
    });
  }
};

module.exports = {
  register,
  login,
  refreshToken,
  changePassword,
  logout,
};

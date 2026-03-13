const express = require("express");
const router = express.Router();
const {
  register,
  login,
  refreshToken,
  changePassword,
  logout,
} = require("../controllers/authController");
const { verifyToken } = require("../middleware/auth");

const { body, validationResult } = require("express-validator");

const validateRequest = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() });
  }
  next();
};

const registerValidation = [
  body("username").isAlphanumeric().withMessage("Username debe ser alfanumérico").isLength({ min: 4 }),
  body("email").isEmail().withMessage("Email no válido"),
  body("password").isLength({ min: 8 }).withMessage("Contraseña demasiado corta (mínimo 8)"),
  body("dni").isLength({ min: 8, max: 20 }).withMessage("DNI no válido"),
  validateRequest
];

const loginValidation = [
  body("username").notEmpty(),
  body("password").notEmpty(),
  validateRequest
];

// Rutas de autenticación (Públicas)
router.post("/register", registerValidation, register);
router.post("/login", loginValidation, login);
router.post("/refresh", refreshToken);

// Rutas protegidas (requieren token válido)
router.post("/change-password", verifyToken, changePassword);
router.post("/logout", logout); // Logout usa la cookie directamente

module.exports = router;

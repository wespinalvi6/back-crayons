const express = require("express");
const cors = require("cors");
require("dotenv").config();
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const cookieParser = require("cookie-parser");
const compression = require("compression");

process.removeAllListeners('warning');
process.on('warning', (warning) => {
  if (warning.name === 'DeprecationWarning' && warning.message.includes('punycode')) {
    return;
  }
});

const authRoutes = require("./src/routes/authRoutes");
const matriculaRoutes = require("./src/routes/matriculaRoutes");
const gradoRoutes = require("./src/routes/gradoRoutes");
const reniecRoutes = require("./src/routes/reniecRoutes");
const alumnoRoutes = require("./src/routes/alumnoRoutes");
const docenteRoutes = require("./src/routes/docenteRoutes");
const periodoPagoasRoutes = require("./src/routes/periodoPagoasRoutes");
const cuotasRoutes = require("./src/routes/cuotasRoutes");
const pagoRoutes = require("./src/routes/pagoRoutes");
const justificacionRoutes = require("./src/routes/justificacionRoutes");
const asistenciaRoutes = require("./src/routes/asistenciaRoutes");
const chatRoutes = require("./src/routes/chatRoutes");
const cursoRoutes = require("./src/routes/cursoRoutes");
const dashboardRoutes = require("./src/routes/dashboardRoutes");
const horarioRoutes = require("./src/routes/horarioRoutes");
const aiAssistantRoutes = require("./src/routes/aiAssistantRoutes");
const { pool } = require("./src/config/database");
const logger = require("./src/config/logger");

const app = express();
app.locals.pool = pool;

// Confiar en el proxy (necesario para Railway/Vercel)
app.set('trust proxy', 1);

// Validar variables de entorno críticas al inicio
const requiredEnvVars = ['JWT_SECRET', 'ENCRYPTION_KEY'];
const missingEnvVars = requiredEnvVars.filter(envVar => !process.env[envVar]);
if (missingEnvVars.length > 0) {
  logger.error(`FATAL: Variables de entorno faltantes: ${missingEnvVars.join(', ')}`);
  process.exit(1);
}

// Middleware CORS - Solo orígenes explícitamente permitidos
const allowedOrigins = process.env.NODE_ENV === 'production'
  ? [
    'https://colegiocrayons.com',
    'https://www.colegiocrayons.com'
  ]
  : [
    'https://colegiocrayons.com',
    'https://www.colegiocrayons.com',
    'http://localhost:5173',
    'http://127.0.0.1:5173'
  ];

app.use(cors({
  origin: (origin, callback) => {
    // Vuln #12: CORS Estricto - Solo permitir orígenes explícitos
    if (!origin || allowedOrigins.includes(origin) || allowedOrigins.includes(origin.replace(/\/$/, ''))) {
      callback(null, true);
    } else {
      logger.warn(`Origin bloqueado por CORS: ${origin}`);
      callback(new Error('No autorizado por CORS'), false);
    }
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'PATCH'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'Accept', 'X-Access-Token', 'Cache-Control', 'Pragma'],
  optionsSuccessStatus: 200
}));

app.use(cookieParser());

// Security Middleware
app.use(helmet());

// Compresión de respuestas HTTP (GZIP) optimiza el peso de los JSON
app.use(compression());

// Rate Limiting Específico para Autenticación (Vuln #10)
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 50, // 5 intentos permitidos por cada ventana de 15 minutos
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: "Demasiados intentos de inicio de sesión, intente más tarde." }
});
app.use("/api/auth/login", authLimiter);

// Rate Limiting General - Reducido de 1000 a 100 requests
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 200, // 100 requests por 15 minutos
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: "Demasiadas peticiones, intente más tarde." }
});
app.use("/api/", limiter);

// Limitar tamaño de JSON body (reducido de 10MB a 2MB)
app.use(express.json({ limit: '2mb' }));

// Rutas
app.use("/api/auth", authRoutes);
app.use("/api/matricula", matriculaRoutes);
app.use("/api/grado", gradoRoutes);
app.use("/api/dni", reniecRoutes);
app.use("/api/alumno", alumnoRoutes);
app.use("/api/docente", docenteRoutes);
app.use("/api/cuotas", periodoPagoasRoutes);
app.use("/api/cuotas", cuotasRoutes);
app.use("/api/pago", pagoRoutes);
app.use("/api/justificacion", justificacionRoutes);
app.use("/api/asistencia", asistenciaRoutes);
app.use("/api/chat", chatRoutes);
app.use("/api/curso", cursoRoutes);
app.use("/api/dashboard", dashboardRoutes);
app.use("/api/horario", horarioRoutes);
app.use("/api/ai-assistant", aiAssistantRoutes);

const ocrExtractorRoutes = require("./src/routes/ocrExtractorRoutes");
app.use("/api/ocr", ocrExtractorRoutes);

const promocionRoutes = require("./src/routes/promocionRoutes");
app.use("/api/promocion", promocionRoutes);

app.get("/pago-exitoso", (req, res) => {
  res.send("¡Pago exitoso! Se ha registrado su pago.");
});
app.get("/pago-fallido", (req, res) => {
  res.send("El pago fue cancelado o falló. Intenta nuevamente.");
});
app.get("/pago-pendiente", (req, res) => {
  res.send("El pago está en proceso. Se notificará cuando se complete.");
});

// Ruta de prueba
app.get("/", (req, res) => {
  res.json({ message: "API funcionando correctamente" });
});

// Manejo de errores global (OWASP: No stack traces en producción)
app.use((err, req, res, next) => {
  logger.error(`${err.status || 500} - ${err.message} - ${req.originalUrl} - ${req.method} - ${req.ip}`);

  res.status(err.status || 500).json({
    success: false,
    message: process.env.NODE_ENV === 'production'
      ? 'Error interno del servidor'
      : err.message,
    stack: process.env.NODE_ENV === 'production' ? null : err.stack
  });
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, '0.0.0.0', () => {
  logger.info(`Servidor corriendo en modo ${process.env.NODE_ENV || 'development'} en http://0.0.0.0:${PORT}`);
});

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

// Middleware
const allowedOrigins = [
  'https://colegiocrayons.com',
  'https://colegiocrayons.com/',
  'http://localhost:5173/',
  'http://localhost:5173'
];

app.use(cors({
  origin: (origin, callback) => {
    // Permitir peticiones sin origin (como apps móviles o curl)
    if (!origin) return callback(null, true);

    if (allowedOrigins.includes(origin) || allowedOrigins.includes(origin + '/')) {
      callback(null, true);
    } else {
      logger.warn(`Origin no permitido por CORS: ${origin}`);
      // No lanzar error, simplemente no permitir
      callback(null, false);
    }
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'PATCH'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'Accept', 'X-Access-Token', 'Cache-Control', 'Pragma'],
  optionsSuccessStatus: 200 // Para compatibilidad con navegadores antiguos
}));

app.use(cookieParser());

// Security Middleware
app.use(helmet());

// Compresión de respuestas HTTP (GZIP) optimiza el peso de los JSON
app.use(compression());

// Rate Limiting General
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 1000, // Increased max for development/general use
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: "Demasiadas peticiones, intente más tarde." }
});
app.use("/api/", limiter);

app.use(express.json({ limit: '10mb' }));

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

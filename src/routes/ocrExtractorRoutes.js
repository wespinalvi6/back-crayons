const express = require('express');
const router = express.Router();
const multer = require('multer');
const ocrController = require('../controllers/ocrExtractorController');

// Configuración de Multer (Memoria)
const storage = multer.memoryStorage();
const upload = multer({
    storage: storage,
    limits: { fileSize: 5 * 1024 * 1024 }, // 5MB
    fileFilter: (req, file, cb) => {
        if (file.mimetype === 'application/pdf') {
            cb(null, true);
        } else {
            cb(new Error('Solo se permiten archivos PDF para OCR'));
        }
    }
});

// Rutas
router.post('/extraer-n8n', upload.single('file'), ocrController.extraerConN8N);

module.exports = router;

const axios = require('axios');
const FormData = require('form-data');

/**
 * ENVIAR A n8n Y OBTENER RESULTADO
 */
exports.extraerConN8N = async (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ error: "No se subió archivo" });

        const formData = new FormData();
        formData.append('file', req.file.buffer, {
            filename: req.file.originalname,
            contentType: req.file.mimetype,
        });

        const response = await axios.post('http://localhost:5678/webhook-test/upload-pdf', formData, {
            headers: { ...formData.getHeaders() }
        });

        // n8n suele devolver un array. Tomamos el primer elemento para que el JSON sea directo.
        const output = Array.isArray(response.data) ? response.data[0] : response.data;

        res.json({ success: true, datos: output });

    } catch (error) {
        res.status(500).json({ success: false, error: "Error al procesar con n8n" });
    }
};
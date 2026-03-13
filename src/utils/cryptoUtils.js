const crypto = require('crypto');

// En producción, ENCRYPTION_KEY debe ser una cadena de 32 bytes o más guardada en .env
const ALGORITHM = 'aes-256-gcm';
const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'a_very_secret_key_of_32_characters_'; // Fallback solo para dev
const KEY = crypto.scryptSync(ENCRYPTION_KEY, 'salt', 32);

/**
 * Cifra un texto usando AES-256-GCM.
 * Retorna formato iv:tag:content
 */
function encrypt(text) {
    if (!text) return null;
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv(ALGORITHM, KEY, iv);
    let encrypted = cipher.update(text, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    const tag = cipher.getAuthTag().toString('hex');
    return `${iv.toString('hex')}:${tag}:${encrypted}`;
}

/**
 * Descifra un texto en formato iv:tag:content
 */
function decrypt(encryptedText) {
    if (!encryptedText || !encryptedText.includes(':')) return encryptedText;
    try {
        const [ivHex, tagHex, encryptedData] = encryptedText.split(':');
        const iv = Buffer.from(ivHex, 'hex');
        const tag = Buffer.from(tagHex, 'hex');
        const decipher = crypto.createDecipheriv(ALGORITHM, KEY, iv);
        decipher.setAuthTag(tag);
        let decrypted = decipher.update(encryptedData, 'hex', 'utf8');
        decrypted += decipher.final('utf8');
        return decrypted;
    } catch (err) {
        // Si falla, asumimos que no estaba cifrado (migración progresiva)
        return encryptedText;
    }
}

/**
 * Genera un blind index (hash) para búsqueda rápida sin revelar el contenido.
 */
function blindIndex(text) {
    if (!text) return null;
    return crypto.createHmac('sha256', KEY).update(text).digest('hex');
}

module.exports = { encrypt, decrypt, blindIndex };

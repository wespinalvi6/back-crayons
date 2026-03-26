const crypto = require('crypto');

const ALGORITHM = 'aes-256-gcm';

// Siempre requerir ENCRYPTION_KEY - no hay fallback
if (!process.env.ENCRYPTION_KEY) {
    throw new Error('FATAL ERROR: ENCRYPTION_KEY no está definida. Configure la variable de entorno ENCRYPTION_KEY.');
}

const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY;

// Validar longitud de la clave (debe ser exactamente 32 caracteres para scrypt)
if (ENCRYPTION_KEY.length < 32) {
    throw new Error('FATAL ERROR: ENCRYPTION_KEY debe tener al menos 32 caracteres.');
}

// Key derivada con la clave maestra actual
const CURRENT_OLD_KEY = crypto.scryptSync(ENCRYPTION_KEY, 'salt', 32);

// Key generada con el texto duro original para soportar registros viejos de desarrollo
const FALLBACK_OLD_KEY = crypto.scryptSync('a_very_secret_key_of_32_characters_', 'salt', 32);

/**
 * Cifra un texto usando AES-256-GCM y un salt dinámico.
 * Retorna formato salt:iv:tag:content
 */
function encrypt(text) {
    if (!text) return null;
    const salt = crypto.randomBytes(16);
    const key = crypto.scryptSync(ENCRYPTION_KEY, salt, 32);
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv(ALGORITHM, key, iv);

    let encrypted = cipher.update(text, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    const tag = cipher.getAuthTag().toString('hex');

    return `${salt.toString('hex')}:${iv.toString('hex')}:${tag}:${encrypted}`;
}

/**
 * Intenta descifrar usando una llave específica. Devuelve null si falla.
 */
function attemptDecryption(key, ivHex, tagHex, encryptedData) {
    try {
        const iv = Buffer.from(ivHex, 'hex');
        const tag = Buffer.from(tagHex, 'hex');
        const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);

        decipher.setAuthTag(tag);
        let decrypted = decipher.update(encryptedData, 'hex', 'utf8');
        decrypted += decipher.final('utf8');
        return decrypted;
    } catch (e) {
        return null;
    }
}

/**
 * Descifra un texto en formato nuevo (salt:iv:tag:content)
 * o antiguo (iv:tag:content).
 */
function decrypt(encryptedText) {
    if (!encryptedText || typeof encryptedText !== 'string' || !encryptedText.includes(':')) return encryptedText;

    const parts = encryptedText.split(':');
    let ivHex, tagHex, encryptedData, salt;

    if (parts.length === 4) {
        // Formato nuevo: salt:iv:tag:content
        salt = Buffer.from(parts[0], 'hex');
        ivHex = parts[1];
        tagHex = parts[2];
        encryptedData = parts[3];

        const key = crypto.scryptSync(ENCRYPTION_KEY, salt, 32);
        const result = attemptDecryption(key, ivHex, tagHex, encryptedData);
        if (result !== null) return result;

    } else if (parts.length === 3) {
        // Formato antiguo: iv:tag:content
        [ivHex, tagHex, encryptedData] = parts;

        // 1. Intentar con la clave actual
        let result = attemptDecryption(CURRENT_OLD_KEY, ivHex, tagHex, encryptedData);
        if (result !== null) return result;

        // 2. Intentar con el fallback duro original (para datos viejos de desarrollo)
        result = attemptDecryption(FALLBACK_OLD_KEY, ivHex, tagHex, encryptedData);
        if (result !== null) return result;
    }

    // En caso de corrupción, asumimos que no estaba cifrado (migración progresiva)
    return encryptedText;
}

/**
 * Genera un blind index (hash) para búsqueda rápida sin revelar el contenido.
 * Nota: Debe usar la OLD_KEY determinística para que las búsquedas DB funcionen,
 * ya que un salt aleatorio haría imposible las consultas de coincidencia exacta en SQL.
 */
function blindIndex(text) {
    if (!text) return null;
    return crypto.createHmac('sha256', CURRENT_OLD_KEY).update(text).digest('hex');
}

module.exports = { encrypt, decrypt, blindIndex };

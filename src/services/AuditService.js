const { pool } = require('../config/database');

const AuditService = {
    log: async ({ userId, action, details, ipAddress }) => {
        try {
            const sql = `INSERT INTO audit_logs (user_id, action, details, ip_address) VALUES (?, ?, ?, ?)`;
            await pool.query(sql, [userId || null, action, JSON.stringify(details), ipAddress || null]);
        } catch (error) {
        }
    }
};

module.exports = AuditService;

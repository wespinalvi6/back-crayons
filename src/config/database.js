// config/database.js
const mysql = require("mysql2");

const pool = mysql.createPool({
  host: process.env.DB_HOST || "localhost",
  user: process.env.DB_USER || "wilmer",
  password: process.env.DB_PASSWORD || "123456",
  database: process.env.DB_NAME || "db_crayons",
  port: process.env.DB_PORT || 3306,
  waitForConnections: true,
  connectionLimit: 50, // Optimizado para producción (hasta 50 conexiones simultáneas)
  queueLimit: 0,
  timezone: "-05:00",
});

const promisePool = pool.promise();

async function withTransaction(callback) {
  const connection = await promisePool.getConnection();
  try {
    await connection.beginTransaction();
    const result = await callback(connection);
    await connection.commit();
    return result;
  } catch (err) {
    await connection.rollback();
    throw err;
  } finally {
    connection.release();
  }
}

module.exports = {
  pool: promisePool,
  withTransaction,
  getConnection: () => promisePool.getConnection(),
};

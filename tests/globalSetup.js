/** Creates the test database and runs migrations once before all tests. */
export async function setup() {
  process.env.NODE_ENV = 'test';
  const { env } = await import('../src/config/env.js');
  const mysql = (await import('mysql2/promise')).default;
  const conn = await mysql.createConnection({ host: env.db.host, port: env.db.port, user: env.db.user, password: env.db.password });
  await conn.query(`CREATE DATABASE IF NOT EXISTS \`${env.db.database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
  await conn.end();

  const { db } = await import('../src/config/db.js');
  await db.migrate.latest();
  await db.destroy();
}

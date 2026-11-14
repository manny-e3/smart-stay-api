import { env } from './src/config/env.js';

/**
 * JSON columns in the schema. MariaDB (XAMPP) stores JSON as LONGTEXT and returns it as text,
 * so these columns are parsed by name. MySQL 8 reports a real JSON type and is handled below too.
 */
const JSON_COLUMNS = new Set(['config', 'state', 'payload', 'data', 'details', 'value', 'keys', 'target', 'conditions', 'actions', 'capabilities', 'preferences']);
const TEXT_TYPES = new Set(['BLOB', 'VAR_STRING', 'STRING']);

const parseJson = (text) => {
  if (text === null) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
};

// Cloud MySQL hosts (and proxies in front of them) silently drop idle TCP connections, which later
// surface as "read ECONNRESET" / "connection is in closed state". TCP keep-alive keeps live ones open.
const keepAlive = { enableKeepAlive: true, keepAliveInitialDelay: 10000 };

const connection = env.db.url
  ? {
      uri: env.db.url,
      ...keepAlive,
      ...(env.db.ssl ? { ssl: env.db.ssl } : {}),
      timezone: 'Z',
      typeCast(field, next) {
        if (field.type === 'TINY' && field.length === 1) {
          const v = field.string();
          return v === null ? null : v === '1';
        }
        if (field.type === 'JSON' || (TEXT_TYPES.has(field.type) && JSON_COLUMNS.has(field.name))) {
          return parseJson(field.string('utf8'));
        }
        if (field.type === 'NEWDECIMAL') {
          const v = field.string();
          return v === null ? null : Number(v);
        }
        return next();
      },
    }
  : {
      host: env.db.host,
      port: env.db.port,
      user: env.db.user,
      password: env.db.password,
      database: env.db.database,
      ...keepAlive,
      ...(env.db.ssl ? { ssl: env.db.ssl } : {}),
      timezone: 'Z',
      typeCast(field, next) {
        if (field.type === 'TINY' && field.length === 1) {
          const v = field.string();
          return v === null ? null : v === '1';
        }
        if (field.type === 'JSON' || (TEXT_TYPES.has(field.type) && JSON_COLUMNS.has(field.name))) {
          return parseJson(field.string('utf8'));
        }
        if (field.type === 'NEWDECIMAL') {
          const v = field.string();
          return v === null ? null : Number(v);
        }
        return next();
      },
    };

const config = {
  client: 'mysql2',
  connection,
  // Close pooled connections after 30s idle, before the database server times them out,
  // so the pool never hands out a connection the server has already closed.
  // DB_POOL_MAX: shared hosts (e.g. Hostinger) cap connections per MySQL user across ALL apps using it.
  pool: {
    min: 0,
    max: Math.max(1, Number(process.env.DB_POOL_MAX) || 10),
    idleTimeoutMillis: 30000,
    reapIntervalMillis: 5000,
  },
  migrations: { directory: './db/migrations', loadExtensions: ['.js'] },
  seeds: { directory: './db/seeds', loadExtensions: ['.js'] },
};

export default config;

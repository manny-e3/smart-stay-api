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

const config = {
  client: 'mysql2',
  connection: {
    ...env.db,
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
  },
  pool: { min: 0, max: 10 },
  migrations: { directory: './db/migrations', loadExtensions: ['.js'] },
  seeds: { directory: './db/seeds', loadExtensions: ['.js'] },
};

export default config;

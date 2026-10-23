import fs from 'node:fs';
import { parse } from 'csv-parse/sync';
import { db } from '../src/config/db.js';

export function readCsv(file) {
  if (!file || !fs.existsSync(file)) {
    console.error(`File not found: ${file ?? '(none given)'}`);
    process.exit(1);
  }
  return parse(fs.readFileSync(file), { columns: (h) => h.map((c) => c.trim().toLowerCase()), skip_empty_lines: true, trim: true, bom: true });
}

/** The admin whose name goes in the audit log for script actions. */
export async function scriptActor() {
  const admin = await db('staff').where({ role: 'admin', is_active: true }).orderBy('id').first('id');
  if (!admin) throw new Error('No active admin found. Run "npm run seed" first.');
  return { id: admin.id, ip: 'script' };
}

export async function run(main) {
  try {
    await main();
  } catch (err) {
    console.error(err.details ? `${err.message}:\n${err.details.map((d) => ` - ${d.message}`).join('\n')}` : err);
    process.exitCode = 1;
  } finally {
    await db.destroy();
  }
}

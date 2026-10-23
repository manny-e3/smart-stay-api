/**
 * Creates staff accounts in bulk for the pilot.
 *
 *   node scripts/import-staff.js staff.csv
 *
 * Columns: name, email, role, password (optional)
 * Roles: service, maintenance, front_desk, manager, admin.
 * When password is empty a temporary one is generated and printed once.
 * Accounts whose email already exists are skipped.
 */
import crypto from 'node:crypto';
import { readCsv, scriptActor, run } from './_util.js';
import { createStaff } from '../src/modules/staff/staff.service.js';
import { ROLES } from '../src/core/permissions.js';

const tempPassword = () => `${crypto.randomBytes(6).toString('base64url')}${crypto.randomInt(10, 99)}`;

run(async () => {
  const rows = readCsv(process.argv[2]);
  const actor = await scriptActor();
  const created = [];
  for (const [i, r] of rows.entries()) {
    if (!ROLES.includes(r.role)) {
      console.warn(`Line ${i + 2}: skipped ${r.email}, unknown role "${r.role}"`);
      continue;
    }
    const password = r.password || tempPassword();
    try {
      await createStaff({ name: r.name, email: r.email, role: r.role, password }, actor);
      created.push({ name: r.name, email: r.email, role: r.role, password: r.password ? '(from file)' : password });
    } catch (err) {
      console.warn(`Line ${i + 2}: skipped ${r.email}: ${err.message}`);
    }
  }
  console.table(created);
  console.log(`${created.length} account(s) created. Share temporary passwords privately and ask staff to change them.`);
});

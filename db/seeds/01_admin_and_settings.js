import bcrypt from 'bcryptjs';
import { env } from '../../src/config/env.js';
import { DEFAULT_SETTINGS } from '../../src/modules/settings/settings.service.js';

/** Creates the first admin from ADMIN_* env values and default settings. Safe to run again. */
export async function seed(knex) {
  const existing = await knex('staff').where({ email: env.admin.email.toLowerCase() }).first('id');
  if (!existing) {
    await knex('staff').insert({
      name: env.admin.name,
      email: env.admin.email.toLowerCase(),
      role: 'admin',
      password_hash: await bcrypt.hash(env.admin.password, 12),
    });
    console.log(`Created admin ${env.admin.email}. Change the password after first login.`);
  }

  for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
    await knex('settings').insert({ key, value: JSON.stringify(value) }).onConflict('key').ignore();
  }
}

import { db, paginate } from '../../config/db.js';
import { audit } from '../../core/audit.js';
import { badRequest, conflict, notFound } from '../../core/errors.js';
import { disconnectStaff } from '../../core/sockets.js';
import { hashPassword, isStrongPassword, PASSWORD_RULES, publicStaff, revokeAllSessions } from '../auth/auth.service.js';

export async function listStaff({ role, active, q, page, limit }) {
  const query = db('staff').select('*').orderBy('name');
  if (role) query.where({ role });
  if (active !== undefined) query.where({ is_active: active });
  if (q) query.where((w) => w.whereILike('name', `%${q}%`).orWhereILike('email', `%${q}%`));
  const result = await paginate(query, { page, limit });
  return { ...result, items: result.items.map(publicStaff) };
}

export async function getStaff(id) {
  const staff = await db('staff').where({ id }).first();
  if (!staff) throw notFound('Staff member');
  return publicStaff(staff);
}

export async function createStaff({ name, email, role, password }, actor) {
  if (!isStrongPassword(password)) throw badRequest(`Password must be ${PASSWORD_RULES}`);
  const exists = await db('staff').whereRaw('LOWER(email) = ?', [email.toLowerCase()]).first('id');
  if (exists) throw conflict('A staff account with this email already exists');
  return db.transaction(async (trx) => {
    const [id] = await trx('staff').insert({ name, email: email.toLowerCase(), role, password_hash: await hashPassword(password) });
    await audit({ actor: { type: 'staff', id: actor.id }, action: 'staff.create', entityType: 'staff', entityId: id, details: { name, email, role }, ip: actor.ip }, trx);
    return publicStaff(await trx('staff').where({ id }).first());
  });
}

async function activeAdminCount(trx, excludeId) {
  const row = await trx('staff').where({ role: 'admin', is_active: true }).whereNot({ id: excludeId }).count({ n: '*' }).first();
  return Number(row.n);
}

/** Edits name, email, role, active flag; can reset password or one-time code. */
export async function updateStaff(id, input, actor) {
  const staff = await db('staff').where({ id }).first();
  if (!staff) throw notFound('Staff member');

  const losesAdmin = staff.role === 'admin' && staff.is_active && ((input.role && input.role !== 'admin') || input.isActive === false);
  if (id === actor.id && (input.isActive === false || (input.role && input.role !== staff.role))) {
    throw badRequest('You cannot deactivate your own account or change your own role');
  }

  const patch = {};
  const changes = {};
  for (const [key, col] of [['name', 'name'], ['email', 'email'], ['role', 'role'], ['isActive', 'is_active']]) {
    if (input[key] !== undefined && input[key] !== staff[col]) {
      patch[col] = key === 'email' ? input[key].toLowerCase() : input[key];
      changes[key] = { from: staff[col], to: patch[col] };
    }
  }
  if (input.password) {
    if (!isStrongPassword(input.password)) throw badRequest(`Password must be ${PASSWORD_RULES}`);
    patch.password_hash = await hashPassword(input.password);
    patch.failed_attempts = 0;
    patch.locked_until = null;
    changes.password = 'reset';
  }
  if (input.resetOtp) {
    patch.otp_enabled = false;
    patch.otp_secret = null;
    changes.otp = 'reset';
  }
  if (input.unlock) {
    patch.failed_attempts = 0;
    patch.locked_until = null;
    changes.unlock = true;
  }
  if (!Object.keys(patch).length) return publicStaff(staff);

  if (patch.email) {
    const taken = await db('staff').whereRaw('LOWER(email) = ?', [patch.email]).whereNot({ id }).first('id');
    if (taken) throw conflict('A staff account with this email already exists');
  }

  const endSessions = patch.is_active === false || patch.role !== undefined || patch.password_hash !== undefined;

  const updated = await db.transaction(async (trx) => {
    // Lock admin rows so two admins can't remove each other at the same moment.
    if (losesAdmin) {
      await trx('staff').where({ role: 'admin' }).forUpdate().select('id');
      if ((await activeAdminCount(trx, id)) === 0) throw badRequest('There must be at least one active admin');
    }
    await trx('staff').where({ id }).update(patch);
    if (endSessions) await revokeAllSessions(id, trx);
    const action = patch.is_active === false ? 'staff.deactivate' : patch.is_active === true ? 'staff.reactivate' : 'staff.update';
    await audit({ actor: { type: 'staff', id: actor.id }, action, entityType: 'staff', entityId: id, details: changes, ip: actor.ip }, trx);
    return trx('staff').where({ id }).first();
  });

  if (endSessions) await disconnectStaff(id);
  return publicStaff(updated);
}

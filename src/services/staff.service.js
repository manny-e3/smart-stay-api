import { transaction } from '../config/db.js';
import * as Staff from '../models/staff.model.js';
import { recordAudit } from './audit.service.js';
import { badRequest, conflict, notFound } from '../utils/errors.js';
import { disconnectStaff } from '../realtime/socket.js';
import { hashPassword, isStrongPassword, PASSWORD_RULES, publicStaff } from './auth.service.js';

/** Staff accounts managed by admins. */

export async function listStaff(filters) {
  const result = await Staff.list(filters);
  return { ...result, items: result.items.map(publicStaff) };
}

export async function getStaff(id) {
  const staff = await Staff.findById(id);
  if (!staff) throw notFound('Staff member');
  return publicStaff(staff);
}

export async function createStaff({ name, email, role, password }, actor) {
  if (!isStrongPassword(password)) throw badRequest(`Password must be ${PASSWORD_RULES}`);
  if (await Staff.findByEmail(email)) throw conflict('A staff account with this email already exists');
  const passwordHash = await hashPassword(password);
  return transaction(async (trx) => {
    const id = await Staff.create({ name, email: email.toLowerCase(), role, password_hash: passwordHash }, trx);
    await recordAudit({ actor: { type: 'staff', id: actor.id }, action: 'staff.create', entityType: 'staff', entityId: id, details: { name, email, role }, ip: actor.ip }, trx);
    return publicStaff(await Staff.findById(id, trx));
  });
}

/** Edits name, email, role or active flag; can also reset the password, the one-time code or a lockout. */
export async function updateStaff(id, input, actor) {
  const staff = await Staff.findById(id);
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

  if (patch.email && (await Staff.findByEmailExcept(patch.email, id))) throw conflict('A staff account with this email already exists');

  const endSessions = patch.is_active === false || patch.role !== undefined || patch.password_hash !== undefined;

  const updated = await transaction(async (trx) => {
    if (losesAdmin) {
      await Staff.lockAdmins(trx);
      if ((await Staff.countActiveAdminsExcept(id, trx)) === 0) throw badRequest('There must be at least one active admin');
    }
    await Staff.update(id, patch, trx);
    if (endSessions) await Staff.revokeAllSessions(id, trx);
    const action = patch.is_active === false ? 'staff.deactivate' : patch.is_active === true ? 'staff.reactivate' : 'staff.update';
    await recordAudit({ actor: { type: 'staff', id: actor.id }, action, entityType: 'staff', entityId: id, details: changes, ip: actor.ip }, trx);
    return Staff.findById(id, trx);
  });

  if (endSessions) await disconnectStaff(id);
  return publicStaff(updated);
}

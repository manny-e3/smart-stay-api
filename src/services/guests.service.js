import { transaction } from '../config/db.js';
import * as Guest from '../models/guest.model.js';
import * as Stay from '../models/stay.model.js';
import * as GuestAccess from '../models/guestAccess.model.js';
import { recordAudit } from './audit.service.js';
import { badRequest, conflict, notFound } from '../utils/errors.js';
import { getSettings } from './settings.service.js';
import { toStay } from './stays.service.js';

/** Guest profiles: search, edit, anonymise (GDPR) and the retention job. */

export const toGuest = (g) => ({
  id: g.id,
  firstName: g.first_name,
  lastName: g.last_name,
  email: g.email,
  phone: g.phone,
  language: g.language,
  vip: Boolean(g.vip),
  notes: g.notes,
  externalId: g.external_id,
  anonymized: Boolean(g.anonymized_at),
  anonymizedAt: g.anonymized_at,
  createdAt: g.created_at,
});

const auditActor = (actor) => (actor.type === 'staff' ? { type: 'staff', id: actor.id } : { type: 'system' });

export async function listGuests(filters) {
  const result = await Guest.search(filters);
  return { ...result, items: result.items.map(toGuest) };
}

export async function getGuest(id) {
  const guest = await Guest.findById(id);
  if (!guest) throw notFound('Guest');
  const stays = await Stay.listForGuest(id);
  return { ...toGuest(guest), stays: stays.map(toStay) };
}

export async function createGuest(input, actor) {
  const id = await Guest.create({
    first_name: input.firstName,
    last_name: input.lastName ?? null,
    email: input.email?.toLowerCase() ?? null,
    phone: input.phone ?? null,
    language: input.language ?? null,
    vip: input.vip ?? false,
    notes: input.notes ?? null,
  });
  await recordAudit({ actor: auditActor(actor), action: 'guest.create', entityType: 'guest', entityId: id, ip: actor.ip });
  return getGuest(id);
}

export async function updateGuest(id, patch, actor) {
  const guest = await Guest.findById(id);
  if (!guest) throw notFound('Guest');
  if (guest.anonymized_at) throw badRequest('This guest has been anonymised and cannot be edited');
  const map = { firstName: 'first_name', lastName: 'last_name', email: 'email', phone: 'phone', language: 'language', vip: 'vip', notes: 'notes' };
  const update = {};
  for (const [k, col] of Object.entries(map)) if (patch[k] !== undefined) update[col] = k === 'email' && patch[k] ? patch[k].toLowerCase() : patch[k];
  if (Object.keys(update).length) {
    await Guest.update(id, update);
    // Field names only: the audit log should not become a second copy of personal data.
    await recordAudit({ actor: auditActor(actor), action: 'guest.update', entityType: 'guest', entityId: id, details: { fields: Object.keys(patch) }, ip: actor.ip });
  }
  return getGuest(id);
}

/**
 * Removes personal details but keeps the guest row so stays, requests and feedback
 * still add up in reports. Not allowed while the guest has a current or future stay.
 */
export async function anonymizeGuest(id, actor) {
  await transaction(async (trx) => {
    const guest = await Guest.lockById(id, trx);
    if (!guest) throw notFound('Guest');
    if (guest.anonymized_at) return;
    const active = await Guest.findActiveBooking(id, trx);
    if (active) throw conflict(`Guest has an active booking (${active.reference}); anonymise after it ends`);
    await Guest.update(id, { first_name: 'Anonymised', last_name: null, email: null, phone: null, notes: null, external_id: null, anonymized_at: new Date() }, trx);
    await Guest.deleteDevicesForGuest(id, trx);
    await Guest.deletePreferences(id, trx);
    await GuestAccess.revokeSessionsForGuest(id, {}, trx);
    await recordAudit({ actor: auditActor(actor), action: 'guest.anonymize', entityType: 'guest', entityId: id, details: { automatic: actor.type === 'system' }, ip: actor.ip }, trx);
  });
  return getGuest(id);
}

/** Retention job: anonymises guests whose last stay ended longer ago than the retention setting. */
export async function runGuestRetention(now = new Date()) {
  const { guest_data_retention_days: days } = await getSettings();
  if (!days) return 0;
  const cutoff = new Date(now.getTime() - days * 86_400_000);
  const candidates = await Guest.listForRetention(cutoff);
  for (const { id } of candidates) await anonymizeGuest(id, { type: 'system' });
  return candidates.length;
}

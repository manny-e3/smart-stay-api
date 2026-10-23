import { db, paginate } from '../../config/db.js';
import { audit } from '../../core/audit.js';
import { badRequest, conflict, notFound } from '../../core/errors.js';
import { getSettings } from '../settings/settings.service.js';
import { toStay } from './stays.service.js';

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

export async function listGuests({ q, vip, includeAnonymized, page, limit }) {
  const query = db('guests as g').select('g.*').orderBy('g.last_name').orderBy('g.first_name');
  if (!includeAnonymized) query.whereNull('g.anonymized_at');
  if (vip !== undefined) query.where('g.vip', vip);
  if (q) {
    query.where((w) =>
      w
        .whereILike('g.first_name', `%${q}%`)
        .orWhereILike('g.last_name', `%${q}%`)
        .orWhereILike('g.email', `%${q}%`)
        .orWhereILike('g.phone', `%${q}%`)
        .orWhereExists(db('stay_guests as sg').join('stays as s', 's.id', 'sg.stay_id').whereRaw('sg.guest_id = g.id').whereILike('s.reference', `%${q}%`)),
    );
  }
  const result = await paginate(query, { page, limit });
  return { ...result, items: result.items.map(toGuest) };
}

export async function getGuest(id) {
  const guest = await db('guests').where({ id }).first();
  if (!guest) throw notFound('Guest');
  const stays = await db('stays as s')
    .join('stay_guests as sg', 'sg.stay_id', 's.id')
    .join('guests as g', 'g.id', 's.guest_id')
    .leftJoin('rooms as r', 'r.id', 's.room_id')
    .leftJoin('floors as f', 'f.id', 'r.floor_id')
    .leftJoin('room_types as t', 't.id', 's.room_type_id')
    .where('sg.guest_id', id)
    .orderBy('s.check_in_at', 'desc')
    .select('s.*', 'g.first_name', 'g.last_name', 'g.email as guest_email', 'g.phone as guest_phone', 'g.language as guest_language', 'g.vip as guest_vip', 'r.number as room_number', 'f.number as floor_number', 't.name as room_type_name');
  return { ...toGuest(guest), stays: stays.map(toStay) };
}

export async function createGuest(input, actor) {
  const [id] = await db('guests').insert({
    first_name: input.firstName,
    last_name: input.lastName ?? null,
    email: input.email?.toLowerCase() ?? null,
    phone: input.phone ?? null,
    language: input.language ?? null,
    vip: input.vip ?? false,
    notes: input.notes ?? null,
  });
  await audit({ actor: auditActor(actor), action: 'guest.create', entityType: 'guest', entityId: id, ip: actor.ip });
  return getGuest(id);
}

export async function updateGuest(id, patch, actor) {
  const guest = await db('guests').where({ id }).first();
  if (!guest) throw notFound('Guest');
  if (guest.anonymized_at) throw badRequest('This guest has been anonymised and cannot be edited');
  const map = { firstName: 'first_name', lastName: 'last_name', email: 'email', phone: 'phone', language: 'language', vip: 'vip', notes: 'notes' };
  const update = {};
  for (const [k, col] of Object.entries(map)) if (patch[k] !== undefined) update[col] = k === 'email' && patch[k] ? patch[k].toLowerCase() : patch[k];
  if (Object.keys(update).length) {
    await db('guests').where({ id }).update(update);
    // Field names only: the audit log should not become a second copy of personal data.
    await audit({ actor: auditActor(actor), action: 'guest.update', entityType: 'guest', entityId: id, details: { fields: Object.keys(patch) }, ip: actor.ip });
  }
  return getGuest(id);
}

/**
 * Removes personal details but keeps the guest row so stays, requests and feedback
 * still add up in reports. Not allowed while the guest has a current or future stay.
 */
export async function anonymizeGuest(id, actor) {
  await db.transaction(async (trx) => {
    const guest = await trx('guests').where({ id }).forUpdate().first();
    if (!guest) throw notFound('Guest');
    if (guest.anonymized_at) return;
    const active = await trx('stay_guests as sg').join('stays as s', 's.id', 'sg.stay_id').where('sg.guest_id', id).whereIn('s.status', ['reserved', 'checked_in']).first('s.reference');
    if (active) throw conflict(`Guest has an active booking (${active.reference}); anonymise after it ends`);
    await trx('guests').where({ id }).update({ first_name: 'Anonymised', last_name: null, email: null, phone: null, notes: null, external_id: null, anonymized_at: new Date() });
    await trx('guest_devices').where({ guest_id: id }).del();
    await trx('guest_preferences').where({ guest_id: id }).del();
    await trx('guest_sessions').where({ guest_id: id }).whereNull('revoked_at').update({ revoked_at: new Date() });
    await audit({ actor: auditActor(actor), action: 'guest.anonymize', entityType: 'guest', entityId: id, details: { automatic: actor.type === 'system' }, ip: actor.ip }, trx);
  });
  return getGuest(id);
}

/** Retention job: anonymises guests whose last stay ended longer ago than the retention setting. */
export async function runGuestRetention(now = new Date()) {
  const { guest_data_retention_days: days } = await getSettings();
  if (!days) return 0;
  const cutoff = new Date(now.getTime() - days * 86_400_000);
  const candidates = await db('guests as g')
    .whereNull('g.anonymized_at')
    .whereNotExists(db('stay_guests as sg').join('stays as s', 's.id', 'sg.stay_id').whereRaw('sg.guest_id = g.id').whereIn('s.status', ['reserved', 'checked_in']))
    .whereNotExists(
      db('stay_guests as sg')
        .join('stays as s', 's.id', 'sg.stay_id')
        .whereRaw('sg.guest_id = g.id')
        .whereRaw('COALESCE(s.checked_out_at, s.check_out_at) >= ?', [cutoff]),
    )
    .where('g.created_at', '<', cutoff)
    .select('g.id')
    .limit(500);
  for (const { id } of candidates) await anonymizeGuest(id, { type: 'system' });
  return candidates.length;
}

import { db } from '../config/db.js';

/** Tables: folios (a stay's bill), folio_charges (lines on the bill), folio_payments. */

/* ---- folios ------------------------------------------------------------------- */

const withStayAndGuest = () =>
  db('folios as f').join('stays as s', 's.id', 'f.stay_id').join('guests as g', 'g.id', 'f.guest_id').leftJoin('rooms as r', 'r.id', 's.room_id');

/** Folios newest first with guest, room and stay. status 'all' (or empty) lists every folio. */
export function list({ status }) {
  const q = withStayAndGuest()
    .select('f.*', 'g.first_name', 'g.last_name', 'g.email as guest_email', 'r.number as room_number', 's.reference as stay_reference', 's.check_in_at', 's.check_out_at', 's.status as stay_status')
    .orderBy('f.created_at', 'desc');
  if (status && status !== 'all') q.where('f.status', status);
  return q;
}

export function findWithDetails(id) {
  return withStayAndGuest()
    .where('f.id', id)
    .first('f.*', 'g.first_name', 'g.last_name', 'g.email as guest_email', 'g.phone as guest_phone', 'r.number as room_number', 's.reference as stay_reference', 's.check_in_at', 's.check_out_at');
}

export function findById(id) {
  return db('folios').where({ id }).first();
}

/** The stay's open folio, if any. */
export function findOpenForStay(stayId, trx = db) {
  return trx('folios').where({ stay_id: stayId, status: 'open' }).first();
}

export async function create(fields, trx = db) {
  const [id] = await trx('folios').insert(fields);
  return id;
}

export function update(id, fields, trx = db) {
  return trx('folios').where({ id }).update(fields);
}

export function increaseBalance(id, amount, trx = db) {
  return trx('folios').where({ id }).increment('balance', amount);
}

/* ---- folio_charges and folio_payments ------------------------------------------ */

export function addCharge(fields, trx = db) {
  return trx('folio_charges').insert(fields);
}

export function addPayment(fields, trx = db) {
  return trx('folio_payments').insert(fields);
}

/** Charges on a folio, oldest first, with who posted them. */
export function charges(folioId) {
  return db('folio_charges as fc').leftJoin('staff as st', 'st.id', 'fc.posted_by_staff_id').where('fc.folio_id', folioId).select('fc.*', 'st.name as posted_by_name').orderBy('fc.created_at', 'asc');
}

/** Payments on a folio, oldest first, with who took them. */
export function payments(folioId) {
  return db('folio_payments as fp').leftJoin('staff as st', 'st.id', 'fp.staff_id').where('fp.folio_id', folioId).select('fp.*', 'st.name as staff_name').orderBy('fp.settled_at', 'asc');
}

/** Every charge posted since `since` (daily report). */
export function chargesSince(since) {
  return db('folio_charges').where('created_at', '>=', since);
}

import { db, paginate } from '../config/db.js';

/** Tables: feedback, feedback_photos. */

const PERIOD_FORMATS = { day: '%Y-%m-%d', week: '%x-W%v', month: '%Y-%m' };

const base = () => db('feedback as fb').join('rooms as r', 'r.id', 'fb.room_id').join('floors as f', 'f.id', 'r.floor_id');

function applyFilters(q, { from, to, minRating, maxRating, roomId, floor, category, hasPhotos }) {
  if (from) q.where('fb.created_at', '>=', from);
  if (to) q.where('fb.created_at', '<=', to);
  if (minRating) q.where('fb.rating', '>=', minRating);
  if (maxRating) q.where('fb.rating', '<=', maxRating);
  if (roomId) q.where('fb.room_id', roomId);
  if (floor !== undefined) q.where('f.number', floor);
  if (category) q.where('fb.category', category);
  if (hasPhotos !== undefined) {
    const sub = db('feedback_photos as p').whereRaw('p.feedback_id = fb.id');
    hasPhotos ? q.whereExists(sub) : q.whereNotExists(sub);
  }
  return q;
}

/** Feedback list, newest first, with room and guest names. */
export function list(filters) {
  const q = applyFilters(
    base()
      .leftJoin('guests as g', 'g.id', 'fb.guest_id')
      .select('fb.*', 'r.number as room_number', 'f.number as floor_number', 'g.first_name', 'g.last_name')
      .orderBy('fb.created_at', 'desc'),
    filters,
  );
  return paginate(q, { page: filters.page, limit: filters.limit });
}

/** Count and average rating for the filters. */
export async function summary(filters) {
  const [row] = await applyFilters(base(), filters).select(db.raw('COUNT(*) AS count, AVG(fb.rating) AS average'));
  return row;
}

/** How many of each rating (1-5) for the filters. */
export function distribution(filters) {
  return applyFilters(base(), filters).select('fb.rating').count({ n: '*' }).groupBy('fb.rating');
}

/** Count and average per day, week or month. */
export function averagesByPeriod(filters, groupBy) {
  return applyFilters(base(), filters)
    .select(db.raw('DATE_FORMAT(fb.created_at, ?) AS period', [PERIOD_FORMATS[groupBy]]))
    .select(db.raw('COUNT(*) AS count, AVG(fb.rating) AS average'))
    .groupBy('period')
    .orderBy('period');
}

export async function create(fields, trx = db) {
  const [id] = await trx('feedback').insert(fields);
  return id;
}

export function listForRoom(roomId, limit = 5) {
  return db('feedback').where({ room_id: roomId }).orderBy('created_at', 'desc').limit(limit).select('id', 'rating', 'comment', 'created_at');
}

export function listForStay(stayId) {
  return db('feedback').where({ stay_id: stayId }).select('id', 'rating', 'comment', 'created_at');
}

/* ---- feedback_photos ----------------------------------------------------------- */

export function photosFor(feedbackIds) {
  if (!feedbackIds.length) return [];
  return db('feedback_photos').whereIn('feedback_id', feedbackIds).select('id', 'feedback_id', 'url', 'storage_key');
}

export function addPhotos(rows, trx = db) {
  return trx('feedback_photos').insert(rows);
}

/** An uploaded (privately stored) photo. */
export function findStoredPhoto(id) {
  return db('feedback_photos').where({ id }).whereNotNull('storage_key').first();
}

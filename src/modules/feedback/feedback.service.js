import { db, paginate } from '../../config/db.js';
import { bus, EVENTS } from '../../core/events.js';
import { badRequest } from '../../core/errors.js';
import { notifyStaff } from '../../core/notifier.js';
import { signPath } from '../../core/crypto.js';
import { savePrivateImage, deletePrivate } from '../../core/storage.js';
import { raiseAlert } from '../alerts/alerts.service.js';
import { getSettings } from '../settings/settings.service.js';

const PERIOD_FORMATS = { day: '%Y-%m-%d', week: '%x-W%v', month: '%Y-%m' };

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

const base = () => db('feedback as fb').join('rooms as r', 'r.id', 'fb.room_id').join('floors as f', 'f.id', 'r.floor_id');

export async function listFeedback(filters) {
  const { page, limit, groupBy = 'day' } = filters;
  const listQ = applyFilters(
    base()
      .leftJoin('guests as g', 'g.id', 'fb.guest_id')
      .select('fb.*', 'r.number as room_number', 'f.number as floor_number', 'g.first_name', 'g.last_name')
      .orderBy('fb.created_at', 'desc'),
    filters,
  );
  const result = await paginate(listQ, { page, limit });

  const ids = result.items.map((i) => i.id);
  const photos = ids.length ? await db('feedback_photos').whereIn('feedback_id', ids).select('id', 'feedback_id', 'url', 'storage_key') : [];

  const [summary] = await applyFilters(base(), filters).select(db.raw('COUNT(*) AS count, AVG(fb.rating) AS average'));
  const distribution = await applyFilters(base(), filters).select('fb.rating').count({ n: '*' }).groupBy('fb.rating');
  const periods = await applyFilters(base(), filters)
    .select(db.raw('DATE_FORMAT(fb.created_at, ?) AS period', [PERIOD_FORMATS[groupBy]]))
    .select(db.raw('COUNT(*) AS count, AVG(fb.rating) AS average'))
    .groupBy('period')
    .orderBy('period');

  const round = (n) => (n === null || n === undefined ? null : Math.round(Number(n) * 100) / 100);
  return {
    ...result,
    items: result.items.map((f) => ({
      id: f.id,
      rating: f.rating,
      category: f.category,
      comment: f.comment,
      room: { id: f.room_id, number: f.room_number, floor: f.floor_number },
      guest: f.guest_id ? { id: f.guest_id, name: [f.first_name, f.last_name].filter(Boolean).join(' ') } : null,
      stayId: f.stay_id,
      isIssue: Boolean(f.is_issue),
      // Uploaded photos are private: the URL is signed and expires after an hour.
      photos: photos.filter((p) => p.feedback_id === f.id).map((p) => ({ id: p.id, url: p.storage_key ? signPath(`/media/feedback-photos/${p.id}`) : p.url })),
      createdAt: f.created_at,
    })),
    summary: {
      count: Number(summary.count),
      average: round(summary.average),
      distribution: Object.fromEntries([1, 2, 3, 4, 5].map((r) => [r, Number(distribution.find((d) => d.rating === r)?.n ?? 0)])),
    },
    averages: { groupBy, periods: periods.map((p) => ({ period: p.period, count: Number(p.count), average: round(p.average) })) },
  };
}

/**
 * Stores guest feedback (called by the guest section of the API).
 * Ratings at or below the low-rating threshold notify managers straight away.
 */
export async function submitFeedback({ roomId, stayId = null, guestId = null, rating, category = null, comment = null, photos = [], files = [], isIssue = false }) {
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) throw badRequest('Rating must be between 1 and 5');
  // Validate and store uploaded photos first, so a bad file rejects the whole submission.
  const stored = [];
  try {
    for (const f of files) stored.push(await savePrivateImage(f.buffer, 'feedback'));
  } catch (err) {
    await Promise.all(stored.map((s) => deletePrivate(s.key)));
    throw err;
  }
  const id = await db.transaction(async (trx) => {
    const [fid] = await trx('feedback').insert({ room_id: roomId, stay_id: stayId, guest_id: guestId, rating, category, comment, is_issue: isIssue });
    if (photos.length) await trx('feedback_photos').insert(photos.map((url) => ({ feedback_id: fid, url })));
    if (stored.length) await trx('feedback_photos').insert(stored.map((s) => ({ feedback_id: fid, storage_key: s.key, content_type: s.contentType, size_bytes: s.sizeBytes })));
    return fid;
  });
  const room = await db('rooms').where({ id: roomId }).first('number');
  const feedback = { id, roomId, roomNumber: room?.number, rating, category, comment, isIssue, photos: stored.length + photos.length };
  bus.publish(EVENTS.FEEDBACK_CREATED, feedback);

  // "Mark as issue" puts the feedback in the alert list for maintenance and managers.
  if (isIssue) {
    await raiseAlert({
      type: 'guest_issue',
      severity: 'warning',
      source: 'guest',
      title: `Guest reported ${category ? `a ${category} issue` : 'an issue'} in feedback`,
      message: comment ?? null,
      roomId,
      feedbackId: id,
      payload: { guestId, stayId, rating, photos: feedback.photos },
    });
  }

  const { low_rating_threshold: threshold } = await getSettings();
  if (rating <= threshold) {
    bus.publish(EVENTS.FEEDBACK_LOW_RATING, feedback);
    await notifyStaff({
      roles: ['manager', 'admin'],
      title: `Low rating (${rating}/5) from room ${room?.number ?? roomId}`,
      body: comment ? comment.slice(0, 200) : 'No comment left',
      data: { type: 'low_rating', feedbackId: id, roomId },
      email: true,
    });
  }
  return feedback;
}

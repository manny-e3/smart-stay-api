import { transaction } from '../config/db.js';
import * as Feedback from '../models/feedback.model.js';
import * as Room from '../models/room.model.js';
import { bus, EVENTS } from '../realtime/eventBus.js';
import { AppError, badRequest, notFound } from '../utils/errors.js';
import { notifyStaff } from './notification.service.js';
import { signPath, verifySignedPath } from '../utils/crypto.js';
import { savePrivateImage, deletePrivate, privatePath } from '../utils/storage.js';
import { raiseAlert } from './alerts.service.js';
import { getSettings } from './settings.service.js';

/** Guest feedback: the manager's list with averages, and submissions from the guest app. */

const round = (n) => (n === null || n === undefined ? null : Math.round(Number(n) * 100) / 100);

export async function listFeedback(filters) {
  const groupBy = filters.groupBy ?? 'day';
  const result = await Feedback.list(filters);
  const photos = await Feedback.photosFor(result.items.map((i) => i.id));
  const [summary, distribution, periods] = await Promise.all([Feedback.summary(filters), Feedback.distribution(filters), Feedback.averagesByPeriod(filters, groupBy)]);

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
 * Stores guest feedback. Low ratings notify managers straight away, and
 * "mark as issue" also puts it in the alert list.
 */
export async function submitFeedback({ roomId, stayId = null, guestId = null, rating, category = null, comment = null, photos = [], files = [], isIssue = false }) {
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) throw badRequest('Rating must be between 1 and 5');
  // Check and store uploaded photos first, so a bad file rejects the whole submission.
  const stored = [];
  try {
    for (const f of files) stored.push(await savePrivateImage(f.buffer, 'feedback'));
  } catch (err) {
    await Promise.all(stored.map((s) => deletePrivate(s.key)));
    throw err;
  }
  const id = await transaction(async (trx) => {
    const fid = await Feedback.create({ room_id: roomId, stay_id: stayId, guest_id: guestId, rating, category, comment, is_issue: isIssue }, trx);
    if (photos.length) await Feedback.addPhotos(photos.map((url) => ({ feedback_id: fid, url })), trx);
    if (stored.length) await Feedback.addPhotos(stored.map((s) => ({ feedback_id: fid, storage_key: s.key, content_type: s.contentType, size_bytes: s.sizeBytes })), trx);
    return fid;
  });
  const room = await Room.findNumber(roomId);
  const feedback = { id, roomId, roomNumber: room?.number, rating, category, comment, isIssue, photos: stored.length + photos.length };
  bus.publish(EVENTS.FEEDBACK_CREATED, feedback);

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

/**
 * A feedback photo behind a signed link (from GET /admin/feedback).
 * Returns the file path and content type to stream back.
 */
export async function getSignedPhoto(id, { exp, sig }) {
  if (!verifySignedPath(`/media/feedback-photos/${id}`, exp, sig)) throw new AppError(403, 'This link has expired', 'LINK_EXPIRED');
  const photo = await Feedback.findStoredPhoto(id);
  if (!photo) throw notFound('Photo');
  return { file: privatePath(photo.storage_key), contentType: photo.content_type };
}

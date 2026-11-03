import { Router } from 'express';
import { authenticateGuest } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { limiter, guestCommandLimiter } from '../middleware/rateLimit.js';
import { photoUpload } from '../middleware/upload.js';
import { idParam } from '../validators/common.validator.js';
import * as v from '../validators/guestApp.validator.js';
import * as account from '../controllers/guestAccount.controller.js';
import * as booking from '../controllers/booking.controller.js';
import * as voice from '../controllers/voice.controller.js';
import * as app from '../controllers/guestApp.controller.js';

/**
 * Guest app API (mobile and web). Mounted at /guest
 * Every signed-in handler works only on the guest's own stay and current room (req.guest).
 */
const router = Router();
// Each route gets its own counter: 10 attempts per IP per 15 minutes.
const signInLimit = () => limiter({ limit: 10, minutes: 15 });

/* ---- Public ---- */

router.get('/info', app.info);
router.post('/login', signInLimit(), validate({ body: v.loginBody }), account.login);
router.post('/register', signInLimit(), validate({ body: v.registerBody }), account.register);
router.post('/forgot-password', signInLimit(), validate({ body: v.forgotPasswordBody }), account.forgotPassword);
router.post('/reset-password', signInLimit(), validate({ body: v.resetPasswordBody }), account.resetPassword);

router.get('/rooms/catalog', booking.catalog);
router.post('/bookings', signInLimit(), validate({ body: v.bookingBody }), booking.create);

/* ---- Signed in (everything below needs a guest token) ---- */

router.use(authenticateGuest);

router.post('/logout', account.logout);
router.get('/me', app.home);
router.get('/history', app.history);
router.post('/link-booking', validate({ body: v.linkBookingBody }), app.linkBooking);
router.put('/push-token', validate({ body: v.pushTokenBody }), app.pushToken);
router.get('/bookings/my', booking.myBookings);

// Digital key
router.get('/key', app.keys);
router.post('/key/unlock', limiter({ limit: 30, minutes: 5, byGuest: true }), validate({ body: v.unlockBody }), app.unlock);

// Room controls and status
router.get('/devices', app.devices);
router.post('/devices/:id/command', guestCommandLimiter, validate({ params: idParam, body: v.deviceCommandBody }), app.deviceCommand);
router.put('/room-status', validate({ body: v.roomStatusBody }), app.roomStatus);

// Requests
router.get('/requests', app.listRequests);
router.get('/requests/:id', validate({ params: idParam }), app.getRequest);
router.post('/requests', limiter({ limit: 20, minutes: 15, byGuest: true }), validate({ body: v.requestBody }), app.createRequest);
router.post('/requests/:id/cancel', validate({ params: idParam }), app.cancelRequest);

// Feedback (JSON, or multipart/form-data with up to 3 photos)
router.post('/feedback', limiter({ limit: 5, minutes: 60, byGuest: true }), photoUpload, validate({ body: v.feedbackBody }), app.feedback);

// Preferences
router.get('/preferences', app.preferences);
router.put('/preferences', validate({ body: v.preferencesBody }), app.updatePreferences);

// Voice assistant ("/voice-command" is an older name for the same endpoint)
const voiceLimit = limiter({ limit: 60, minutes: 1, byGuest: true });
router.post('/assistant/command', voiceLimit, validate({ body: v.voiceCommandBody }), voice.command);
router.post('/voice-command', voiceLimit, validate({ body: v.voiceCommandBody }), voice.command);

export default router;

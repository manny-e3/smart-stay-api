import { Router } from 'express';
import { authenticate } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { limiter } from '../middleware/rateLimit.js';
import * as v from '../validators/auth.validator.js';
import * as controller from '../controllers/auth.controller.js';

/** Mounted at /staff: staff sign-in and the signed-in staff member's own account. */
const router = Router();

const loginLimiter = limiter({ limit: 20, minutes: 15, message: 'Too many login attempts, try again later' });

router.post('/login', loginLimiter, validate({ body: v.loginBody }), controller.login);
router.post('/refresh', loginLimiter, validate({ body: v.refreshBody }), controller.refresh);
router.post('/logout', controller.logout);

router.get('/me', authenticate, controller.me);
router.post('/me/password', authenticate, validate({ body: v.changePasswordBody }), controller.changePassword);
router.post('/me/otp/setup', authenticate, controller.setupOtp);
router.post('/me/otp/enable', authenticate, validate({ body: v.otpBody }), controller.enableOtp);
router.post('/me/otp/disable', authenticate, validate({ body: v.otpBody }), controller.disableOtp);

router.get('/push/public-key', controller.pushPublicKey);
router.post('/me/push-subscriptions', authenticate, validate({ body: v.pushSubscriptionBody }), controller.savePushSubscription);
router.delete('/me/push-subscriptions', authenticate, validate({ body: v.deletePushSubscriptionBody }), controller.deletePushSubscription);

export default router;

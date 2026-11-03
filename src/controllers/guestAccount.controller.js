import * as guestAuthService from '../services/guestAuth.service.js';
import * as guestAccountService from '../services/guestAccount.service.js';

const meta = (req) => ({ ip: req.ip, userAgent: req.get('user-agent') });

/** POST /guest/login */
export async function login(req, res) {
  res.status(201).json({ success: true, data: await guestAuthService.signIn(req.valid.body, meta(req)) });
}

/** POST /guest/register */
export async function register(req, res) {
  res.status(201).json({ success: true, data: await guestAccountService.register(req.valid.body, meta(req)) });
}

/** POST /guest/forgot-password. Same answer whether or not the email exists. */
export async function forgotPassword(req, res) {
  await guestAccountService.forgotPassword(req.valid.body);
  res.json({ success: true, message: 'If an account exists with this email, a verification code has been sent.' });
}

/** POST /guest/reset-password */
export async function resetPassword(req, res) {
  await guestAccountService.resetPassword(req.valid.body);
  res.json({ success: true, message: 'Your password has been reset successfully. You can now log in.' });
}

/** POST /guest/logout */
export async function logout(req, res) {
  await guestAuthService.signOut(req.guest.sessionId);
  res.json({ success: true });
}

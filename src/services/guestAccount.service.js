import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import * as Guest from '../models/guest.model.js';
import { AppError } from '../utils/errors.js';
import { sendEmail } from './notification.service.js';
import { signIn } from './guestAuth.service.js';

/** Guest app accounts: register with email and password, forgot password, reset password. */

const RESET_MINUTES = 15;

const toAccount = (g) => ({ id: g.id, firstName: g.first_name, lastName: g.last_name, email: g.email, phone: g.phone });

function welcomeEmail(guest) {
  return {
    to: guest.email,
    subject: `Welcome to SmartStay, ${guest.first_name}!`,
    text: `Hello ${guest.first_name},\n\nWelcome to SmartStay! Your mobile guest account is ready.\n\nWith your account you can manage your bookings, room keys, and in-room controls.\n\nWarm regards,\nThe SmartStay Team`,
    html: `
        <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; max-width: 560px; margin: 0 auto; padding: 32px 24px; background: #ffffff; color: #1e293b; border-radius: 12px; border: 1px solid #e2e8f0;">
          <div style="text-align: center; margin-bottom: 24px;">
            <h1 style="color: #0f172a; font-size: 24px; font-weight: 700; margin: 0 0 8px 0;">Welcome to SmartStay</h1>
            <p style="color: #64748b; font-size: 15px; margin: 0;">Smart Hospitality, Elevated Comfort</p>
          </div>
          <div style="background: #f8fafc; border-radius: 10px; padding: 20px; margin-bottom: 20px; border: 1px solid #edf2f7;">
            <p style="margin: 0 0 12px 0; font-size: 16px; color: #334155;">Hello <strong>${guest.first_name}</strong>,</p>
            <p style="margin: 0 0 12px 0; font-size: 15px; line-height: 1.6; color: #475569;">Thank you for registering your SmartStay mobile account. Your companion app is ready to elevate your stay.</p>
            <p style="margin: 0; font-size: 14px; font-weight: 600; color: #0f172a;">What you can do with your SmartStay app:</p>
            <ul style="margin: 10px 0 0 0; padding-left: 20px; font-size: 14px; line-height: 1.7; color: #475569;">
              <li>Instant digital room key access</li>
              <li>Smart room controls for lighting, climate & entertainment</li>
              <li>Housekeeping and concierge service requests</li>
              <li>Review complete past stays and room records</li>
            </ul>
          </div>
          <p style="font-size: 13px; color: #94a3b8; text-align: center; margin: 20px 0 0 0;">
            If you did not sign up for this account, please contact our front desk.
          </p>
        </div>
      `,
  };
}

function resetCodeEmail(guest, code) {
  return {
    to: guest.email,
    subject: `SmartStay - Password Reset Code: ${code}`,
    text: `Hello ${guest.first_name},\n\nYou requested to reset your password.\n\nYour 6-digit verification code is: ${code}\n\nThis code will expire in 15 minutes.`,
    html: `
          <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; max-width: 560px; margin: 0 auto; padding: 32px 24px; background: #ffffff; color: #1e293b; border-radius: 12px; border: 1px solid #e2e8f0;">
            <div style="text-align: center; margin-bottom: 24px;">
              <h1 style="color: #0f172a; font-size: 24px; font-weight: 700; margin: 0 0 8px 0;">Reset Your Password</h1>
              <p style="color: #64748b; font-size: 15px; margin: 0;">SmartStay Guest Account</p>
            </div>
            <div style="background: #f8fafc; border-radius: 10px; padding: 24px; text-align: center; margin-bottom: 24px; border: 1px solid #edf2f7;">
              <p style="margin: 0 0 16px 0; font-size: 15px; color: #475569;">Enter this verification code in the mobile app to set a new password:</p>
              <div style="display: inline-block; font-size: 32px; font-weight: 800; letter-spacing: 6px; color: #0284c7; background: #e0f2fe; padding: 12px 28px; border-radius: 8px; border: 1px dashed #38bdf8;">
                ${code}
              </div>
              <p style="margin: 16px 0 0 0; font-size: 13px; color: #64748b;">This code will expire in 15 minutes.</p>
            </div>
            <p style="font-size: 13px; color: #94a3b8; text-align: center; margin: 24px 0 0 0;">
              If you did not request this password reset, please ignore this email.
            </p>
          </div>
        `,
  };
}

/**
 * Creates a guest account, or adds a password to a guest the hotel already knows by email.
 * Signs the guest in when possible. Returns { guest, session? }.
 */
export async function register({ firstName, lastName, email, phone, password }, meta) {
  const normalizedEmail = email.toLowerCase().trim();
  let guest = await Guest.findByEmail(normalizedEmail);
  if (guest && guest.password_hash) throw new AppError(409, 'An account with this email already exists. Please log in or reset your password.', 'EMAIL_EXISTS');

  const passwordHash = await bcrypt.hash(password, 12);
  if (guest) {
    await Guest.update(guest.id, { first_name: firstName.trim(), last_name: lastName.trim(), phone: phone ? phone.trim() : guest.phone, password_hash: passwordHash, updated_at: new Date() });
    guest = await Guest.findById(guest.id);
  } else {
    const id = await Guest.create({ first_name: firstName.trim(), last_name: lastName.trim(), email: normalizedEmail, phone: phone ? phone.trim() : null, language: 'en', password_hash: passwordHash });
    guest = await Guest.findById(id);
  }

  // Not awaited, so the response does not wait for the mail server.
  sendEmail(welcomeEmail(guest)).catch((err) => console.error('[mail] Welcome email failed:', err.message));

  try {
    const session = await signIn({ email: guest.email, password }, meta);
    return { guest: toAccount(guest), session };
  } catch {
    return { guest: toAccount(guest) };
  }
}

/** Emails a 6-digit reset code if the email belongs to a guest. Says nothing either way. */
export async function forgotPassword({ email }) {
  const guest = await Guest.findByEmail(email);
  if (!guest) return;
  const code = String(crypto.randomInt(100000, 999999));
  await Guest.update(guest.id, { reset_token: code, reset_expires_at: new Date(Date.now() + RESET_MINUTES * 60_000), updated_at: new Date() });
  sendEmail(resetCodeEmail(guest, code)).catch((err) => console.error('[mail] Reset code email failed:', err.message));
}

/** Sets a new password when the reset code matches and has not expired. */
export async function resetPassword({ email, code, newPassword }) {
  const guest = await Guest.findByEmail(email);
  if (!guest || !guest.reset_token || !guest.reset_expires_at) throw new AppError(400, 'Invalid or expired reset code. Please request a new code.', 'INVALID_RESET_CODE');
  if (new Date(guest.reset_expires_at) < new Date()) throw new AppError(400, 'This reset code has expired. Please request a new code.', 'RESET_CODE_EXPIRED');
  if (guest.reset_token.trim() !== code.trim()) throw new AppError(400, 'Incorrect reset code.', 'INVALID_RESET_CODE');

  await Guest.update(guest.id, { password_hash: await bcrypt.hash(newPassword, 12), reset_token: null, reset_expires_at: null, updated_at: new Date() });
}

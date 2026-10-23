import fs from 'node:fs';
import nodemailer from 'nodemailer';
import webpush from 'web-push';
import { env } from '../config/env.js';
import { db } from '../config/db.js';
import { rolesFor } from './permissions.js';
import { emitToRoles } from './sockets.js';
import { getSettings } from '../modules/settings/settings.service.js';

/**
 * Outgoing notifications: email, browser push to staff, mobile push to guests.
 * Each channel switches itself off when not configured, so development works without credentials.
 * In tests, messages are collected in `outbox` instead of being sent.
 */

export const outbox = { emails: [], webPush: [], guestPush: [] };

let transporter = null;
function mailer() {
  if (transporter) return transporter;
  const isPort587 = Number(env.mail.port) === 587;
  transporter = env.mail.host
    ? nodemailer.createTransport({
        host: env.mail.host,
        port: env.mail.port,
        secure: isPort587 ? false : env.mail.secure,
        auth: env.mail.user ? { user: env.mail.user, pass: (env.mail.password || '').replace(/^['"]|['"]$/g, '') } : undefined,
      })
    : nodemailer.createTransport({ jsonTransport: true });
  return transporter;
}

export async function sendEmail({ to, subject, text, html }) {
  const recipients = [].concat(to).filter(Boolean);
  if (!recipients.length) return;
  if (env.isTest) {
    outbox.emails.push({ to: recipients, subject, text, html });
    return;
  }
  try {
    await mailer().sendMail({ from: env.mail.from, to: recipients.join(', '), subject, text, html });
    if (!env.mail.host) console.log(`[mail:dev] to=${recipients.join(',')} subject="${subject}"`);
  } catch (err) {
    console.error('[mail] send failed:', err.message);
  }
}

const webPushReady = Boolean(env.vapid.publicKey && env.vapid.privateKey);
if (webPushReady) webpush.setVapidDetails(env.vapid.subject, env.vapid.publicKey, env.vapid.privateKey);

export async function webPushToRoles(roles, payload) {
  if (env.isTest) {
    outbox.webPush.push({ roles, payload });
    return;
  }
  if (!webPushReady || !roles.length) return;
  const subs = await db('push_subscriptions as p')
    .join('staff as s', 's.id', 'p.staff_id')
    .whereIn('s.role', roles)
    .where('s.is_active', true)
    .select('p.id', 'p.endpoint', 'p.keys');
  await Promise.all(
    subs.map(async (sub) => {
      try {
        await webpush.sendNotification({ endpoint: sub.endpoint, keys: sub.keys }, JSON.stringify(payload), { TTL: 300 });
      } catch (err) {
        if (err.statusCode === 404 || err.statusCode === 410) await db('push_subscriptions').where({ id: sub.id }).del();
        else console.error('[webpush] failed:', err.message);
      }
    }),
  );
}

/**
 * Notifies staff who hold a permission (or the given roles): live socket message, browser push
 * and, if asked, email to the alert recipients in hotel settings.
 */
export async function notifyStaff({ permission, roles, title, body, data = {}, email = false }) {
  const targetRoles = roles ?? rolesFor(permission);
  const payload = { title, body, data, at: new Date().toISOString() };
  emitToRoles(targetRoles, 'notification', payload);
  await webPushToRoles(targetRoles, payload);
  if (email) {
    const { alert_email_recipients: recipients } = await getSettings();
    await sendEmail({ to: recipients, subject: `[SmartStay] ${title}`, text: body });
  }
}

let firebaseMessaging = null;
let firebaseTried = false;
async function messaging() {
  if (firebaseTried) return firebaseMessaging;
  firebaseTried = true;
  if (!env.firebaseServiceAccount) return null;
  try {
    const { initializeApp, cert } = await import('firebase-admin/app');
    const { getMessaging } = await import('firebase-admin/messaging');
    const account = JSON.parse(fs.readFileSync(env.firebaseServiceAccount, 'utf8'));
    firebaseMessaging = getMessaging(initializeApp({ credential: cert(account) }, 'smartstay'));
  } catch (err) {
    console.error('[fcm] init failed:', err.message);
  }
  return firebaseMessaging;
}

/** Push to the guest app devices registered for a stay (or a guest). */
export async function pushToGuest({ stayId, guestId }, { title, body, data = {} }) {
  if (!stayId && !guestId) return;
  const q = db('guest_devices').select('id', 'push_token');
  if (stayId) q.where({ stay_id: stayId });
  else q.where({ guest_id: guestId });
  const devices = await q;
  const stringData = Object.fromEntries(Object.entries(data).map(([k, v]) => [k, String(v)]));
  if (env.isTest) {
    outbox.guestPush.push({ stayId, guestId, title, body, data: stringData, devices: devices.length });
    return;
  }
  const fcm = await messaging();
  if (!fcm || !devices.length) return;
  const res = await fcm.sendEachForMulticast({ tokens: devices.map((d) => d.push_token), notification: { title, body }, data: stringData });
  const dead = res.responses
    .map((r, i) => (!r.success && /registration-token-not-registered|invalid-argument/.test(r.error?.code || '') ? devices[i].id : null))
    .filter(Boolean);
  if (dead.length) await db('guest_devices').whereIn('id', dead).del();
}
